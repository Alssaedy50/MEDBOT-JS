/**
 * Re-key the encrypted runtime-secret vault after moving a MEDBOT bundle to a new bot.
 *
 * Required environment:
 *   OLD_BOT_TOKEN=<token used by the source bot>
 *   BOT_TOKEN=<new destination bot token>
 *   MEDBOT_DB_PATH=<optional copied SQLite path>
 *
 * Neither token is stored in the database or printed.
 */
import { rekeyRuntimeSecrets } from '../src/security/secretVault.js';

const oldToken = String(process.env.OLD_BOT_TOKEN ?? '').trim();
const newToken = String(process.env.BOT_TOKEN ?? '').trim();

if (!oldToken) throw new Error('OLD_BOT_TOKEN is required');
if (!newToken) throw new Error('BOT_TOKEN is required');
if (oldToken === newToken) throw new Error('OLD_BOT_TOKEN and BOT_TOKEN must be different');

const count = rekeyRuntimeSecrets(oldToken, newToken);
console.log(`Re-keyed ${count} encrypted runtime secret(s). Plaintext values were not written to disk.`);
