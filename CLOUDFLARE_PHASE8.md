# Cloudflare Phase 8 — R2 storage + Worker composition

## Scope

Phase 8 adds the object-storage boundary required for Cloudflare R2 and connects
the Worker HTTP route to the Phase 7 Telegram webhook/idempotency adapter.

Production Telegram polling on Render and the SQLite runtime remain unchanged.

## R2

`src/storage/r2.js` provides a runtime-neutral adapter with `put`, `get`,
`head`, `delete`, and `list`. It validates object keys so callers cannot
address absolute paths or traversal-like keys. Resource keys are deterministic.

The Worker binding is `FILES`, configured in `wrangler.jsonc`.

## Worker ingress

`/telegram/webhook` now uses:

1. Telegram secret-token validation.
2. D1-backed `telegram_updates` idempotency.
3. A Worker-safe dispatch boundary.

The business router is deliberately not imported yet. The existing Node router
depends on `node:sqlite` through the UI/domain modules and would violate the
Worker runtime boundary. Until that domain router is ported, a valid webhook
reaches the boundary but returns controlled `503` and releases its idempotency
claim, allowing Telegram to retry.

## Data migration

`telegram_updates` is ephemeral delivery state and is intentionally excluded
from the SQLite-to-D1 application-data exporter. A new D1 environment creates
it through the D1 schema/runtime initialization.

## Production safety

No Telegram `setWebhook` call is made. No Render cutover occurs. Staging must
first prove the Worker domain router, Telegram replies, D1 persistence, AI
routing, and resource delivery before production webhook activation.
