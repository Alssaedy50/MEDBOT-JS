/**
 * Cross-runtime AES-256-GCM cryptographic secret vault for Multi-College Platform.
 *
 * Encrypts college bot tokens and per-college AI API keys at rest in D1 / SQLite.
 * Plaintext secrets are never logged or returned in UI screens.
 */

import crypto from 'node:crypto';

const VAULT_VERSION = 1;
const COLLEGE_SECRET_PREFIX = 'college_secret.v1.';
const ALLOWED_COLLEGE_SECRETS = new Set([
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]);

/**
 * Resolve the master key material used to encrypt platform & college secrets.
 * Falls back deterministically to configured tokens so local/dev environments work
 * without extra setup while production can set `PLATFORM_MASTER_KEY` or `MEDBOT_SECRETS_KEY`.
 */
export function resolveMasterKeyBuffer(env = {}, scope = 'platform') {
  const raw =
    String(
      env?.PLATFORM_MASTER_KEY ||
        env?.MEDBOT_SECRETS_KEY ||
        env?.PLATFORM_BOT_TOKEN ||
        env?.TELEGRAM_BOT_TOKEN ||
        env?.BOT_TOKEN ||
        process.env?.PLATFORM_MASTER_KEY ||
        process.env?.MEDBOT_SECRETS_KEY ||
        process.env?.BOT_TOKEN ||
        'medbot-default-dev-key',
    ).trim();

  return crypto
    .createHash('sha256')
    .update(`MEDBOT_MULTI_COLLEGE_VAULT:v1:${scope}:`)
    .update(raw)
    .digest();
}

export function encryptSecretValue(plaintext, env = {}, scope = 'platform') {
  const text = String(plaintext ?? '');
  if (!text) throw new Error('empty_secret_value');
  if (text.includes('\0')) throw new Error('secret_contains_nul');
  if (Buffer.byteLength(text, 'utf8') > 10000) throw new Error('secret_too_long');

  const key = resolveMasterKeyBuffer(env, scope);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: VAULT_VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

export function decryptSecretValue(payload, env = {}, scope = 'platform') {
  if (!payload) return null;
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (parsed?.v !== VAULT_VERSION) {
    throw new Error('unsupported_vault_version');
  }
  const key = resolveMasterKeyBuffer(env, scope);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(parsed.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function generateWebhookSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function maskSecret(secret) {
  const s = String(secret ?? '').trim();
  if (!s) return 'غير مضبوط';
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export function validateBotTokenFormat(token) {
  const clean = String(token ?? '').trim();
  // Standard Telegram bot token format: <bot_id>:<alphanumeric_secret>
  return /^\d{5,15}:[A-Za-z0-9_-]{20,64}$/.test(clean);
}

export function validateCollegeSecretName(name) {
  const normalized = String(name ?? '').trim().toUpperCase();
  if (!ALLOWED_COLLEGE_SECRETS.has(normalized)) {
    throw new Error('unsupported_college_secret_name');
  }
  return normalized;
}

export function collegeSecretSettingKey(name) {
  return `${COLLEGE_SECRET_PREFIX}${validateCollegeSecretName(name)}`;
}

export const COLLEGE_SECRET_KEYS = Object.freeze([...ALLOWED_COLLEGE_SECRETS]);
export { COLLEGE_SECRET_PREFIX };
