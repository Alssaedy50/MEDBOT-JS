import test from 'node:test';
import assert from 'node:assert/strict';

import {
  all,
  get,
  run,
  exec,
  batch,
  createD1Adapter,
} from '../src/db/d1/core.js';
import { D1_SCHEMA_VERSION, getD1SchemaSql } from '../src/db/d1/migrations.js';

function mockD1() {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      calls.push({ type: 'prepare', sql });
      return {
        bind(...params) {
          calls.push({ type: 'bind', params });
          return this;
        },
        async raw() {
          calls.push({ type: 'raw' });
          return [[7, 'Hematology'], [8, 'MSK']];
        },
        async run() {
          calls.push({ type: 'run' });
          return {
            success: true,
            meta: { changes: 1, last_row_id: 42 },
            results: [],
          };
        },
      };
    },
    async exec(sql) {
      calls.push({ type: 'exec', sql });
      return { count: 2, duration: 1 };
    },
    async batch(statements) {
      calls.push({ type: 'batch', count: statements.length });
      return statements.map(() => ({
        success: true,
        meta: { changes: 1, last_row_id: 1 },
        results: [],
      }));
    },
  };
  return db;
}

test('D1 all() preserves positional row semantics through raw()', async () => {
  const db = mockD1();
  const rows = await all(db, 'SELECT id, name FROM folders WHERE id > ?', [5]);

  assert.deepEqual(rows, [[7, 'Hematology'], [8, 'MSK']]);
  assert.deepEqual(db.calls.slice(0, 3), [
    { type: 'prepare', sql: 'SELECT id, name FROM folders WHERE id > ?' },
    { type: 'bind', params: [5] },
    { type: 'raw' },
  ]);
});

test('D1 get() returns the first positional row', async () => {
  const db = mockD1();
  assert.deepEqual(await get(db, 'SELECT id, name FROM folders LIMIT 1'), [
    7,
    'Hematology',
  ]);
});

test('D1 run() normalizes D1 write metadata to the SQLite helper contract', async () => {
  const db = mockD1();
  assert.deepEqual(await run(db, 'INSERT INTO folders(name) VALUES (?)', ['MSK']), {
    changes: 1,
    lastInsertRowid: 42,
  });
});

test('D1 exec() delegates schema/maintenance SQL to D1', async () => {
  const db = mockD1();
  assert.deepEqual(await exec(db, 'CREATE TABLE test(id INTEGER)'), {
    count: 2,
    duration: 1,
  });
});

test('D1 batch() provides the atomic multi-statement boundary', async () => {
  const db = mockD1();
  const result = await batch(db, [
    { sql: 'UPDATE users SET username = ? WHERE user_id = ?', params: ['a', 1] },
    { sql: 'UPDATE users SET username = ? WHERE user_id = ?', params: ['b', 2] },
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(db.calls.at(-1), { type: 'batch', count: 2 });
});

test('createD1Adapter exposes dependency-injected async primitives', async () => {
  const db = mockD1();
  const adapter = createD1Adapter(db);

  assert.deepEqual(await adapter.get('SELECT id, name FROM folders LIMIT 1'), [
    7,
    'Hematology',
  ]);
  assert.equal(typeof adapter.batch, 'function');
});

test('D1 schema contract is version 18 and contains core MEDBOT tables', () => {
  const sql = getD1SchemaSql();

  assert.equal(D1_SCHEMA_VERSION, 18);
  for (const table of [
    'users',
    'folders',
    'content',
    'contributions',
    'admins',
    'ai_registry',
    'news',
    'news_deliveries',
    'admin_scopes',
    'telegram_updates',
    'schema_meta',
  ]) {
    assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
  }

  assert.match(sql, /schema_version/);
  assert.match(sql, /idx_news_auto_resource_unique/);
});
