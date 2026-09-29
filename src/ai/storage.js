/**
 * AI persistence boundary.
 *
 * The AI router depends only on this small async contract. The default Node
 * implementation wraps the existing synchronous SQLite facade; Cloudflare
 * Workers can inject the D1 implementation without importing SQLite into the
 * AI service layer.
 */
import * as nodeDb from '../db/index.js';
import * as d1Users from '../db/d1/users.js';
import * as d1AiRegistry from '../db/d1/aiRegistry.js';

function nodeAsync(fn, ...args) {
  return Promise.resolve().then(() => fn(...args));
}

export function createNodeAiStorage(db = nodeDb) {
  return Object.freeze({
    getUserLanguage: (userId) => nodeAsync(db.getUserLanguage, userId),
    aiRegistryEnsure: (...args) => nodeAsync(db.aiRegistryEnsure, ...args),
    aiRegistryGetAll: () => nodeAsync(db.aiRegistryGetAll),
    aiRegistryGetHealthy: () => nodeAsync(db.aiRegistryGetHealthy),
    aiRegistryMarkSuccess: (...args) => nodeAsync(db.aiRegistryMarkSuccess, ...args),
    aiRegistryMarkFailure: (...args) => nodeAsync(db.aiRegistryMarkFailure, ...args),
    aiUsageRecord: (...args) => nodeAsync(db.aiUsageRecord, ...args),
  });
}

export function createD1AiStorage(d1) {
  if (!d1) throw new TypeError('D1 database binding is required');
  return Object.freeze({
    getUserLanguage: (userId) => d1Users.getUserLanguage(d1, userId),
    aiRegistryEnsure: (...args) => d1AiRegistry.aiRegistryEnsure(d1, ...args),
    aiRegistryGetAll: () => d1AiRegistry.aiRegistryGetAll(d1),
    aiRegistryGetHealthy: () => d1AiRegistry.aiRegistryGetHealthy(d1),
    aiRegistryMarkSuccess: (...args) => d1AiRegistry.aiRegistryMarkSuccess(d1, ...args),
    aiRegistryMarkFailure: (...args) => d1AiRegistry.aiRegistryMarkFailure(d1, ...args),
    aiUsageRecord: (...args) => d1AiRegistry.aiUsageRecord(d1, ...args),
  });
}

/**
 * Explicit service factory for Worker/runtime composition.
 *
 * Provider/network concerns stay outside this module; callers inject storage
 * and pass fetch implementations through the existing AI router APIs.
 */
export function createAiService({ storage } = {}) {
  if (!storage) throw new TypeError('AI storage is required');
  return Object.freeze({ storage });
}
