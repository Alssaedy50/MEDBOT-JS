# CELL-01 — Worker + Wrangler Audit

Audit only:
- wrangler.jsonc
- src/worker.js

Check:
1. Worker entrypoint and compatibility configuration.
2. D1/R2 binding names and consistency with Worker code.
3. HTTP routes, health endpoint, backup endpoint, storage status, Telegram webhook route.
4. Environment/secret names referenced by the Worker.
5. Runtime assumptions that would prevent Cloudflare execution.
6. Production safety: confirm no Render/SQLite/long-polling cutover is introduced.

Do not edit files outside this cell's ownership. Prefer no edits unless a concrete defect is proven.

When finished, write .mece/cells/CELL-01/REPORT.md with findings, evidence, verification, blockers/residual risk, and session id.
