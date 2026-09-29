/**
 * Owner-managed runtime secrets.
 *
 * Values are encrypted at rest in SQLite with AES-256-GCM. The encryption key
 * is derived from the bot token, so the vault survives redeploys when the same
 * bot token is restored. The Telegram bot token itself is never stored here.
 */
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db/settings.js';
import { withDb } from '../db/core.js';

const PREFIX = 'secret.v1.';
const RESERVED = new Set([
  'BOT_TOKEN','ADMIN_ID','ADMIN_IDS','MEDBOT_SECRETS_KEY','MEDBOT_DB_PATH',
  'PORT','NODE_VERSION','DATABASE_URL',
]);
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function key() {
  const token = String(process.env.BOT_TOKEN ?? '').trim();
  if (!token) throw new Error('BOT_TOKEN_REQUIRED_FOR_SECRET_VAULT');
  return crypto.createHash('sha256').update('MEDBOT_SECRET_VAULT:v1:').update(token).digest();
}
function validateName(name) {
  const n = String(name ?? '').trim().toUpperCase();
  if (!NAME_RE.test(n) || RESERVED.has(n)) throw new Error('invalid_or_reserved_secret_name');
  return n;
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v:1, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:ciphertext.toString('base64') });
}
function decrypt(payload) {
  const parsed = JSON.parse(String(payload));
  if (parsed?.v !== 1) throw new Error('unsupported_secret_version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parsed.iv,'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parsed.data,'base64')), decipher.final()]).toString('utf8');
}
function settingKey(name) { return PREFIX + name; }

export function setRuntimeSecret(name, value) {
  const n = validateName(name);
  if (String(value ?? '').length > 10000) throw new Error('secret_too_long');
  setSetting(settingKey(n), encrypt(value));
  process.env[n] = String(value);
  return n;
}
export function getRuntimeSecret(name) {
  const n = validateName(name);
  const raw = getSetting(settingKey(n));
  return raw ? decrypt(raw) : null;
}
export function deleteRuntimeSecret(name) {
  const n = validateName(name);
  // Keep the encrypted value out of generic settings by replacing it with an
  // empty marker; actual row deletion is handled by the dedicated helper below.
  const deleted = withDb((db) => db.prepare('DELETE FROM settings WHERE key=?').run(settingKey(n)).changes > 0);
  if (deleted) delete process.env[n];
  return deleted;
}
export function listRuntimeSecrets() {
  return getRuntimeSecretNames();
}
export function loadRuntimeSecrets() {
  const loaded = [];
  withDb((db) => {
    for (const row of db.prepare("SELECT key FROM settings WHERE key LIKE 'secret.v1.%' ORDER BY key").all()) {
      try {
        const name = String(row[0]).slice(PREFIX.length);
        const value = decrypt(db.prepare('SELECT value FROM settings WHERE key=?').get(row[0])?.[0]);
        if (name && value !== null) { process.env[name] = value; loaded.push(name); }
      } catch (error) {
        console.error(`[MEDBOT] secret vault entry skipped: ${String(row[0])} (${error.message})`);
      }
    }
  });
  return loaded;
}
export function getRuntimeSecretNames() {
  return withDb((db) => db.prepare("SELECT key FROM settings WHERE key LIKE 'secret.v1.%' ORDER BY key").all().map((row)=>String(row[0]).slice(PREFIX.length)));
}
