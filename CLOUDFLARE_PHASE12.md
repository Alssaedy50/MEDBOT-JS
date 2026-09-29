# Phase 12 — Owner Secrets + Full Deploy Bundle

## Owner-only secret manager

The owner can open **🔐 المتغيرات السرية** or use `/secrets`.
- Add/update: send `NAME=VALUE`.
- The input message is deleted after capture.
- Values are encrypted at rest with AES-256-GCM.
- Values are never displayed back by the bot.
- On startup, encrypted values are loaded into `process.env` before the bot starts.
- BOT_TOKEN, ADMIN_ID, ADMIN_IDS, MEDBOT_SECRETS_KEY, and core process variables are reserved.
- The encryption key is derived from BOT_TOKEN; the same bot token is required to decrypt the vault after migration.

Typical managed values: GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, MEDBOT_BACKUP_URL, MEDBOT_BACKUP_TOKEN.

## Full deploy bundle

The owner can choose **📦 ملف البوت الكامل** or use `/bundle`.
The archive contains application source, package/deployment configuration, SQLite data, encrypted runtime secret vault, Cloudflare/Render/Docker deployment files, a manifest, and registered Telegram resource files when the official Bot API permits downloading them.

Telegram currently allows bots to download files up to 20 MB and upload documents up to 50 MB. Files larger than 20 MB are recorded as not_embedded instead of being silently omitted.

For a different Telegram bot, embedded resources must be rebound because file_id belongs to the original bot. Run:

`BOT_TOKEN=... ADMIN_ID=... npm run restore:resources`

This uploads embedded resources to the destination bot and replaces the copied database file IDs.

## Security boundary

The bundle never contains the plaintext BOT_TOKEN. Runtime secrets are encrypted in the database. The full bundle remains owner-sensitive.

A destination platform still needs Node.js >=22.5, the Telegram bot token, persistent SQLite storage or the D1 path, network access, and platform bindings such as R2/D1. The archive contains the application and state; platform credentials and infrastructure cannot safely be embedded as plaintext.