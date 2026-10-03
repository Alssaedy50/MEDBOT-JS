# Cloudflare Worker Parity Audit

Date: 2026-10-03
Reference production implementation: `src/telegram/bot.js` and `src/ui/*`
Worker under audit: `src/worker.js`
Audit head: `82ca3c9b0dd83e055101a8b023472144e9b57a76`
Scope: staging Worker parity only. Production Render, production SQLite, and production Telegram webhook are out of scope.

## 1. Current command parity

### Covered by Worker
- /start
- /help
- /quota
- /whoami
- /contact
- /cancel
- /ask (including inline question)
- /contribute
- /search

### Missing as production command/workflow parity
- /backup
- /restore
- /secrets
- /bundle

The production router also has a generic /text route and multiple stateful text handlers that are not represented by the Worker message state machine.

## 2. Stateful text workflow parity

Production registers these text workflows:
- news creation/editing
- admin custom upload title
- admin file rename
- admin folder create
- admin folder rename
- contribution title
- contribution resubmit
- contribution review note
- admin reply
- student contact
- admin add
- settings edit
- secret management
- topic creation
- notifications
- assistant
- library search

Worker currently implements only a subset:
- admin folder create/rename
- admin file rename
- admin message reply
- settings save
- secrets set/delete
- student contact
- assistant
- library search

Missing/partial workflow parity:
- news text workflow
- custom upload title workflow
- contribution title workflow
- contribution resubmit workflow
- contribution review-note workflow
- admin add workflow
- topic creation workflow
- notifications workflow
- restore-upload workflow
- full cancel semantics across every workflow state

## 3. Callback/admin parity

### Production admin-management callbacks
Production supports:
- admin roster/add/roles/permissions/preview
- revoke/restore
- ownership transfer
- scoped RBAC: scope_menu, scope_add, scope_browse, scope_set, scope_remove_menu, scope_del, scope_clear

Worker has admin roster/role screens, but scoped RBAC and ownership-transfer flows are not exposed in the Worker router.

### Production admin-settings callbacks
Production supports:
- settings editing
- notifications creation/history
- audit log
- AI registry
- runtime
- archive status/resync/retry

Worker exposes settings, AI, runtime, but does not expose notification history/actions, audit log, or archive operations.

### Production folder/content callbacks
Worker covers the main folder/resource CRUD paths, but the production implementation also has:
- folder type management
- accepts-contributions toggle
- folder move
- upload confirmation
- custom upload title
- file type management
- file move

These need explicit parity verification rather than assuming that the simpler Worker CRUD surface is equivalent.

### Production contributions
Production supports:
- browse
- contribute
- resubmit
- pending review
- preview
- approve/reject/revise
- review note

Worker currently covers the basic contribution start/folder/media path and approve/reject, but not the complete lifecycle.

### Production news
Production supports:
- feed/detail/read-all
- filters
- subscriptions
- section subscriptions
- full admin news creation wizard
- references to section/subject/resource
- publish/archive/restore/delete
- delivery status/retry

Worker currently covers feed/detail and simplified admin publish/delete. The full creation/reference/subscription/delivery lifecycle is not parity-complete.

### Production topics
Production supports:
- browse/detail
- create
- link/unlink folders
- active toggle
- ordering
- delete

Worker covers browse/detail and admin toggle, but not the complete management lifecycle.

### Production visibility
Production supports:
- list
- show-all
- toggle

Worker currently exposes only the toggle path.

## 4. Security/correctness findings

### P0 — Secret Vault key rotation flaw
`src/telegram/workerSecrets.js` derives the AES-GCM key from:
`MEDBOT_SECRET_VAULT:v1:<TELEGRAM_BOT_TOKEN>`.

Therefore rotating the Telegram bot token changes the encryption key and can make existing Worker vault entries undecryptable.

`MEDBOT_SECRETS_KEY` is reserved but is not currently used.

Required fix:
- derive the vault key from a dedicated stable secret (prefer `MEDBOT_SECRETS_KEY`)
- keep the Telegram bot token independent from vault encryption
- define a safe migration path for existing v1 entries before production

### P0 — Scoped RBAC audit required
The Worker has permission checks, but the complete production scope model is not represented in the Worker callback router. Before production, every admin action that touches folders/topics/resources/news/messages/settings must be verified against the actor's permission AND scope.

### P1 — Backup/restore/bundle parity
Production has Telegram data backup, restore-from-upload, and full deploy bundle workflows. Worker currently has only an HTTP backup endpoint gated by R2/BACKUP_SECRET, and R2 is unavailable in the current account. This is not equivalent functionality.

## 5. Performance findings

The Worker /ask path can accumulate:
- D1 quota/user work
- PubMed search/fetch
- secret loading
- AI registry/model discovery
- provider request
- Telegram response

Cold Worker isolates do not share the same in-memory cache behavior as the long-lived Node process. Home/admin screens also perform multiple D1 round trips.

Performance work should follow parity correctness:
1. avoid unnecessary D1 round trips
2. parallelize independent reads
3. persist stable AI/model metadata in D1 where appropriate
4. cache only safe/short-lived data
5. avoid expensive provider discovery on every cold request

## 6. Priority order

P0:
1. Stable Secret Vault key independent of Telegram token
2. Complete scoped-RBAC authorization audit
3. Prevent privilege escalation across all Worker admin routes

P1:
1. Restore missing admin workflows
2. Restore complete contribution lifecycle
3. Restore complete news lifecycle
4. Restore topics/folder advanced management
5. Restore notifications + audit + archive
6. Restore backup/restore/bundle strategy compatible with current Cloudflare constraints

P2:
1. Performance/D1 round-trip reduction
2. Worker UI/UX parity
3. Real staging Telegram E2E across every restored workflow

## 7. Release gate

Do not call Cloudflare Worker feature parity complete until:
- every production command is mapped to a Worker equivalent or explicitly retired
- every production callback namespace is mapped
- every stateful text/media workflow is mapped
- security/scope tests cover each admin action
- 100% automated tests remain green
- staging Worker deployment is verified
- real Telegram staging E2E passes
- production Render, production DB, and production webhook remain untouched until final cutover approval
