# MEDBOT Python → JavaScript migration map

The Python repository (`Alssaedy50/MEDBOT`) is the authoritative functional
reference. This document maps each Python subsystem to its JavaScript
counterpart, and records the decisions taken where a direct translation would
have been wrong.

The JavaScript implementation is [intentionally idiomatic](./ARCHITECTURE.md) — the
Telegram transport is a hand-written `fetch` client rather than a line-by-line
translation of `python-telegram-bot`, the database layer is `node:sqlite`
(Node's built-in SQLite) rather than `aiosqlite`, and the handlers are split by
subsystem rather than one registration function.

## 1. Database and schema

| Python (`database.py`) | JavaScript | Notes |
|---|---|---|
| `SCHEMA` / `_migrate_v1`..`_migrate_v17` | `src/db/migrations.js` | Same ordering and additive semantics; v1–v4 frozen. |
| `folders`, `content`, `topics` | `src/db/registry.js`, `src/db/topics.js` | Same columns and navigation model. |
| `users`, `admins` | `src/db/users.js`, `src/db/admins.js` | Role/`permissions` columns preserved. |
| `news`, `news_subscriptions`, `news_deliveries`, `news_reads` | `src/db/news.js` | Two-kind model preserved (see §5). |
| `notifications` | `src/db/notifications.js` | Broadcast log, audience/recipients/delivered. |
| `audit_log` | `src/db/audit.js` | Append-only. |
| `settings` | `src/db/settings.js` | Key/value; also holds hidden features. |
| `admin_scopes` | `src/db/scopes.js` | `(admin_id, scope_type, scope_id)`. |
| `archive_sync` | `src/db/notifications.js` | Archive publish bookkeeping. |
| `contributions` | `src/db/contributions.js` | Student submissions + review state. |
| `messages` | `src/db/messages.js` | Student → admin inbox. |
| `ai_registry` | `src/db/aiRegistry.js` | Model discovery/health cache. |
| `identifiers`, helpers | `src/db/identifiers.js`, `src/db/core.js` | ESM exports with the same guards. |

### Migration status

All 17 migrations are implemented and verified by `test/database.test.js`:

- **v1–v4** — core schema (folders/content/topics, users, admins, settings).
- **v5–v12** — News, subscriptions, read tracking, audit, messages, scopes.
- **v13–v16** — archive sync, contributions, AI registry, additive columns.
- **v17** — folds the legacy `resource` news kind into `section` (`news_type`
  rewrite plus the `LEGACY_NEWS_TYPES` display fallback). Recreated exactly,
  including the partial unique index on `news(resource_id) WHERE source='resource'`.

## 2. Folders and resources

| Python | JavaScript | Notes |
|---|---|---|
| `main.py` folder browse/create/rename/delete handlers | `src/ui/adminFolders.js`, `src/ui/library.js`, `src/ui/topics.js` | Browse is scope-filtered (§4). |
| Folder/resource CRUD | `src/db/registry.js` | `getFolders`, `getFiles`, breadcrumbs, parent lookup. |
| Resource types and icons | `src/constants.js` | `RESOURCE_ICONS`, node types. |

## 3. Admin and Scoped RBAC

| Python | JavaScript | Notes |
|---|---|---|
| `admin_management.py` | `src/ui/adminManagement.js` | Roster, roles, permission editing, scope picker. |
| `authorization.py` | `src/authorization.js` | Capability + scope checks. |
| Permission constants | `src/constants.js` (`PERMISSION_KEYS`, role defaults) | Deny-by-default is explicit (`PERMISSIONS_NONE`). |
| `admin_scopes` CRUD | `src/db/scopes.js` | Grant/revoke/clear, scope resolution. |

Scoped RBAC semantics preserved: owner/super-admin has full authority; a
non-admin has none; `folder`, `topic` and `resource` scopes all exist; denial is
the default. A folder scope covers its whole subtree; a topic scope covers every
folder the topic links to; a resource scope covers exactly one resource.

## 4. Scope picker (latest intended UX)

The Python version left this as an outstanding UX task. The JavaScript version
implements the intended behaviour directly in
`src/ui/adminManagement.js` (`showScopePicker`):

- Adding a scope opens **one hierarchical browser at the real MEDBOT root**.
- There is **no initial "Section / Topic / Resource" question** — the scope
  type is derived from the node the admin selects.
- Navigation is downward: folders drill in (`↳ دخول`), topics are surfaced as
  root-level entry points, and resources are listed under their folder.
- Every selectable node carries its own selection button (`✅` marks one already
  granted).
- The admin may grant an entire parent section, a child section, or one resource,
  and may assign **multiple scopes to the same admin** (the picker stays open).

## 5. News

| Python | JavaScript | Notes |
|---|---|---|
| `news.py` | `src/ui/news.js`, `src/db/news.js` | Publish lifecycle, feed, reads, subscriptions. |
| News delivery | `src/newsDelivery.js` | Batching, rate limiting, recovery. |
| News Center / archive lifecycle | `src/ui/news.js`, `src/archive.js` | `draft` → `published` → `archived`. |

**Two-kind model preserved.** `NEWS_TYPES = ['notify', 'section']`, surfaced as:

- 🚨 **Important / Urgent** (`notify`)
- 📚 **Section News** (`section`)

There is **no separate "Resource News" type**. A section news item may carry a
linked `resource_id`, and that is a property of the item, not a news kind.
`legacy resource` rows are folded into `section` by migration v17 and only keep a
display label for any un-migrated row.

**Section/subject semantics.** A `section` news item stores:

- `section_folder_id` — the real folder the author picked as the section;
- `subject_folder_id` — an *optional*, explicitly chosen branch, never inferred
  from the section's position in the tree (a section may be any real node, so
  its parent says nothing about the subject);
