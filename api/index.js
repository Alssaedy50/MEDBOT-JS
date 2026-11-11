/* global Request, Response, Headers */
/**
 * Universal Vercel & Serverless Entrypoint (`/api/index.js`).
 *
 * Supports ALL Vercel runtime invocation contracts seamlessly:
 *   1. Raw Node.js `(req, res)` (`http.IncomingMessage` + `http.ServerResponse` without `.status()`)
 *   2. Enhanced `@vercel/node` `(req, res)` (`res.status().send()`)
 *   3. Web Standard / WinterCG `fetch(request)` (`res === undefined`, returns `new Response(...)`)
 *   4. Named HTTP method exports (`GET`, `POST`, `PUT`, `DELETE`, `fetch`)
 *   5. Rewritten Vercel paths (`/`, `/dashboard`, `/api`, `/api/index`, `/api/index.js`)
 *
 * Zero `node:sqlite` or native C++ imports so it runs on Node 18, 20, 22, and Edge.
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

function getHeader(req, name) {
  const lower = name.toLowerCase();
  if (!req || !req.headers) return '';
  if (typeof req.headers.get === 'function') {
    return String(req.headers.get(name) || req.headers.get(lower) || '');
  }
  const val = req.headers[lower] ?? req.headers[name];
  if (Array.isArray(val)) return val.join(', ');
  return typeof val === 'string' ? val : '';
}

function resolveFullUrlAndPath(req) {
  const rawUrl = String(req?.url || '/');
  if (/^https?:\/\//i.test(rawUrl)) {
    const parsed = new URL(rawUrl);
    return { fullUrl: parsed.toString(), pathname: parsed.pathname };
  }
  const proto = getHeader(req, 'x-forwarded-proto') || 'https';
  const host = getHeader(req, 'x-forwarded-host') || getHeader(req, 'host') || 'localhost';
  const pathWithQuery = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
  const fullUrl = `${proto}://${host}${pathWithQuery}`;
  const pathname = pathWithQuery.split('?')[0];
  return { fullUrl, pathname };
}

function sendUniversalResponse(res, statusCode, headersObj, bodyText) {
  const webResponse = new Response(bodyText, {
    status: statusCode,
    headers: headersObj,
  });

  if (!res || (typeof res.end !== 'function' && typeof res.send !== 'function')) {
    return webResponse;
  }

  for (const [k, v] of Object.entries(headersObj || {})) {
    if (typeof res.setHeader === 'function') {
      res.setHeader(k, v);
    }
  }

  if (typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(statusCode).send(bodyText);
    return webResponse;
  }

  res.statusCode = statusCode;
  if (typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(statusCode, headersObj);
  }
  if (typeof res.end === 'function') {
    res.end(bodyText);
  }
  return webResponse;
}

export async function handler(req, res) {
  try {
    const method = String(req?.method || 'GET').toUpperCase();
    const { fullUrl, pathname } = resolveFullUrlAndPath(req);
    const accept = getHeader(req, 'accept');

    const isPortalRoute =
      pathname === '/dashboard' ||
      pathname === '/api/index.js' ||
      pathname === '/api/index' ||
      (pathname === '/' && (accept.includes('text/html') || accept.includes('*/*') || !accept));

    if (method === 'GET' && isPortalRoute) {
      return sendUniversalResponse(
        res,
        200,
        {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        renderPlatformWebPortalHtml(),
      );
    }

    const { db, workerUrl } = await resolveVercelD1();

    const headers = new Headers();
    if (req?.headers) {
      if (typeof req.headers.forEach === 'function') {
        req.headers.forEach((v, k) => headers.set(k, v));
      } else {
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) headers.set(k, v.join(', '));
          else if (typeof v === 'string') headers.set(k, v);
        }
      }
    }

    let rawBody;
    if (!['GET', 'HEAD'].includes(method)) {
      if (req?.body !== undefined && req?.body !== null && !(req instanceof Request)) {
        if (typeof req.body === 'string') {
          rawBody = req.body;
        } else if (Buffer.isBuffer(req.body)) {
          rawBody = req.body.toString('utf8');
        } else if (typeof req.body === 'object') {
          rawBody = JSON.stringify(req.body);
        }
      } else if (typeof req?.text === 'function') {
        rawBody = await req.text();
      } else if (req && typeof req[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        if (chunks.length > 0) {
          rawBody = Buffer.concat(chunks).toString('utf8');
        }
      }
    }

    const webReq = new Request(fullUrl, {
      method,
      headers,
      body: rawBody,
    });

    const parsedOrigin = new URL(fullUrl).origin;
    const env = {
      ...process.env,
      DB: db,
      PLATFORM_DB: db,
      CLOUDFLARE_WORKER_URL: workerUrl || process.env.CLOUDFLARE_WORKER_URL || parsedOrigin,
    };

    const webRes = pathname.startsWith('/api/platform/')
      ? await handlePlatformWebApi(webReq, env, {
          onConnectRuntimeBot: (body, activeDb, baseUrl) =>
            connectVercelRuntimeHandler(body, activeDb, baseUrl),
        })
      : await worker.fetch(webReq, env);

    const outHeaders = {};
    webRes.headers.forEach((val, key) => {
      outHeaders[key] = val;
    });
    const text = await webRes.text();
    return sendUniversalResponse(res, webRes.status, outHeaders, text);
  } catch (err) {
    return sendUniversalResponse(
      res,
      500,
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      JSON.stringify({ ok: false, error: err?.message || 'Vercel handler error' }),
    );
  }
}

handler.fetch = handler;

export default handler;
export {
  handler as fetch,
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as DELETE,
  handler as OPTIONS,
};
