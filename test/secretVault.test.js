import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db/migrations.js';
import { setDbPath } from '../src/db/core.js';
import {
  getRuntimeSecret,
  parseSecretAssignment,
  rekeyRuntimeSecrets,
  setRuntimeSecret,
} from '../src/security/secretVault.js';
import { getSetting } from '../src/db/settings.js';

function withTestDb(fn) {
  const file = path.join(os.tmpdir(), `medbot-secret-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite3`);
  const oldToken = process.env.BOT_TOKEN;
  setDbPath(file);
  process.env.BOT_TOKEN = '123456:TEST_TOKEN';
  try {
    initDb();
    return fn(file);
  } finally {
    if (oldToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = oldToken;
    setDbPath(null);
    try { fs.rmSync(file, { force: true }); } catch { /* cleanup is best-effort */ }
    try { fs.rmSync(`${file}-wal`, { force: true }); } catch { /* cleanup is best-effort */ }
    try { fs.rmSync(`${file}-shm`, { force: true }); } catch { /* cleanup is best-effort */ }
  }
}

test('secret vault encrypts values and round-trips', () => withTestDb(() => {
  setRuntimeSecret('TEST_API_KEY', 'super-secret');
  assert.equal(getRuntimeSecret('TEST_API_KEY'), 'super-secret');
  assert.notEqual(getSetting('secret.v1.TEST_API_KEY'), 'super-secret');
}));

test('secret assignment uses only the first equals and preserves the value', () => {
  assert.deepEqual(
    parseSecretAssignment('TOKEN=a=b=c'),
    { name: 'TOKEN', value: 'a=b=c' },
  );
});

test('secret assignment preserves whitespace and multiline values', () => {
  const value = '  line1\nline2  ';
  assert.deepEqual(parseSecretAssignment(`CUSTOM_SECRET=${value}`), {
    name: 'CUSTOM_SECRET',
    value,
  });
});

test('secret names normalize to uppercase and support underscore-first names', () => {
  assert.deepEqual(parseSecretAssignment('_custom=abc'), {
    name: '_CUSTOM',
    value: 'abc',
  });
  assert.deepEqual(parseSecretAssignment('gemini_api_key=abc'), {
    name: 'GEMINI_API_KEY',
    value: 'abc',
  });
});

test('invalid or reserved secret names are rejected', () => {
  assert.throws(() => parseSecretAssignment('bad-name=value'), /invalid_or_reserved_secret_name/);
  assert.throws(() => parseSecretAssignment('BOT_TOKEN=value'), /invalid_or_reserved_secret_name/);
  assert.throws(() => parseSecretAssignment('=value'), /invalid_secret_assignment/);
});

test('NUL bytes and oversized values are rejected', () => {
  assert.throws(() => parseSecretAssignment(`TOKEN=a${String.fromCharCode(0)}b`), /secret_contains_nul/);
  assert.throws(() => setRuntimeSecret('TOKEN', 'x'.repeat(10001)), /secret_too_long/);
});

test('vault can be re-keyed for a different bot without exposing plaintext', () => withTestDb(() => {
  setRuntimeSecret('MIGRATION_TOKEN', 'opaque-a=b\\nline2');
  const count = rekeyRuntimeSecrets('123456:TEST_TOKEN', '654321:DEST_TOKEN');
  assert.equal(count, 1);
  process.env.BOT_TOKEN = '654321:DEST_TOKEN';
  assert.equal(getRuntimeSecret('MIGRATION_TOKEN'), 'opaque-a=b\\nline2');
  assert.throws(() => {
    process.env.BOT_TOKEN = '123456:TEST_TOKEN';
    getRuntimeSecret('MIGRATION_TOKEN');
  });
}));
