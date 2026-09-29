# Cloudflare Phase 10 — Start, Home and Account

The first real MEDBOT student-facing workflows are now Worker-safe:

- `/start` registers the Telegram user in D1 and renders the localized home.
- `home` rebuilds the home menu from D1 settings, visibility and admin state.
- `account` reads the D1 AI allowance, contribution count and news-read state.
- Telegram API transport is injected through the Worker environment; no
  Telegraf, filesystem or Node SQLite code is imported.
- Unsupported commands/callbacks fail closed and the webhook releases the
  idempotency claim for Telegram retry.

Production remains Render polling + SQLite. This phase does not call
`setWebhook` and does not change the production bot.
