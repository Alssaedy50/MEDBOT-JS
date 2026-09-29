import test from 'node:test';
import assert from 'node:assert/strict';

import { hasKey, keyFor } from '../src/ai/providers.js';

test('provider credentials can be supplied by a Worker env object', () => {
  const env = {
    GEMINI_API_KEY: ' gemini-test ',
    GROQ_API_KEY: 'groq-test',
    OPENROUTER_API_KEY: 'router-test',
  };
  assert.equal(keyFor('google_gemini', env), 'gemini-test');
  assert.equal(keyFor('groq', env), 'groq-test');
  assert.equal(keyFor('openrouter', env), 'router-test');
  assert.equal(hasKey('groq', env), true);
});

test('missing Worker credentials are treated as unavailable', () => {
  assert.equal(keyFor('groq', {}), '');
  assert.equal(hasKey('groq', {}), false);
});
