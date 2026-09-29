#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
const exists = (p) => fs.existsSync(path.join(root, p));

const wranglerPath = path.join(root, 'wrangler.jsonc');
let wrangler = '';
if (fs.existsSync(wranglerPath)) {
  wrangler = fs.readFileSync(wranglerPath, 'utf8');
  add('wrangler_config', 'PASS', 'wrangler.jsonc present');
} else add('wrangler_config', 'FAIL', 'wrangler.jsonc is missing');

for (const file of [
  'src/worker.js',
  'src/telegram/webhook.js',
  'src/db/d1/migrations.js',
  'src/db/d1/telegramUpdates.js',
  'src/storage/r2.js',
  'package-lock.json',
]) {
  add('file:' + file, exists(file) ? 'PASS' : 'FAIL', exists(file) ? 'present' : 'missing');
}

const placeholderAllowed = String(process.env.CF_PREFLIGHT_ALLOW_D1_PLACEHOLDER ?? '') === '1';
const d1Configured = /"database_id"\s*:\s*"[^"]+"/.test(wrangler) && (!/REPLACE_WITH_D1_DATABASE_ID/i.test(wrangler) || placeholderAllowed);
add('d1_database_id', d1Configured ? 'PASS' : 'FAIL', d1Configured ? (placeholderAllowed ? 'placeholder accepted for CI only' : 'configured') : 'D1 database_id is still a placeholder or missing');

const workerConfigured = /"main"\s*:\s*"src\/worker\.js"/.test(wrangler);
add('worker_entrypoint', workerConfigured ? 'PASS' : 'FAIL', workerConfigured ? 'src/worker.js' : 'expected src/worker.js');

const r2Configured = /"binding"\s*:\s*"FILES"/.test(wrangler) && /"bucket_name"\s*:\s*"medbot-files"/.test(wrangler);
add('r2_binding', r2Configured ? 'PASS' : 'FAIL', r2Configured ? 'FILES -> medbot-files' : 'FILES R2 binding missing');

const node = process.versions.node.split('.').map(Number);
add('node', node[0] > 22 || (node[0] === 22 && node[1] >= 5) ? 'PASS' : 'FAIL',
  'running ' + process.version + '; required >=22.5.0');

const admin = String(process.env.ADMIN_ID ?? '').trim();
add('ADMIN_ID', /^-?\d+$/.test(admin) ? 'PASS' : 'WARN', admin ? 'configured' : 'not set locally');

const token = String(process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
add('TELEGRAM_BOT_TOKEN', token ? 'PASS' : 'WARN', token ? 'configured (hidden)' : 'not set locally');

const workerUrl = String(process.env.CLOUDFLARE_WORKER_URL ?? '').trim();
add('CLOUDFLARE_WORKER_URL', /^https:\/\//.test(workerUrl) ? 'PASS' : 'WARN',
  workerUrl ? 'configured' : 'not set; required for webhook staging');

const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
add('TELEGRAM_WEBHOOK_SECRET', webhookSecret ? 'PASS' : 'WARN',
  webhookSecret ? 'configured (hidden)' : 'not set; required for webhook staging');

const suspicious = [
  /bot\d{6,}:[A-Za-z0-9_-]{20,}/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
].some((re) => re.test(wrangler));
add('config_secret_scan', suspicious ? 'FAIL' : 'PASS',
  suspicious ? 'possible credential pattern in wrangler.jsonc' : 'no credential pattern found');

const failures = checks.filter((c) => c.status === 'FAIL');
for (const c of checks) console.log('[' + c.status + '] ' + c.name + ': ' + c.detail);
console.log('Summary: PASS=' + checks.filter(c => c.status === 'PASS').length +
  ' WARN=' + checks.filter(c => c.status === 'WARN').length +
  ' FAIL=' + failures.length);
if (failures.length) process.exitCode = 1;
