/* global Request, Headers */
/**
 * Container healthcheck HTTP server & Multi-College Bot Management Platform Control Plane.
 *
 * Serves three roles:
 *   1. Container health probes (`GET /health` -> 200 JSON, `GET /` for non-HTML
 *      probes -> 200 `HEALTH_TEXT`) without ever exposing secrets.
 *   2. External Web Developer Control Plane (`GET /` with `Accept: text/html`
 *      or `GET /dashboard` and `/api/platform/*`) for creating and managing
 *      isolated college bots outside Telegram.
 *   3. Webhook gateway forwarding (`/telegram/webhook`, `/telegram/webhook/:collegeId`,
 *      `/platform/webhook`, `/platform/status`) to the unified multi-college worker.
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';
import { runBot } from './telegram/bot.js';
import { getD1SchemaSql } from './db/d1/migrations.js';
import { normalizeChannelValue, validateChannelValue } from './archive.js';
import { dualUploadMediaMessage } from './storage/googleDrive.js';
import {
  ensureDefaultCollegeRegistered,
  ensurePlatformSchema,
  handlePlatformWebApi,
  renderPlatformWebPortalHtml,
  setCollegeBotToken,
  updateCollegeManager,
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function connectRuntimeBotHandler(body, platformDb, webhookBaseUrl) {
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
  if (adminId && /^\d+$/.test(adminId)) {
    process.env.ADMIN_ID = adminId;
    process.env.PLATFORM_OWNER_ID = adminId;
    await updateCollegeManager(platformDb, process.env, 'default', Number(adminId), null, 1).catch(
      () => {},
    );
  }
  if (archiveChannel) {
    const normalized = normalizeChannelValue(archiveChannel);
    if (validateChannelValue(normalized).valid) {
      process.env.MEDBOT_ARCHIVE_CHANNEL = normalized;
    }
  }

  await setCollegeBotToken(platformDb, process.env, 'default', botToken, 1, {
    webhookBaseUrl,
  }).catch(() => {});

  // Register college bot commands (without /platform, keeping /setup inside the bot)
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

  const whRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`)
    .then((r) => r.json())
    .catch(() => null);
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

  return { ok: true, bot: activeRuntimeBotInfo };
}

async function toWebRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);
  const host = request.headers?.host || 'localhost:3000';
  const fullUrl = `http://${host}${request.url || '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(request.headers || {})) {
    if (Array.isArray(v)) {
      headers.set(k, v.join(', '));
    } else if (typeof v === 'string') {
      headers.set(k, v);
    }
  }

  return new Request(fullUrl, {
    method: request.method || 'GET',
    headers,
    body: ['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase())
      ? undefined
      : rawBody,
  });
}

async function sendWebResponse(response, webRes) {
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

    if (pathname.startsWith('/api/platform/')) {
      (async () => {
        const db = await getControlD1();
        const webReq = await toWebRequest(request);
        const env = { ...process.env, DB: db };
        const webRes = await handlePlatformWebApi(webReq, env, {
          onConnectRuntimeBot: connectRuntimeBotHandler,
        });
        await sendWebResponse(response, webRes);
      })().catch((err) => {
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
      (async () => {
        const db = await getControlD1();
        const webReq = await toWebRequest(request);
        const env = { ...process.env, DB: db };
        const webRes = await worker.fetch(webReq, env);
        await sendWebResponse(response, webRes);
      })().catch((err) => {
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
      response.end(renderPlatformWebPortalHtml());
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
