# Feature-parity checklist

Parity is claimed only for behaviour that is implemented **and** covered by a
passing test. Everything below is backed by `npm test`.

Status legend: ✅ implemented + tested · ⚠️ implemented, test is partial ·
❌ not in the JavaScript version.

## Database and migrations

| # | Feature | Status | Test |
|---|---|---|---|
| 1 | Core schema (folders, content, topics, users, admins, settings) | ✅ | `database.test.js` |
| 2 | Migrations v1–v17, additive and idempotent | ✅ | `database.test.js` |
| 3 | v17 folds legacy `resource` news kind into `section` | ✅ | `database.test.js` |
| 4 | Re-running the chain is a no-op | ✅ | `database.test.js` |
| 5 | Registry accessors (folders, files, breadcrumbs, parents) | ✅ | `database.test.js` |
| 6 | Identifier/reference guards reject bad ids | ✅ | `database.test.js` |

## Authorization and Scoped RBAC

| # | Feature | Status | Test |
|---|---|---|---|
| 7 | Owner/super-admin has full authority | ✅ | `rbac.test.js` |
| 8 | Non-admin is denied everything | ✅ | `rbac.test.js` |
| 9 | Deny-by-default for explicit `PERMISSIONS_NONE` | ✅ | `rbac.test.js` |
| 10 | Legacy empty-permission admin keeps full access | ✅ | `rbac.test.js` |
| 11 | Per-permission capability checks | ✅ | `rbac.test.js` |
| 12 | Folder scope covers the whole subtree | ✅ | `rbac.test.js` |
| 13 | Topic scope covers every linked folder | ✅ | `rbac.test.js` |
| 14 | Resource scope covers exactly one resource | ✅ | `rbac.test.js` |
| 15 | Scope filtering of the admin's browsing surface | ✅ | `rbac.test.js`, `admin.test.js` |
| 16 | Grant/revoke/clear scopes | ✅ | `admin.test.js` |
| 17 | Multiple scopes per admin | ✅ | `admin.test.js` |

## Scope picker (latest intended UX)

| # | Feature | Status | Test |
|---|---|---|---|
| 18 | Single hierarchical browser, no "type" pre-question | ✅ | `admin.test.js` |
| 19 | Root lists real folders/topics, drill-down navigates children | ✅ | `admin.test.js` |
| 20 | Every selectable node has its own selection button | ✅ | `admin.test.js` |
| 21 | Selecting a parent section, a child section, or one resource | ✅ | `admin.test.js` |
| 22 | Picker stays open to add further scopes | ✅ | `admin.test.js` |
| 23 | Already-granted nodes are marked (✅) | ✅ | `admin.test.js` |

## Admin features

| # | Feature | Status | Test |
|---|---|---|---|
| 24 | Admin roster with roles and revocation state | ✅ | `admin.test.js` |
| 25 | Role changes and permission editing | ✅ | `admin.test.js` |
| 26 | Owner transfer / stale-owner demotion | ✅ | `admin.test.js` |
| 27 | Folder/topic/resource administration | ✅ | `admin.test.js`, `database.test.js` |
| 28 | Platform settings | ✅ | `admin.test.js` |
| 28a | Role reference screen (every role explained, owner not assignable) | ✅ | `admin.test.js` |
| 28b | Permissions/scope guide screen | ✅ | `admin.test.js` |
| 28c | Read-only admin interface preview (+ `admin_preview` audit) | ✅ | `admin.test.js` |
| 28d | Audit viewer filterable by action | ✅ | `admin.test.js`, `notify.test.js` |
| 28e | Upload resource: capture → suggested title → confirm/custom/cancel | ✅ | `folders.test.js` |
| 28f | Upload preview enforces scope on the held file (stale/forged session) | ✅ | `folders.test.js` |

## News

| # | Feature | Status | Test |
|---|---|---|---|
| 29 | Two-kind model only: 🚨 `notify`, 📚 `section` | ✅ | `news.test.js` |
| 30 | No separate "Resource News" type | ✅ | `news.test.js` |
| 31 | A section item may link a resource (property, not a kind) | ✅ | `news.test.js`, `delivery.test.js` |
| 32 | News Center feed (published view) | ✅ | `news.test.js` |
| 33 | draft → published → archived lifecycle | ✅ | `news.test.js` |
| 34 | Archive hides but keeps a news item | ✅ | `news.test.js` |
| 35 | Read tracking (unread until opened) | ✅ | `news.test.js` |
| 36 | Admin News UX: publish / published / archive | ✅ | `news.test.js` |
| 37 | Publish metadata: title/body/doctor/event | ✅ | `news.test.js` |
| 38 | Preview → publish path | ✅ | `news.test.js` |
| 39 | Student News UX: all / important / section | ✅ | `news.test.js` |
| 40 | Title/body length limits enforced | ✅ | `news.test.js` |
| 41 | Invalid references are rejected at creation | ✅ | `news.test.js` |

