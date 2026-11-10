/* global Response */
/**
 * External Web Developer Control Plane (`src/platform/webControlPlane.js`).
 *
 * Runtime-agnostic module (works identically on Cloudflare Workers and Node.js)
 * that provides the Platform Developer with a dedicated web portal outside Telegram
 * to create, provision, bind webhooks, assign managers, configure the central
 * mandatory subscription channel, and manage all college bots.
 *
 * Meanwhile, each individual college bot's own operational settings (Archive Channel,
 * AI API Keys, Bot Identity) remain configurable by the College Manager directly
 * inside the bot's own Settings menu (`⚙️ إعدادات المنصة` / `/setup`).
 */

import { run } from '../db/d1/core.js';
import { ensureCollegeSchema, resolveCollegeDatabase } from './isolation.js';
import {
  getPlatformChannelConfig,
  setPlatformMandatoryChannel,
} from './membershipGate.js';
import {
  activateCollege,
  configureCollegeBotWebhook,
  createCollege,
  decommissionCollege,
  deleteCollegeSecret,
  ensureDefaultCollegeRegistered,
  getCollege,
  listColleges,
  listPlatformAuditLogs,
  setCollegeArchiveChannel,
  setCollegeBotToken,
  setCollegeSecret,
  suspendCollege,
  updateCollegeManager,
  validateCollegeConfiguration,
} from './registry.js';
import { ensurePlatformSchema } from './schema.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function resolveWebhookBaseUrl(request, env = {}) {
  const configured = String(env?.CLOUDFLARE_WORKER_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\//i.test(configured)) {
    return configured.replace(/\/telegram\/webhook.*$/i, '');
  }
  try {
    const u = new URL(request.url);
    if (u.protocol === 'https:') {
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    // Ignore URL parse error
  }
  return null;
}

/**
 * Unified HTTP API handler for `/api/platform/*` across Cloudflare Workers and Node.js.
 */
