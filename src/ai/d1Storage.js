import * as d1Users from '../db/d1/users.js';
import * as d1AiRegistry from '../db/d1/aiRegistry.js';
import { assertAiStorage } from './storage.js';

export function createD1AiStorage(d1) {
  if (!d1) throw new TypeError('D1 database binding is required');
  return assertAiStorage(Object.freeze({
    getUserLanguage: (userId) => d1Users.getUserLanguage(d1, userId),
    aiRegistryEnsure: (...args) => d1AiRegistry.aiRegistryEnsure(d1, ...args),
    aiRegistryGetAll: () => d1AiRegistry.aiRegistryGetAll(d1),
    aiRegistryGetHealthy: () => d1AiRegistry.aiRegistryGetHealthy(d1),
    aiRegistryMarkSuccess: (...args) => d1AiRegistry.aiRegistryMarkSuccess(d1, ...args),
    aiRegistryMarkFailure: (...args) => d1AiRegistry.aiRegistryMarkFailure(d1, ...args),
    aiUsageRecord: (...args) => d1AiRegistry.aiUsageRecord(d1, ...args),
  }));
}
