import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIdempotencyStore, handleTelegramWebhook } from '../src/telegram/webhook.js';

function request(body, secret = 'secret') {
  return new Request('https://example.test/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(body),
  });
}

test('webhook rejects wrong method and secret', async () => {
  const get = await handleTelegramWebhook(new Request('https://x.test'));
  assert.equal(get.status, 405);
  const bad = await handleTelegramWebhook(request({ update_id: 1 }, 'wrong'), {
    env: { TELEGRAM_WEBHOOK_SECRET: 'secret' },
  });
  assert.equal(bad.status, 401);
});

test('webhook dispatches once and acknowledges duplicates', async () => {
  const store = createMemoryIdempotencyStore();
  const updates = [];
  const opts = {
    env: { TELEGRAM_WEBHOOK_SECRET: 'secret' },
    idempotency: store,
    dispatch: async (update) => updates.push(update.update_id),
  };
  const first = await handleTelegramWebhook(request({ update_id: 42 }), opts);
  const second = await handleTelegramWebhook(request({ update_id: 42 }), opts);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(updates, [42]);
});

test('failed dispatch releases the claim for Telegram retry', async () => {
  const store = createMemoryIdempotencyStore();
  let attempts = 0;
  const opts = {
    env: { TELEGRAM_WEBHOOK_SECRET: 'secret' },
    idempotency: store,
    dispatch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary');
    },
  };
  await handleTelegramWebhook(request({ update_id: 7 }), opts);
  await handleTelegramWebhook(request({ update_id: 7 }), opts);
  assert.equal(attempts, 2);
});

test('invalid payloads are rejected before claiming', async () => {
  const store = createMemoryIdempotencyStore();
  const response = await handleTelegramWebhook(new Request('https://x.test', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    body: '{bad',
  }), { env: { TELEGRAM_WEBHOOK_SECRET: 'secret' }, idempotency: store, dispatch: async () => {} });
  assert.equal(response.status, 400);
});
