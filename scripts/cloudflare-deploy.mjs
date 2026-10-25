#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const wranglerPath = path.join(root, 'wrangler.jsonc');
const schemaFile = path.join(root, 'artifacts', 'd1-schema.sql');

function run(cmd, options = {}) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: root, ...options });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root });
  } catch (err) {
    return String(err.stdout || '') + '\n' + String(err.stderr || '');
  }
}

function putWorkerSecret(name, value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return;
  console.log(`> Setting Cloudflare Worker secret: ${name}`);
  const res = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    cwd: root,
    input: trimmed,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (res.status !== 0) {
    console.warn(`[WARN] Could not set secret ${name} (exit ${res.status})`);
  }
}

async function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN is required to auto-provision and deploy to Cloudflare.');
  }

  let wrangler = fs.readFileSync(wranglerPath, 'utf8');
  let d1Id = String(process.env.CF_D1_DATABASE_ID || '').trim();

  if (!d1Id && !/REPLACE_WITH_D1_DATABASE_ID/i.test(wrangler)) {
    const match = wrangler.match(/"database_id"\s*:\s*"([^"]+)"/);
    if (match) d1Id = match[1];
  }

  // 1. Ensure D1 database exists and discover its UUID if not provided
  if (!d1Id) {
    console.log('> Checking existing Cloudflare D1 databases for "medbot"...');
    const listOut = runCapture('npx wrangler d1 list --json');
    try {
      const parsed = JSON.parse(listOut);
      const found = Array.isArray(parsed) && parsed.find((db) => db.name === 'medbot');
      if (found?.uuid) {
        d1Id = found.uuid;
        console.log(`> Found existing D1 database "medbot": ${d1Id}`);
      }
    } catch {
      // Fallback to creating
    }
  }

  if (!d1Id) {
    console.log('> Creating Cloudflare D1 database "medbot"...');
    const createOut = runCapture('npx wrangler d1 create medbot');
    const uuidMatch = createOut.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      d1Id = uuidMatch[0];
      console.log(`> Created D1 database "medbot": ${d1Id}`);
    } else {
      throw new Error('Could not determine D1 database_id. Set CF_D1_DATABASE_ID or check Cloudflare permissions.\n' + createOut);
    }
  }

  // Patch wrangler.jsonc with real D1 database_id
  if (/REPLACE_WITH_D1_DATABASE_ID/i.test(wrangler)) {
    wrangler = wrangler.replace(/REPLACE_WITH_D1_DATABASE_ID/g, d1Id);
    fs.writeFileSync(wranglerPath, wrangler, 'utf8');
    console.log(`> Updated wrangler.jsonc with database_id: ${d1Id}`);
  }

  // 2. Ensure R2 bucket exists (non-fatal if already exists)
  console.log('> Ensuring Cloudflare R2 bucket "medbot-files" exists...');
  runCapture('npx wrangler r2 bucket create medbot-files');

  // 3. Generate and apply D1 schema
  run('node scripts/d1-apply-schema.mjs --output ./artifacts/d1-schema.sql');
  if (fs.existsSync(schemaFile)) {
    run('npx wrangler d1 execute medbot --remote --file=./artifacts/d1-schema.sql');
  }

  // 4. Deploy Cloudflare Worker
  const deployOut = runCapture('npx wrangler deploy');
  console.log(deployOut);

  // 5. Push runtime secrets to Worker if present in environment
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  putWorkerSecret('BOT_TOKEN', botToken);
  putWorkerSecret('TELEGRAM_BOT_TOKEN', botToken);
  putWorkerSecret('ADMIN_ID', process.env.ADMIN_ID);
  putWorkerSecret('TELEGRAM_WEBHOOK_SECRET', process.env.TELEGRAM_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET);
  putWorkerSecret('GEMINI_API_KEY', process.env.GEMINI_API_KEY);
  putWorkerSecret('GROQ_API_KEY', process.env.GROQ_API_KEY);
  putWorkerSecret('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY);

  // 6. Register Telegram Webhook if BOT_TOKEN andTELEGRAM_WEBHOOK_SECRET are configured
  const urlMatch = deployOut.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  const workerBaseUrl = String(process.env.CLOUDFLARE_WORKER_URL || (urlMatch ? urlMatch[0] : '')).trim().replace(/\/+$/, '');
  const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '').trim();

  if (botToken && workerBaseUrl && webhookSecret) {
    const webhookUrl = workerBaseUrl.endsWith('/telegram/webhook')
      ? workerBaseUrl
      : `${workerBaseUrl}/telegram/webhook`;
    console.log(`> Registering Telegram Webhook -> ${webhookUrl}`);
    run('node scripts/cloudflare-webhook.mjs set', {
      env: {
        ...process.env,
        BOT_TOKEN: botToken,
        TELEGRAM_BOT_TOKEN: botToken,
        WEBHOOK_URL: webhookUrl,
        TELEGRAM_WEBHOOK_SECRET: webhookSecret,
        WEBHOOK_SECRET: webhookSecret,
      },
    });
  } else {
    console.log('> Skipping automatic Telegram webhook registration (set BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to enable).');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