export async function handlePlatformWebApi(request, env = {}, { onConnectRuntimeBot = null } = {}) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = String(request.method || 'GET').toUpperCase();
  const platformDb = env?.PLATFORM_DB || env?.DB;

  if (!platformDb) {
    return jsonResponse({ ok: false, error: 'قاعدة بيانات المنصة (D1) غير متصلة.' }, 503);
  }

  await ensurePlatformSchema(platformDb);
  await ensureDefaultCollegeRegistered(platformDb, env);

  const webhookBaseUrl = resolveWebhookBaseUrl(request, env);

  if (method === 'GET' && pathname === '/api/platform/overview') {
    const rawColleges = await listColleges(platformDb, env);
    const colleges = [];
    for (const col of rawColleges) {
      const validation = await validateCollegeConfiguration(platformDb, env, col.college_id);
      const webhookPath =
        col.college_id === 'default'
          ? '/telegram/webhook'
          : `/telegram/webhook/${encodeURIComponent(col.college_id)}`;
      colleges.push({
        id: col.college_id,
        college_id: col.college_id,
        slug: col.college_id,
        name: col.name_ar,
        nameEn: col.name_en,
        isDefault: col.college_id === 'default',
        status: col.status,
        suspensionReason: col.suspension_reason,
        managerId: col.manager_telegram_id,
        managerUsername: col.manager_username,
        botId: col.bot_id,
        botUsername: col.bot_username,
        hasBotToken: col.has_bot_token,
        botTokenMasked: col.bot_token_masked,
        managedBotMode: col.managed_bot_mode,
        dbBinding: col.db_binding,
        archiveChannelId: validation.archiveChannel || col.archive_channel_id || null,
        webhookPath,
        webhookUrl: col.webhook_url || (webhookBaseUrl ? `${webhookBaseUrl}${webhookPath}` : null),
        secrets: validation.secrets || [],
        hasAiKey: Boolean(validation.hasAiKey),
        ready: Boolean(validation.ready),
        missing: validation.missing || [],
        checks: validation.checks || [],
        updatedAt: col.updated_at,
      });
    }

    const centralChannel = await getPlatformChannelConfig(platformDb, env);
    const auditLogs = await listPlatformAuditLogs(platformDb, { limit: 40 });

    return jsonResponse({
      ok: true,
      platform: 'MEDBOT Multi-College Developer Control Plane',
      webhookBaseUrl,
      centralChannel: {
        enabled: centralChannel.enabled,
        channelId: centralChannel.channelId,
        inviteLink: centralChannel.channelUrl,
        title: centralChannel.channelTitle,
      },
      colleges,
      auditLogs,
    });
  }

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    try {
      const rawText = await request.text();
      body = rawText.trim() ? JSON.parse(rawText) : {};
    } catch {
      return jsonResponse({ ok: false, error: 'صيغة البيانات المرسلة (JSON) غير صالحة.' }, 400);
    }
  }

  if (method === 'POST' && pathname === '/api/platform/colleges') {
    try {
      const created = await createCollege(platformDb, env, {
        slug: body.slug,
        nameAr: body.name || body.nameAr,
        nameEn: body.nameEn || null,
        managerTelegramId: body.managerId || body.managerTelegramId || null,
        managerUsername: body.managerUsername || null,
        botToken: body.botToken || null,
        managedBotMode: body.managedBotMode || undefined,
        archiveChannelId: body.archiveChannelId || null,
        actorId: Number(env?.PLATFORM_OWNER_ID || env?.ADMIN_ID || 1),
        webhookBaseUrl: body.webhookBaseUrl || webhookBaseUrl,
      });

      const collegeDb = resolveCollegeDatabase(env, created);
      if (collegeDb) {
        await ensureCollegeSchema(collegeDb);
        if (body.geminiKey && String(body.geminiKey).trim()) {
          await setCollegeSecret(
            collegeDb,
            platformDb,
            env,
            created.college_id,
            'GEMINI_API_KEY',
            String(body.geminiKey).trim(),
            1,
          );
        }
        if (body.groqKey && String(body.groqKey).trim()) {
          await setCollegeSecret(
            collegeDb,
            platformDb,
            env,
            created.college_id,
            'GROQ_API_KEY',
            String(body.groqKey).trim(),
            1,
          );
        }
        if (body.openrouterKey && String(body.openrouterKey).trim()) {
          await setCollegeSecret(
            collegeDb,
            platformDb,
            env,
            created.college_id,
            'OPENROUTER_API_KEY',
            String(body.openrouterKey).trim(),
            1,
          );
        }
      }

      if (body.autoActivate) {
        await activateCollege(platformDb, env, created.college_id, 1, { force: true });
      }

      const updated = await getCollege(platformDb, created.college_id, env);
      return jsonResponse({ ok: true, college: updated });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err?.message || err) }, 400);
    }
  }

  if (method === 'POST' && pathname.startsWith('/api/platform/colleges/')) {
    try {
      const suffix = pathname.slice('/api/platform/colleges/'.length);
      const parts = suffix.split('/').filter(Boolean);
      const collegeId = decodeURIComponent(parts[0] || '');
      const op = String(body.action || parts[1] || '').trim();

      if (!collegeId) {
        return jsonResponse({ ok: false, error: 'معرّف الكلية مطلوب.' }, 400);
      }

      if (op === 'activate') {
        const res = await activateCollege(platformDb, env, collegeId, 1, {
          force: Boolean(body.force ?? true),
        });
        return jsonResponse(res, res.ok ? 200 : 400);
      }

      if (op === 'suspend') {
        const res = await suspendCollege(
          platformDb,
          env,
          collegeId,
          body.reason || 'موقوف مؤقتاً من لوحة تحكم المطور',
          1,
        );
        return jsonResponse(res, res.ok ? 200 : 400);
      }

      if (op === 'decommission') {
        const res = await decommissionCollege(platformDb, env, collegeId, 1);
        return jsonResponse(res, res.ok ? 200 : 400);
      }

      if (op === 'validate') {
        const validation = await validateCollegeConfiguration(platformDb, env, collegeId);
        return jsonResponse({ ok: true, validation });
      }

      if (op === 'set_token') {
        const college = await setCollegeBotToken(
          platformDb,
          env,
          collegeId,
          body.botToken,
          1,
          {
            webhookBaseUrl: body.webhookBaseUrl || webhookBaseUrl,
            managedBotMode: body.managedBotMode || null,
          },
        );
        return jsonResponse({ ok: true, college });
      }

      if (op === 'bind_webhook') {
        const col = await getCollege(platformDb, collegeId, env, { includeDecryptedToken: true });
        if (!col || !col.bot_token) {
          return jsonResponse({ ok: false, error: 'لا يوجد توكن بوت محفوظ لهذه الكلية بعد.' }, 400);
        }
        const base = String(body.webhookBaseUrl || webhookBaseUrl || '').replace(/\/+$/, '');
        if (!base) {
          return jsonResponse({ ok: false, error: 'رابط الويب هوك الأساسي (HTTPS) غير متوفر.' }, 400);
        }
        const targetUrl =
          col.college_id === 'default'
            ? `${base}/telegram/webhook`
            : `${base}/telegram/webhook/${col.college_id}`;
        const wh = await configureCollegeBotWebhook(col.bot_token, targetUrl, col.webhook_secret, {
          collegeNameAr: col.name_ar,
        });
        if (!wh.ok) {
          return jsonResponse({ ok: false, error: wh.error || 'تعذر ربط الويب هوك مع تيليجرام.' }, 400);
        }
        await run(
          platformDb,
          'UPDATE platform_colleges SET webhook_url = ?, updated_at = CURRENT_TIMESTAMP WHERE college_id = ?',
          [targetUrl, col.college_id],
        ).catch(() => {});
        return jsonResponse({ ok: true, webhookUrl: targetUrl });
      }

      if (op === 'set_manager') {
        const college = await updateCollegeManager(
          platformDb,
          env,
          collegeId,
          body.managerId || body.managerTelegramId,
          body.managerUsername || null,
          1,
        );
        return jsonResponse({ ok: true, college });
      }

      if (op === 'set_channel') {
        const col = await getCollege(platformDb, collegeId, env);
        const collegeDb = resolveCollegeDatabase(env, col || collegeId);
        const channel = await setCollegeArchiveChannel(
          platformDb,
          collegeDb,
          env,
          collegeId,
          body.archiveChannelId ?? '',
          1,
        );
        return jsonResponse({ ok: true, archiveChannelId: channel });
      }

      if (op === 'set_secret') {
        const col = await getCollege(platformDb, collegeId, env);
        const collegeDb = resolveCollegeDatabase(env, col || collegeId);
        const secretName = await setCollegeSecret(
          collegeDb,
          platformDb,
          env,
          collegeId,
          body.secretName,
          body.secretValue,
          1,
        );
        return jsonResponse({ ok: true, secretName });
      }

      if (op === 'delete_secret') {
        const col = await getCollege(platformDb, collegeId, env);
        const collegeDb = resolveCollegeDatabase(env, col || collegeId);
        const deleted = await deleteCollegeSecret(
          collegeDb,
          platformDb,
          env,
          collegeId,
          body.secretName,
          1,
        );
        return jsonResponse({ ok: true, deleted });
      }

      return jsonResponse({ ok: false, error: `عملية غير معروفة: ${op}` }, 400);
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err?.message || err) }, 400);
    }
  }

  if (method === 'POST' && pathname === '/api/platform/central-channel') {
    try {
      const updated = await setPlatformMandatoryChannel(platformDb, {
        channelId: body.channelId ?? '',
        channelUrl: body.inviteLink ?? body.channelUrl ?? '',
        channelTitle: body.title ?? body.channelTitle ?? 'القناة الرسمية للمنصة الأكاديمية',
        enabled: Boolean(String(body.channelId ?? '').trim()),
        actorId: 1,
      });
      return jsonResponse({
        ok: true,
        centralChannel: {
          enabled: updated.enabled,
          channelId: updated.channelId,
          inviteLink: updated.channelUrl,
          title: updated.channelTitle,
        },
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err?.message || err) }, 400);
    }
  }

  if (method === 'POST' && pathname === '/api/platform/connect-bot') {
    try {
      if (typeof onConnectRuntimeBot === 'function') {
        const result = await onConnectRuntimeBot(body, platformDb, webhookBaseUrl);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      const botToken = String(body.botToken || '').trim();
      if (!botToken) {
        return jsonResponse({ ok: false, error: 'يرجى إدخال توكن البوت.' }, 400);
      }
      const college = await setCollegeBotToken(platformDb, env, 'default', botToken, 1, {
        webhookBaseUrl: body.webhookBaseUrl || webhookBaseUrl,
      });
      if (body.adminId && /^\d+$/.test(String(body.adminId).trim())) {
        await updateCollegeManager(platformDb, env, 'default', Number(body.adminId), null, 1);
      }
      return jsonResponse({
        ok: true,
        bot: {
          id: college.bot_id,
          username: college.bot_username,
          mode: 'webhook',
          webhookUrl: college.webhook_url,
        },
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err?.message || err) }, 400);
    }
  }

  return jsonResponse({ ok: false, error: 'not_found' }, 404);
}