- `resource_id` — an optional linked resource, not a news kind.

An auto Section News item produced for a newly registered resource anchors the
resource's own folder as the section and leaves `subject_folder_id` empty.

Admin News UX (`📰 News` → `➕ Publish News` / `📋 Published News` / `🗄 Archive`),
student News UX (`📋 All News` / `🚨 Important / Urgent` / `📚 Section News`) and
subscriptions (`🚨 Important / Urgent` / `📚 Section News` / `📚 Manage Followed
Sections`) are preserved.

## 6. Subscriptions and private delivery

| Behaviour | Implementation |
|---|---|
| Subscribe by type (`notify`/`section`) | `db.addNewsSubscription(userId, 'type', kind)` |
| Subscribe to a specific section | `db.addNewsSubscription(userId, 'section', folderId)` |
| Audience resolution | `db.resolveNewsRecipients` — type subscribers, plus section followers for a section item |
| Private delivery | `src/newsDelivery.js` (`sendOne`/`sendBatch`/`deliver`) |
| Delivery recovery | `recoverPendingDeliveries`, `resetStaleNewsDeliveries`, `listRecoverableNewsIds` |
| Batching / rate limiting | `DELIVERY_BATCH_SIZE`/`DELIVERY_BATCH_DELAY`, `retry_after` honoured and capped |

A crash mid-send leaves a `sending` claim that the startup recovery resets, so a
student is neither missed nor double-delivered. Terminal `sent`/`skipped` rows
are never resent.

## 7. Notifications compatibility

The Python "notifications compatibility" layer is preserved in
`src/notifications.js` and `src/db/notifications.js`: a broadcast logs an
`audience`/`recipients`/`delivered` row, batches at `BROADCAST_BATCH_SIZE` with
`BROADCAST_BATCH_DELAY`, isolates per-recipient failures, and a targeted
announcement can be sent to the admins holding a permission
(`broadcastToAdmins`).

## 8. Contributions

`src/ui/contributions.js` + `src/db/contributions.js` preserve the student
submission flow (choose a real target section/resource, submit, track status) and
the admin review flow (approve/reject), gated by `can_contributions`.

## 9. Visibility

`src/visibility.js` + `src/db/settings.js` preserve feature visibility: hiding a
feature removes its home button for regular users and blocks its callbacks,
while admins keep an entry point so they can restore it. Stored in `settings`,
so no schema change.

## 10. AI and resource search

| Python | JavaScript | Notes |
|---|---|---|
| `ai.py`, `ai_architect.py`, `ai_discovery.py`, `ai_router.py` | `src/ai/` | `providers.js`, `router.js`, `prompts.js`, `guard.js`, `intent.js`, `index.js`. |
| `medical_sources.py` | `src/medicalSources.js` | Scientific-source requirement. |
| `search_engine.py` | `src/searchEngine.js` | Registry-grounded search. |

Boundaries preserved: MEDBOT's AI is **not** a general unrestricted medical
chatbot. Resource search answers only from registered MEDBOT resources, general
and medical explanations stay cautious, and the assistant must never invent
resources, folders, lectures or links. Where a medical claim is made, scientific
sources are required; the grounding validator (`src/ai/guard.js`) enforces this.

