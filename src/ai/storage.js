/**
 * AI persistence boundary.
 *
 * The AI router depends only on this small async contract. Runtime-specific
 * persistence adapters live in nodeStorage.js and d1Storage.js so importing
 * the Worker path never imports SQLite or other Node-only modules.
 */
export const AI_STORAGE_METHODS = Object.freeze([
  'getUserLanguage',
  'aiRegistryEnsure',
  'aiRegistryGetAll',
  'aiRegistryGetHealthy',
  'aiRegistryMarkSuccess',
  'aiRegistryMarkFailure',
  'aiUsageRecord',
]);

export function assertAiStorage(storage) {
  if (!storage || AI_STORAGE_METHODS.some((method) => typeof storage[method] !== 'function')) {
    throw new TypeError('A complete AI storage adapter is required');
  }
  return storage;
}

/**
 * Explicit service composition point. Higher layers can carry this object
 * without knowing whether persistence is SQLite, D1, or another backend.
 */
export function createAiService({ storage }) {
  return Object.freeze({ storage: assertAiStorage(storage) });
}
