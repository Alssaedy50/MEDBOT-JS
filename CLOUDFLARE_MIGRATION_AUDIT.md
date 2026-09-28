# MEDBOT-JS — Cloudflare Migration Phase 0 Audit

**Repository:** `Alssaedy50/MEDBOT-JS`  
**Audited branch:** `main`  
**Audited commit:** `ed471cccf15285b3ee668bf4880e8c1a533987e2`  
**Migration branch:** `cloudflare/migration-phase0-audit`  
**Audit scope:** Phase 0 — Freeze, inventory, and Cloudflare compatibility audit  
**Date:** 2026-09-28

## 1. Phase 0 result

The existing MEDBOT-JS implementation is suitable for an incremental Cloudflare migration. The business/domain layer should be preserved. The migration must replace infrastructure boundaries rather than rewrite MEDBOT.

The current application is a Node.js ESM application requiring Node `>=22.5.0`. Its current production runtime is a long-polling Telegram bot with a native HTTP health server and a local SQLite database.

**No production behaviour was changed by Phase 0.**

## 2. Current architecture inventory

### Runtime
- Entry point: `src/index.js`
- Current runtime: Node.js
- Current startup: health HTTP server + Telegram long polling
- Current host-oriented configuration: `render.yaml`, Dockerfile, PORT
- Current graceful process handling: Node process signals/exceptions

### Telegram transport
- `src/telegram/client.js`: dependency-free Telegram Bot API transport using `fetch`
- `src/telegram/adapter.js`: Telegram update normalization and long-poll loop
- `src/telegram/bot.js`: handler assembly and startup
- Current update ingress: `getUpdates` long polling
- Target ingress: Telegram webhook handled by a Worker

### Database
- `src/db/core.js`: Node built-in `node:sqlite` / `DatabaseSync`
- Local filesystem dependencies: `node:fs`, `node:os`, `node:path`
- SQLite tuning: WAL, NORMAL synchronous mode, busy timeout, foreign keys
- Schema/migrations: v1–v17 in `src/db/migrations.js`
- Domain accessors remain split by subsystem
- Target database: Cloudflare D1

### In-memory state
- `src/telegram/adapter.js`: per-user workflow scratch state is stored in a process-local `Map`
- `src/workflow.js`: workflow ownership model depends on that user-data store
- Target: durable state must not depend on Worker process memory

### Background work
- `src/newsDelivery.js`: asynchronous background delivery tasks, bounded batches, retry/backoff and recovery
- `src/telegram/adapter.js`: polling retry loop uses timers
- Target: event-driven/background execution should use Cloudflare-compatible mechanisms (Queues/Workflows where required), not a permanently running process loop

### Health server
- `src/server.js`: native Node `http.createServer`
- This is host-health infrastructure, not MEDBOT business logic
- Target: remove from Worker runtime; Worker fetch handler becomes the HTTP entry point

### AI
- AI routing and medical safety remain in:
  - `src/ai/index.js`
  - `src/ai/router.js`
  - `src/ai/providers.js`
  - `src/ai/guard.js`
  - `src/ai/intent.js`
  - `src/ai/questionType.js`
  - `src/ai/prompts.js`
- External provider credentials are environment secrets
- Current provider pool/failover logic should be preserved
- Cloudflare AI Gateway can be added as an infrastructure layer later; it is not a reason to rewrite MEDBOT's AI logic

### File/archive handling
- Registered resources currently retain Telegram file identity and use Telegram to preview/send resources
- Emergency archive is implemented through `src/archive.js`
- File storage must remain separate from D1
- Future storage abstraction should support Telegram archive plus R2/object storage without exposing provider details to the domain layer

## 3. Migration classification

| Component | Current implementation | Cloudflare action | Risk |
|---|---|---|---|
| Business rules | JS modules | Preserve | Low |
| Telegram UI/routes | Custom adapter/router | Preserve; replace ingress adapter | Medium |
| Telegram API client | fetch-based | Reuse/adapt | Low |
| Long polling | `getUpdates` | Replace with webhook | High |
| SQLite engine | `node:sqlite` | Replace with D1 adapter | High |
| DB schema | v1–v17 | Port/verify against D1 | Medium |
| Local filesystem | fs/path/os | Remove from runtime DB path handling | Medium |
| Workflow state | process-local Map | Durable state strategy | High |
| News background delivery | in-process tasks | Queue/Workflow or bounded request work | High |
| Health HTTP server | native Node HTTP | Worker fetch endpoint | Low |
| AI provider calls | fetch/external APIs | Preserve; optionally add AI Gateway | Medium |
| AI safety/grounding | MEDBOT-owned | Preserve | Low |
| Archive | Telegram | Preserve; later add storage adapter | Medium |
| Tests | Node test suite | Preserve and add Worker/D1 tests | Medium |
| Render config | render.yaml | No longer production runtime | Low |

