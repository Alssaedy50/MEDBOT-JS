import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db/migrations.js';
import { setDbName } from '../src/db/core.js';
import { setRuntimeSecret, getRuntimeSecret } from '../src/security/secretVault.js';
import { getSetting } from '../src/db/settings.js';

test('secret vault encrypts values and round-trips',()=>{
  const file=path.join(os.tmpdir(),`medbot-secret-test-${process.pid}-${Date.now()}.sqlite3`);
  const old=process.env.BOT_TOKEN; setDbName(file); initDb(); process.env.BOT_TOKEN='123456:TEST_TOKEN';
  setRuntimeSecret('TEST_API_KEY','super-secret=with/slashes + symbols @ #');
  setRuntimeSecret('my_service_token','abc');
  assert.equal(getRuntimeSecret('TEST_API_KEY'),'super-secret');
  assert.notEqual(getSetting('secret.v1.TEST_API_KEY'),'super-secret=with/slashes + symbols @ #');
  assert.equal(getRuntimeSecret('MY_SERVICE_TOKEN'),'abc');
  if(old===undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN=old;
  try { fs.rmSync(file,{force:true}); } catch (error) { assert.ok(error); }
});
