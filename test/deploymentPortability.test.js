import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeploymentManifest } from '../src/deployment/manifest.js';
import { runDeploymentDoctor } from '../scripts/deployment-doctor.mjs';

test('deployment manifest declares both runtimes without secret values',()=>{
  const m=buildDeploymentManifest();
  assert.equal(m.format,'medbot-deployment');
  assert.equal(m.version,1);
  assert.deepEqual(m.required_environment,['BOT_TOKEN','ADMIN_ID']);
  assert.ok(m.runtime.production.database==='SQLite');
  assert.ok(m.runtime.parallel.database==='D1');
  assert.equal(JSON.stringify(m).includes('BOT_TOKEN='),false);
});

test('deployment doctor validates required configuration and hides secret values',()=>{
  const r=runDeploymentDoctor({env:{BOT_TOKEN:'123:secret',ADMIN_ID:'12345',GEMINI_API_KEY:'secret-key'}});
  assert.equal(r.ok,true);
  const output=JSON.stringify(r);
  assert.equal(output.includes('123:secret'),false);
  assert.equal(output.includes('secret-key'),false);
});

test('deployment doctor rejects incomplete backup configuration',()=>{
  const r=runDeploymentDoctor({env:{BOT_TOKEN:'123:secret',ADMIN_ID:'12345',MEDBOT_BACKUP_URL:'https://example.invalid/backup'}});
  assert.equal(r.ok,false);
  assert.ok(r.checks.some(c=>c.name==='backup_configuration'&&c.status==='FAIL'));
});
