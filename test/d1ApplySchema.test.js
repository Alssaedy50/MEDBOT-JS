import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { D1_SCHEMA_VERSION, getD1SchemaSql } from '../src/db/d1/migrations.js';
import { buildSchemaFile } from '../scripts/d1-apply-schema.mjs';

function run(args, options = {}) {
  return execFileSync(process.execPath, ['scripts/d1-apply-schema.mjs', ...args], {
    cwd: process.cwd(),
    stdio: 'pipe',
    ...options,
  });
}

test('schema helper materialises the reviewed schema v18 verbatim', () => {
  const sql = buildSchemaFile();
  assert.equal(D1_SCHEMA_VERSION, 18);
  assert.match(sql, new RegExp('schema v' + D1_SCHEMA_VERSION));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS telegram_updates/);
  assert.ok(sql.includes(getD1SchemaSql()));
});

test('schema helper writes to --output and --check passes when current', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medbot-d1-schema-'));
  const output = path.join(dir, 'd1-schema.sql');
  try {
    const stdout = run(['--output', output]);
    assert.match(String(stdout), /d1-schema\.sql/);
    assert.ok(fs.existsSync(output));

    const current = fs.readFileSync(output, 'utf8');
    assert.match(current, /CREATE TABLE IF NOT EXISTS schema_meta/);

    const check = run(['--output', output, '--check']);
    assert.match(String(check), /up to date/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema helper refuses to overwrite a stale file without --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medbot-d1-schema-'));
  const output = path.join(dir, 'd1-schema.sql');
  try {
    fs.writeFileSync(output, '-- stale\n');
    assert.throws(() => run(['--output', output]), /Command failed|status 1/);
    assert.equal(fs.readFileSync(output, 'utf8'), '-- stale\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema helper --check fails when the file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medbot-d1-schema-'));
  const output = path.join(dir, 'missing.sql');
  try {
    assert.throws(() => run(['--output', output, '--check']), /Command failed|status 1/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
