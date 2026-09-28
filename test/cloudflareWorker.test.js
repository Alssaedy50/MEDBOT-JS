import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';

async function request(path, method = 'GET') {
  return worker.fetch(
    new globalThis.Request(`https://example.test${path}`, { method }),
    {},
    {},
  );
}

test('Cloudflare Worker health endpoint is available without starting the Node bot', async () => {
  const response = await request('/health');
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'MEDBOT');
  assert.equal(body.runtime, 'cloudflare-worker');
  assert.equal(body.telegram_webhook, 'not_enabled');
  assert.equal(body.database, 'd1-boundary-declared');
});

test('root path exposes the same Worker health contract', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
});

test('Telegram webhook remains explicitly disabled during Phase 1', async () => {
  const response = await request('/telegram/webhook', 'POST');
  assert.equal(response.status, 501);

  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'telegram_webhook_not_enabled');
});

test('unknown Worker routes return a safe 404', async () => {
  const response = await request('/does-not-exist');
  assert.equal(response.status, 404);

  const body = await response.json();
  assert.deepEqual(body, { ok: false, error: 'not_found' });
});
