/* global Request, Headers */
/**
 * Container healthcheck HTTP server & Multi-College Bot Management Platform Control Plane.
 *
 * Serves three roles:
 *   1. Container health probes (`GET /health` -> 200 JSON, `GET /` for non-HTML
 *      probes -> 200 `HEALTH_TEXT`) without ever exposing secrets.
 *   2. Interactive Multi-College Platform Control Plane (`GET /` with `Accept: text/html`
 *      or `GET /dashboard`) for creating and managing isolated college bots,
 *      enforcing the central mandatory platform channel, inspecting audit logs,
 *      and connecting/deploying Telegram bots.
 *   3. Webhook gateway forwarding (`/telegram/webhook`, `/telegram/webhook/:collegeId`,
 *      `/platform/webhook`, `/platform/status`) to the unified multi-college worker.
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';
import { runBot } from './telegram/bot.js';
import { getD1SchemaSql } from './db/d1/migrations.js';
import { normalizeChannelValue, resolveChannel, validateChannelValue } from './archive.js';
import { dualUploadMediaMessage } from './storage/googleDrive.js';
import {
  activateCollege,
  createCollege,
  decommissionCollege,
  ensureDefaultCollegeRegistered,
  ensurePlatformSchema,
  getCollege,
  getPlatformChannelConfig,
  listColleges,
  listCollegeSecrets,
  listPlatformAuditLogs,
  setCollegeArchiveChannel,
  setCollegeBotToken,
  setCollegeSecret,
  setPlatformMandatoryChannel,
  suspendCollege,
  updateCollegeManager,
  validateCollegeConfiguration,
} from './platform/index.js';

export const DEFAULT_PORT = 3000;
export const HEALTH_TEXT = 'MEDBOT is active and running';
/** Health check path a host should be pointed at (see `render.yaml`). */
export const HEALTH_PATH = '/health';

/** Resolve the listen port: `PORT` when valid, else the container default. */
export function resolvePort(...args) {
  const value = args.length > 0 ? args[0] : process.env.PORT;
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

/**
 * The lightweight health payload. Never contains a secret, a token, a database
 * path or an environment value: only liveness and process uptime.
 */
export function healthPayload() {
  return { status: 'ok', uptime_seconds: Math.floor(process.uptime()) };
}

let sharedControlD1 = null;
let sharedInitPromise = null;
let activeRuntimeBotInfo = null;

function createNodeSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(getD1SchemaSql());

  function createPrepared(sql, boundParams = []) {
    return {
      bind(...params) {
        return createPrepared(sql, params.map((p) => (p === undefined ? null : p)));
      },
      async raw() {
        const stmt = sqlite.prepare(sql);
        stmt.setReturnArrays(true);
        return stmt.all(...boundParams);
      },
      async all() {
        const stmt = sqlite.prepare(sql);
        return { results: stmt.all(...boundParams) };
      },
      async first(colName) {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...boundParams) ?? null;
        if (!row) return null;
        return colName ? (row[colName] ?? null) : row;
      },
      async run() {
        const stmt = sqlite.prepare(sql);
        const info = stmt.run(...boundParams);
        return {
          success: true,
          meta: {
            changes: Number(info.changes ?? 0),
            last_row_id: Number(info.lastInsertRowid ?? 0),
          },
        };
      },
    };
  }

  return {
    prepare(sql) {
      return createPrepared(sql);
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements) {
        out.push(await stmt.run());
      }
      return out;
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}

async function getControlD1() {
  if (!sharedControlD1) {
    sharedControlD1 = createNodeSqliteD1();
  }
  if (!sharedInitPromise) {
    sharedInitPromise = (async () => {
      await ensurePlatformSchema(sharedControlD1);
      await ensureDefaultCollegeRegistered(sharedControlD1, process.env);
    })();
  }
  await sharedInitPromise;
  return sharedControlD1;
}

