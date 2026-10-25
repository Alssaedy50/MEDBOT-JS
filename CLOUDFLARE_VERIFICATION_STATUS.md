# CLOUDFLARE — Deployment Verification Status

This document records the **actual, verified** state of the Cloudflare
migration. It is deliberately conservative: an item is only marked verified when
it was executed and observed. Anything requiring Cloudflare account
authentication is marked **BLOCKED** and was **not** faked.

## Verified locally (executed)

| Check | Result |
| --- | --- |
| D1 schema contract | v18 (`src/db/d1/migrations.js`) |
| Schema materialisation (`cf:apply-schema`) | PASS — 10093-byte `artifacts/d1-schema.sql` |
| Schema freshness (`cf:schema-check`) | PASS |
| SQLite -> D1 export on synthetic fixture | PASS — column parity, row parity, 0 FK violations |
| FK enforcement ON import (no defer pragma) | PASS — topological ordering is correct |
| Empty-table export/import | PASS |
| Oversized-row export | Refused above the 90 KB statement limit (by design) |
| `npm run lint` | PASS |
| `npm test` | PASS — 525 tests, 0 failures |
| `npm run migration:verify` (fresh local SQLite) | PASS |
| `npm run cf:preflight` (strict) | 12 PASS / 4 WARN / 1 FAIL (only the production D1 placeholder) |
| GitHub Actions on `main` | PASS |

### PR #34

- Status: **merged** into `main`.
- Merge commit: `38d80a0804e25cb066fd5e0d19ec09955694e69f`.
- Adds the explicit D1 schema-apply mechanism, the staging data-import path, a
  schema/exporter parity guard, and corrected v17 -> v18 documentation.

## BLOCKED on Cloudflare authentication (not executed)

The environment has **no usable Cloudflare credentials**: `wrangler` is
installed but reports *"You are not authenticated"*, and
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are unset. No OAuth login is
present. Therefore the following were **not** performed and **no Cloudflare
resources were created or changed**:

- staging D1 database (`medbot-staging`)
- staging R2 bucket (`medbot-files-staging`)
- schema apply / data import into staging
- staging Worker deployment (`medbot-js-staging`)
- staging secrets
- staging Telegram webhook
- staging AI, backup/R2 verification

No production resource, Worker, Telegram webhook, or Render deployment was
touched.

### Required non-secret configuration to unblock

- A Cloudflare API token with **D1 Edit**, **Workers Scripts Edit**, and
  **R2 Edit** scopes for the target account (supplied via the environment, not
  committed).
- `CLOUDFLARE_ACCOUNT_ID` for the target account.
- A dedicated **test** Telegram bot token and webhook secret for staging
  (never the production bot token).

## Staging execution sequence (ready to run once authenticated)

```bash
# 0. Confirm identity
npx wrangler whoami

# 1. Staging D1 (record the returned database_id; do not commit it)
npx wrangler d1 create medbot-staging

# 2. Staging R2
npx wrangler r2 bucket create medbot-files-staging

# 3. Point the staging environment at medbot-staging. Add a minimal `env.staging`
#    block to wrangler.jsonc (top-level config keeps production semantics):
#
#    "env": {
#      "staging": {
#        "name": "medbot-js-staging",
#        "d1_databases": [{ "binding": "DB", "database_name": "medbot-staging", "database_id": "<STAGING_ID>" }],
#        "r2_buckets": [{ "binding": "FILES", "bucket_name": "medbot-files-staging" }]
#      }
#    }
#
#    The staging D1 id stays out of source control; inject it at deploy time or
#    via a non-committed local override.

# 4. Generate + apply schema v18 to the EMPTY staging D1
npm run cf:apply-schema
npx wrangler d1 execute medbot-staging --remote --file=./artifacts/d1-schema.sql

# 5. Verify schema_meta value = 18, all tables, indexes, foreign keys,
#    and telegram_updates.

# 6. Export production SQLite (read-only) and import into staging
npm run cf:export-data -- --sqlite <PRODUCTION_SQLITE> --output ./artifacts/d1-data.sql
npm run cf:import-data   # CF_D1_DATABASE=<staging> CF_D1_DATA=./artifacts/d1-data.sql

# 7. Verify row counts vs. the manifest and foreign-key integrity.

# 8. Preflight + deploy staging Worker
npm run cf:preflight
npm run cf:deploy        # staging environment
```

## Production cutover — NOT performed

Production cutover remains pending and must be explicitly authorized. See
`CLOUDFLARE_PHASE17.md` for the cutover and rollback procedure. Render polling
remains the production path and the rollback target until staging is fully
verified.
