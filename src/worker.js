/**
 * MEDBOT Cloudflare Worker compatibility boundary.
 *
 * The Worker now owns the HTTP ingress and Cloudflare bindings. The Node bot
 * assembly remains separate until every domain dependency is Worker-safe.
 */

import { handleTelegramWebhook } from './telegram/webhook.js';
import { createD1TelegramIdempotencyStore, initTelegramWebhookStore } from './db/d1/telegramUpdates.js';
import { createR2Storage } from './storage/r2.js';

/** Return a stable JSON response without leaking secrets or provider details. */
function json(data, status = 200) {
  return new globalThis.Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function healthResponse(env = {}) {
  return json({
    ok: true,
    service: 'MEDBOT',
    runtime: 'cloudflare-worker',
    phase: 8,
    telegram_webhook: 'adapter_enabled',
    telegram_domain_router: 'not_migrated',
    database: env.DB ? 'd1-bound' : 'd1-missing',
    object_storage: env.FILES ? 'r2-bound' : 'r2-missing',
  });
}

/**
 * Phase 8 dispatch boundary.
 *
 * This intentionally does not call the Node router. That router imports
 * node:sqlite-backed UI modules and cannot execute safely in a Worker yet.
 */
async function dispatchTelegramUpdate() {
  throw new Error('telegram_domain_router_not_migrated');
}

async function webhookResponse(request, env) {
  if (!env.DB) {
    return json({ ok: false, error: 'd1_not_configured' }, 503);
  }

  await initTelegramWebhookStore(env.DB);
  const idempotency = createD1TelegramIdempotencyStore(env.DB);

  return handleTelegramWebhook(request, {
    env,
    idempotency,
    dispatch: dispatchTelegramUpdate,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return healthResponse(env);
    }

    if (url.pathname === '/telegram/webhook') {
      return webhookResponse(request, env);
    }

    if (url.pathname === '/storage/status') {
      return json({
        ok: Boolean(env.FILES),
        storage: env.FILES ? 'r2' : 'unconfigured',
        adapter: env.FILES ? Boolean(createR2Storage(env.FILES)) : false,
      });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },
};
