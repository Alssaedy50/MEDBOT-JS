import test from 'node:test';
import assert from 'node:assert/strict';
import { workerFeatureName, buildWorkerUnsupported } from '../src/telegram/workerParity.js';

test('Phase 14 worker parity module exposes feature routing helpers', () => {
  assert.equal(workerFeatureName('news:12'), 'news');
  assert.equal(workerFeatureName('language'), 'language');
});

test('Phase 14 unsupported surfaces fail closed without throwing', async () => {
  const db = {
    prepare() { throw new Error('db should not be touched by this assertion'); },
  };
  const result = await buildWorkerUnsupported(db, { id: 1 }, 'assistant');
  assert.match(result.text, /المساعد الذكي|AI Assistant/);
  assert.equal(result.reply_markup.inline_keyboard[0][0].callback_data, 'home');
});
