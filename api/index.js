/* global Request, Headers */
/**
 * Vercel Serverless Entrypoint (`/api/index.js`).
 *
 * Zero `node:sqlite` or native C++ dependencies so it runs cleanly on
 * Vercel's Serverless Node runtime (Node 18 / 20 / 22) without
 * `500 FUNCTION_INVOCATION_FAILED`.
 *
 * Capabilities on Vercel (Free Hobby Tier):
 *   1. Connects automatically to Cloudflare D1 via `CLOUDFLARE_API_TOKEN`
 *      (or via Section 04 of the Web Portal UI) and falls back to a pure-JS
 *      in-memory store before `CLOUDFLARE_API_TOKEN` is configured.
 *   2. Serves the Developer Web Portal on `/` and `/dashboard`.
 *   3. Serves `/api/platform/*` for creating & managing college bots.
 *   4. Serves `/telegram/webhook` and `/telegram/webhook/:collegeId` so bots
 *      can also run directly on Vercel if desired.
 */

import worker from '../src/worker.js';
import {
  createPureJsMemoryD1,
  discoverCloudflareD1Bridge,
  ensureDefaultCollegeRegistered,
  ensurePlatformSchema,
  handlePlatformWebApi,
  renderPlatformWebPortalHtml,
  setCollegeBotToken,
  updateCollegeManager,
} from '../src/platform/index.js';

function normalizeArchiveChannelInput(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, '@');
  return s;
}

let cachedRemoteD1 = null;
let cachedFallbackD1 = null;
let cachedBridgeInfo = null;

async function resolveVercelD1() {
  if (cachedRemoteD1) {
    return {
      db: cachedRemoteD1,
      workerUrl: cachedBridgeInfo?.workerUrl || process.env.CLOUDFLARE_WORKER_URL || null,
      bridgeInfo: cachedBridgeInfo,
    };
  }

  const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (token) {
    try {
      const { db, info } = await discoverCloudflareD1Bridge({
        apiToken: token,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: process.env.CF_D1_DATABASE_ID,
        workerUrl: process.env.CLOUDFLARE_WORKER_URL,
      });
      await ensurePlatformSchema(db);
      await ensureDefaultCollegeRegistered(db, process.env);
      cachedRemoteD1 = db;
      cachedBridgeInfo = info;
      if (info.workerUrl) {
        process.env.CLOUDFLARE_WORKER_URL = info.workerUrl;
      }
      return {
        db: cachedRemoteD1,
        workerUrl: info.workerUrl,
        bridgeInfo: cachedBridgeInfo,
      };
    } catch (err) {
      console.warn('[MEDBOT Vercel] Cloudflare D1 auto-discovery warning:', err?.message || err);
    }
  }

  if (!cachedFallbackD1) {
    cachedFallbackD1 = createPureJsMemoryD1();
    await ensurePlatformSchema(cachedFallbackD1);
    await ensureDefaultCollegeRegistered(cachedFallbackD1, process.env);
  }
  return {
    db: cachedFallbackD1,
    workerUrl: process.env.CLOUDFLARE_WORKER_URL || null,
    bridgeInfo: null,
  };
}