## Subscriptions and private delivery

| # | Feature | Status | Test |
|---|---|---|---|
| 42 | Type subscription (🚨 / 📚) | ✅ | `news.test.js` |
| 43 | Section-specific subscription | ✅ | `news.test.js`, `delivery.test.js` |
| 44 | Manage followed sections UX | ✅ | `news.test.js` |
| 45 | Audience resolution (type + section followers) | ✅ | `delivery.test.js` |
| 46 | Private delivery to each subscriber | ✅ | `delivery.test.js` |
| 47 | Batching of a large audience | ✅ | `delivery.test.js` |
| 48 | Rate limiting between batches | ✅ | `delivery.test.js` |
| 49 | `retry_after` honoured and capped | ✅ | `delivery.test.js` |
| 50 | Bounded retries (no infinite loop) | ✅ | `delivery.test.js` |
| 51 | Failure isolated per recipient | ✅ | `delivery.test.js` |
| 52 | Recovery of a crashed mid-send claim | ✅ | `delivery.test.js` |
| 53 | No double-delivery of a terminal row | ✅ | `delivery.test.js` |
| 54 | Retry only the failed recipients | ✅ | `delivery.test.js` |
| 55 | Delivery text/markup mirrors the News Center | ✅ | `delivery.test.js` |
| 56 | Dead resource link degrades to the News Center | ✅ | `delivery.test.js` |

## Notifications, visibility, audit

| # | Feature | Status | Test |
|---|---|---|---|
| 57 | Broadcast log (audience/recipients/delivered) | ✅ | `notify.test.js` |
| 58 | Broadcast reaches every registered student | ✅ | `notify.test.js` |
| 59 | A blocked recipient does not stop the broadcast | ✅ | `notify.test.js` |
| 60 | Targeted announcement to permission-holders | ✅ | `notify.test.js` |
| 61 | Unknown permission targets nobody | ✅ | `notify.test.js` |
| 62 | Hidden features removed from the student surface | ✅ | `notify.test.js` |
| 63 | Feature visibility round-trip | ✅ | `notify.test.js` |
| 64 | Audit log records actor/action/target | ✅ | `notify.test.js` |
| 65 | Audit log is append-only | ✅ | `notify.test.js` |
| 66 | Audit filter by action | ✅ | `notify.test.js` |

## Contributions

| # | Feature | Status | Test |
|---|---|---|---|
| 67 | Choose a real target (section/resource) | ✅ | `contributions.test.js` |
| 68 | Student submission flow | ✅ | `contributions.test.js` |
| 69 | Contribution status tracking | ✅ | `contributions.test.js` |
| 70 | Admin review (approve/reject) | ✅ | `contributions.test.js` |
| 71 | Review gated by `can_contributions` | ✅ | `contributions.test.js` |

## AI and resource search


| # | Feature | Status | Test |
|---|---|---|---|
| 72 | Resource search answers from registered MEDBOT resources only | ✅ | `ai.test.js` |
| 73 | Registry-grounded overview | ✅ | `ai.test.js` |
| 74 | Assistant never invents resources/folders/links | ✅ | `ai.test.js` |
| 75 | Medical answers require scientific sources | ✅ | `ai.test.js`, `notify`-adjacent guard |
| 76 | Cautious general/medical explanation boundary | ✅ | `ai.test.js` |
| 77 | Intent classification (resource vs. general) | ✅ | `ai.test.js` |
| 78 | Grounding validator rejects ungrounded claims | ✅ | `ai.test.js` |
| 79 | Provider failover/health bookkeeping | ⚠️ | `ai.test.js` (routing covered; live provider calls not exercised) |

## Telegram UX and workflows

