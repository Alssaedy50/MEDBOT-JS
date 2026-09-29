import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCandidatesUncached, getCandidates, providerFailover } from '../src/ai/router.js';

function storage() {
  return {
    getUserLanguage: async () => 'ar',
    aiRegistryEnsure: async () => 1,
    aiRegistryGetAll: async () => [],
    aiRegistryGetHealthy: async () => [],
    aiRegistryMarkSuccess: async () => true,
    aiRegistryMarkFailure: async () => true,
    aiUsageRecord: async () => true,
  };
}

test('runtime-neutral AI router accepts injected async storage', async () => {
  const s = storage();
  assert.deepEqual(await buildCandidatesUncached(async () => new Response('{}'), s, {}), []);
  assert.deepEqual(await getCandidates(async () => new Response('{}'), s, {}), []);
});

test('provider failover requires the injected persistence boundary', async () => {
  await assert.rejects(
    providerFailover({
      groundedPrompt: 'test',
      systemPrompt: 'test',
      candidates: [],
    }),
    /complete AI storage adapter/,
  );
});
