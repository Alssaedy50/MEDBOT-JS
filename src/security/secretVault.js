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
const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

function deriveKey(token) {
  const value = String(token ?? '').trim();
  if (!value) throw new Error('BOT_TOKEN_REQUIRED_FOR_SECRET_VAULT');
  return crypto.createHash('sha256').update('MEDBOT_SECRET_VAULT:v1:').update(value).digest();
}
function key() { return deriveKey(process.env.BOT_TOKEN); }
function validateName(name) {
  const n = String(name ?? '').trim().toUpperCase();
  if (!NAME_RE.test(n) || RESERVED.has(n)) throw new Error('invalid_or_reserved_secret_name');
  return n;
}
function encryptWithKey(value, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v:1, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:ciphertext.toString('base64') });
}
function encrypt(value) { return encryptWithKey(value, key()); }
function decryptWithKey(payload, decryptionKey) {
  const parsed = JSON.parse(String(payload));
  if (parsed?.v !== 1) throw new Error('unsupported_secret_version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', decryptionKey, Buffer.from(parsed.iv,'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parsed.data,'base64')), decipher.final()]).toString('utf8');
}
function decrypt(payload) { return decryptWithKey(payload, key()); }
function settingKey(name) { return PREFIX + name; }

/** Parse the first '=' as the assignment separator and preserve the value byte-for-byte as text. */
export function parseSecretAssignment(input) {
  const source = String(input ?? '');
  const separator = source.indexOf('=');
  if (separator <= 0) throw new Error('invalid_secret_assignment');
  const rawName = source.slice(0, separator).trim();
  const value = source.slice(separator + 1);
  const name = validateName(rawName);
  if (value.includes(String.fromCharCode(0))) throw new Error('secret_contains_nul');
  return { name, value };
}

export function setRuntimeSecret(name, value) {
  const n = validateName(name);
  const text = String(value ?? '');
  if (text.includes('\\u0000')) throw new Error('secret_contains_nul');
  if (Buffer.byteLength(text, 'utf8') > 10000) throw new Error('secret_too_long');
  setSetting(settingKey(n), encrypt(value));
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
  return withDb((db) => db.prepare('DELETE FROM settings WHERE key=?').run(settingKey(n)).changes > 0);
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

/**
 * Re-encrypt the vault for a destination bot identity.
 *
 * Used only during an explicit offline bundle migration. The old and new bot
 * tokens are supplied by the operator and are never written to the database,
 * bundle, logs, or process.env by this helper.
 */
export function rekeyRuntimeSecrets(fromToken, toToken) {
  const oldKey = deriveKey(fromToken);
  const newKey = deriveKey(toToken);
  if (crypto.timingSafeEqual(oldKey, newKey)) throw new Error('SOURCE_AND_DESTINATION_TOKENS_MATCH');
  return withDb((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'secret.v1.%' ORDER BY key").all();
      const updates = [];
      for (const row of rows) {
        const value = decryptWithKey(row[1], oldKey);
        updates.push([row[0], encryptWithKey(value, newKey)]);
      }
      for (const [setting, encrypted] of updates) {
        db.prepare('UPDATE settings SET value=? WHERE key=?').run(encrypted, setting);
      }
      db.exec('COMMIT');
      return updates.length;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  });
}
