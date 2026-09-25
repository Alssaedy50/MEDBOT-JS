/**
 * SQLite access layer for MEDBOT-JS.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5) so the project needs no
 * native build step. The Python MEDBOT used `aiosqlite` with one connection per
 * call and positional row indexing; this module keeps the same semantics:
 *
 *   * every public helper opens and closes its own connection, so callers never
 *     manage handles (matching the Python contract);
 *   * WAL + busy_timeout are configured per connection so concurrent handler
 *     coroutines wait briefly instead of failing with "database is locked";
 *   * foreign keys are enforced.
 *
 * The synchronous `node:sqlite` API is wrapped in async helpers. Node's single
 * threaded execution model means a statement that does not await between its
 * read and write is atomic by construction, which is what the Python code
 * achieved with `BEGIN IMMEDIATE`; explicit transactions are still used where
 * multiple statements must be grouped.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DB_PATH_ENV_VAR, DEFAULT_DB_NAME } from '../constants.js';

let dbName = DEFAULT_DB_NAME;
let dbPathOverride = null;

/**
 * Resolve the effective SQLite database path.
 *
 * Precedence, first match wins:
 *   1. `setDbPath()` — explicit programmatic override (tests).
 *   2. `setDbName()` — when changed from its default.
 *   3. `MEDBOT_DB_PATH` — deployment override.
 *   4. the default relative `medbot_v2.sqlite3`.
 */
export function resolveDbPath() {
  if (dbPathOverride) return dbPathOverride;
  if (dbName !== DEFAULT_DB_NAME) return dbName;
  const envPath = (process.env[DB_PATH_ENV_VAR] ?? '').trim();
  if (envPath) {
    return envPath.startsWith('~')
      ? path.join(os.homedir(), envPath.slice(1))
      : envPath;
  }
  return DEFAULT_DB_NAME;
}

/** Create the DB parent directory if needed and return the path to open. */
export function ensureDbDir(target = null) {
  const resolved = target ?? resolveDbPath();
  const parent = path.dirname(path.resolve(resolved));
  if (parent && !fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
  return resolved;
}

/** Test/deployment hook: pin an explicit database path (null clears it). */
export function setDbPath(target) {
  dbPathOverride = target;
}

/** Test hook: override the database file name (null/undefined clears it). */
export function setDbName(name) {
  dbName = name || DEFAULT_DB_NAME;
}

export function getDbName() {
  return dbName;
}

/** Current effective path (what `openDb` would open). */
export function currentDbPath() {
  return ensureDbDir();
}

function tune(db) {
  db.exec('PRAGMA foreign_keys = ON');
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch {
    // PRAGMA tuning is best-effort, exactly like the Python implementation.
  }
}

/**
 * A `DatabaseSync` whose statements return positional arrays.
 *
 * `node:sqlite` returns rows as objects keyed by column name by default. The
 * Python MEDBOT indexed rows positionally (`row[0]`, `row[1]`, …) and the whole
 * port relies on that shape, so every statement created through this subclass
 * is configured with `setReturnArrays(true)`.
 */
class PositionalDatabase extends DatabaseSync {
  prepare(sql) {
    const statement = super.prepare(sql);
    statement.setReturnArrays(true);
    return statement;
  }
}

/** Open a tuned connection. Callers own it and must close it. */
export function openDb(target = null) {
  const db = new PositionalDatabase(ensureDbDir(target));
  tune(db);
  return db;
}

/**
 * Run `fn(db)` against a fresh connection, always closing it.
 *
 * This is the JS analogue of the Python `db = await get_db(); try: ... finally:
 * await db.close()` idiom, without leaking a handle on an exception.
 */
export function withDb(fn, target = null) {
  const db = openDb(target);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Run `fn` inside an IMMEDIATE transaction, rolling back on any error.
 *
 * `node:sqlite` has no transaction helper; this mirrors the Python
 * `BEGIN IMMEDIATE` / `commit` / `rollback` blocks.
 */
export function withTransaction(fn, target = null) {
  const db = openDb(target);
  try {
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = fn(db);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    }
    db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}

/** Query helper: all rows (positional arrays, like the Python rows). */
export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

/** Query helper: first row, or undefined. */
export function get(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

/** Write helper: run a statement, returning `{ changes, lastInsertRowid }`. */
export function run(db, sql, params = []) {
  const info = db.prepare(sql).run(...params);
  return {
    changes: Number(info.changes ?? 0),
    lastInsertRowid: Number(info.lastInsertRowid ?? 0),
  };
}

/** Execute one or more statements with no parameters. */
export function exec(db, sql) {
  db.exec(sql);
}

/** True when the error is a SQLite constraint violation. */
export function isIntegrityError(error) {
  if (!error) return false;
  const code = error.code ?? error.errcode ?? '';
  const message = String(error.message ?? '');
  return (
    String(code).includes('CONSTRAINT') ||
    /UNIQUE constraint failed|FOREIGN KEY constraint failed|NOT NULL constraint/i.test(
      message,
    )
  );
}
