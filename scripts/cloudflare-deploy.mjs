#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const wranglerPath = path.join(root, 'wrangler.jsonc');
const schemaFile = path.join(root, 'artifacts', 'd1-schema.sql');
const remoteSchemaFile = path.join(root, 'artifacts', 'd1-schema-remote.sql');

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (env[key] === '') delete env[key];
  }
  return env;
}

function run(cmd, options = {}) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: root, env: cleanEnv(), ...options });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: root,
      env: cleanEnv(),
    });
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
    env: cleanEnv(),
    input: trimmed,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (res.status !== 0) {
    console.warn(`[WARN] Could not set secret ${name} (exit ${res.status})`);
  }
}

async function main() {
  const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!apiToken) {
    console.log('[SKIP] CLOUDFLARE_API_TOKEN is not set in GitHub Secrets. Skipping Cloudflare deployment.');
    return;
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
      const jsonStart = listOut.indexOf('[');
      const jsonEnd = listOut.lastIndexOf(']');
      const parsed = jsonStart >= 0 && jsonEnd > jsonStart
        ? JSON.parse(listOut.slice(jsonStart, jsonEnd + 1))
        : JSON.parse(listOut);
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
      throw new Error('Could not determine D1 database_id. Set CF_D1_DATABASE_ID or check Cloudflare API token permissions (D1:Edit).\n' + createOut);
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

  // 3. Generate and apply D1 schema (strip PRAGMA for remote D1 API compatibility)
  run('node scripts/d1-apply-schema.mjs --output ./artifacts/d1-schema.sql');
  if (fs.existsSync(schemaFile)) {
    const rawSql = fs.readFileSync(schemaFile, 'utf8');
    const remoteSql = rawSql
      .split('\n')
      .filter((line) => !/^\s*PRAGMA\b/i.test(line))
      .join('\n');
    fs.writeFileSync(remoteSchemaFile, remoteSql, 'utf8');
    run('npx wrangler d1 execute medbot --remote --yes --file=./artifacts/d1-schema-remote.sql');
  }

  // 4. Deploy Cloudflare Worker
  console.log('> Deploying Cloudflare Worker...');
  const deployRes = spawnSync('npx', ['wrangler', 'deploy'], {
    cwd: root,
    env: cleanEnv(),
    encoding: 'utf8',
  });
  const deployOut = String(deployRes.stdout || '') + '\n' + String(deployRes.stderr || '');
  console.log(deployOut);
  if (deployRes.status !== 0) {
    throw new Error(`Wrangler deploy failed with exit code ${deployRes.status}`);
  }

  // 5. Push runtime secrets to Worker
  const botToken = String(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const explicitSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '').trim();
  const webhookSecret = explicitSecret || (
    botToken
      ? crypto.createHmac('sha256', botToken).update('medbot-cloudflare-webhook').digest('hex')
      : ''
  );

  putWorkerSecret('BOT_TOKEN', botToken);
  putWorkerSecret('TELEGRAM_BOT_TOKEN', botToken);
  putWorkerSecret('ADMIN_ID', process.env.ADMIN_ID);
  putWorkerSecret('TELEGRAM_WEBHOOK_SECRET', webhookSecret);
  putWorkerSecret('MEDBOT_ARCHIVE_CHANNEL', process.env.MEDBOT_ARCHIVE_CHANNEL || process.env.ARCHIVE_CHANNEL_ID);
  putWorkerSecret('GEMINI_API_KEY', process.env.GEMINI_API_KEY);
  putWorkerSecret('GROQ_API_KEY', process.env.GROQ_API_KEY);
  putWorkerSecret('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY);

  // 6. Register Telegram Webhook automatically
  const urlMatch = deployOut.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  const workerBaseUrl = String(process.env.CLOUDFLARE_WORKER_URL || (urlMatch ? urlMatch[0] : '')).trim().replace(/\/+$/, '');

  if (botToken && workerBaseUrl && webhookSecret) {
    const webhookUrl = workerBaseUrl.endsWith('/telegram/webhook')
      ? workerBaseUrl
      : `${workerBaseUrl}/telegram/webhook`;
    console.log(`> Registering Telegram Webhook -> ${webhookUrl}`);
    run('node scripts/cloudflare-webhook.mjs set', {
      env: {
        ...cleanEnv(),
        BOT_TOKEN: botToken,
        TELEGRAM_BOT_TOKEN: botToken,
        WEBHOOK_URL: webhookUrl,
        TELEGRAM_WEBHOOK_SECRET: webhookSecret,
        WEBHOOK_SECRET: webhookSecret,
      },
    });
  } else {
    console.log('> Skipping automatic Telegram webhook registration (set BOT_TOKEN and ensure workers.dev subdomain is active).');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
