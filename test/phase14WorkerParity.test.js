import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerUnsupported } from '../src/telegram/workerParity.js';

test('Phase 14 fallback is explicit', async () => {
  const result = await buildWorkerUnsupported({}, { id: 1 }, 'assistant');
  assert.match(result.text, /المساعد الذكي|AI Assistant/);
  assert.equal(result.reply_markup.inline_keyboard[0][0].callback_data, 'home');
});
