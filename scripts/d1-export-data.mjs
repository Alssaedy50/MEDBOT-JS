#!/usr/bin/env node
/**
 * Generate a D1-safe data-only SQL import from the live SQLite database.
 *
 * Safety:
 * - opens SQLite read-only;
 * - never writes to the source database;
 * - never contacts Cloudflare;
 * - exports only MEDBOT application tables;
 * - preserves explicit primary keys;
 * - keeps every SQL statement below D1's 100 KB statement limit;
 * - writes a manifest with row counts and SHA-256 of the generated SQL.
 *
 * Usage:
 *   node scripts/d1-export-data.mjs --sqlite ./medbot_v2.sqlite3 --output ./artifacts/d1-data.sql
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { finished } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const EXPECTED_TABLES = [
  'users',
  'folders',
  'content',
  'contributions',
  'about_us',
  'settings',
  'daily_ai_usage',
  'admins',
  'ai_registry',
  'ai_model_usage',
  'messages',
  'audit_log',
  'topics',
  'topic_folders',
  'notifications',
  'archive_sync',
  'news',
  'news_reads',
  'news_subscriptions',
  'news_deliveries',
  'admin_scopes',
  'telegram_updates',
];

const MAX_STATEMENT_BYTES = 90_000;

function usage(message = '') {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/d1-export-data.mjs --sqlite <path> --output <sql-path> [--manifest <json-path>]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) usage(`Unknown argument: ${value}`);
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) usage(`Missing value for --${key}`);
    args[key] = next;
    i += 1;
  }
  if (!args.sqlite || !args.output) usage();
  return args;
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Unsupported numeric value: ${value}`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString('hex')}'`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function primaryKeyOrder(columns) {
  return columns
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => quoteIdent(column.name))
    .join(', ');
}

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .map((row) => ({ name: row[1], pk: row[5] }));
}

function foreignParents(db, table) {
  return db
    .prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`)
    .all()
    .map((row) => String(row[2]))
    .filter((name) => EXPECTED_TABLES.includes(name) && name !== table);
}

function selfReferences(db, table) {
  return db
    .prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`)
    .all()
    .filter((row) => String(row[2]) === table)
    .map((row) => ({ from: String(row[3]), to: String(row[4]) }));
}

function orderRowsForSelfReferences(db, table, columns, rows) {
  const references = selfReferences(db, table);
  if (!references.length || !rows.length) return rows;
  if (references.length !== 1 || !references[0].from || !references[0].to) {
    throw new Error(`Unsupported self-referential schema in table: ${table}`);
  }

  const reference = references[0];
  const fromIndex = columns.findIndex((column) => column.name === reference.from);
  const toIndex = columns.findIndex((column) => column.name === reference.to);
  if (fromIndex < 0 || toIndex < 0) {
    throw new Error(`Self-reference columns are missing in table: ${table}`);
  }

  const pending = new Map();
  for (const row of rows) pending.set(String(row[toIndex]), row);
  const ordered = [];

  while (pending.size) {
    let progressed = false;
    for (const [key, row] of pending) {
      const parent = row[fromIndex];
      if (parent === null || parent === undefined || !pending.has(String(parent))) {
        ordered.push(row);
        pending.delete(key);
        progressed = true;
      }
    }
    if (!progressed) {
      throw new Error(`Self-referential row cycle detected in table: ${table}`);
    }
  }

  return ordered;
}

function topoOrder(db) {
  const remaining = new Set(EXPECTED_TABLES);
  const ordered = [];

  while (remaining.size) {
    const ready = [...remaining].filter((table) =>
      foreignParents(db, table).every((parent) => !remaining.has(parent)),
    );

    if (!ready.length) {
      throw new Error(
        `Foreign-key dependency cycle detected among: ${[...remaining].join(', ')}`,
      );
    }

    ready.sort();
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }

  return ordered;
}

async function writeStatement(stream, sql) {
  const bytes = Buffer.byteLength(sql, 'utf8');
  if (bytes > MAX_STATEMENT_BYTES) {
    throw new Error(
      `Generated statement for D1 is ${bytes} bytes, above safety limit ${MAX_STATEMENT_BYTES}`,
    );
  }
  if (stream.write(sql)) return;
  await new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

async function exportData({ sqlitePath, outputPath, manifestPath }) {
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite file not found: ${sqlitePath}`);
  }

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(manifestPath)), { recursive: true });

  const db = new DatabaseSync(sqlitePath, { readOnly: true, returnArrays: true });
  const available = new Set(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => String(row[0])),
  );

  const missing = EXPECTED_TABLES.filter((table) => !available.has(table));
  if (missing.length) {
    db.close();
    throw new Error(`SQLite schema is missing required MEDBOT tables: ${missing.join(', ')}`);
  }

  const order = topoOrder(db);
  const manifest = {
    format: 1,
    source: path.resolve(sqlitePath),
    generated_at: new Date().toISOString(),
    statement_limit_bytes: MAX_STATEMENT_BYTES,
    table_order: order,
    tables: {},
  };

  const stream = fs.createWriteStream(outputPath, { encoding: 'utf8' });
  stream.write(
    '-- MEDBOT-JS SQLite -> Cloudflare D1 data-only export\n' +
      '-- Generated by scripts/d1-export-data.mjs\n' +
      '-- Source database is opened read-only; this file does not create or alter schema.\n' +
      'PRAGMA defer_foreign_keys = ON;\n\n',
  );

  try {
    for (const table of order) {
      const columns = tableColumns(db, table);
      if (!columns.length) throw new Error(`No columns found for table: ${table}`);

      const names = columns.map((column) => quoteIdent(column.name));
      const select = `SELECT ${names.join(', ')} FROM ${quoteIdent(table)}`;
      const orderBy = primaryKeyOrder(columns);
      const rows = orderRowsForSelfReferences(
        db,
        table,
        columns,
        db.prepare(orderBy ? select + ' ORDER BY ' + orderBy : select).all(),
      );

      let rowsExported = 0;
      for (const row of rows) {
        const values = row.map(quoteValue);
        const sql =
          `INSERT INTO ${quoteIdent(table)} (${names.join(', ')}) VALUES (${values.join(', ')});\n`;
        await writeStatement(stream, sql);
        rowsExported += 1;
      }

      manifest.tables[table] = { rows: rowsExported, columns: columns.map((c) => c.name) };
    }
  } finally {
    stream.write('\n-- End of MEDBOT-JS data export\n');
    stream.end();
    await finished(stream);
    db.close();
  }

  const sql = fs.readFileSync(outputPath);
  manifest.bytes = sql.byteLength;
  manifest.sha256 = crypto.createHash('sha256').update(sql).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return manifest;
}

const args = parseArgs(process.argv.slice(2));
const outputPath = path.resolve(args.output);
const manifestPath = path.resolve(
  args.manifest ?? outputPath.replace(/\.sql$/i, '') + '.manifest.json',
);

try {
  const manifest = await exportData({
    sqlitePath: path.resolve(args.sqlite),
    outputPath,
    manifestPath,
  });
  const total = Object.values(manifest.tables).reduce((sum, item) => sum + item.rows, 0);
  console.log(
    `D1 export ready: ${manifest.bytes} bytes, ${total} rows, sha256=${manifest.sha256}`,
  );
  console.log(`SQL: ${outputPath}`);
  console.log(`Manifest: ${manifestPath}`);
} catch (error) {
  console.error(`D1 export failed: ${error.message}`);
  process.exitCode = 1;
}
