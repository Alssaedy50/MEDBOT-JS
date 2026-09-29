# Cloudflare Phase 11 — Resource Library + Durable State

## Delivered
- Worker/D1 student resource root, folder navigation, breadcrumbs and SQL-backed search.
- Worker delivery of registered Telegram files using their stored Telegram `file_id`.
- Admin-only MEDBOT data snapshot as JSON.
- In-bot backup menu:
  - download the complete state to the owner's private chat;
  - optionally send the same snapshot to `MEDBOT_BACKUP_CHAT_ID`.
- Automatic debounced backup after audited admin mutations.
- Optional durable remote backup in R2 through `/backup/latest`.
- Startup recovery only when the local SQLite database is effectively empty; an existing database is never overwritten automatically.
- Owner-only `/restore` flow for an uploaded MEDBOT JSON snapshot.

## Durable backup configuration
Node/Render:
- `MEDBOT_BACKUP_URL`: Worker base URL, for example `https://<worker>/backup`.
- `MEDBOT_BACKUP_TOKEN`: same secret value as Worker `BACKUP_SECRET`.
- `MEDBOT_BACKUP_CHAT_ID`: optional Telegram channel/group/chat receiving automatic snapshots.

Cloudflare Worker:
- `BACKUP_SECRET`: Worker secret protecting `GET/PUT /backup/latest`.
- `FILES`: existing R2 binding.

Do not commit these values.

## Recovery model
1. Admin changes are persisted in SQLite as before.
2. Audited changes schedule a debounced snapshot.
3. If configured, the snapshot is uploaded to R2 as `backups/latest.json` and optionally sent to Telegram.
4. On a new empty Render filesystem, startup checks for meaningful local state. If none exists and remote backup credentials are configured, the latest R2 snapshot is validated and restored.
5. Manual `/restore` remains available to the owner for a Telegram backup file.

This avoids destructive "start from zero" behavior while keeping automatic recovery fail-closed.

## Telegram limits
The snapshot is sent as a normal document. Keep the state file below Telegram's current document send limit; R2 remains the durable path for larger backups.
