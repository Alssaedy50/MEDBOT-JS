# MEDBOT-JS — Cloudflare Migration Phase 3 foundation

## Purpose

Prepare the **verified SQLite → staging D1 data migration** without touching the
production database or enabling Telegram webhook.

## New tool

`scripts/d1-export-data.mjs`

The exporter:

- opens the supplied SQLite database **read-only**;
- verifies all MEDBOT application tables required by schema v17 exist;
- discovers foreign-key dependencies and exports in a safe parent-first order;
- preserves explicit primary keys and all column values;
- escapes text and binary values as SQLite SQL literals;
- refuses to generate a statement above 90 KB, leaving margin below D1's 100 KB SQL-statement limit;
- generates a SHA-256 checksum and row-count manifest;
- never contacts Cloudflare and never changes the source database.

### Example

```bash
npm run cf:export-data -- \
  --sqlite /path/to/medbot_v2.sqlite3 \
  --output ./artifacts/d1-data.sql
```

The command produces:

- `artifacts/d1-data.sql`
- `artifacts/d1-data.manifest.json`

These artifacts are intentionally **not committed** to Git.

## Migration sequence

1. Obtain a copy of the real production SQLite database without modifying it.
2. Run the exporter.
3. Create a **staging** D1 database.
4. Bootstrap the already-reviewed schema v17.
5. Import the generated SQL into staging.
6. Compare table row counts and key ranges against the manifest.
7. Run foreign-key and semantic checks.
8. Test every major MEDBOT workflow against staging.
9. Repeat the migration against a fresh staging database to prove repeatability.
10. Only after all checks pass, prepare production cutover.

Cloudflare documents `wrangler d1 execute --remote --file=...` for SQL imports
and recommends splitting oversized statements. D1 currently limits an individual
SQL statement to 100 KB; the exporter deliberately uses a 90 KB safety ceiling.

## Important

The exporter is **data-only**. It does not recreate the schema. This prevents
the migration artifact from silently becoming a second, drifting schema source.
The reviewed D1 schema contract remains the schema source of truth.

Production Telegram polling, Render, SQLite runtime behavior, RBAC, News,
contributions, AI, localization, and resource semantics remain unchanged in
this phase.