async function connectVercelRuntimeHandler(body, platformDb, webhookBaseUrl) {
  if (body.cloudflareApiToken) {
    const { db, info } = await discoverCloudflareD1Bridge({
      apiToken: body.cloudflareApiToken,
      accountId: body.cloudflareAccountId,
      databaseId: body.cloudflareDatabaseId,
      workerUrl: body.cloudflareWorkerUrl,
    });
    await ensurePlatformSchema(db);
    await ensureDefaultCollegeRegistered(db, process.env);
    cachedRemoteD1 = db;
    cachedBridgeInfo = info;
    process.env.CLOUDFLARE_API_TOKEN = String(body.cloudflareApiToken).trim();
    if (info.workerUrl) {
      process.env.CLOUDFLARE_WORKER_URL = info.workerUrl;
    }
    return {
      ok: true,
      cloudflareBridge: info,
    };
  }

  const botToken = String(body.botToken || '').trim();
  const adminId = String(body.adminId || '').trim();
  const archiveChannel = String(body.archiveChannel || '').trim();
  if (!botToken || !/^\d{6,14}:[A-Za-z0-9_-]{30,64}$/.test(botToken)) {
    return {
      ok: false,
      error: 'صيغة توكن البوت غير صالحة. يجب أن تكون على الشكل 123456789:AAH...',
    };
  }

  const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const meJson = await meRes.json().catch(() => null);
  if (!meRes.ok || !meJson?.ok) {
    return {
      ok: false,
      error: meJson?.description || 'رفض تيليجرام هذا التوكن (Unauthorized).',
    };
  }

  process.env.BOT_TOKEN = botToken;
  process.env.TELEGRAM_BOT_TOKEN = botToken;
  const activeDb = cachedRemoteD1 || platformDb;
  if (adminId && /^\d+$/.test(adminId)) {
    process.env.ADMIN_ID = adminId;
    process.env.PLATFORM_OWNER_ID = adminId;
    await updateCollegeManager(activeDb, process.env, 'default', Number(adminId), null, 1).catch(
      () => {},
    );
  }
  if (archiveChannel) {
    const normalized = normalizeArchiveChannelInput(archiveChannel);
    if (/^(-100\d{5,}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(normalized)) {
      process.env.MEDBOT_ARCHIVE_CHANNEL = normalized;
    }
  }

  const updatedCollege = await setCollegeBotToken(activeDb, process.env, 'default', botToken, 1, {
    webhookBaseUrl,
  });

  await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start', description: '🏠 القائمة الرئيسية للمنصة' },
        { command: 'setup', description: '⚙️ إعدادات البوت والقناة ومفاتيح الذكاء الاصطناعي' },
        { command: 'admin', description: '🛠 لوحة إدارة الكلية والمحتوى' },
        { command: 'search', description: '🔎 البحث الذكي في المقررات والمراجع' },
        { command: 'ask', description: '🤖 المساعد الطبي الذكي' },
        { command: 'contribute', description: '📤 إرسال مساهمة طلابية' },
      ],
    }),
  }).catch(() => null);

  return {
    ok: true,
    bot: {
      id: meJson.result.id,
      username: meJson.result.username,
      firstName: meJson.result.first_name,
      mode: 'webhook',
      webhookUrl: updatedCollege?.webhookUrl || `${webhookBaseUrl}/telegram/webhook/default`,
    },
    cloudflareBridge: cachedBridgeInfo,
  };
}

export default async function handler(req, res) {
  try {
    const pathname = String(req.url || '/').split('?')[0];
    const accept = String(req.headers?.accept || '');

    if (
      req.method === 'GET' &&
      (pathname === '/dashboard' || (pathname === '/' && accept.includes('text/html')))
    ) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(renderPlatformWebPortalHtml());
      return;
    }

    const { db, workerUrl } = await resolveVercelD1();
    const protocol = req.headers?.['x-forwarded-proto'] || 'https';
    const host = req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost';
    const fullUrl = `${protocol}://${host}${req.url || '/'}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (Array.isArray(v)) headers.set(k, v.join(', '));
      else if (typeof v === 'string') headers.set(k, v);
    }

    let rawBody;
    if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
      if (typeof req.body === 'string') {
        rawBody = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        rawBody = req.body.toString('utf8');
      } else if (req.body && typeof req.body === 'object') {
        rawBody = JSON.stringify(req.body);
      }
    }

    const webReq = new Request(fullUrl, {
      method: req.method || 'GET',
      headers,
      body: rawBody,
    });

    const env = {
      ...process.env,
      DB: db,
      PLATFORM_DB: db,
      CLOUDFLARE_WORKER_URL:
        workerUrl || process.env.CLOUDFLARE_WORKER_URL || `${protocol}://${host}`,
    };

    const webRes = pathname.startsWith('/api/platform/')
      ? await handlePlatformWebApi(webReq, env, {
          onConnectRuntimeBot: (body, activeDb, baseUrl) =>
            connectVercelRuntimeHandler(body, activeDb, baseUrl),
        })
      : await worker.fetch(webReq, env);

    // If connect-bot just connected Cloudflare D1, ensure subsequent calls use cachedRemoteD1
    webRes.headers.forEach((val, key) => {
      res.setHeader(key, val);
    });
    const text = await webRes.text();
    res.status(webRes.status).send(text);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Vercel handler error' });
  }
}
