# MEDBOT-JS — Cloudflare Phase 17

Phase 17 prepares a controlled Cloudflare staging deployment and final Telegram webhook cutover without changing the existing Render/Node.js/SQLite/long-polling production path.

## Implemented

- Read-only Cloudflare deployment preflight.
- Explicit Telegram webhook helper for staging/cutover.
- Explicit D1 schema-apply helper (`scripts/d1-apply-schema.mjs`) that
  materialises the reviewed schema v18 for `wrangler d1 execute`.
- Validation of Worker entrypoint, D1/R2 bindings, required runtime files, Node version, and secret hygiene.
- No automatic webhook change.
- No automatic D1 reset or deletion.
- Existing Render production remains untouched.

## Staging gate

1. Create the target D1 database in the Cloudflare account.
2. Replace only the D1 database_id placeholder in wrangler.jsonc.
3. Generate the reviewed D1 schema (version 18) from
   src/db/d1/migrations.js and apply it to an empty D1 database:
   npm run cf:apply-schema
   npx wrangler d1 execute <database> --remote --file=./artifacts/d1-schema.sql
   `cf:apply-schema` only materialises the schema source of truth; it never
   contacts Cloudflare and never embeds ids. `npm run cf:schema-check` verifies
   the generated file is current.
4. Export SQLite data with:
   npm run cf:export-data -- --sqlite ./medbot_v2.sqlite3 --output ./artifacts/d1-data.sql
5. Import that data into D1 after schema creation:
   npm run cf:import-data
   (defaults to the `medbot` database and ./artifacts/d1-data.sql; override with
   CF_D1_DATABASE / CF_D1_DATA)
6. Verify source SQLite with the existing migration:verify command and independently verify D1 row counts/FK integrity.
7. Create/bind the R2 bucket medbot-files.
8. Configure Worker secrets/variables without committing values:
   TELEGRAM_BOT_TOKEN
   ADMIN_ID
   AI provider credentials as needed
   backup settings as needed
   the webhook secret used by src/telegram/webhook.js
9. Run npm run cf:preflight.
10. Deploy the Worker to a staging Worker.
11. Test /health, /storage/status, invalid webhook-secret rejection, controlled Telegram updates, student flows, AI quota/failover, and admin/RBAC flows.
12. Inspect webhook state:
   TELEGRAM_BOT_TOKEN=... node scripts/cloudflare-webhook.mjs info
13. Only after staging passes, explicitly set:
   TELEGRAM_BOT_TOKEN=... WEBHOOK_URL=https://<worker>/telegram/webhook WEBHOOK_SECRET=... node scripts/cloudflare-webhook.mjs set

## Rollback

Do not delete Render or the SQLite database.

If cutover fails, keep Render available and use the explicit webhook delete command only after confirming the intended bot. Do not run destructive D1 operations against a populated database.

## Secrets

Never commit Telegram tokens, API keys, webhook secrets, or Cloudflare credentials. Use Cloudflare secret/variable configuration and local environment variables.

## Boundary

Phase 17 adds the deployment/cutover gate and tooling. It does not claim that the user's Cloudflare account, D1 database, R2 bucket, Worker deployment, or Telegram webhook has been changed. Those require authenticated execution in the target environments.
