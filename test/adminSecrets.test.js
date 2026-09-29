import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSecretInput, validateSecretInputs } from '../src/telegram/adminSecrets.js';

test('secret parser accepts assignment and export forms', () => {
  assert.deepEqual(parseSecretInput('GEMINI_API_KEY = abc'), [{ name: 'GEMINI_API_KEY', value: 'abc' }]);
  assert.deepEqual(parseSecretInput('export GROQ_API_KEY=gsk_test'), [{ name: 'GROQ_API_KEY', value: 'gsk_test' }]);
  assert.deepEqual(parseSecretInput('OPENROUTER_API_KEY: sk-or-test'), [{ name: 'OPENROUTER_API_KEY', value: 'sk-or-test' }]);
});

test('secret parser accepts JSON object and preserves multiline values', () => {
  assert.deepEqual(parseSecretInput('{"A":"one","B":"two"}'), [
    { name: 'A', value: 'one' },
    { name: 'B', value: 'two' },
  ]);
  assert.deepEqual(parseSecretInput('PRIVATE_KEY=-----BEGIN KEY-----\nabc\n-----END KEY-----'), [
    { name: 'PRIVATE_KEY', value: '-----BEGIN KEY-----\nabc\n-----END KEY-----' },
  ]);
});

test('secret validation is dynamic and provider-aware without pretending format proves validity', () => {
  const [good] = validateSecretInputs('OPENROUTER_API_KEY=sk-or-test-value-123');
  assert.equal(good.valid, true);
  assert.equal(good.name, 'OPENROUTER_API_KEY');

  const [bad] = validateSecretInputs('BAD NAME=value');
  assert.equal(bad.valid, false);

  const [warning] = validateSecretInputs('GROQ_API_KEY=not-a-gsk-key');
  assert.equal(warning.valid, true);
  assert.ok(warning.warnings.length > 0);
});
