# CELL-03 — R2 Audit

Audit only:
- src/storage/r2.js
- Worker R2 integration points in src/worker.js when necessary to validate the storage contract

Check:
1. R2 binding and adapter contract.
2. Key normalization/security.
3. put/get/head/delete/list behavior.
4. File/resource key conventions.
5. Worker integration and missing-binding behavior.
6. Migration/deployment risks around the medbot-files bucket.

Do not create buckets or modify Cloudflare resources.

When finished, write .mece/cells/CELL-03/REPORT.md with findings, evidence, verification, blockers/residual risk, and session id.
