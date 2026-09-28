/**
 * MEDBOT Cloudflare Worker compatibility boundary — Phase 1.
 *
 * IMPORTANT:
 * - This module is intentionally a skeleton.
 * - It does NOT replace the Node/SQLite runtime.
 * - It does NOT start Telegram webhook processing.
 * - It does NOT import the Node bot assembly, because that assembly still
 *   depends on node:sqlite and process/filesystem APIs.
 *
 * The Worker boundary is kept deliberately small so the existing MEDBOT
 * business logic can be ported behind adapters in later phases.
 */

/**
 * Return a stable JSON response without leaking secrets or provider details.
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Phase 1 health endpoint.
 *
 * This proves that the Worker can be deployed independently from the current
 * Node runtime. It does not claim that the Telegram bot is running on Worker.
 */
function healthResponse() {
  return json({
    ok: true,
    service: 'MEDBOT',
    runtime: 'cloudflare-worker',
    phase: 1,
    telegram_webhook: 'not_enabled',
    database: 'd1-boundary-declared',
  });
}

/**
 * Reject webhook traffic during the compatibility phase.
 *
 * A production Telegram webhook must not be enabled until durable workflow
 * state, D1 persistence, update dispatch, and cutover tests are complete.
 */
function webhookDisabledResponse() {
  return json(
    {
      ok: false,
      error: 'telegram_webhook_not_enabled',
      phase: 1,
    },
    501,
  );
}

/**
 * Basic request routing for the Worker boundary.
 *
 * Future phases will inject:
 *   Request -> Telegram ingress -> MEDBOT context -> existing router
 *
 * The current Node polling entry point remains untouched.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return healthResponse();
    }

    if (url.pathname === '/telegram/webhook') {
      return webhookDisabledResponse();
    }

    return json(
      {
        ok: false,
        error: 'not_found',
      },
      404,
    );
  },
};
