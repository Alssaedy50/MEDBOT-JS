/* global Request, Headers */
/**
 * Vercel Serverless Entrypoint (`/api/index.js`).
 *
 * Allows deploying the MEDBOT Web Developer Portal AND/OR the Multi-College
 * Telegram Bot Webhooks directly on Vercel (Free Hobby Tier):
 *   - Connects automatically to Cloudflare D1 via `CLOUDFLARE_API_TOKEN`
 *     (or falls back to in-memory SQLite for preview testing).
 *   - Serves the Developer Web Portal on `/` and `/dashboard`.
 *   - Serves `/api/platform/*` for creating & managing college bots.
 *   - Serves `/telegram/webhook` and `/telegram/webhook/:collegeId` so bots
 *     can also run directly on Vercel if desired.
 */

import worker from '../src/worker.js';
import { createCloudflareRemoteD1 } from '../src/server.js';
import {
  ensureDefaultCollegeRegistered,
  ensurePlatformSchema,
  handlePlatformWebApi,
  renderPlatformWebPortalHtml,
} from '../src/platform/index.js';

let cachedRemoteD1 = null;
let cachedWorkerUrl = null;

async function resolveVercelD1() {
  if (cachedRemoteD1) return { db: cachedRemoteD1, workerUrl: cachedWorkerUrl };

  const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!token) return { db: null, workerUrl: null };

  const cfFetch = async (ep) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${ep}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return r.json().catch(() => ({ success: false }));
  };

  let accountId = (String(process.env.CLOUDFLARE_ACCOUNT_ID || '').match(/([a-f0-9]{32})/i) || [])[1] || '';
  if (!accountId) {
    const accData = await cfFetch('/accounts?per_page=10');
    if (accData?.success && Array.isArray(accData.result) && accData.result[0]?.id) {
      accountId = accData.result[0].id;
    }
  }
  if (!accountId) return { db: null, workerUrl: null };

  let databaseId =
    (String(process.env.CF_D1_DATABASE_ID || '').match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    ) || [])[1] || '';
  if (!databaseId) {
    const d1List = await cfFetch(`/accounts/${accountId}/d1/database`);
    if (d1List?.success && Array.isArray(d1List.result) && d1List.result.length > 0) {
      const found = d1List.result.find((d) => d.name === 'medbot') || d1List.result[0];
      databaseId = found.uuid;
    }
  }
  if (!databaseId) return { db: null, workerUrl: null };

  let workerUrl = String(process.env.CLOUDFLARE_WORKER_URL || '').trim();
  if (!workerUrl) {
    const subData = await cfFetch(`/accounts/${accountId}/workers/subdomain`);
    if (subData?.success && subData.result?.subdomain) {
      workerUrl = `https://medbot-js.${subData.result.subdomain}.workers.dev`;
    }
  }

  cachedRemoteD1 = createCloudflareRemoteD1({ apiToken: token, accountId, databaseId });
  cachedWorkerUrl = workerUrl || null;
  await ensurePlatformSchema(cachedRemoteD1);
  await ensureDefaultCollegeRegistered(cachedRemoteD1, process.env);
  return { db: cachedRemoteD1, workerUrl: cachedWorkerUrl };
}

export default async function handler(req, res) {
  try {
    const pathname = String(req.url || '/').split('?')[0];
    const accept = String(req.headers?.accept || '');

    if (req.method === 'GET' && (pathname === '/dashboard' || (pathname === '/' && accept.includes('text/html')))) {
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
      CLOUDFLARE_WORKER_URL: workerUrl || process.env.CLOUDFLARE_WORKER_URL || `${protocol}://${host}`,
    };

    const webRes = pathname.startsWith('/api/platform/')
      ? await handlePlatformWebApi(webReq, env)
      : await worker.fetch(webReq, env);

    webRes.headers.forEach((val, key) => {
      res.setHeader(key, val);
    });
    const text = await webRes.text();
    res.status(webRes.status).send(text);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Vercel handler error' });
  }
}
