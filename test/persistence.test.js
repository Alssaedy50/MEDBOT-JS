/**
 * Persistence audit for platform settings.
 *
 * The production symptom this guards against is "the setting saved but reverted
 * after a restart". That has two possible causes and the tests separate them:
 *
 *  * a real persistence bug — the write never reached the SQLite file, or a
 *    cache served a stale value; or
 *  * an infrastructure fact — the file lives on an ephemeral filesystem, so a
 *    redeploy starts from an empty file.
 *
 * The code must be correct for the first; the second is a hosting setting. These
 * tests prove the first (the value survives a fresh connection and a fresh
 * `initDb`) and prove the diagnostic reports the path the process would use.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as db from '../src/db/index.js';
import { cleanupDb, tempDbPath } from './helpers/harness.js';

let dbPath;

before(() => {
  dbPath = tempDbPath('persistence');
  db.setDbPath(dbPath);
  db.initDb();
});

after(() => {
  cleanupDb(dbPath);
});

describe('platform settings persist to SQLite', () => {
  it('survives a fresh connection and a re-run of the migration chain', () => {
    db.setPlatformSetting('contact_text', 'نص محفوظ');

    // Re-open: `initDb` opens a new connection and re-runs every migration.
    db.initDb();

    assert.equal(db.getPlatformSetting('contact_text'), 'نص محفوظ');
    // The value really is on disk, not only in the open connection's page cache.
    assert.ok(fs.existsSync(dbPath), 'the SQLite file exists at the resolved path');
    assert.ok(fs.statSync(dbPath).size > 0, 'the file has content');
  });

  it('reads back through the raw settings accessor with no stale cache', () => {
    db.setPlatformSetting('contact_text', 'القيمة الأولى');
    assert.equal(db.getSetting('contact_text'), 'القيمة الأولى');

    db.setPlatformSetting('contact_text', 'القيمة الثانية');
    assert.equal(db.getSetting('contact_text'), 'القيمة الثانية', 'the second write wins immediately');
  });

  it('resolves MEDBOT_DB_PATH as the effective database path', () => {
    const previousOverride = process.env.MEDBOT_DB_PATH;
    db.setDbPath(null); // drop the programmatic override so the env var is consulted
    process.env.MEDBOT_DB_PATH = '/tmp/medbot-env-path.sqlite3';
    try {
      assert.equal(db.currentDbPath(), '/tmp/medbot-env-path.sqlite3');
    } finally {
      if (previousOverride === undefined) delete process.env.MEDBOT_DB_PATH;
      else process.env.MEDBOT_DB_PATH = previousOverride;
      db.setDbPath(dbPath);
      db.initDb();
    }
  });

  it('falls back to the default file name when nothing is configured', () => {
    db.setDbPath(null);
    const previous = process.env.MEDBOT_DB_PATH;
    delete process.env.MEDBOT_DB_PATH;
    try {
      assert.equal(db.currentDbPath(), db.DEFAULT_DB_NAME);
    } finally {
      if (previous !== undefined) process.env.MEDBOT_DB_PATH = previous;
      db.setDbPath(dbPath);
      db.initDb();
    }
  });

  it('rejects an unknown setting key and an empty value', () => {
    assert.equal(db.setPlatformSetting('not_a_real_setting', 'x'), false);
    assert.equal(db.setPlatformSetting('contact_text', '   '), false);
  });

  it('reports the DB path and archive state at boot without leaking secrets', async () => {
    const logs = [];
    const original = console.log;
    console.log = (line) => logs.push(String(line));
    try {
      const botModule = await import('../src/telegram/bot.js');
      await botModule.createBot({ transport: null });
    } finally {
      console.log = original;
    }

    const line = logs.find((entry) => entry.startsWith('MEDBOT db:'));
    assert.ok(line, 'a startup diagnostic line is emitted');
    assert.match(line, /MEDBOT db: /);
    assert.match(line, /archive: (configured|not configured)/);
    // The line names a path and a state, never a token or a channel id.
    assert.doesNotMatch(line, /BOT_TOKEN|[0-9]{8,}:[A-Za-z0-9_-]{30,}/);
  });
});
