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

test('Cloudflare Worker health endpoint exposes Phase 8 bindings without starting the Node bot', async () => {
  const response = await request('/health');
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'MEDBOT');
  assert.equal(body.runtime, 'cloudflare-worker');
  assert.equal(body.telegram_webhook, 'adapter_enabled');
  assert.equal(body.telegram_domain_router, 'not_migrated');
  assert.equal(body.database, 'd1-missing');
  assert.equal(body.object_storage, 'r2-missing');
});

test('root path exposes the same Worker health contract', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
});

test('Telegram webhook requires the D1 binding before entering the adapter', async () => {
  const response = await request('/telegram/webhook', 'POST');
  assert.equal(response.status, 503);

  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'd1_not_configured');
});

test('storage status exposes the R2 binding without exposing bucket details', async () => {
  const response = await worker.fetch(
    new globalThis.Request('https://example.test/storage/status'),
    { FILES: { put() {}, get() {} } },
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, storage: 'r2', adapter: true });
});

test('unknown Worker routes return a safe 404', async () => {
  const response = await request('/does-not-exist');
  assert.equal(response.status, 404);

  const body = await response.json();
  assert.deepEqual(body, { ok: false, error: 'not_found' });
});