| # | Feature | Status | Test |
|---|---|---|---|
| 80 | Ordered callback routing | ✅ | `telegram.test.js` |
| 81 | Subsystem namespaces win over the generic fallback | ✅ | `telegram.test.js` |
| 82 | Single-owner workflow state (one consumer per message) | ✅ | `telegram.test.js` |
| 83 | `/cancel` clears every armed workflow | ✅ | `telegram.test.js` |
| 84 | An unconsumed message never dead-ends the student | ✅ | `telegram.test.js` |
| 85 | Command routing (`/start`, `/quota`, `/whoami`, `/search`, `/ask`, `/cancel`, `/contact`) | ✅ | `startup.test.js`, `commands.test.js` |
| 85b | `/quota` reports the shared daily allowance (25, as Python) | ✅ | `commands.test.js` |
| 85c | `/whoami` never auto-promotes the first caller | ✅ | `commands.test.js` |
| 85d | `/search` and the search button both arm the pending-query marker | ✅ | `commands.test.js` |
| 85e | `/ask <q>` answers in chat mode and charges one allowance unit | ✅ | `commands.test.js` |
| 85f | Callback taps carry the query id and message id through the context (the tap is acknowledged and the screen edits in place) | ✅ | `telegram.test.js` |
| 86 | Media (document/photo) routing | ✅ | `telegram.test.js` |
| 87 | Keyboard builders for each screen | ✅ | `admin.test.js`, `news.test.js` |
| 87b | Library `folder:` / `file:` drill-down lists only real rows | ✅ | `telegram.test.js` |
| 87c | `library:` / `library_parent:` root + parent-aware back navigation | ✅ | `telegram.test.js` |
| 87d | Topics-menu "open resources" (`library:0`) resolves, not a stale button | ✅ | `telegram.test.js`, `topics.test.js` |
| 87e | Family prefixes (`msg_`, `admin_folder_`) reach their handler | ✅ | `telegram.test.js` |
| 87f | Every rendered `btn()` callback is claimed by some route | ✅ | `telegram.test.js` |
| 87g | Section creation walks parent → name → type → accepts | ✅ | `folders.test.js` |
| 87h | Section parent picker is the real hierarchy, not a flat prompt | ✅ | `folders.test.js` |
| 87i | Folder `node_type` vocabulary matches Python (`books`/`summaries`) | ✅ | `folders.test.js` |
| 87j | Section detail offers upload, retype, move and child navigation | ✅ | `folders.test.js` |
| 87k | A scoped admin cannot create a top-level section | ✅ | `folders.test.js` |

## Startup and configuration

| # | Feature | Status | Test |
|---|---|---|---|
| 88 | `createBot` migrates, wires routes, warms caches | ✅ | `startup.test.js` |
| 89 | Boot is idempotent and schema exists after boot | ✅ | `startup.test.js` |
| 90 | Long-polling advances the offset past each update | ✅ | `startup.test.js` |
| 91 | Every update type requested, so a stale filter cannot hide button presses | ✅ | `startup.test.js` |
| 92 | Polling survives a transient transport failure | ✅ | `startup.test.js` |
| 93 | 401/429 surfacing from the transport | ✅ | `startup.test.js` |
| 94 | Delivery recovery started on boot | ✅ | `startup.test.js`, `delivery.test.js` |
| 95 | Environment-driven configuration | ⚠️ | `.env.example`; not asserted by a test |

## Emergency Resource Archive

| # | Feature | Status | Test |
|---|---|---|---|
| 96 | Enablement is env-only (`MEDBOT_ARCHIVE_CHANNEL` / `ARCHIVE_CHANNEL_ID`) | ✅ | `archive.test.js` |
| 97 | Numeric channel id sent as number, `@username` as string | ✅ | `archive.test.js` |
| 98 | Resource identity is (normalised title, type, file_id) — a rename/move cannot republish | ✅ | `archive.test.js` |
| 99 | Publication is idempotent (one post per resource) | ✅ | `archive.test.js` |
| 100 | Media dispatch by registered file type | ✅ | `archive.test.js` |
| 101 | Per-folder section header posted once | ✅ | `archive.test.js` |
| 102 | A failed send is recorded, never thrown | ✅ | `archive.test.js` |
| 103 | Resync skips published rows, mirrors pending ones | ✅ | `archive.test.js` |
| 104 | Retry reaches only failed rows and never reconstructs an orphan | ✅ | `archive.test.js` |
| 105 | Admin surface: `archive_resync` / `archive_retry` / `archive_status` | ✅ | `archive.test.js` |
| 106 | Resync/retry are authorized and audited | ✅ | `archive.test.js` |
| 107 | Upload/approved contribution mirror with the header, best-effort | ✅ | `archive.test.js` |
| 108 | No startup resync (matches Python; the mirror is registration-driven) | ✅ | `startup.test.js` |

## Deliberate divergences

| Item | Divergence | Reason |
|---|---|---|
| `/help` | Registered in JS, absent in Python | Convenience alias that replies with the platform `help_text` setting and the home keyboard. It is additive: the Python command set (`/start`, `/quota`, `/whoami`, `/search`, `/cancel`, `/ask`, `/contact`) is fully preserved, so no Python behaviour is lost. |

## Deliberately out of scope

| Item | Reason |
|---|---|
| `mcq_quiz.py` quiz bank | Dead code in Python (`register_quiz_handlers` is never called from `main.py`). Adding it would invent a feature the Python bot does not run. |
| Live Telegram polling against the real Bot API | Requires a real `BOT_TOKEN`; the polling path itself is covered with a stubbed transport. |
| Live LLM provider calls | Requires provider credentials; routing, grounding and boundaries are covered with stubs. |
