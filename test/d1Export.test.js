import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TABLES = [
  'users','folders','content','contributions','about_us','settings',
  'daily_ai_usage','admins','ai_registry','ai_model_usage','messages',
  'audit_log','topics','topic_folders','notifications','archive_sync',
  'news','news_reads','news_subscriptions','news_deliveries','admin_scopes',
];

test('D1 exporter reads SQLite read-only and preserves row data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medbot-d1-export-'));
  const sqlite = path.join(dir, 'source.sqlite3');
  const output = path.join(dir, 'd1-data.sql');
  try {
    const db = new DatabaseSync(sqlite);
    for (const table of TABLES) {
      db.exec('CREATE TABLE "' + table + '" (id INTEGER PRIMARY KEY, value TEXT)');
    }
    db.exec("INSERT INTO users(id, value) VALUES (7, 'Hematology')");
    db.exec("INSERT INTO folders(id, value) VALUES (3, 'Second Year')");
    db.close();
    execFileSync(process.execPath, ['scripts/d1-export-data.mjs', '--sqlite', sqlite, '--output', output], { cwd: process.cwd(), stdio: 'pipe' });
    const sql = fs.readFileSync(output, 'utf8');
    assert.match(sql, /INSERT INTO "users" .*VALUES \(7, 'Hematology'\\);/);
    assert.match(sql, /INSERT INTO "folders" .*VALUES \(3, 'Second Year'\\);/);
    const manifestPath = output.replace(/\.sql$//i, '') + '.manifest.json';
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.tables.users.rows, 1);
    assert.equal(manifest.tables.folders.rows, 1);
    assert.equal(typeof manifest.sha256, 'string');
    assert.equal(manifest.sha256.length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