## 4. Database migration constraints

D1 is SQLite-compatible SQL, but the current implementation is **not** directly portable because it depends on Node's `DatabaseSync` API, filesystem-backed paths, explicit connection opening/closing, and synchronous transaction helpers.

Therefore the correct migration is:

`domain DB accessors -> database port -> SQLite adapter + D1 adapter`

The current schema and migration semantics remain the source of truth. We must not redesign the schema during the runtime migration unless a concrete D1 incompatibility is demonstrated.

D1 binding should be used from the Worker rather than a generic REST round trip.

## 5. Telegram migration constraints

The existing custom Telegram transport is an advantage: there is no Telegraf/grammY framework that must be replaced.

The clean boundary is:

`Telegram update -> MEDBOT context -> existing router/UI`

Only the update ingress and transport lifecycle need Cloudflare-specific work.

Long polling must not coexist with the production webhook for the same bot token. Cutover therefore happens only after the Worker webhook path has passed the test suite and a separate test bot can be used for live validation.

## 6. State migration constraint

The current per-user `Map` is safe for a single long-lived Node process but is not a durable application store.

Cloudflare Workers can execute requests independently. A Worker request must not assume that a previous request used the same isolate.

The workflow state therefore needs an explicit durable store before production webhook cutover. The preferred first candidate is D1 because the state is small and relational; if concurrency semantics require stronger coordination, Durable Objects can be introduced selectively.

## 7. Background delivery constraint

News delivery currently relies on:
- process-local background task tracking;
- timers;
- startup recovery;
- a bounded batch loop.

This cannot simply be copied into a stateless Worker.

The migration must preserve these guarantees:
1. no duplicate reservation for a terminal delivery;
2. recovery of interrupted `sending` claims;
3. per-recipient failure isolation;
4. Telegram `RetryAfter` handling;
5. bounded work;
6. no blocking of the webhook request.

A Queue/Workflow-based implementation should be evaluated during the background-jobs phase rather than mixed into the database migration.

## 8. AI migration boundary

The existing AI architecture should remain MEDBOT-owned.

Target:

`Telegram/Android -> Worker -> MEDBOT AI Router -> provider adapter(s)`

Optional later layer:

`MEDBOT AI Router -> Cloudflare AI Gateway -> external providers / Workers AI`

This keeps provider selection, medical grounding, source validation, answer-depth contracts, safety guard, daily allowance, and fallback policy under MEDBOT control.

## 9. File-storage boundary

D1 must store metadata/references, not large binary resources.

Recommended abstraction:

`FileStore`
- `TelegramStore`
- `R2Store` (when enabled)
- future providers without changing the UI/domain layer

The current Telegram archive remains valuable during migration.

## 10. What must NOT be changed during the next phase

Do not remove or rewrite:
- RBAC/capabilities/scopes
- resource hierarchy
- student contributions
- News Center semantics
- News subscriptions/delivery semantics
- AI grounding and safety rules
- Telegram UI/keyboard semantics
- existing migration history
- existing test coverage

Do not start the Android application work in the Cloudflare migration branch.

## 11. Phase 0 exit criteria

Phase 0 is complete when:
- current main commit is recorded;
- runtime/database/Telegram/AI/state/background/file boundaries are identified;
- Node-only dependencies are identified;
- D1 migration constraints are documented;
- webhook constraints are documented;
- durable-state requirements are documented;
- no production behaviour is modified.

**Phase 0 status: COMPLETE.**

## 12. Next task

**Phase 1 — Cloudflare compatibility skeleton**

The next change should introduce the Worker boundary and Cloudflare configuration on a new migration commit/PR, while leaving the current Node entry point and production behaviour intact.

Phase 1 must not yet switch the production Telegram bot to webhook and must not delete the existing SQLite implementation.
