import { withDb, run } from '../db/core.js';
globalThis.__MEDBOT_WITH_DB = withDb;
globalThis.__MEDBOT_RUN = run;
import { loadRuntimeSecrets } from './secretVault.js';

export function hydrateRuntimeConfig() {
  try { return loadRuntimeSecrets(); } catch (error) {
    console.error('[MEDBOT] runtime secret vault unavailable:', error.message);
    return [];
  }
}