/**
 * Render the external Developer Web Portal HTML.
 * Follows the SaaS & Developer Console design constitution:
 *   - 3-zone Top Bar Contract
 *   - Plus Jakarta Sans + Cairo + JetBrains Mono (`tabular-nums`)
 *   - Unboxed metadata with `·` separators, 1px hairline borders, single-elevation surfaces
 *   - Full developer lifecycle controls for all college bots outside Telegram
 */
export function renderPlatformWebPortalHtml() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MEDBOT — بوابة المطور المركزية لإدارة بوتات الكليات</title>
  <meta name="description" content="بوابة الويب المركزية للمطور لإنشاء وإدارة بوتات الكليات المستقلة، ضبط قناة الاشتراك الإجباري، ومراقبة الجاهزية وسجل التدقيق." />
  <meta property="og:title" content="MEDBOT — بوابة المطور لإدارة بوتات الكليات" />
  <meta property="og:description" content="إنشاء وإدارة بوتات الكليات الطبية المستقلة من خارج تيليجرام، بينما تُدار القناة ومفاتيح الذكاء الاصطناعي لكل كلية من داخل إعدادات البوت نفسه." />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&family=JetBrains+Mono:wght@400;600&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap');
    body {
      font-family: 'Cairo', 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background-color: #0b0f19;
      color: #f1f5f9;
    }
    .font-mono-num {
      font-family: 'JetBrains Mono', monospace;
      font-variant-numeric: tabular-nums;
    }
    .tabular-nums {
      font-variant-numeric: tabular-nums;
    }
  </style>
