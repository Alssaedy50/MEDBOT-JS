/**
 * Cloudflare D1 database adapter.
 *
 * D1 is asynchronous. The existing SQLite callers are intentionally not
 * switched in this phase.
 *
 * D1 prepared-statement raw() returns rows as arrays, preserving the
 * positional-row contract used by the current MEDBOT data layer.
 */

function assertDb(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A Cloudflare D1 database binding is required');
  }
}

function bind(statement, params) {
  return params.length ? statement.bind(...params) : statement;
}

export async function all(db, sql, params = []) {
  assertDb(db);
  return bind(db.prepare(sql), params).raw();
}

export async function get(db, sql, params = []) {
  const rows = await all(db, sql, params);
  return rows[0];
}

export async function run(db, sql, params = []) {
  assertDb(db);
  const result = await bind(db.prepare(sql), params).run();
  return {
    changes: Number(result.meta?.changes ?? 0),
    lastInsertRowid: Number(result.meta?.last_row_id ?? 0),
  };
}

export async function exec(db, sql) {
  assertDb(db);
  return db.exec(sql);
}

/**
 * D1's atomic multi-statement boundary.
 *
 * Domain modules that currently use synchronous withTransaction() must be
 * ported to construct their statements and use this async batch API.
 */
export async function batch(db, statements) {
  assertDb(db);
  if (!Array.isArray(statements) || statements.length === 0) return [];
  const prepared = statements.map(({ sql, params = [] }) =>
    bind(db.prepare(sql), params),
  );
  return db.batch(prepared);
}

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

export function createD1Adapter(db) {
  assertDb(db);
  return Object.freeze({
    all: (sql, params = []) => all(db, sql, params),
    get: (sql, params = []) => get(db, sql, params),
    run: (sql, params = []) => run(db, sql, params),
    exec: (sql) => exec(db, sql),
    batch: (statements) => batch(db, statements),
  });
}
