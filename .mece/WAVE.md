# MECE Wave — MEDBOT-JS Phase 17 Cloudflare Staging Audit

## Goal
Audit the merged Phase 17 Cloudflare staging readiness without changing Cloudflare resources, Telegram webhook state, or Render production.

## Parent
ChatGPT/Codex — parent conductor.

## Execute muscle
OpenCode on a supported Linux environment using user-owned authentication.

## Cell ownership
- CELL-01: wrangler.jsonc + src/worker.js
- CELL-02: D1 migrations + D1 adapters + Telegram idempotency storage
- CELL-03: R2/storage boundaries + Worker storage integration
- CELL-04: Telegram webhook adapter + webhook helper/cutover safety
- CELL-05: preflight + package scripts + CI + Phase 17 deployment documentation

Cells are mutually exclusive by file ownership. Cross-cell findings must be reported, not edited by another cell.

## Safety boundary
Do not create/delete Cloudflare resources. Do not deploy a Worker. Do not set/delete a Telegram webhook. Do not alter Render production. Do not add secrets. Do not rebuild or remove existing functionality.

## Required output
Every cell must produce a real .mece/cells/<CELL-ID>/REPORT.md containing:
- findings
- paths inspected
- verification performed
- blockers/residual risk
- recommended fixes, if any
- OpenCode session id when available
