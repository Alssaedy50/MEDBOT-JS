import test from 'node:test';
import assert from 'node:assert/strict';

import { createAiService, assertAiStorage } from '../src/ai/storage.js';
import { createD1AiStorage } from '../src/ai/d1Storage.js';
import { createNodeAiStorage } from '../src/ai/nodeStorage.js';

function makeStorage() {
  return {
    getUserLanguage: async () => 'en',
    aiRegistryEnsure: async () => 1,
    aiRegistryGetAll: async () => [],
    aiRegistryGetHealthy: async () => [],
    aiRegistryMarkSuccess: async () => true,
    aiRegistryMarkFailure: async () => true,
    aiUsageRecord: async () => true,
  };
}

test('AI service accepts the complete async persistence contract', () => {
  const storage = makeStorage();
  assert.equal(assertAiStorage(storage), storage);
  assert.equal(createAiService({ storage }).storage, storage);
});

test('AI service rejects incomplete persistence adapters', () => {
  assert.throws(() => createAiService({ storage: {} }), /complete AI storage adapter/);
});

test('D1 AI storage maps D1 domain functions without SQLite imports', async () => {
  const calls = [];
  const d1 = {};
  const storage = createD1AiStorage(d1);
  assert.equal(typeof storage.aiRegistryGetHealthy, 'function');
  assert.equal(typeof storage.getUserLanguage, 'function');
  void calls;
});

test('Node AI storage preserves an async contract over synchronous facade', async () => {
  const storage = createNodeAiStorage({
    getUserLanguage: () => 'ar',
    aiRegistryEnsure: () => 7,
    aiRegistryGetAll: () => [],
    aiRegistryGetHealthy: () => [],
    aiRegistryMarkSuccess: () => true,
    aiRegistryMarkFailure: () => true,
    aiUsageRecord: () => true,
  });
  assert.equal(await storage.getUserLanguage(1), 'ar');
  assert.equal(await storage.aiRegistryEnsure('p', 'm', 'e'), 7);
});
