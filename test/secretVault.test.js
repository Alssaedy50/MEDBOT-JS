import test from 'node:test';
import assert from 'node:assert/strict';
import { setRuntimeSecret, getRuntimeSecret } from '../src/security/secretVault.js';
import { setSetting, getSetting } from '../src/db/settings.js';
test('secret vault encrypts values and round-trips',()=>{
  const old=process.env.BOT_TOKEN; process.env.BOT_TOKEN='123456:TEST_TOKEN';
  setRuntimeSecret('TEST_API_KEY','super-secret');
  assert.equal(getRuntimeSecret('TEST_API_KEY'),'super-secret');
  assert.notEqual(getSetting('secret.v1.TEST_API_KEY'),'super-secret');
  if(old===undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN=old;
});
