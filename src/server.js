/* global Request, Headers */
/**
 * Container healthcheck HTTP server & Multi-College Bot Management Platform Control Plane.
 *
 * Can run on ANY hosting platform (Google Cloud Run / AI Studio, Render,
 * Hugging Face Spaces, Railway, VPS) even in regions where `*.workers.dev` is
 * blocked by local ISPs:
 *   - When `CLOUDFLARE_API_TOKEN` is configured (via environment variables or the
 *     Web Portal), `src/server.js` bridges directly to the remote Cloudflare D1
 *     database over HTTPS (`api.cloudflare.com`) and binds Telegram webhooks to
 *     the Cloudflare Worker URL (`https://medbot-js.<subdomain>.workers.dev`).
 *   - Otherwise, it uses a persistent local SQLite database (`node:sqlite`).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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
let activeCloudflareBridgeInfo = null;

/**
 * Create a local SQLite-backed D1 adapter (uses persistent file when `MEDBOT_CONTROL_DB_PATH` is set,
 * or `:memory:` during ephemeral test runs).
 */
function createNodeSqliteD1() {
  const dbPath = String(process.env.MEDBOT_CONTROL_DB_PATH || '').trim() || ':memory:';
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const sqlite = new DatabaseSync(dbPath);
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

/**
 * Create a Remote Cloudflare D1 adapter over the official Cloudflare REST API.
 * Allows the Web Portal to run on ANY external platform (Google Cloud Run, Render,
 * Hugging Face Spaces, Railway) when `*.workers.dev` is blocked in the user's region,
 * while reading/writing directly to the production Cloudflare D1 database!
 */
export function createCloudflareRemoteD1({ apiToken, accountId, databaseId }) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  async function executeQuery(sql, params = []) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sql,
        params: params.map((p) => (p === undefined ? null : p)),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      const msg = data?.errors?.[0]?.message || `Cloudflare D1 HTTP ${res.status}`;
      throw new Error(msg);
    }
    const firstResult = Array.isArray(data.result) ? data.result[0] : data.result;
    return {
      results: Array.isArray(firstResult?.results) ? firstResult.results : [],
      meta: firstResult?.meta || { changes: 0, last_row_id: 0 },
    };
  }

  function createPrepared(sql, boundParams = []) {
    return {
      bind(...params) {
        return createPrepared(sql, params.map((p) => (p === undefined ? null : p)));
      },
      async raw() {
        const { results } = await executeQuery(sql, boundParams);
        return results.map((row) => Object.values(row));
      },
      async all() {
        const { results } = await executeQuery(sql, boundParams);
        return { results };
      },
      async first(colName) {
        const { results } = await executeQuery(sql, boundParams);
        const row = results[0] ?? null;
        if (!row) return null;
        return colName ? (row[colName] ?? null) : row;
      },
      async run() {
        const { meta } = await executeQuery(sql, boundParams);
        return {
          success: true,
          meta: {
            changes: Number(meta.changes ?? 0),
            last_row_id: Number(meta.last_row_id ?? 0),
          },
        };
      },
    };
  }

  return {
    __isRemoteCloudflareD1: true,
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
      await executeQuery(sql, []);
      return { count: 1, duration: 0 };
    },
  };
}

/**
 * Auto-discover Cloudflare Account ID, D1 Database UUID (`medbot`), and Worker Subdomain
 * using just a `CLOUDFLARE_API_TOKEN`.
 */
async function discoverCloudflareD1Bridge({
  apiToken,
  accountId: rawAccountId = '',
  databaseId: rawDatabaseId = '',
  workerUrl: rawWorkerUrl = '',
}) {
  const token = String(apiToken || '').trim();
  if (!token) throw new Error('يرجى إدخال CLOUDFLARE_API_TOKEN.');

  const cfFetch = async (ep) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${ep}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return r.json().catch(() => ({ success: false }));
  };

  let accountId = (String(rawAccountId || '').match(/([a-f0-9]{32})/i) || [])[1] || '';
  if (!accountId) {
    const accData = await cfFetch('/accounts?per_page=10');
    if (accData?.success && Array.isArray(accData.result) && accData.result[0]?.id) {
      accountId = accData.result[0].id;
    }
  }
  if (!accountId) {
    throw new Error('تعذّر اكتشاف Cloudflare Account ID من هذا التوكن. تأكد من صلاحيات التوكن.');
  }

  let databaseId =
    (String(rawDatabaseId || '').match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    ) || [])[1] || '';
  let databaseName = 'medbot';
  if (!databaseId) {
    const d1List = await cfFetch(`/accounts/${accountId}/d1/database`);
    if (d1List?.success && Array.isArray(d1List.result) && d1List.result.length > 0) {
      const found = d1List.result.find((d) => d.name === 'medbot') || d1List.result[0];
      databaseId = found.uuid;
      databaseName = found.name || 'medbot';
    }
  }
  if (!databaseId) {
    throw new Error('لم يتم العثور على قاعدة بيانات D1 في حساب Cloudflare هذا.');
  }

  let workerUrl = String(rawWorkerUrl || process.env.CLOUDFLARE_WORKER_URL || '').trim();
  if (!workerUrl) {
    const subData = await cfFetch(`/accounts/${accountId}/workers/subdomain`);
    if (subData?.success && subData.result?.subdomain) {
      workerUrl = `https://medbot-js.${subData.result.subdomain}.workers.dev`;
    }
  }

  const remoteD1 = createCloudflareRemoteD1({ apiToken: token, accountId, databaseId });
  await ensurePlatformSchema(remoteD1);
  await ensureDefaultCollegeRegistered(remoteD1, process.env);

  sharedControlD1 = remoteD1;
  sharedInitPromise = Promise.resolve();
  if (workerUrl) {
    process.env.CLOUDFLARE_WORKER_URL = workerUrl;
  }
  activeCloudflareBridgeInfo = {
    connected: true,
    accountId,
    databaseId,
    databaseName,
    workerUrl: workerUrl || null,
  };
  return activeCloudflareBridgeInfo;
}

async function getControlD1() {
  if (!sharedControlD1) {
    const envToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
    if (envToken) {
      try {
        await discoverCloudflareD1Bridge({
          apiToken: envToken,
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          databaseId: process.env.CF_D1_DATABASE_ID,
          workerUrl: process.env.CLOUDFLARE_WORKER_URL,
        });
        return sharedControlD1;
      } catch (err) {
        console.warn('[MEDBOT] Falling back to local SQLite Control Plane:', err?.message || err);
      }
    }
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
  if (body.cloudflareApiToken) {
    const bridge = await discoverCloudflareD1Bridge({
      apiToken: body.cloudflareApiToken,
      accountId: body.cloudflareAccountId,
      databaseId: body.cloudflareDatabaseId,
      workerUrl: body.cloudflareWorkerUrl,
    });
    return {
      ok: true,
      cloudflareBridge: bridge,
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

  return { ok: true, bot: activeRuntimeBotInfo, cloudflareBridge: activeCloudflareBridgeInfo };
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
