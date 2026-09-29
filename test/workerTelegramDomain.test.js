import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerContext } from '../src/telegram/workerContext.js';
import { createWorkerTelegramDispatcher } from '../src/telegram/workerDispatcher.js';

test('Worker context maps a Telegram message', () => {
  const ctx = buildWorkerContext({ update: { message: { chat: { id: 42 }, from: { id: 42 }, text: '/start' } }, db: { ok: true } });
  assert.equal(ctx.kind, 'message');
  assert.equal(ctx.chatId, 42);
  assert.equal(ctx.text, '/start');
  assert.equal(ctx.db.ok, true);
});

test('Worker dispatcher injects context into command handlers', async () => {
  let received;
  const bot = {};
  const dispatch = createWorkerTelegramDispatcher({ bot, db: {}, handlers: { command: async (ctx) => { received = ctx; } } });
  await dispatch({ message: { chat: { id: 9 }, from: { id: 9 }, text: '/start' } });
  assert.equal(received.chatId, 9);
  assert.equal(received.bot, bot);
});
