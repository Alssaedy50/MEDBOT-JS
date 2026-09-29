/**
 * Runtime-neutral object storage boundary.
 *
 * Cloudflare production uses an R2 bucket binding. Tests can inject any object
 * store implementing the same small contract. No filesystem or Node APIs live
 * in this module.
 */

function assertBucket(bucket) {
  if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function') {
    throw new TypeError('An R2-compatible bucket binding is required');
  }
  return bucket;
}

function normalizeKey(key) {
  const value = String(key ?? '').trim();
  if (!value || value.startsWith('/') || value.includes('..')) {
    throw new TypeError('Object key must be a non-empty relative path');
  }
  return value;
}

export function createR2Storage(bucket) {
  const store = assertBucket(bucket);
  return Object.freeze({
    async put(key, value, options = {}) { return store.put(normalizeKey(key), value, options); },
    async get(key, options = {}) { return store.get(normalizeKey(key), options); },
    async head(key) { return typeof store.head === 'function' ? store.head(normalizeKey(key)) : null; },
    async delete(key) {
      if (typeof store.delete !== 'function') throw new TypeError('R2 bucket does not support delete');
      return store.delete(normalizeKey(key));
    },
    async list(options = {}) {
      if (typeof store.list !== 'function') throw new TypeError('R2 bucket does not support list');
      return store.list(options);
    },
  });
}

export const R2_KEY_PREFIXES = Object.freeze({
  resources: 'resources/',
  contributions: 'contributions/',
  exports: 'exports/',
  temporary: 'tmp/',
});

export function resourceObjectKey(contentId, fileName = '') {
  const id = Number(contentId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Invalid content id');
  const safeName = String(fileName ?? '').trim().replaceAll('/', '_').replaceAll('\\\\', '_');
  return R2_KEY_PREFIXES.resources + id + (safeName ? '-' + safeName : '');
}