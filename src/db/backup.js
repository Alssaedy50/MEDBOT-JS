/**
 * Portable MEDBOT state snapshots.
 *
 * The SQLite file is an implementation detail; this snapshot is the durable,
 * migration-safe representation of every application table. It is suitable for
 * Telegram export, external backup storage, and disaster recovery after an
 * ephemeral deployment is recreated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDbPath, withDb, withTransaction } from './core.js';

const FORMAT = 'medbot-state';
const VERSION = 1;
const EXCLUDED_TABLES = new Set(['sqlite_sequence']);

function encodeValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  return value;
}

function decodeValue(value) {
  if (value && typeof value === 'object' && value.__type === 'blob') {
    return Buffer.from(String(value.base64 ?? ''), 'base64');
  }
  return value;
}

function quoteIdent(value) {
  const text = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new Error('unsafe_identifier');
  return '"' + text.replace(/"/g, '""') + '"';
}

function tableNames(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row[0]).filter((name) => !EXCLUDED_TABLES.has(name));
}

/** Export every application table, including historical audit/configuration data. */
export function exportDatabaseSnapshot(target = null) {
  return withDb((db) => {
    const tables = [];
    for (const name of tableNames(db)) {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all()
        .map((row) => ({ name: row[1], type: row[2], notNull: row[3], defaultValue: row[4], pk: row[5] }));
      const rows = db.prepare(`SELECT * FROM ${quoteIdent(name)}`).all()
        .map((row) => row.map(encodeValue));
      tables.push({ name, columns, rows });
    }
    return {
      format: FORMAT,
      version: VERSION,
      exported_at: new Date().toISOString(),
      database_path: resolveDbPath(),
      tables,
    };
  }, target);
}

export function snapshotToJson(snapshot) {
  if (!snapshot || snapshot.format !== FORMAT || snapshot.version !== VERSION) {
    throw new Error('invalid_medbot_snapshot');
  }
  return JSON.stringify(snapshot);
}

export function snapshotFromJson(text) {
  const snapshot = JSON.parse(String(text));
  if (!snapshot || snapshot.format !== FORMAT || snapshot.version !== VERSION || !Array.isArray(snapshot.tables)) {
    throw new Error('invalid_medbot_snapshot');
  }
  return snapshot;
}

function validateSnapshot(snapshot, db) {
  const live = new Set(tableNames(db));
  for (const table of snapshot.tables) {
    if (!table || !live.has(table.name) || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      throw new Error('snapshot_schema_mismatch');
    }
    const liveColumns = db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all().map((row) => row[1]);
    const snapshotColumns = table.columns.map((column) => column.name);
    if (liveColumns.length !== snapshotColumns.length || liveColumns.some((name, i) => name !== snapshotColumns[i])) {
      throw new Error(`snapshot_columns_mismatch:${table.name}`);
    }
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length !== snapshotColumns.length) throw new Error(`snapshot_row_mismatch:${table.name}`);
    }
  }
}

export function restoreDatabaseSnapshot(snapshot, target = null) {
  return withTransaction((db) => {
    validateSnapshot(snapshot, db);
    const tables = tableNames(db);

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (const table of tables) db.exec(`DELETE FROM ${quoteIdent(table)}`);

      for (const table of snapshot.tables) {
        if (!table.rows.length) continue;
        const columns = table.columns.map((column) => quoteIdent(column.name)).join(', ');
        const placeholders = table.columns.map(() => '?').join(', ');
        const statement = db.prepare(
          `INSERT INTO ${quoteIdent(table.name)} (${columns}) VALUES (${placeholders})`,
        );
        for (const encodedRow of table.rows) statement.run(...encodedRow.map(decodeValue));
      }
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('snapshot_foreign_key_violation');
    return true;
  }, target);
}

export function writeSnapshotFile(snapshot, directory = null) {
  const dir = directory ?? path.dirname(resolveDbPath());
  fs.mkdirSync(dir, { recursive: true });
  const filename = `medbot-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, snapshotToJson(snapshot), { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

export function databaseHasMeaningfulState(target = null) {
  return withDb((db) => {
    const checks = [
      'SELECT COUNT(*) FROM users',
      'SELECT COUNT(*) FROM folders',
      'SELECT COUNT(*) FROM content',
      'SELECT COUNT(*) FROM admins',
      'SELECT COUNT(*) FROM settings',
      'SELECT COUNT(*) FROM contributions',
      'SELECT COUNT(*) FROM news',
    ];
    return checks.some((sql) => Number(db.prepare(sql).get()[0] ?? 0) > 0);
  }, target);
}

export async function restoreRemoteSnapshotIfEmpty({ url, token, target = null, fetchImpl = fetch } = {}) {
  if (!url || !token || databaseHasMeaningfulState(target)) return { restored: false, reason: 'database_has_state' };
  const response = await fetchImpl(String(url).replace(/\/$/, '') + '/latest', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (response.status === 404) return { restored: false, reason: 'no_remote_backup' };
  if (!response.ok) throw new Error(`remote_backup_get_failed:${response.status}`);
  const snapshot = snapshotFromJson(await response.text());
  restoreDatabaseSnapshot(snapshot, target);
  return { restored: true, exported_at: snapshot.exported_at ?? null };
}