function readJsonBody(request, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function handleApiRequest(request, response, pathname) {
  const method = String(request.method || 'GET').toUpperCase();
  const db = await getControlD1();

  if (method === 'GET' && pathname === '/api/platform/overview') {
    await ensureDefaultCollegeRegistered(db, process.env);
    const colleges = await listColleges(db);
    const enrichedColleges = [];
    for (const col of colleges) {
      const secrets = await listCollegeSecrets(db, col.id);
      const validation = await validateCollegeConfiguration(db, col.id, process.env);
      enrichedColleges.push({
        ...col,
        secrets,
        validation,
      });
    }
    const centralChannel = await getPlatformChannelConfig(db, process.env);
    const auditLogs = await listPlatformAuditLogs(db, { limit: 25 });
    const channel = resolveChannel();

    return sendJson(response, 200, {
      ok: true,
      platform: 'MEDBOT Multi-College Management Platform',
      defaultCollege: {
        id: 'default',
        slug: 'default',
        status: 'active',
        botTokenConfigured: Boolean(String(process.env.BOT_TOKEN ?? '').trim()),
        archiveChannel: channel || null,
        activeRuntimeBot: activeRuntimeBotInfo,
      },
      centralChannel,
      colleges: enrichedColleges,
      auditLogs,
      platformOwnerBotConfigured: Boolean(
        String(process.env.PLATFORM_BOT_TOKEN ?? process.env.BOT_TOKEN ?? '').trim(),
      ),
    });
  }

  if (method === 'POST' && pathname === '/api/platform/colleges') {
    try {
      const body = await readJsonBody(request);
      const created = await createCollege(
        db,
        {
          slug: body.slug,
          name: body.name,
          managerId: body.managerId || null,
          managerUsername: body.managerUsername || null,
          archiveChannelId: body.archiveChannelId || null,
          botToken: body.botToken || null,
          actorId: Number(process.env.PLATFORM_OWNER_ID || process.env.ADMIN_ID || 1),
        },
        process.env,
      );
      if (!created.ok) {
        return sendJson(response, 400, created);
      }
      if (body.geminiKey) {
        await setCollegeSecret(
          db,
          created.college.id,
          'GEMINI_API_KEY',
          body.geminiKey,
          process.env,
          1,
        );
      }
      if (body.groqKey) {
        await setCollegeSecret(
          db,
          created.college.id,
          'GROQ_API_KEY',
          body.groqKey,
          process.env,
          1,
        );
      }
      if (body.autoActivate) {
        await activateCollege(db, created.college.id, process.env, { force: true, actorId: 1 });
      }
      const updated = await getCollege(db, created.college.id);
      return sendJson(response, 200, { ok: true, college: updated });
    } catch (err) {
      return sendJson(response, 400, { ok: false, error: err?.message || 'Failed to create college' });
    }
  }

  if (method === 'POST' && pathname.startsWith('/api/platform/colleges/')) {
    try {
      const parts = pathname.slice('/api/platform/colleges/'.length).split('/');
      const collegeId = decodeURIComponent(parts[0] || '');
      const action = parts[1] || 'action';
      const body = await readJsonBody(request);
      const op = String(body.action || action).trim();

      if (op === 'activate') {
        const res = await activateCollege(db, collegeId, process.env, {
          force: Boolean(body.force ?? true),
          actorId: 1,
        });
        return sendJson(response, res.ok ? 200 : 400, res);
      }
      if (op === 'suspend') {
        const res = await suspendCollege(db, collegeId, body.reason || 'إيقاف من لوحة المنصة', 1);
        return sendJson(response, res.ok ? 200 : 400, res);
      }
      if (op === 'decommission') {
        const res = await decommissionCollege(db, collegeId, 1);
        return sendJson(response, res.ok ? 200 : 400, res);
      }
      if (op === 'validate') {
        const res = await validateCollegeConfiguration(db, collegeId, process.env);
        return sendJson(response, 200, { ok: true, validation: res });
      }
      if (op === 'set_channel') {
        const res = await setCollegeArchiveChannel(db, collegeId, body.archiveChannelId || '', 1);
        return sendJson(response, res.ok ? 200 : 400, res);
      }
      if (op === 'set_manager') {
        const res = await updateCollegeManager(
          db,
          collegeId,
          { managerId: body.managerId, managerUsername: body.managerUsername },
          1,
        );
        return sendJson(response, res.ok ? 200 : 400, res);
      }
      if (op === 'set_token') {
        const res = await setCollegeBotToken(db, collegeId, body.botToken, process.env, {
          actorId: 1,
          Managed: Boolean(body.isManaged ?? true),
        });
        return sendJson(response, res.ok ? 200 : 400, res);
      }
      if (op === 'set_secret') {
        const res = await setCollegeSecret(
          db,
          collegeId,
          body.secretName,
          body.secretValue,
          process.env,
          1,
        );
        return sendJson(response, res.ok ? 200 : 400, res);
      }

      return sendJson(response, 400, { ok: false, error: `Unknown college operation: ${op}` });
    } catch (err) {
      return sendJson(response, 400, { ok: false, error: err?.message || 'Operation failed' });
    }
  }

  if (method === 'POST' && pathname === '/api/platform/central-channel') {
    try {
      const body = await readJsonBody(request);
      const updated = await setPlatformMandatoryChannel(db, {
        channelId: body.channelId ?? '',
        inviteLink: body.inviteLink ?? '',
        title: body.title ?? 'قناة المنصة المركزية',
        actorId: 1,
      });
      if (updated.channelId) {
        process.env.PLATFORM_CHANNEL_ID = updated.channelId;
      } else {
        delete process.env.PLATFORM_CHANNEL_ID;
      }
      if (updated.inviteLink) {
        process.env.PLATFORM_CHANNEL_URL = updated.inviteLink;
      }
      if (updated.title) {
        process.env.PLATFORM_CHANNEL_TITLE = updated.title;
      }
      return sendJson(response, 200, { ok: true, centralChannel: updated });
    } catch (err) {
      return sendJson(response, 400, { ok: false, error: err?.message || 'Failed to update central channel' });
    }
  }

  if (method === 'POST' && pathname === '/api/platform/connect-bot') {
    try {
      const body = await readJsonBody(request);
      const botToken = String(body.botToken || '').trim();
      const adminId = String(body.adminId || '').trim();
      const archiveChannel = String(body.archiveChannel || '').trim();
      if (!botToken || !/^\d{6,14}:[A-Za-z0-9_-]{30,64}$/.test(botToken)) {
        return sendJson(response, 400, {
          ok: false,
          error: 'صيغة توكن البوت غير صالحة. يجب أن تكون على الشكل 123456789:AAH...',
        });
      }

      // Verify with Telegram getMe
      const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const meJson = await meRes.json().catch(() => null);
      if (!meRes.ok || !meJson?.ok) {
        return sendJson(response, 400, {
          ok: false,
          error: meJson?.description || 'رفض تيليجرام هذا التوكن (Unauthorized).',
        });
      }

      process.env.BOT_TOKEN = botToken;
      process.env.TELEGRAM_BOT_TOKEN = botToken;
      if (adminId && /^\d+$/.test(adminId)) {
        process.env.ADMIN_ID = adminId;
        process.env.PLATFORM_OWNER_ID = adminId;
      }
      if (archiveChannel) {
        const normalized = normalizeChannelValue(archiveChannel);
        if (validateChannelValue(normalized).valid) {
          process.env.MEDBOT_ARCHIVE_CHANNEL = normalized;
        }
      }

      // Register /platform and /setup commands on the bot
      await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [
            { command: 'start', description: '🏠 القائمة الرئيسية للمنصة' },
            { command: 'platform', description: '🏛 إدارة كليات المنصة المركزية (للمطور)' },
            { command: 'setup', description: '🔑 إعدادات الكلية والـ AI وقناة الأرشيف (لمدير الكلية)' },
            { command: 'admin', description: '🛠 لوحة إدارة الكلية والمحتوى' },
            { command: 'search', description: '🔎 البحث الذكي في المقررات والمراجع' },
            { command: 'ask', description: '🤖 المساعد الطبي الذكي' },
            { command: 'contribute', description: '📤 إرسال مساهمة طلابية' },
          ],
        }),
      }).catch(() => null);

      // Check if the bot currently has a webhook active; if the user requested polling mode, delete webhook and run polling
      const whRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`).then((r) => r.json()).catch(() => null);
      const existingWebhookUrl = whRes?.result?.url || '';

      if (body.startPolling || !existingWebhookUrl) {
        await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drop_pending_updates: false }),
        }).catch(() => null);

        if (!activeRuntimeBotInfo || activeRuntimeBotInfo.username !== meJson.result.username) {
          activeRuntimeBotInfo = {
            id: meJson.result.id,
            username: meJson.result.username,
            firstName: meJson.result.first_name,
            mode: 'polling',
          };
          runBot({ token: botToken }).catch((err) => {
            console.error('[MEDBOT] Runtime bot polling stopped:', err?.message || err);
            activeRuntimeBotInfo = null;
          });
        }
      } else {
        activeRuntimeBotInfo = {
          id: meJson.result.id,
          username: meJson.result.username,
          firstName: meJson.result.first_name,
          mode: 'webhook',
          webhookUrl: existingWebhookUrl,
        };
      }

      await ensureDefaultCollegeRegistered(db, process.env);
      return sendJson(response, 200, {
        ok: true,
        bot: activeRuntimeBotInfo,
      });
    } catch (err) {
      return sendJson(response, 400, { ok: false, error: err?.message || 'Failed to connect bot' });
    }
  }

  return sendJson(response, 404, { ok: false, error: 'not_found' });
}

function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MEDBOT — منصة إدارة بوتات الكليات المتعددة (Multi-College Platform)</title>
  <meta name="description" content="اللوحة المركزية لإدارة كليات منصة MEDBOT، عزل قواعد البيانات، التحقق من الاشتراك الإجباري، وإعداد مفاتيح الذكاء الاصطناعي لكل كلية." />
  <meta property="og:title" content="MEDBOT — منصة إدارة بوتات الكليات المتعددة" />
  <meta property="og:description" content="إدارة مركزية لبوتات الكليات الطبية المستقلة مع حماية وتشفير المفاتيح وعزل البيانات." />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap');
    body { font-family: 'Cairo', system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <!-- Header -->
  <header class="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-30">
    <div class="max-w-7xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-xl">
          🏛
        </div>
        <div>
          <h1 class="text-lg md:text-xl font-extrabold text-white">MEDBOT — منصة إدارة بوتات الكليات المتعددة</h1>
          <p class="text-xs md:text-sm text-slate-400">
            البوت الأساسي محفوظ بالكامل كـ <span class="text-emerald-400 font-bold">الكلية الافتراضية (Default College)</span> + إدارة مركزية لبوتات الكليات المستقلة
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2.5">
        <span id="platformHealthBadge" class="text-xs font-bold px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
          🟢 المنصة نشطة (Free-Tier D1 · بدون R2 أو Drive)
        </span>
        <button id="refreshAllBtn" type="button"
          class="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition">
          🔄 تحديث البيانات
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 py-8 space-y-8">
    <!-- Status Notice -->
    <div id="statusNotice" class="hidden rounded-xl border px-4 py-3 text-sm font-medium"></div>

    <!-- Important Note about Telegram Bot Menu & Cloudflare / Polling -->
    <section class="bg-gradient-to-l from-emerald-950/60 via-slate-900 to-slate-900 border border-emerald-500/30 rounded-2xl p-5 space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-1.5 max-w-3xl">
          <h2 class="text-base font-extrabold text-emerald-300 flex items-center gap-2">
            <span>⚡</span>
            <span>كيف تظهر الأزرار الجديدة في بوت تيليجرام فوراً؟</span>
          </h2>
          <p class="text-xs md:text-sm text-slate-300 leading-relaxed">
            تمت إضافة زر <b>«🏛 إدارة كليات المنصة المركزية»</b> وزر <b>«🔑 إعدادات الكلية والـ AI»</b> مباشرةً في القائمة الرئيسية (<code>/start</code>) وفي أعلى <b>«🛠 إدارة المنصة»</b>، بالإضافة إلى الأوامر السريعة <code>/platform</code> و<code>/setup</code>.
            إذا كان البوت مرتبطاً حالياً بـ <b>Cloudflare Workers القديم</b> ولم تقم بمزامنة التحديث بعد، يمكنك إما <b>تشغيل البوت مباشرةً من هنا</b> بإدخال التوكن أدناه (وضع Polling الفوري) أو مزامنة المستودع مع GitHub ليقوم GitHub Actions بتحديث Cloudflare تلقائياً.
          </p>
        </div>
      </div>

      <form id="connectBotForm" class="grid grid-cols-1 md:grid-cols-12 gap-3 pt-1">
        <div class="md:col-span-5">
          <label class="block text-xs font-bold text-slate-300 mb-1">توكن البوت (<code>BOT_TOKEN</code>) لتفعيله وتجربته فوراً في تيليجرام</label>
          <input id="connectBotTokenInput" type="password" dir="ltr" placeholder="123456789:AAH..."
            class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
        </div>
        <div class="md:col-span-3">
          <label class="block text-xs font-bold text-slate-300 mb-1">معرّف المالك في تيليجرام (<code>ADMIN_ID</code>)</label>
          <input id="connectAdminIdInput" type="text" dir="ltr" placeholder="مثال: 6155683890"
            class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
        </div>
        <div class="md:col-span-4 flex items-end gap-2">
          <button type="submit" id="connectBotBtn"
            class="w-full py-2 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition shadow">
            🚀 تفعيل البوت مباشرةً وتحديث أوامر /start و /platform
          </button>
        </div>
      </form>
    </section>

    <!-- Summary Cards -->
    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div class="text-xs text-slate-400">إجمالي الكليات المسجلة</div>
        <div id="metricTotalColleges" class="text-2xl font-extrabold text-white mt-1">1</div>
        <div class="text-[11px] text-emerald-400 mt-1">تشمل الكلية الافتراضية الأساسية</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div class="text-xs text-slate-400">الكليات النشطة (Active)</div>
        <div id="metricActiveColleges" class="text-2xl font-extrabold text-emerald-400 mt-1">1</div>
        <div class="text-[11px] text-slate-400 mt-1">تستقبل تحديثات الطلاب والمشرفين</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div class="text-xs text-slate-400">بوابة الاشتراك الإجباري المركزية</div>
        <div id="metricCentralChannel" class="text-base font-extrabold text-sky-400 mt-1 truncate">غير مفعّلة</div>
        <div class="text-[11px] text-slate-400 mt-1">تحقق مركزي قبل استخدام أي بوت كلية</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div class="text-xs text-slate-400">تشفير المفاتيح وعزل البيانات</div>
        <div class="text-base font-extrabold text-amber-300 mt-1">AES-256-GCM + D1 Isolation</div>
        <div class="text-[11px] text-slate-400 mt-1">عزل صارم لجداول ومفاتيح كل كلية</div>
      </div>
    </section>

    <!-- Main Grid: Create College + Central Mandatory Channel -->
    <section class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <!-- Create New College Form -->
      <div class="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-base font-extrabold text-white">➕ إنشاء وتجهيز كلية جديدة (Provision New College)</h2>
            <p class="text-xs text-slate-400">ينشئ بيئة معزولة بالكامل (جداول قاعدة بيانات مستقلة + ويب هوك مخصص + خزنة مفاتيح مشفرة)</p>
          </div>
          <span class="text-[11px] font-bold px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            Managed Bot Ready
          </span>
        </div>

        <form id="createCollegeForm" class="grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-1">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">المعرّف النصي للكلية (Slug باللغة الإنجليزية)</label>
            <input id="colSlugInput" type="text" dir="ltr" required placeholder="pharmacy أو dentistry"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">اسم الكلية (بالعربية)</label>
            <input id="colNameInput" type="text" required placeholder="مثال: كلية الصيدلة - جامعة صنعاء"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">معرّف مدير الكلية في تيليجرام (Manager Telegram ID)</label>
            <input id="colManagerIdInput" type="text" dir="ltr" placeholder="مثال: 55443322"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">معرّف قناة أرشيف الكلية (اختياري — يمكن للمدير إعداده)</label>
            <input id="colChannelInput" type="text" dir="ltr" placeholder="@pharmacy_archive أو -1001234567890"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div class="md:col-span-2">
            <label class="block text-xs font-semibold text-slate-300 mb-1">توكن بوت الكلية المستقل (اختياري — يُشفّر بـ AES-256-GCM)</label>
            <input id="colBotTokenInput" type="password" dir="ltr" placeholder="123456789:AAH... (أو اتركه ليُدخله مدير الكلية من داخل البوت)"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">مفتاح Gemini AI الخاص بالكلية (اختياري)</label>
            <input id="colGeminiKeyInput" type="password" dir="ltr" placeholder="AIzaSy..."
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">مفتاح Groq AI الخاص بالكلية (اختياري)</label>
            <input id="colGroqKeyInput" type="password" dir="ltr" placeholder="gsk_..."
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div class="md:col-span-2 flex items-center justify-between pt-2">
            <label class="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input id="colAutoActivateInput" type="checkbox" checked class="rounded border-slate-700 bg-slate-950 text-emerald-500" />
              <span>تفعيل الكلية فوراً بعد الإنشاء (Activate Immediately)</span>
            </label>
            <button type="submit"
              class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition shadow">
              🏛 إنشاء الكلية وتجهيز جداولها المعزولة
            </button>
          </div>
        </form>
      </div>

      <!-- Central Mandatory Platform Channel -->
      <div class="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div>
          <h2 class="text-base font-extrabold text-white">📢 قناة المنصة المركزية (الاشتراك الإجباري الموحد)</h2>
          <p class="text-xs text-slate-400 mt-1 leading-relaxed">
            عند ضبط هذه القناة، لن يتمكن أي طالب في أي بوت كلية من استخدام البوت إلا بعد التحقق المركزى من اشتراكه في قناة المطور الرئيسية.
          </p>
        </div>

        <form id="centralChannelForm" class="space-y-3 pt-1">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">معرّف القناة المركزية (<code>@username</code> أو <code>-100...</code>)</label>
            <input id="centralChannelIdInput" type="text" dir="ltr" placeholder="@medbot_platform أو -1001987654321"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">رابط الدعوة للقناة (Invite URL)</label>
            <input id="centralChannelUrlInput" type="text" dir="ltr" placeholder="https://t.me/medbot_platform"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">اسم القناة الظاهر للطلاب</label>
            <input id="centralChannelTitleInput" type="text" placeholder="قناة منصة MEDBOT المركزية"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
          </div>
          <div class="flex items-center justify-between gap-2 pt-2">
            <button type="button" id="disableCentralChannelBtn"
              class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-300 text-xs font-bold border border-slate-700 transition">
              إيقاف الاشتراك الإجباري
            </button>
            <button type="submit"
              class="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold transition shadow">
              💾 حفظ وتفعيل بوابة الاشتراك الإجباري
            </button>
          </div>
        </form>
      </div>
    </section>

    <!-- Registered Colleges Table / Cards -->
    <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-extrabold text-white">🏛 قائمة الكليات المسجلة في المنصة (Colleges Registry)</h2>
          <p class="text-xs text-slate-400">تحكم كامل في تفعيل، إيقاف، فحص الجاهزية، وتعيين مدراء ومفاتيح كل كلية بشكل مستقل</p>
        </div>
      </div>

      <div id="collegesContainer" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="text-xs text-slate-400 py-6 text-center col-span-2">جارٍ تحميل قائمة الكليات...</div>
      </div>
    </section>

    <!-- Audit Logs -->
    <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-base font-extrabold text-white">📜 سجل التدقيق الأمني للمنصة (Platform Audit Logs)</h2>
          <p class="text-xs text-slate-400">توثيق جميع عمليات الإنشاء، التفعيل، تعديل المفاتيح، وإدارة الكليات</p>
        </div>
      </div>
      <div id="auditLogsContainer" class="space-y-2 max-h-72 overflow-y-auto pr-1">
        <div class="text-xs text-slate-500 py-4 text-center">لا توجد سجلات بعد.</div>
      </div>
    </section>
  </main>

  <script type="module">
    const statusNotice = document.getElementById('statusNotice');
    const metricTotalColleges = document.getElementById('metricTotalColleges');
    const metricActiveColleges = document.getElementById('metricActiveColleges');
    const metricCentralChannel = document.getElementById('metricCentralChannel');
    const collegesContainer = document.getElementById('collegesContainer');
    const auditLogsContainer = document.getElementById('auditLogsContainer');
    const createCollegeForm = document.getElementById('createCollegeForm');
    const centralChannelForm = document.getElementById('centralChannelForm');
    const disableCentralChannelBtn = document.getElementById('disableCentralChannelBtn');
    const connectBotForm = document.getElementById('connectBotForm');
    const refreshAllBtn = document.getElementById('refreshAllBtn');

    function showNotice(message, kind = 'success') {
      statusNotice.className =
        'rounded-xl border px-4 py-3 text-sm font-medium ' +
        (kind === 'error'
          ? 'bg-rose-500/15 border-rose-500/30 text-rose-200'
          : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200');
      statusNotice.textContent = message;
      statusNotice.classList.remove('hidden');
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function loadPlatformOverview() {
      try {
        const res = await fetch('/api/platform/overview');
        const data = await res.json();
        if (!data?.ok) return;

        const colleges = data.colleges || [];
        const activeCount = colleges.filter((c) => c.status === 'active').length;
        metricTotalColleges.textContent = String(colleges.length);
        metricActiveColleges.textContent = String(activeCount);

        if (data.centralChannel?.channelId) {
          metricCentralChannel.textContent = '✅ ' + data.centralChannel.channelId;
          document.getElementById('centralChannelIdInput').value = data.centralChannel.channelId;
          document.getElementById('centralChannelUrlInput').value = data.centralChannel.inviteLink || '';
          document.getElementById('centralChannelTitleInput').value = data.centralChannel.title || '';
        } else {
          metricCentralChannel.textContent = '⚪️ غير مفعّلة';
        }

        renderColleges(colleges);
        renderAuditLogs(data.auditLogs || []);
      } catch (err) {
        console.error('Failed to load overview:', err);
      }
    }

    function renderColleges(colleges) {
      if (!colleges.length) {
        collegesContainer.innerHTML = '<div class="text-xs text-slate-400 py-6 text-center col-span-2">لا توجد كليات مسجلة.</div>';
        return;
      }

      collegesContainer.innerHTML = colleges
        .map((c) => {
          const statusBadge =
            c.status === 'active'
              ? '<span class="px-2.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-bold">🟢 نشطة (Active)</span>'
              : c.status === 'suspended'
              ? '<span class="px-2.5 py-0.5 rounded-md bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px] font-bold">🔴 موقوفة (Suspended)</span>'
              : '<span class="px-2.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[11px] font-bold">🟡 قيد الإعداد (Pending Setup)</span>';

          const webhookPath = c.isDefault ? '/telegram/webhook' : '/telegram/webhook/' + encodeURIComponent(c.slug);
          const secretsList = (c.secrets || []).map((s) => s.name).join('، ') || 'لم تُضاف مفاتيح خاصة بعد';

          return \`
            <div class="bg-slate-950 border border-slate-800 rounded-2xl p-5 space-y-3 flex flex-col justify-between">
              <div class="space-y-2">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <div class="text-sm font-extrabold text-white">\${escapeHtml(c.name)}</div>
                    <div class="text-[11px] text-slate-400" dir="ltr">Slug: <code>\${escapeHtml(c.slug)}</code> · Table Prefix: <code>\${escapeHtml(c.tablePrefix || 'default (unprefixed)')}</code></div>
                  </div>
                  \${statusBadge}
                </div>

                <div class="grid grid-cols-2 gap-2 text-xs bg-slate-900/90 border border-slate-800/80 rounded-xl p-3">
                  <div>
                    <span class="text-slate-400">البوت:</span>
                    <span class="font-bold text-slate-200 mr-1" dir="ltr">\${c.botUsername ? '@' + escapeHtml(c.botUsername) : c.hasBotToken ? 'مربوط (مشفر)' : 'غير مربوط'}</span>
                  </div>
                  <div>
                    <span class="text-slate-400">المدير:</span>
                    <span class="font-bold text-slate-200 mr-1" dir="ltr">\${c.managerId ? escapeHtml(c.managerId) : 'غير محدد'}</span>
                  </div>
                  <div>
                    <span class="text-slate-400">قناة الأرشيف:</span>
                    <span class="font-bold text-slate-200 mr-1" dir="ltr">\${c.archiveChannelId ? escapeHtml(c.archiveChannelId) : 'غير مضبوطة'}</span>
                  </div>
                  <div>
                    <span class="text-slate-400">مسار الويب هوك:</span>
                    <code class="text-[11px] text-emerald-400" dir="ltr">\${escapeHtml(webhookPath)}</code>
                  </div>
                </div>

                <div class="text-[11px] text-slate-400">
                  🔐 <b>المفاتيح المشفرة:</b> \${escapeHtml(secretsList)}
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                \${
                  c.status !== 'active'
                    ? \`<button type="button" data-col-action="activate" data-col-id="\${escapeHtml(c.id)}" class="col-action-btn px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-bold transition">✅ تفعيل الكلية</button>\`
                    : !c.isDefault
                    ? \`<button type="button" data-col-action="suspend" data-col-id="\${escapeHtml(c.id)}" class="col-action-btn px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 text-xs font-bold transition">⏸ إيقاف مؤقت</button>\`
                    : ''
                }
                <button type="button" data-col-action="validate" data-col-id="\${escapeHtml(c.id)}" class="col-action-btn px-3 py-1.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-xs font-bold transition">🩺 فحص الجاهزية</button>
              </div>
            </div>
          \`;
        })
        .join('');

      document.querySelectorAll('.col-action-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const colId = btn.getAttribute('data-col-id');
          const action = btn.getAttribute('data-col-action');
          try {
            const res = await fetch('/api/platform/colleges/' + encodeURIComponent(colId) + '/' + action, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action, force: true }),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
              showNotice(data.error || 'تعذر تنفيذ العملية', 'error');
              return;
            }
            if (action === 'validate') {
              const v = data.validation;
              showNotice(
                v.ready
                  ? '✅ الكلية جاهزة ومكتملة الإعدادات بالكامل!'
                  : '⚠️ تنبيهات الجاهزية: ' + [...(v.issues || []), ...(v.warnings || [])].join(' | '),
                v.ready ? 'success' : 'error',
              );
            } else {
              showNotice('✅ تم تحديث حالة الكلية بنجاح.');
            }
            await loadPlatformOverview();
          } catch (err) {
            showNotice('حدث خطأ: ' + err.message, 'error');
          }
        });
      });
    }

    function renderAuditLogs(logs) {
      if (!logs.length) {
        auditLogsContainer.innerHTML = '<div class="text-xs text-slate-500 py-4 text-center">لا توجد سجلات تدقيق بعد.</div>';
        return;
      }
      auditLogsContainer.innerHTML = logs
        .map(
          (log) => \`
          <div class="flex items-center justify-between gap-3 bg-slate-950 border border-slate-800/80 rounded-xl px-3.5 py-2 text-xs">
            <div class="flex items-center gap-2 min-w-0">
              <span class="px-2 py-0.5 rounded bg-slate-800 text-emerald-300 font-mono text-[11px]" dir="ltr">\${escapeHtml(log.action)}</span>
              <span class="text-slate-300 truncate">الكلية: <b>\${escapeHtml(log.collegeId || 'platform')}</b></span>
            </div>
            <div class="text-[11px] text-slate-500 shrink-0" dir="ltr">\${escapeHtml(log.createdAt || '')}</div>
          </div>
        \`,
        )
        .join('');
    }

    createCollegeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const payload = {
          slug: document.getElementById('colSlugInput').value.trim(),
          name: document.getElementById('colNameInput').value.trim(),
          managerId: document.getElementById('colManagerIdInput').value.trim() || null,
          archiveChannelId: document.getElementById('colChannelInput').value.trim() || null,
          botToken: document.getElementById('colBotTokenInput').value.trim() || null,
          geminiKey: document.getElementById('colGeminiKeyInput').value.trim() || null,
          groqKey: document.getElementById('colGroqKeyInput').value.trim() || null,
          autoActivate: document.getElementById('colAutoActivateInput').checked,
        };
        const res = await fetch('/api/platform/colleges', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showNotice(data.error || 'تعذر إنشاء الكلية', 'error');
          return;
        }
        showNotice('✅ تم إنشاء الكلية وتجهيز جداولها المعزولة بنجاح: ' + data.college.name);
        createCollegeForm.reset();
        document.getElementById('colAutoActivateInput').checked = true;
        await loadPlatformOverview();
      } catch (err) {
        showNotice('خطأ أثناء إنشاء الكلية: ' + err.message, 'error');
      }
    });

    centralChannelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await fetch('/api/platform/central-channel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channelId: document.getElementById('centralChannelIdInput').value.trim(),
            inviteLink: document.getElementById('centralChannelUrlInput').value.trim(),
            title: document.getElementById('centralChannelTitleInput').value.trim() || 'قناة المنصة المركزية',
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showNotice(data.error || 'تعذر حفظ القناة المركزية', 'error');
          return;
        }
        showNotice('✅ تم تفعيل وحفظ بوابة الاشتراك الإجباري في القناة المركزية لجميع الكليات.');
        await loadPlatformOverview();
      } catch (err) {
        showNotice('خطأ: ' + err.message, 'error');
      }
    });

    disableCentralChannelBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/platform/central-channel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: '', inviteLink: '', title: '' }),
        });
        document.getElementById('centralChannelIdInput').value = '';
        showNotice('⚪️ تم إيقاف الاشتراك الإجباري المركزي.');
        await loadPlatformOverview();
      } catch (err) {
        showNotice('خطأ: ' + err.message, 'error');
      }
    });

    connectBotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const botToken = document.getElementById('connectBotTokenInput').value.trim();
      const adminId = document.getElementById('connectAdminIdInput').value.trim();
      if (!botToken) {
        showNotice('يرجى إدخال توكن البوت (BOT_TOKEN) أولاً.', 'error');
        return;
      }
      const btn = document.getElementById('connectBotBtn');
      btn.disabled = true;
      btn.textContent = '⏳ جارٍ الاتصال بـ Telegram وتفعيل التحديثات...';
      try {
        const res = await fetch('/api/platform/connect-bot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botToken, adminId, startPolling: true }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showNotice(data.error || 'تعذر الاتصال بالبوت', 'error');
        } else {
          showNotice(
            '🎉 تم ربط وتفعيل البوت @' +
              (data.bot?.username || '') +
              ' بنجاح! افتح تيليجرام الآن وأرسل /start أو /platform لترى جميع أزرار المنصة الجديدة فوراً.',
          );
          document.getElementById('connectBotTokenInput').value = '';
          await loadPlatformOverview();
        }
      } catch (err) {
        showNotice('حدث خطأ أثناء تفعيل البوت: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🚀 تفعيل البوت مباشرةً وتحديث أوامر /start و /platform';
      }
    });

    refreshAllBtn.addEventListener('click', () => loadPlatformOverview());
    loadPlatformOverview();
  </script>
</body>
</html>`;
}