`ai_architect.py` and `mcq_quiz.py` were audited: `mcq_quiz.py` is **dead code**
in Python (its `register_quiz_handlers` is never called from `main.py`), so no
equivalent was added — inventing a quiz feature would exceed the Python
behaviour. Model discovery/health from `ai_discovery.py`/`ai_router.py` is
reimplemented in `src/ai/router.js`.

## 11. Emergency Resource Archive

| Python | JavaScript | Notes |
|---|---|---|
| `archive.py` | `src/archive.js` | Standalone disaster-recovery channel mirror. |
| `database.py` archive helpers | `src/db/notifications.js` | `archive_sync` rows + status transitions. |
| Admin surface | `src/ui/adminSettings.js` | `admin_archive`, `archive_resync`, `archive_retry`, `archive_status`. |

The mirror is **registration-driven**, exactly as in Python: a resource is posted
when it is uploaded (`src/ui/adminFolders.js`) or when a contribution is approved
(`src/ui/contributions.js`), and an admin can sweep or retry from the surface.
Startup does **not** sweep the catalog — there is deliberately no boot-time
resync, so no test asserts one. Enablement is environment-only
(`MEDBOT_ARCHIVE_CHANNEL` / `ARCHIVE_CHANNEL_ID`), the channel is never
hardcoded, and publication identity is the normalised (title, type, file_id)
triple so a rename or a move cannot republish the same file.

`ai_architect.py` is **dead code** in Python (nothing imports it; the only
matches are the unrelated word "architecture"), so no equivalent was written —
reimplementing it would add a feature the Python bot never runs.

## 12. Audit

`src/audit.js` + `src/db/audit.js`: privileged actions are recorded append-only
with actor, role, action, target and details. Viewing is limited to the owner and
`can_admins`. Auditing is best-effort and never blocks the action.

## 13. Telegram handlers and keyboards

| Python | JavaScript | Notes |
|---|---|---|
| `main.py` registration + handler pyramid | `src/telegram/router.js`, `src/telegram/adapter.js` | Ordered routes; subsystem namespaces register before the generic fallback. |
| `messaging.py` | `src/ui/messages.js` | Student inbox + admin replies. |
| i18n (`i18n.py`) | `src/i18n.js` | Arabic UI strings. |
| Keyboards | `src/ui/*.js`, `src/telegram/ui.js` | Per-screen builders, not one giant file. |
| Workflow state | `src/workflow.js` | Single-owner state so a message is consumed once. |

The Telegram client (`src/telegram/client.js`) is a small dependency-free
`fetch` transport, which keeps the project free of a heavy client library and
makes the transport trivially stubbable in tests.

## 14. Tests and configuration

| Python test | JavaScript equivalent |
|---|---|
| `test_db_patch.py` | `test/database.test.js` |
| `test_medbot_system.py` | `test/database.test.js`, `test/startup.test.js` |
| `test_rbac_audit.py` | `test/rbac.test.js`, `test/notify.test.js` |
| `test_news_core.py`, `test_news_phase2*.py`, `test_news_phase3.py` | `test/news.test.js`, `test/delivery.test.js` |
| `test_visibility.py` | `test/notify.test.js` |
| `test_contribution_ux.py` | `test/contributions.test.js` |
| `test_ai*.py`, `test_medbot_grounding.py`, `test_medbot_search_intent.py` | `test/ai.test.js` |
| `test_keys.py`, `test_messaging.py`, `test_medbot_router.py` | `test/telegram.test.js`, `test/startup.test.js` |
| `test_medbot_fixes.py` | `test/telegram.test.js`, `test/messages.test.js` (workflow ownership, `/cancel`, reply audit) |
| `test_medbot_phase2.py` | `test/contributions.test.js` (review columns, reviewer + reason, double-review guards) |
| `test_news_phase2_fixes.py` | `test/delivery.test.js` (startup recovery, crash-window semantics) |
| `test_archive_sync.py` | `test/archive.test.js` |
| `test_platform_update.py` | `test/admin.test.js` (owner transfer, new permission keys) |
| `test_medbot_performance.py` | `test/database.test.js`, `test/startup.test.js` (pragmas, breadcrumbs, pool reuse) |

Run with `npm test` (`node --test`). Configuration is environment-driven and
documented in `.env.example`; there is no Python runtime file in this repository.
