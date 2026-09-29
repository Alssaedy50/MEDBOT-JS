# Cloudflare Phase 9 — Worker Telegram domain boundary

Phase 9 creates the Worker-safe seam for Telegram domain handlers without
pulling the Node/SQLite application into the Worker bundle.

- `workerContext.js`: normalized Telegram context for Worker runtimes.
- `workerDispatcher.js`: dependency-injected command/message/callback dispatch.
- Existing Node `context.js`, router, handlers, SQLite and Render polling are
  unchanged.
- A missing Worker handler fails closed instead of acknowledging a Telegram
  update as successfully processed.

The next migration can port one MEDBOT subsystem at a time behind this seam,
then connect the resulting dispatcher to the Phase 7 webhook.

Production remains on Render polling + SQLite. No Telegram webhook cutover is
performed by Phase 9.
