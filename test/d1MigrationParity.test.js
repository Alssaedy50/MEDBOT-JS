import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDb } from '../src/db/migrations.js';
import { getD1SchemaSql } from '../src/db/d1/migrations.js';

// The tables the SQLite -> D1 exporter transfers. Kept in sync with
// scripts/d1-export-data.mjs (EXPECTED_TABLES).
const EXPORTED_TABLES = [
  'users', 'folders', 'content', 'contributions', 'about_us', 'settings',
  'daily_ai_usage', 'admins', 'ai_registry', 'ai_model_usage', 'messages',
  'audit_log', 'topics', 'topic_folders', 'notifications', 'archive_sync',
  'news', 'news_reads', 'news_subscriptions', 'news_deliveries', 'admin_scopes',
];

function d1Columns() {
  const db = new DatabaseSync(':memory:');
  db.exec(getD1SchemaSql());
  const map = {};
  for (const table of EXPORTED_TABLES) {
    map[table] = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => row.name);
  }
  db.close();
  return map;
}

test('every exported table and column exists in the D1 schema contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medbot-parity-'));
  const sqlite = path.join(dir, 'schema.sqlite3');
  try {
    initDb(sqlite);
    const source = new DatabaseSync(sqlite, { readOnly: true });
    const present = new Set(
      source
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => row.name),
    );
    const d1 = d1Columns();

    for (const table of EXPORTED_TABLES) {
      assert.ok(present.has(table), `SQLite schema is missing exported table: ${table}`);
      assert.ok(d1[table].length > 0, `D1 schema is missing table: ${table}`);
      const sourceColumns = source
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
      const missing = sourceColumns.filter((column) => !d1[table].includes(column));
      assert.deepEqual(missing, [], `D1 schema ${table} is missing columns: ${missing.join(', ')}`);
    }
    source.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
