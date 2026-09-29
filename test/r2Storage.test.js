import test from 'node:test';
import assert from 'node:assert/strict';

import { createR2Storage, resourceObjectKey } from '../src/storage/r2.js';

function fakeBucket() {
  const objects = new Map();
  return {
    async put(key, value, options) { objects.set(key, { value, options }); return { etag: 'test-etag' }; },
    async get(key) { const entry = objects.get(key); return entry ? { body: entry.value, httpEtag: 'test-etag' } : null; },
    async head(key) { return objects.has(key) ? { key } : null; },
    async delete(key) { objects.delete(key); },
    async list(options = {}) { return { objects: [...objects.keys()].map((key) => ({ key })), options }; },
  };
}

test('R2 storage delegates object operations without Node filesystem APIs', async () => {
  const storage = createR2Storage(fakeBucket());
  await storage.put('resources/1.pdf', 'pdf', { httpMetadata: { contentType: 'application/pdf' } });
  assert.equal((await storage.get('resources/1.pdf')).body, 'pdf');
  assert.equal((await storage.head('resources/1.pdf')).key, 'resources/1.pdf');
  assert.equal((await storage.list()).objects.length, 1);
  await storage.delete('resources/1.pdf');
  assert.equal(await storage.get('resources/1.pdf'), null);
});

test('R2 storage rejects unsafe object keys', async () => {
  const storage = createR2Storage(fakeBucket());
  await assert.rejects(() => storage.put('../secret', 'x'), /relative path/);
  await assert.rejects(() => storage.get('/absolute', {}), /relative path/);
});

test('resource keys are stable and names are path-safe', () => {
  assert.equal(resourceObjectKey(42, 'lecture/a.pdf'), 'resources/42-lecture_a.pdf');
  assert.equal(resourceObjectKey(42), 'resources/42');
});
