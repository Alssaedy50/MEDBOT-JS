import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initDb } from '../src/db/migrations.js';
import { setDbPath } from '../src/db/core.js';
import { setSetting } from '../src/db/settings.js';
import { buildFullBotBundle } from '../src/backup/fullBundle.js';

test('full bundle contains a consistent database snapshot and excludes plaintext env files', async () => {
  const dbFile = path.join(
    os.tmpdir(),
    `medbot-bundle-test-${process.pid}-${Date.now()}.sqlite3`,
  );
  const oldToken = process.env.BOT_TOKEN;
  const oldBackupToken = process.env.MEDBOT_BACKUP_TOKEN;
  delete process.env.BOT_TOKEN;
  delete process.env.MEDBOT_BACKUP_TOKEN;
  setDbPath(dbFile);

  let bundlePath = null;
  try {
    initDb();
    setSetting('bundle.test', 'present');
    const result = await buildFullBotBundle();
    bundlePath = result.path;

    assert.equal(result.manifest.database_snapshot, 'consistent_sqlite_snapshot');
    const listing = execFileSync('tar', ['-tzf', bundlePath], { encoding: 'utf8' });
    assert.ok(listing.split('\n').some((entry) => entry.endsWith(path.basename(dbFile))));
    assert.doesNotMatch(listing, /(?:^|\/)\.env(?:\.|$)/m);
    assert.doesNotMatch(listing, /(?:^|\/)\.git(?:\/|$)/m);
  } finally {
    setDbPath(null);
    if (oldToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = oldToken;
    if (oldBackupToken === undefined) delete process.env.MEDBOT_BACKUP_TOKEN;
    else process.env.MEDBOT_BACKUP_TOKEN = oldBackupToken;
    if (bundlePath) {
      try { fs.rmSync(path.dirname(bundlePath), { recursive: true, force: true }); } catch {}
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch {}
    }
  }
});