</head>
<body class="min-h-screen flex flex-col selection:bg-emerald-500/30 selection:text-emerald-200">
  <!-- Strict 3-Zone Top Bar Contract -->
  <header class="border-b border-slate-800/90 bg-slate-950/90 backdrop-blur sticky top-0 z-30">
    <div class="max-w-[1360px] mx-auto px-6 py-3.5 flex items-center justify-between gap-8">
      <!-- Zone 1: Single-line Brand Wordmark -->
      <a href="/dashboard" class="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0">
        MEDBOT Control Plane
      </a>

      <!-- Zone 2: 4 Concise Single-Line Navigation Links -->
      <nav class="hidden md:flex items-center gap-7 text-sm font-semibold text-slate-400">
        <a href="#colleges-section" class="hover:text-white transition-colors whitespace-nowrap shrink-0">بوتات الكليات</a>
        <a href="#provision-section" class="hover:text-white transition-colors whitespace-nowrap shrink-0">إنشاء كلية</a>
        <a href="#mandatory-channel-section" class="hover:text-white transition-colors whitespace-nowrap shrink-0">الاشتراك الإجباري</a>
        <a href="#audit-section" class="hover:text-white transition-colors whitespace-nowrap shrink-0">سجل التدقيق</a>
      </nav>

      <!-- Zone 3: 1 Primary Action -->
      <div class="flex items-center gap-3 shrink-0">
        <a href="#provision-section" class="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap shrink-0">
          إنشاء بوت كلية جديد
        </a>
      </div>
    </div>
  </header>

  <main class="max-w-[1360px] w-full mx-auto px-6 py-8 space-y-10 flex-1">
    <!-- Status Notification Banner -->
    <div id="statusNotice" class="hidden rounded-lg border px-4 py-3 text-sm font-semibold"></div>

    <!-- Hero / Architecture Split Summary -->
    <section class="border-b border-slate-800/80 pb-8 flex flex-col lg:flex-row lg:items-end justify-between gap-6">
      <div class="space-y-2 max-w-3xl">
        <p class="text-xs font-semibold text-emerald-400">بوابة المطور المركزية خارج تيليجرام · فصل الصلاحيات الكامل</p>
        <h1 class="text-2xl md:text-3xl font-bold text-white tracking-tight" style="text-wrap: balance;">
          إدارة وإنشاء بوتات الكليات من الويب، وإعداد القناة والـ AI من داخل كل بوت
        </h1>
        <p class="text-sm text-slate-400 leading-relaxed">
          يتحكم المطور الأساسي من هذا الموقع في إنشاء الكليات، ربط توكنات البوتات، تعيين مدراء الكليات، وتفعيل الاشتراك الإجباري المركزي. بينما يقوم مدير كل كلية بإدخال <b>قناة الأرشيف</b> و<b>مفاتيح الذكاء الاصطناعي</b> الخاصة به مباشرةً من داخل <b>⚙️ إعدادات المنصة</b> في البوت نفسه.
        </p>
      </div>

      <!-- KPI Strip (Tabular Numerals) -->
      <div class="grid grid-cols-3 gap-6 border border-slate-800 bg-slate-900/50 rounded-xl px-6 py-4 shrink-0">
        <div>
          <div class="text-xs text-slate-400">إجمالي الكليات</div>
          <div id="metricTotalColleges" class="text-2xl font-bold text-white font-mono-num mt-0.5">1</div>
        </div>
        <div class="border-r border-slate-800 pr-6">
          <div class="text-xs text-slate-400">البوتات النشطة</div>
          <div id="metricActiveColleges" class="text-2xl font-bold text-emerald-400 font-mono-num mt-0.5">1</div>
        </div>
        <div class="border-r border-slate-800 pr-6">
          <div class="text-xs text-slate-400">الاشتراك الإجباري</div>
          <div id="metricCentralGate" class="text-sm font-bold text-slate-200 mt-1.5 truncate max-w-[140px]">غير مفعل</div>
        </div>
      </div>
    </section>

    <!-- Section 1: Colleges Registry & Live Management Table -->
    <section id="colleges-section" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 class="text-lg font-bold text-white">01. سجل الكليات والبوتات المستقلة</h2>
          <p class="text-xs text-slate-400 mt-0.5">كل كلية تمتلك جداول بيانات معزولة ومسار ويب هوك مستقل وخزنة مفاتيح مشفرة بـ AES-256-GCM</p>
        </div>

        <!-- Interactive Filter Controls & Search -->
        <div class="flex flex-wrap items-center gap-3">
          <input id="collegeSearchInput" type="search" placeholder="ابحث باسم الكلية أو المعرّف..."
            class="rounded-lg bg-slate-900 border border-slate-800 px-3.5 py-1.5 text-xs text-white placeholder-slate-500 focus:border-emerald-400 focus:outline-none w-56" />
          <div class="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
            <button type="button" data-filter="all" class="filter-tab-btn px-3 py-1 text-xs font-semibold rounded-md bg-slate-800 text-white whitespace-nowrap shrink-0">الكل</button>
            <button type="button" data-filter="active" class="filter-tab-btn px-3 py-1 text-xs font-semibold rounded-md text-slate-400 hover:text-white whitespace-nowrap shrink-0">نشط</button>
            <button type="button" data-filter="pending_setup" class="filter-tab-btn px-3 py-1 text-xs font-semibold rounded-md text-slate-400 hover:text-white whitespace-nowrap shrink-0">قيد الإعداد</button>
            <button type="button" data-filter="suspended" class="filter-tab-btn px-3 py-1 text-xs font-semibold rounded-md text-slate-400 hover:text-white whitespace-nowrap shrink-0">موقوف</button>
          </div>
          <button id="refreshOverviewBtn" type="button"
            class="px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-semibold border border-slate-800 transition whitespace-nowrap shrink-0">
            تحديث البيانات
          </button>
        </div>
      </div>

      <!-- High-Density Colleges Table -->
      <div class="border border-slate-800 rounded-xl overflow-hidden bg-slate-900/40">
        <div class="overflow-x-auto">
          <table class="w-full text-right text-xs">
            <thead class="bg-slate-900/90 border-b border-slate-800 text-slate-400 font-semibold">
              <tr>
                <th class="py-3 px-4">الكلية والمعرّف</th>
                <th class="py-3 px-4">الحالة</th>
                <th class="py-3 px-4">بوت تيليجرام</th>
                <th class="py-3 px-4">مدير الكلية (Telegram ID)</th>
                <th class="py-3 px-4">إعدادات داخل البوت (القناة · AI)</th>
                <th class="py-3 px-4">مسار Webhook المعزول</th>
                <th class="py-3 px-4 text-left">إجراءات المطور</th>
              </tr>
            </thead>
            <tbody id="collegesTableBody" class="divide-y divide-slate-800/70">
              <tr>
                <td colspan="7" class="py-8 text-center text-slate-500">جارٍ تحميل بيانات الكليات...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Section 2: Two-Column Split — Provision New College + Central Mandatory Channel & Default Bot Quick Bind -->
    <section id="provision-section" class="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start pt-2">
      <!-- Provision New College Bot -->
      <div class="lg:col-span-7 border border-slate-800 bg-slate-900/40 rounded-xl p-6 space-y-5">
        <div class="border-b border-slate-800 pb-4">
          <h2 class="text-lg font-bold text-white">02. إنشاء وتجهيز بوت كلية جديد</h2>
          <p class="text-xs text-slate-400 mt-1">
            يُنشئ المطور الكلية ويربط توكن البوت ويعيّن المدير من هنا، ثم يدخل مدير الكلية إلى البوت عبر <code>⚙️ إعدادات المنصة</code> لإدخال قناته ومفاتيح الذكاء الاصطناعي.
          </p>
        </div>

        <form id="createCollegeForm" class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">المعرّف الفريد للكلية (Slug بالإنجليزية)</label>
            <input id="colSlugInput" type="text" dir="ltr" required placeholder="pharmacy / dentistry / nursing"
              class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">اسم الكلية (بالعربية)</label>
            <input id="colNameInput" type="text" required placeholder="مثال: كلية الصيدلة"
              class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">معرّف مدير الكلية في تيليجرام (Manager ID)</label>
            <input id="colManagerIdInput" type="text" dir="ltr" placeholder="6155683890"
              class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">معرّف المستخدم لمدير الكلية (اختياري)</label>
            <input id="colManagerUserInput" type="text" dir="ltr" placeholder="@college_dean"
              class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
          </div>

          <div class="md:col-span-2">
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">توكن بوت الكلية المستقل (Bot Token من @BotFather)</label>
            <input id="colBotTokenInput" type="password" dir="ltr" placeholder="123456789:AAH... (يُشفّر بـ AES-256-GCM ويُربط تلقائياً بالويب هوك)"
              class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">نمط ملكية البوت (Managed Bot Mode)</label>
            <select id="colModeSelect"
              class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white focus:border-emerald-400 focus:outline-none">
              <option value="managed_bot">مملوك لمدير الكلية بتفويض تقني (Managed Bot)</option>
              <option value="platform_created">مُنشأ ومملوك بواسطة المنصة المركزية</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">قناة أرشيف أولية (اختياري — يُدخلها المدير من البوت)</label>
            <input id="colArchiveInput" type="text" dir="ltr" placeholder="@college_archive أو يُترك لمدير الكلية"
              class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
          </div>

          <div class="md:col-span-2 flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-slate-800">
            <label class="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input id="colAutoActivateInput" type="checkbox" checked class="rounded border-slate-700 bg-slate-950 text-emerald-500" />
              <span>تفعيل الكلية فوراً بعد الإنشاء</span>
            </label>
            <button type="submit"
              class="px-5 py-2.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-bold text-xs transition whitespace-nowrap shrink-0">
              إنشاء الكلية وتجهيز البوت
            </button>
          </div>
        </form>
      </div>

      <!-- Right Column: Central Mandatory Platform Channel + Default Bot Connection -->
      <div id="mandatory-channel-section" class="lg:col-span-5 space-y-6">
        <!-- Central Mandatory Subscription Gate -->
        <div class="border border-slate-800 bg-slate-900/40 rounded-xl p-6 space-y-4">
          <div class="border-b border-slate-800 pb-3">
            <h2 class="text-base font-bold text-white">03. بوابة الاشتراك الإجباري في قناة المنصة المركزية</h2>
            <p class="text-xs text-slate-400 mt-1">
              يُشترط على كل طالب في أي بوت كلية الاشتراك في قناة المطور المركزية قبل استخدام البوت.
            </p>
          </div>

          <form id="centralChannelForm" class="space-y-3.5">
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">معرّف القناة المركزية (<code>@username</code> أو <code>-100...</code>)</label>
              <input id="centralChannelIdInput" type="text" dir="ltr" placeholder="@medbot_platform أو -1001987654321"
                class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">رابط الدعوة للقناة (Invite Link)</label>
              <input id="centralChannelUrlInput" type="text" dir="ltr" placeholder="https://t.me/medbot_platform"
                class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">اسم القناة الظاهر للطلاب</label>
              <input id="centralChannelTitleInput" type="text" placeholder="القناة الرسمية لمنصة MEDBOT"
                class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
            </div>
            <div class="flex items-center justify-between gap-3 pt-2">
              <button type="button" id="disableCentralChannelBtn"
                class="px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold border border-slate-800 transition whitespace-nowrap shrink-0">
                إيقاف البوابة
              </button>
              <button type="submit"
                class="px-4 py-2 rounded-lg bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-xs font-bold transition whitespace-nowrap shrink-0">
                حفظ وتفعيل الاشتراك الإجباري
              </button>
            </div>
          </form>
        </div>

        <!-- Default College Bot & Remote Cloudflare D1 Bridge -->
        <div class="border border-slate-800 bg-slate-900/40 rounded-xl p-6 space-y-4">
          <div class="border-b border-slate-800 pb-3">
            <h2 class="text-base font-bold text-white">04. الربط من أي منصة خارجية (Cloudflare D1 Bridge & البوت الأساسي)</h2>
            <p class="text-xs text-slate-400 mt-1">
              إذا كنت تفتح هذا الموقع من منصة خارجية (مثل Cloud Run أو Render أو Hugging Face) لأن روابط Cloudflare محجوبة في منطقتك، أدخل <code>CLOUDFLARE_API_TOKEN</code> ليتحكم الموقع مباشرةً بقاعدة بيانات Cloudflare D1، أو أدخل توكن البوت الأساسي.
            </p>
          </div>

          <form id="connectBotForm" class="space-y-3">
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">مفتاح Cloudflare API للربط عن بُعد بقاعدة D1 (<code>CLOUDFLARE_API_TOKEN</code> — اختياري)</label>
              <input id="connectCfTokenInput" type="password" dir="ltr" placeholder="أدخله عند تشغيل الموقع خارج Cloudflare للتحكم بـ D1"
                class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">توكن البوت الأساسي (<code>BOT_TOKEN</code> — اختياري)</label>
              <input id="connectBotTokenInput" type="password" dir="ltr" placeholder="123456789:AAH..."
                class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">معرّف المالك في تيليجرام (<code>ADMIN_ID</code>)</label>
              <input id="connectAdminIdInput" type="text" dir="ltr" placeholder="6155683890"
                class="w-full rounded-lg bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono-num placeholder-slate-500 focus:border-emerald-400 focus:outline-none" />
            </div>
            <button type="submit" id="connectBotBtn"
              class="w-full py-2 px-4 rounded-lg bg-slate-100 hover:bg-white text-slate-950 font-bold text-xs transition whitespace-nowrap">
              حفظ الربط ومزامنة المنصة
            </button>
          </form>
        </div>
      </div>
    </section>

    <!-- Section 3: Audit Logs Table -->
    <section id="audit-section" class="space-y-4 pt-2">
      <div>
        <h2 class="text-lg font-bold text-white">05. سجل التدقيق الأمني للعمليات (Audit Trail)</h2>
        <p class="text-xs text-slate-400 mt-0.5">توثيق زمني لجميع عمليات الإنشاء، التفعيل، تعديل المدراء، وإعداد القنوات والمفاتيح دون كشف أي قيم سرية</p>
      </div>

      <div class="border border-slate-800 rounded-xl overflow-hidden bg-slate-900/40">
        <div class="overflow-x-auto max-h-80">
          <table class="w-full text-right text-xs">
            <thead class="bg-slate-900/90 border-b border-slate-800 text-slate-400 font-semibold sticky top-0">
              <tr>
                <th class="py-2.5 px-4">العملية</th>
                <th class="py-2.5 px-4">الكلية</th>
                <th class="py-2.5 px-4">المنفّذ</th>
                <th class="py-2.5 px-4">التفاصيل</th>
                <th class="py-2.5 px-4 text-left">التوقيت</th>
              </tr>
            </thead>
            <tbody id="auditTableBody" class="divide-y divide-slate-800/70">
              <tr>
                <td colspan="5" class="py-6 text-center text-slate-500">لا توجد سجلات تدقيق بعد.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <!-- College Management Modal (Edit Token, Bind Webhook, Assign Manager, Inspect Readiness) -->
  <div id="collegeManageModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/75 backdrop-blur-sm p-4">
    <div class="bg-slate-900 border border-slate-800 rounded-xl max-w-xl w-full p-6 space-y-5 max-h-[90vh] overflow-y-auto">
      <div class="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h3 id="modalCollegeTitle" class="text-base font-bold text-white">إدارة الكلية</h3>
          <p id="modalCollegeSubtitle" class="text-xs text-slate-400 font-mono-num mt-0.5" dir="ltr"></p>
        </div>
        <button id="closeManageModalBtn" type="button" class="text-xs text-slate-400 hover:text-white px-2 py-1 rounded border border-slate-800">
          إغلاق
        </button>
      </div>

      <!-- Readiness Checklist inside Modal -->
      <div class="space-y-2">
        <div class="text-xs font-bold text-slate-300">حالة جاهزية الكلية والإعدادات داخل البوت:</div>
        <div id="modalChecklist" class="space-y-1.5 text-xs text-slate-300 border border-slate-800 bg-slate-950 rounded-lg p-3.5"></div>
      </div>

      <!-- Update Bot Token & Bind Webhook -->
      <form id="modalTokenForm" class="space-y-2.5 border-t border-slate-800 pt-4">
        <label class="block text-xs font-semibold text-slate-300">تحديث توكن البوت المستقل وربط الويب هوك تلقائياً</label>
        <div class="flex gap-2">
          <input id="modalBotTokenInput" type="password" dir="ltr" required placeholder="123456789:AAH..."
            class="flex-1 rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white font-mono-num focus:border-emerald-400 focus:outline-none" />
          <button type="submit" class="px-4 py-2 rounded-lg bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-bold text-xs whitespace-nowrap shrink-0">
            حفظ التوكن وربط Webhook
          </button>
        </div>
      </form>

      <!-- Update College Manager -->
      <form id="modalManagerForm" class="space-y-2.5 border-t border-slate-800 pt-4">
        <label class="block text-xs font-semibold text-slate-300">تعيين / تغيير مدير الكلية (Telegram ID)</label>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input id="modalManagerIdInput" type="text" dir="ltr" required placeholder="Telegram ID (مثال: 6155683890)"
            class="rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white font-mono-num focus:border-emerald-400 focus:outline-none" />
          <input id="modalManagerUserInput" type="text" dir="ltr" placeholder="@username (اختياري)"
            class="rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white font-mono-num focus:border-emerald-400 focus:outline-none" />
          <button type="submit" class="px-4 py-2 rounded-lg bg-slate-100 hover:bg-white text-slate-950 font-bold text-xs whitespace-nowrap shrink-0">
            تحديث مدير الكلية
          </button>
        </div>
      </form>

      <!-- Danger / Lifecycle Actions -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
        <div class="flex items-center gap-2">
          <button id="modalBindWebhookBtn" type="button"
            class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold whitespace-nowrap">
            إعادة ربط Webhook مع تيليجرام
          </button>
          <button id="modalActivateBtn" type="button"
            class="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold whitespace-nowrap">
            تفعيل الكلية
          </button>
          <button id="modalSuspendBtn" type="button"
            class="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs font-semibold whitespace-nowrap">
            إيقاف مؤقت
          </button>
        </div>
        <button id="modalDecommissionBtn" type="button"
          class="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 text-xs font-semibold whitespace-nowrap">
          إلغاء الكلية وفصل البوت
        </button>
      </div>
    </div>
  </div>

  <footer class="border-t border-slate-800/80 py-5 px-6 text-center text-xs text-slate-500">
    MEDBOT Multi-College Management Platform · متوافق مع خطة Cloudflare المجانية (D1 + Telegram Native Storage بدون R2 أو Google Drive)
  </footer>

  <script type="module">
    let allColleges = [];
    let currentFilter = 'all';
    let currentSearch = '';
    let selectedCollege = null;

    const statusNotice = document.getElementById('statusNotice');
    const metricTotalColleges = document.getElementById('metricTotalColleges');
    const metricActiveColleges = document.getElementById('metricActiveColleges');
    const metricCentralGate = document.getElementById('metricCentralGate');
    const collegesTableBody = document.getElementById('collegesTableBody');
    const auditTableBody = document.getElementById('auditTableBody');
    const collegeSearchInput = document.getElementById('collegeSearchInput');
    const createCollegeForm = document.getElementById('createCollegeForm');
    const centralChannelForm = document.getElementById('centralChannelForm');
    const disableCentralChannelBtn = document.getElementById('disableCentralChannelBtn');
    const connectBotForm = document.getElementById('connectBotForm');
    const refreshOverviewBtn = document.getElementById('refreshOverviewBtn');

    // Modal elements
    const collegeManageModal = document.getElementById('collegeManageModal');
    const closeManageModalBtn = document.getElementById('closeManageModalBtn');
    const modalCollegeTitle = document.getElementById('modalCollegeTitle');
    const modalCollegeSubtitle = document.getElementById('modalCollegeSubtitle');
    const modalChecklist = document.getElementById('modalChecklist');
    const modalTokenForm = document.getElementById('modalTokenForm');
    const modalBotTokenInput = document.getElementById('modalBotTokenInput');
    const modalManagerForm = document.getElementById('modalManagerForm');
    const modalManagerIdInput = document.getElementById('modalManagerIdInput');
    const modalManagerUserInput = document.getElementById('modalManagerUserInput');
    const modalBindWebhookBtn = document.getElementById('modalBindWebhookBtn');
    const modalActivateBtn = document.getElementById('modalActivateBtn');
    const modalSuspendBtn = document.getElementById('modalSuspendBtn');
    const modalDecommissionBtn = document.getElementById('modalDecommissionBtn');

    function showNotice(message, kind = 'success') {
      statusNotice.className =
        'rounded-lg border px-4 py-3 text-sm font-semibold ' +
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

    function statusText(status) {
      if (status === 'active') return '<span class="text-emerald-400 font-semibold">نشط (Active)</span>';
      if (status === 'suspended') return '<span class="text-rose-400 font-semibold">موقوف (Suspended)</span>';
      if (status === 'decommissioned') return '<span class="text-slate-500 font-semibold">ملغى (Decommissioned)</span>';
      return '<span class="text-amber-300 font-semibold">قيد الإعداد (Pending)</span>';
    }

    async function loadPlatformOverview() {
      try {
        const res = await fetch('/api/platform/overview');
        const data = await res.json();
        if (!data?.ok) return;

        allColleges = data.colleges || [];
        const activeCount = allColleges.filter((c) => c.status === 'active').length;
        metricTotalColleges.textContent = String(allColleges.length);
        metricActiveColleges.textContent = String(activeCount);

        if (data.centralChannel?.enabled && data.centralChannel?.channelId) {
          metricCentralGate.textContent = 'مفعّل · ' + data.centralChannel.channelId;
          metricCentralGate.className = 'text-sm font-bold text-emerald-400 mt-1.5 truncate max-w-[160px] font-mono-num';
          document.getElementById('centralChannelIdInput').value = data.centralChannel.channelId;
          document.getElementById('centralChannelUrlInput').value = data.centralChannel.inviteLink || '';
          document.getElementById('centralChannelTitleInput').value = data.centralChannel.title || '';
        } else {
          metricCentralGate.textContent = 'غير مفعل';
          metricCentralGate.className = 'text-sm font-bold text-slate-400 mt-1.5 truncate max-w-[160px]';
        }

        renderCollegesTable();
        renderAuditTable(data.auditLogs || []);

        if (selectedCollege) {
          const refreshed = allColleges.find((c) => c.id === selectedCollege.id);
          if (refreshed) openCollegeModal(refreshed);
        }
      } catch (err) {
        console.error('Failed to load overview:', err);
      }
    }

    function renderCollegesTable() {
      const filtered = allColleges.filter((c) => {
        if (currentFilter !== 'all' && c.status !== currentFilter) return false;
        if (currentSearch) {
          const q = currentSearch.toLowerCase();
          const matchName = String(c.name || '').toLowerCase().includes(q);
          const matchSlug = String(c.slug || '').toLowerCase().includes(q);
          const matchBot = String(c.botUsername || '').toLowerCase().includes(q);
          if (!matchName && !matchSlug && !matchBot) return false;
        }
        return true;
      });

      if (!filtered.length) {
        collegesTableBody.innerHTML =
          '<tr><td colspan="7" class="py-8 text-center text-slate-500">لا توجد كليات مطابقة لمعايير البحث أو التصفية.</td></tr>';
        return;
      }

      collegesTableBody.innerHTML = filtered
        .map((c) => {
          const botLabel = c.botUsername
            ? '@' + escapeHtml(c.botUsername)
            : c.hasBotToken
              ? escapeHtml(c.botTokenMasked || 'مربوط ومشفر')
              : 'غير مربوط بعد';
          const managerLabel = c.managerId
            ? escapeHtml(c.managerId) + (c.managerUsername ? ' · @' + escapeHtml(c.managerUsername) : '')
            : 'غير معيّن';
          const channelPart = c.archiveChannelId
            ? 'القناة: ' + escapeHtml(c.archiveChannelId)
            : 'القناة: بانتظار المدير';
          const aiPart = c.secrets?.length
            ? 'AI: ' + escapeHtml(c.secrets.map((s) => s.name.replace('_API_KEY', '')).join('/'))
            : c.hasAiKey
              ? 'AI: مفعل'
              : 'AI: بانتظار المدير';

          return \`
            <tr class="hover:bg-slate-900/70 transition-colors">
              <td class="py-3.5 px-4">
                <div class="font-bold text-white">\${escapeHtml(c.name)}</div>
                <div class="text-[11px] text-slate-400 font-mono-num" dir="ltr">\${escapeHtml(c.slug)} · \${escapeHtml(c.dbBinding)}</div>
              </td>
              <td class="py-3.5 px-4 whitespace-nowrap">\${statusText(c.status)}</td>
              <td class="py-3.5 px-4 font-mono-num text-slate-200 whitespace-nowrap" dir="ltr">\${botLabel}</td>
              <td class="py-3.5 px-4 font-mono-num text-slate-300 whitespace-nowrap" dir="ltr">\${managerLabel}</td>
              <td class="py-3.5 px-4 text-slate-300 whitespace-nowrap">
                <span>\${channelPart}</span>
                <span class="mx-1.5 text-slate-600">·</span>
                <span>\${aiPart}</span>
              </td>
              <td class="py-3.5 px-4 font-mono-num text-emerald-400 whitespace-nowrap" dir="ltr">\${escapeHtml(c.webhookPath)}</td>
              <td class="py-3.5 px-4 text-left whitespace-nowrap">
                <button type="button" data-manage-id="\${escapeHtml(c.id)}"
                  class="manage-col-btn px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs border border-slate-700 transition">
                  إدارة البوت والكلية
                </button>
              </td>
            </tr>
          \`;
        })
        .join('');

      document.querySelectorAll('.manage-col-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-manage-id');
          const found = allColleges.find((c) => c.id === id);
          if (found) openCollegeModal(found);
        });
      });
    }

    function openCollegeModal(college) {
      selectedCollege = college;
      modalCollegeTitle.textContent = college.name;
      modalCollegeSubtitle.textContent = \`slug: \${college.slug} · webhook: \${college.webhookPath}\`;
      modalManagerIdInput.value = college.managerId || '';
      modalManagerUserInput.value = college.managerUsername ? '@' + college.managerUsername : '';
      modalBotTokenInput.value = '';

      modalDecommissionBtn.style.display = college.isDefault ? 'none' : 'inline-block';
      modalSuspendBtn.style.display = college.isDefault ? 'none' : 'inline-block';

      const checks = college.checks || [];
      modalChecklist.innerHTML =
        checks
          .map(
            (chk) => \`
            <div class="flex items-center justify-between gap-3 py-1 border-b border-slate-900 last:border-0">
              <span class="text-slate-300">\${escapeHtml(chk.label)}</span>
              <span class="font-mono-num \${chk.ok ? 'text-emerald-400' : 'text-amber-300'}" dir="ltr">\${chk.ok ? 'مكتمل' : 'ناقص'} · \${escapeHtml(chk.detail)}</span>
            </div>
          \`,
          )
          .join('') +
        '<div class="pt-2 text-[11px] text-slate-400">ملاحظة: يستطيع مدير الكلية إدخال أو تعديل قناة الأرشيف ومفاتيح الذكاء الاصطناعي مباشرةً من داخل البوت عبر قائمة (⚙️ إعدادات المنصة).</div>';

      collegeManageModal.classList.remove('hidden');
      collegeManageModal.classList.add('flex');
    }

    closeManageModalBtn.addEventListener('click', () => {
      selectedCollege = null;
      collegeManageModal.classList.add('hidden');
      collegeManageModal.classList.remove('flex');
    });

    async function callCollegeAction(collegeId, action, payload = {}) {
      const res = await fetch('/api/platform/colleges/' + encodeURIComponent(collegeId) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'تعذر تنفيذ العملية');
      }
      return data;
    }

    modalTokenForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selectedCollege) return;
      try {
        await callCollegeAction(selectedCollege.id, 'set_token', {
          botToken: modalBotTokenInput.value.trim(),
        });
        showNotice('تم تشفير وحفظ توكن البوت وربط Webhook للكلية: ' + selectedCollege.name);
        modalBotTokenInput.value = '';
        await loadPlatformOverview();
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    modalManagerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selectedCollege) return;
      try {
        await callCollegeAction(selectedCollege.id, 'set_manager', {
          managerId: modalManagerIdInput.value.trim(),
          managerUsername: modalManagerUserInput.value.trim(),
        });
        showNotice('تم تحديث مدير الكلية ومنحه صلاحية المالك في قاعدة بيانات الكلية.');
        await loadPlatformOverview();
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    modalBindWebhookBtn.addEventListener('click', async () => {
      if (!selectedCollege) return;
      try {
        const res = await callCollegeAction(selectedCollege.id, 'bind_webhook');
        showNotice('تم ربط الويب هوك مع تيليجرام بنجاح: ' + (res.webhookUrl || ''));
        await loadPlatformOverview();
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    modalActivateBtn.addEventListener('click', async () => {
      if (!selectedCollege) return;
      try {
        await callCollegeAction(selectedCollege.id, 'activate', { force: true });
        showNotice('تم تفعيل الكلية بنجاح: ' + selectedCollege.name);
        await loadPlatformOverview();
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    modalSuspendBtn.addEventListener('click', async () => {
      if (!selectedCollege) return;
      try {
        await callCollegeAction(selectedCollege.id, 'suspend', {
          reason: 'إيقاف مؤقت من بوابة المطور المركزية',
        });
        showNotice('تم إيقاف بوت الكلية مؤقتاً.');
        await loadPlatformOverview();
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    modalDecommissionBtn.addEventListener('click', async () => {
      if (!selectedCollege) return;
      try {
        await callCollegeAction(selectedCollege.id, 'decommission');
        showNotice('تم إلغاء الكلية وفصل الويب هوك.');
        closeManageModalBtn.click();
        await loadPlatformOverview();
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    function renderAuditTable(logs) {
      if (!logs.length) {
        auditTableBody.innerHTML =
          '<tr><td colspan="5" class="py-6 text-center text-slate-500">لا توجد سجلات تدقيق بعد.</td></tr>';
        return;
      }
      auditTableBody.innerHTML = logs
        .map(
          (log) => \`
          <tr class="hover:bg-slate-900/60">
            <td class="py-2.5 px-4 font-mono-num text-emerald-400" dir="ltr">\${escapeHtml(log.action)}</td>
            <td class="py-2.5 px-4 font-mono-num text-slate-200" dir="ltr">\${escapeHtml(log.collegeId || 'platform')}</td>
            <td class="py-2.5 px-4 text-slate-400">\${escapeHtml(log.actorRole || 'platform_owner')}</td>
            <td class="py-2.5 px-4 font-mono-num text-slate-400 truncate max-w-xs" dir="ltr">\${escapeHtml(log.details || '—')}</td>
            <td class="py-2.5 px-4 text-left font-mono-num text-slate-500 whitespace-nowrap" dir="ltr">\${escapeHtml(log.createdAt || '')}</td>
          </tr>
        \`,
        )
        .join('');
    }

    document.querySelectorAll('.filter-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentFilter = btn.getAttribute('data-filter') || 'all';
        document.querySelectorAll('.filter-tab-btn').forEach((b) => {
          b.className = 'filter-tab-btn px-3 py-1 text-xs font-semibold rounded-md text-slate-400 hover:text-white whitespace-nowrap shrink-0';
        });
        btn.className = 'filter-tab-btn px-3 py-1 text-xs font-semibold rounded-md bg-slate-800 text-white whitespace-nowrap shrink-0';
        renderCollegesTable();
      });
    });

    collegeSearchInput.addEventListener('input', () => {
      currentSearch = collegeSearchInput.value.trim();
      renderCollegesTable();
    });

    createCollegeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const payload = {
          slug: document.getElementById('colSlugInput').value.trim(),
          name: document.getElementById('colNameInput').value.trim(),
          managerId: document.getElementById('colManagerIdInput').value.trim() || null,
          managerUsername: document.getElementById('colManagerUserInput').value.trim() || null,
          botToken: document.getElementById('colBotTokenInput').value.trim() || null,
          managedBotMode: document.getElementById('colModeSelect').value,
          archiveChannelId: document.getElementById('colArchiveInput').value.trim() || null,
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
        showNotice('تم إنشاء الكلية وتجهيز جداولها المعزولة بنجاح: ' + (data.college?.name_ar || payload.name));
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
            title: document.getElementById('centralChannelTitleInput').value.trim() || 'القناة الرسمية لمنصة MEDBOT',
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showNotice(data.error || 'تعذر حفظ القناة المركزية', 'error');
          return;
        }
        showNotice('تم تفعيل وحفظ بوابة الاشتراك الإجباري في القناة المركزية لجميع الكليات.');
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
        showNotice('تم إيقاف الاشتراك الإجباري المركزي.');
        await loadPlatformOverview();
      } catch (err) {
        showNotice('خطأ: ' + err.message, 'error');
      }
    });

    connectBotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cloudflareApiToken = document.getElementById('connectCfTokenInput').value.trim();
      const botToken = document.getElementById('connectBotTokenInput').value.trim();
      const adminId = document.getElementById('connectAdminIdInput').value.trim();
      if (!cloudflareApiToken && !botToken) {
        showNotice('يرجى إدخال CLOUDFLARE_API_TOKEN أو BOT_TOKEN أولاً.', 'error');
        return;
      }
      const btn = document.getElementById('connectBotBtn');
      btn.disabled = true;
      btn.textContent = 'جارٍ حفظ الربط ومزامنة المنصة...';
      try {
        const res = await fetch('/api/platform/connect-bot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cloudflareApiToken, botToken, adminId, startPolling: true }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showNotice(data.error || 'تعذر حفظ الربط', 'error');
        } else {
          const msgParts = [];
          if (data.cloudflareBridge?.connected) {
            msgParts.push('تم ربط الموقع مباشرةً بقاعدة بيانات Cloudflare D1 (' + data.cloudflareBridge.databaseName + ')');
          }
          if (data.bot?.username) {
            msgParts.push('تم تحديث البوت الأساسي @' + data.bot.username);
          }
          showNotice(msgParts.join(' · ') || 'تم حفظ إعدادات الربط بنجاح.');
          document.getElementById('connectCfTokenInput').value = '';
          document.getElementById('connectBotTokenInput').value = '';
          await loadPlatformOverview();
        }
      } catch (err) {
        showNotice('حدث خطأ أثناء حفظ الربط: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'حفظ الربط ومزامنة المنصة';
      }
    });

    refreshOverviewBtn.addEventListener('click', () => loadPlatformOverview());
    loadPlatformOverview();
  </script>
</body>
</html>`;
}
