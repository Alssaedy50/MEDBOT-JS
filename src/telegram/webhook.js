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
 *   has(updateId) -> Promise<boolean>
 *   mark(updateId, ttlSeconds) -> Promise<void>
 *
 * The production Worker will back this with D1. Keeping it injected makes the
 * adapter deterministic and prevents process-local memory from becoming a
 * correctness dependency.
 */
export function createMemoryIdempotencyStore({ now = () => Date.now() } = {}) {
  const entries = new Map();

  return {
    async has(updateId) {
      const expiresAt = entries.get(updateId);
      if (!expiresAt) return false;
      if (expiresAt <= now()) {
        entries.delete(updateId);
        return false;
      }
      return true;
    },
    async mark(updateId, ttlSeconds = DEFAULT_IDEMPOTENCY_TTL_SECONDS) {
      entries.set(updateId, now() + ttlSeconds * 1000);
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

  if (await idempotency.has(updateId)) {
    return jsonResponse({ ok: true, duplicate: true });
  }

  // Mark only after the payload is authenticated/validated. The dispatch
  // boundary receives exactly one normalized raw update.
  await idempotency.mark(updateId, DEFAULT_IDEMPOTENCY_TTL_SECONDS);

  if (typeof dispatch !== 'function') {
    return jsonResponse({ ok: false, error: 'dispatch_not_configured' }, 503);
  }

  try {
    await dispatch(update, { env, now });
    return jsonResponse({ ok: true });
  } catch (error) {
    // Telegram only needs a fast acknowledgement. The update is already
    // claimed by the idempotency store, so retry storms cannot occur.
    console.error('[MEDBOT] webhook dispatch error:', error?.message ?? error);
    return jsonResponse({ ok: true, accepted: true });
  }
}

export const WEBHOOK_DEFAULTS = Object.freeze({
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  idempotencyTtlSeconds: DEFAULT_IDEMPOTENCY_TTL_SECONDS,
});
