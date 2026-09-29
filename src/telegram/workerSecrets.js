import { all, get, run } from '../db/d1/core.js';

const PREFIX = 'secret.v1.';
const RESERVED = new Set(['TELEGRAM_BOT_TOKEN','ADMIN_ID','ADMIN_IDS','MEDBOT_SECRETS_KEY','DATABASE_URL','PORT','NODE_VERSION']);
const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

function validateName(name) {
  const n = String(name ?? '').trim().toUpperCase();
  if (!NAME_RE.test(n) || RESERVED.has(n)) throw new Error('invalid_or_reserved_secret_name');
  return n;
}

function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function base64ToBytes(value) {
  const s = atob(String(value));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}
async function keyFromToken(token) {
  const source = new TextEncoder().encode('MEDBOT_SECRET_VAULT:v1:'+String(token ?? '').trim());
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', source), {name:'AES-GCM'}, false, ['encrypt','decrypt']);
}
async function encrypt(value, token) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_REQUIRED_FOR_SECRET_VAULT');
  const key = await keyFromToken(token);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, new TextEncoder().encode(String(value))));
  return JSON.stringify({v:1,iv:bytesToBase64(iv),data:bytesToBase64(ciphertext)});
}
async function decrypt(payload, token) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_REQUIRED_FOR_SECRET_VAULT');
  const parsed = JSON.parse(String(payload));
  if (parsed?.v !== 1) throw new Error('unsupported_secret_version');
  const key = await keyFromToken(token);
  const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(parsed.iv)},key,base64ToBytes(parsed.data));
  return new TextDecoder().decode(plain);
}
export function parseSecretAssignment(input) {
  const source = String(input ?? '');
  const i = source.indexOf('=');
  if (i <= 0) throw new Error('invalid_secret_assignment');
  const name = validateName(source.slice(0,i));
  const value = source.slice(i+1);
  if (value.includes(String.fromCharCode(0))) throw new Error('secret_contains_nul');
  if (new TextEncoder().encode(value).length > 10000) throw new Error('secret_too_long');
  return {name,value};
}
export async function listWorkerSecrets(db) {
  const rows = await all(db,"SELECT key FROM settings WHERE key LIKE 'secret.v1.%' ORDER BY key");
  return rows.map(r=>String(r[0]).slice(PREFIX.length));
}
export async function setWorkerSecret(db,token,name,value) {
  const n=validateName(name); const encrypted=await encrypt(value,token);
  await run(db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[PREFIX+n,encrypted]);
  return n;
}
export async function deleteWorkerSecret(db,name) {
  const n=validateName(name);
  return (await run(db,'DELETE FROM settings WHERE key=?',[PREFIX+n])).changes>0;
}
export async function loadWorkerSecrets(db,token) {
  const rows=await all(db,"SELECT key,value FROM settings WHERE key LIKE 'secret.v1.%' ORDER BY key");
  const out={};
  for(const row of rows){
    const name=String(row[0]).slice(PREFIX.length);
    try { out[name]=await decrypt(row[1],token); } catch { /* never expose vault errors or ciphertext */ }
  }
  return out;
}
export async function getWorkerSecret(db,token,name) {
  const n=validateName(name);
  const row=await get(db,'SELECT value FROM settings WHERE key=?',[PREFIX+n]);
  return row ? await decrypt(row[0],token) : null;
}
