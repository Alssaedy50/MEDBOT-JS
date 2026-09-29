/* global Response */
/**
 * Telegram webhook adapter.
 *
 * Cloudflare Worker / HTTP runtimes call this instead of long polling.
 * The handler is deliberately transport-agnostic: request parsing,
 * secret-token validation, update idempotency and dispatch are separated so
 * the same logic remains easy to test.
 */

const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export function getWebhookSecret(env = {}) {
  return String(env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
}

export function validateWebhookSecret(request, expectedSecret) {
  if (!expectedSecret) return { ok: false, reason: 'missing_webhook_secret' };
  const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  return received === expectedSecret
    ? { ok: true }
    : { ok: false, reason: 'invalid_webhook_secret' };
}

export function extractUpdateId(update) {
  const id = Number(update?.update_id);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

async function readJsonWithLimit(request, maxBodyBytes) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw Object.assign(new Error('Webhook payload too large.'), { code: 'PAYLOAD_TOO_LARGE' });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    throw Object.assign(new Error('Webhook payload too large.'), { code: 'PAYLOAD_TOO_LARGE' });
  }

  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Webhook payload must be valid JSON.'), { code: 'INVALID_JSON' });
  }
}

/**
 * Minimal idempotency store contract:
 *   claim(updateId, ttlSeconds) -> Promise<boolean>
 *   complete(updateId) -> Promise<void>
 *   fail(updateId) -> Promise<void>
 *
 * The production Worker will back this with D1. Keeping it injected makes the
 * adapter deterministic and prevents process-local memory from becoming a
 * correctness dependency.
 */
export function createMemoryIdempotencyStore({ now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    async claim(updateId, ttlSeconds = DEFAULT_IDEMPOTENCY_TTL_SECONDS) {
      const current = entries.get(updateId);
      const timestamp = now();
      if (current && current.expiresAt > timestamp) return false;
      entries.set(updateId, { status: 'processing', expiresAt: timestamp + ttlSeconds * 1000 });
      return true;
    },
    async complete(updateId) {
      const current = entries.get(updateId);
      if (current) entries.set(updateId, { ...current, status: 'completed' });
    },
    async fail(updateId) {
      const current = entries.get(updateId);
      if (current) entries.delete(updateId);
    },
  };
}

export async function handleTelegramWebhook(request, {
  env = {},
  dispatch,
  idempotency = createMemoryIdempotencyStore(),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  now = () => Date.now(),
} = {}) {
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'POST' });
  }

  const secretCheck = validateWebhookSecret(request, getWebhookSecret(env));
  if (!secretCheck.ok) return jsonResponse({ ok: false, error: secretCheck.reason }, 401);

  let update;
  try {
    update = await readJsonWithLimit(request, maxBodyBytes);
  } catch (error) {
    return jsonResponse(
      { ok: false, error: error.code ?? 'invalid_payload' },
      error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
    );
  }

  const updateId = extractUpdateId(update);
  if (updateId === null) return jsonResponse({ ok: false, error: 'invalid_update_id' }, 400);

  const claimed = await idempotency.claim(updateId, DEFAULT_IDEMPOTENCY_TTL_SECONDS);
  if (!claimed) return jsonResponse({ ok: true, duplicate: true });

  if (typeof dispatch !== 'function') {
    await idempotency.fail(updateId);
    return jsonResponse({ ok: false, error: 'dispatch_not_configured' }, 503);
  }

  try {
    await dispatch(update, { env, now });
    await idempotency.complete(updateId);
    return jsonResponse({ ok: true });
  } catch (error) {
    // Do not acknowledge a failed dispatch. Removing the claim allows the next
    // Telegram delivery attempt to be processed again instead of losing the
    // update behind a false HTTP 200 acknowledgement.
    await idempotency.fail(updateId);
    console.error('[MEDBOT] webhook dispatch error:', error?.message ?? error);
    return jsonResponse({ ok: false, error: 'dispatch_failed' }, 503);
  }
}

export const WEBHOOK_DEFAULTS = Object.freeze({
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  idempotencyTtlSeconds: DEFAULT_IDEMPOTENCY_TTL_SECONDS,
});
