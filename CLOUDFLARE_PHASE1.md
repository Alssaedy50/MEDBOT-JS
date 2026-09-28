# MEDBOT-JS — Cloudflare Migration Phase 1

## Purpose

Phase 1 introduces a Cloudflare Worker boundary without changing the current
production Node.js/SQLite/Telegram-polling behavior.

## Added

- `src/worker.js` — minimal Worker entry point.
- `wrangler.jsonc` — Cloudflare configuration with a D1 binding declaration.
- `test/cloudflareWorker.test.js` — Worker boundary contract tests.

## Current guarantees

The existing runtime remains unchanged:

`Node.js -> SQLite -> Telegram long polling`

The new boundary is isolated:

`HTTP Request -> Cloudflare Worker`

The Worker currently exposes:

- `GET /` — health response.
- `GET /health` — health response.
- `/telegram/webhook` — deliberately returns HTTP 501.
- unknown paths — HTTP 404.

## Why the webhook is disabled

Phase 1 must not switch the production Telegram bot to webhook.

A production cutover will happen only after:

1. D1 persistence is implemented and verified.
2. Durable workflow state replaces process-local state where required.
3. Telegram update normalization/dispatch is ported.
4. Background news delivery has a Cloudflare-safe execution model.
5. Existing MEDBOT tests remain green.
6. A separate Telegram test bot passes live webhook validation.
7. The production bot is switched from polling to webhook only once.

## D1

The configuration declares a Worker binding named `DB`.

Before remote deployment, create the MEDBOT D1 database and replace:

`REPLACE_WITH_D1_DATABASE_ID`

with the real database ID in `wrangler.jsonc`.

No SQLite data is copied or deleted by Phase 1.

## R2

R2 is intentionally not bound yet. Large binary resources remain outside D1.
The later storage phase can add an R2 binding behind a FileStore abstraction.

## Local validation

Use the existing Node test suite:

`npm test`

The Worker module uses standard Web APIs and can be tested with Node 22+.

If Wrangler is installed/available, the Worker can later be run locally with:

`npx wrangler dev`

Do not configure the production Telegram bot token or webhook URL as part of
Phase 1.

## Exit criteria

- Worker entry point exists.
- Cloudflare configuration exists.
- D1 binding boundary is declared.
- Worker health contract is tested.
- Webhook is explicitly disabled.
- Existing Node entry point is untouched.
- SQLite implementation is untouched.
- No production Telegram cutover occurs.
