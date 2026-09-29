import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFromJson, snapshotToJson } from '../src/db/backup.js';

test('state snapshot round-trips with format/version validation', () => {
  const source = {
    format: 'medbot-state',
    version: 1,
    exported_at: '2026-09-29T00:00:00.000Z',
    database_path: 'test.sqlite3',
    tables: [{ name: 'users', columns: [{ name: 'user_id' }], rows: [[123]] }],
  };
  assert.deepEqual(snapshotFromJson(snapshotToJson(source)), source);
});

test('invalid snapshot format is rejected', () => {
  assert.throws(() => snapshotFromJson(JSON.stringify({ format: 'other', version: 1, tables: [] })), /invalid_medbot_snapshot/);
});
