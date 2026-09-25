/**
 * The MEDBOT database facade.
 *
 * The Python MEDBOT exposed every accessor from one `database` module. This
 * barrel keeps that ergonomic surface — `import * as db from './db/index.js'`
 * then `db.getFolders(0)` — while the implementation stays split into focused
 * modules by concern.
 */

export * from './core.js';
export * from './migrations.js';
// Domain constants live in one module, but re-exported here so the rest of the
// codebase reads them as `db.PERMISSION_KEYS` (as the Python `database.py` did).
export * from '../constants.js';
export * from './users.js';
export * from './registry.js';
export * from './admins.js';
export * from './settings.js';
export * from './news.js';
export * from './scopes.js';
export * from './audit.js';
export * from './messages.js';
export * from './contributions.js';
export * from './topics.js';
export * from './notifications.js';
export * from './aiRegistry.js';
export * from './identifiers.js';
