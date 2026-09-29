import * as nodeDb from '../db/index.js';
import { assertAiStorage } from './storage.js';

function nodeAsync(fn, ...args) {
  return Promise.resolve().then(() => fn(...args));
}

export function createNodeAiStorage(db = nodeDb) {
  return assertAiStorage(Object.freeze({
    getUserLanguage: (userId) => nodeAsync(db.getUserLanguage, userId),
    aiRegistryEnsure: (...args) => nodeAsync(db.aiRegistryEnsure, ...args),
    aiRegistryGetAll: () => nodeAsync(db.aiRegistryGetAll),
    aiRegistryGetHealthy: () => nodeAsync(db.aiRegistryGetHealthy),
    aiRegistryMarkSuccess: (...args) => nodeAsync(db.aiRegistryMarkSuccess, ...args),
    aiRegistryMarkFailure: (...args) => nodeAsync(db.aiRegistryMarkFailure, ...args),
    aiUsageRecord: (...args) => nodeAsync(db.aiUsageRecord, ...args),
  }));
}
