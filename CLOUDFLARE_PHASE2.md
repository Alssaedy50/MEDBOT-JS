# MEDBOT-JS — Cloudflare Migration Phase 2

## Scope

Phase 2 establishes the D1 database adapter and a fresh-database schema
contract without switching the production bot away from SQLite.

## Implemented

- `src/db/d1/core.js`
  - async `all/get/run/exec`
  - atomic multi-statement `batch`
  - D1 constraint-error normalization
  - dependency-injected adapter factory
- `src/db/d1/migrations.js`
  - final MEDBOT schema contract at version 17
  - fresh-D1 bootstrap
  - schema version marker
- `test/d1Core.test.js`
  - adapter and schema contract tests

## Compatibility decision

Cloudflare D1 prepared-statement `raw()` returns rows as arrays. MEDBOT's
current SQLite layer intentionally uses positional arrays, so the adapter
preserves that part of the existing contract.

D1 is asynchronous. The current SQLite `withTransaction(fn)` helper is
synchronous and callback-based, so it is not silently emulated. Multi-statement
Cloudflare transactions use D1's atomic `batch()` boundary and will be
introduced module-by-module during the domain-port phase.

## Production safety

This phase does NOT:

- delete or modify the SQLite database;
- change Telegram transport;
- enable Telegram webhook;
- copy production data to D1;
- replace the existing database facade;
- move binary resources into D1;
- change RBAC, news, AI, contribution, or resource semantics.

## Data migration remains separate

The next database operation is a verified SQLite-to-D1 data transfer:

1. create a real D1 database;
2. bootstrap schema version 17;
3. export/transform SQLite data;
4. import into a staging D1 database;
5. run row-count, key, foreign-key and semantic checks;
6. only then prepare production cutover.

No production data is touched by Phase 2.
