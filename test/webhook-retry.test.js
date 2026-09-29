import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMemoryIdempotencyStore,
  handleTelegramWebhook,
} from '../src/telegram/webhook.js';

function request(updateId) {
  return new Request('https://example.test/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'test-secret',
    },
    body: JSON.stringify({ update_id: updateId, message: { chat: { id: 123 } } }),
  });
}

test('dispatch failure is not acknowledged and the update can be retried', async () => {
  const idempotency = createMemoryIdempotencyStore();
  let attempts = 0;

  const first = await handleTelegramWebhook(request(1001), {
    env: { TELEGRAM_WEBHOOK_SECRET: 'test-secret' },
    idempotency,
    dispatch: async () => {
      attempts += 1;
      throw new Error('temporary failure');
    },
  });

  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { ok: false, error: 'dispatch_failed' });

  const second = await handleTelegramWebhook(request(1001), {
    env: { TELEGRAM_WEBHOOK_SECRET: 'test-secret' },
    idempotency,
    dispatch: async () => {
      attempts += 1;
    },
  });

  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true });
  assert.equal(attempts, 2);
});

test('successfully processed updates are not dispatched twice', async () => {
  const idempotency = createMemoryIdempotencyStore();
  let attempts = 0;

  const first = await handleTelegramWebhook(request(1002), {
    env: { TELEGRAM_WEBHOOK_SECRET: 'test-secret' },
    idempotency,
    dispatch: async () => {
      attempts += 1;
    },
  });

  assert.equal(first.status, 200);

  const duplicate = await handleTelegramWebhook(request(1002), {
    env: { TELEGRAM_WEBHOOK_SECRET: 'test-secret' },
    idempotency,
    dispatch: async () => {
      attempts += 1;
    },
  });

  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
  assert.equal(attempts, 1);
});