/**
 * Forward `/telegram/webhook*` and `/platform/*` HTTP requests to the unified
 * multi-college Cloudflare Worker handler (`src/worker.js`).
 */
async function forwardToWorker(request, response) {
  const db = await getControlD1();
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);
  const protocol = 'http';
  const host = request.headers?.host || 'localhost:3000';
  const fullUrl = `${protocol}://${host}${request.url || '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(request.headers || {})) {
    if (Array.isArray(v)) {
      headers.set(k, v.join(', '));
    } else if (typeof v === 'string') {
      headers.set(k, v);
    }
  }

  const webReq = new Request(fullUrl, {
    method: request.method || 'GET',
    headers,
    body: ['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase())
      ? undefined
      : rawBody,
  });

  const env = {
    ...process.env,
    DB: db,
  };

  const webRes = await worker.fetch(webReq, env);
  const resHeaders = {};
  webRes.headers.forEach((value, key) => {
    resHeaders[key] = value;
  });
  const text = await webRes.text();
  response.writeHead(webRes.status, resHeaders);
  response.end(text);
}

/**
 * Start the healthcheck and Multi-College Platform Control Plane server.
 *
 * `GET /health` answers 200 with a small JSON liveness body;
 * `GET /` answers 200 HTML dashboard when `Accept: text/html` is sent by a
 * browser, or `HEALTH_TEXT` for plain probes (preserving backwards compatibility
 * with container health checks and existing tests).
 */
export function startHealthServer({
  port = resolvePort(),
  host = '0.0.0.0',
  onListening = null,
} = {}) {
  const server = http.createServer((request, response) => {
    const pathname = String(request.url ?? '/').split('?')[0];

    if (pathname === HEALTH_PATH) {
      const body = JSON.stringify(healthPayload());
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }

    if (pathname.startsWith('/api/')) {
      handleApiRequest(request, response, pathname).catch((err) => {
        sendJson(response, 500, { ok: false, error: err?.message || 'Internal server error' });
      });
      return;
    }

    if (
      pathname === '/telegram/webhook' ||
      pathname.startsWith('/telegram/webhook/') ||
      pathname === '/platform/webhook' ||
      pathname === '/platform/status'
    ) {
      forwardToWorker(request, response).catch((err) => {
        sendJson(response, 500, { ok: false, error: err?.message || 'Worker gateway error' });
      });
      return;
    }

    const accept = String(request.headers?.accept ?? '');
    if (pathname === '/dashboard' || (pathname === '/' && accept.includes('text/html'))) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(renderDashboardHtml());
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(HEALTH_TEXT);
  });

  server.on('error', (error) => {
    console.error('Healthcheck server error:', error.message ?? error);
  });

  server.listen(port, host, () => {
    const bound = server.address()?.port ?? port;
    console.log(`MEDBOT healthcheck listening on http://${host}:${bound}`);
    if (typeof onListening === 'function') onListening(bound);
  });

  return server;
}

export { dualUploadMediaMessage };
