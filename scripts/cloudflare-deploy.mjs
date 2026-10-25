#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const wranglerPath = path.join(root, 'wrangler.jsonc');
const schemaFile = path.join(root, 'artifacts', 'd1-schema.sql');
const remoteSchemaFile = path.join(root, 'artifacts', 'd1-schema-remote.sql');

function ghaNotice(title, msg) {
  const clean = String(msg ?? '').replace(/\r?\n/g, ' | ').slice(0, 500);
  console.log(`::notice title=${title}::${clean}`);
}

function ghaError(title, msg) {
  const clean = String(msg ?? '').replace(/\r?\n/g, ' | ').slice(0, 800);
  console.log(`::error title=${title}::${clean}`);
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (env[key] === '' || env[key] === undefined || env[key] === null) {
      delete env[key];
    }
  }
  return env;
}

async function cfApi(token, endpoint, { method = 'GET', body = null } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${res.status}` }] }));
  return { status: res.status, ok: Boolean(data?.success), result: data?.result, errors: data?.errors || [] };
}

function extractHex32(input) {
  const match = String(input || '').match(/([a-f0-9]{32})/i);
  return match ? match[1].toLowerCase() : '';
}

function extractUuid(input) {
  const match = String(input || '').match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return match ? match[1].toLowerCase() : '';
}

async function resolveAccountId(apiToken) {
  const envCandidate = extractHex32(process.env.CLOUDFLARE_ACCOUNT_ID);

  // 1. Query /accounts directly from API token
  console.log('> Discovering Cloudflare Account ID from /accounts...');
  const accRes = await cfApi(apiToken, '/accounts?per_page=20');
  if (accRes.ok && Array.isArray(accRes.result) && accRes.result.length > 0) {
    const matched = envCandidate
      ? accRes.result.find((a) => String(a.id).toLowerCase() === envCandidate)
      : null;
    const chosen = (matched || accRes.result[0]).id;
    console.log(`> Resolved Cloudflare Account ID via /accounts (${accRes.result.length} found)`);
    return chosen;
  }

  // 2. Query /memberships as fallback
  console.log('> Checking /memberships for Cloudflare Account ID...');
  const memRes = await cfApi(apiToken, '/memberships?per_page=20');
  if (memRes.ok && Array.isArray(memRes.result) && memRes.result.length > 0) {
    const accounts = memRes.result.map((m) => m?.account).filter((a) => a?.id);
    if (accounts.length > 0) {
      const matched = envCandidate
        ? accounts.find((a) => String(a.id).toLowerCase() === envCandidate)
        : null;
      const chosen = (matched || accounts[0]).id;
      console.log(`> Resolved Cloudflare Account ID via /memberships`);
      return chosen;
    }
  }

  // 3. Run wrangler whoami WITHOUT CLOUDFLARE_ACCOUNT_ID in env
  console.log('> Running wrangler whoami to discover Account ID...');
  const whoamiRes = spawnSync('npx', ['wrangler', 'whoami'], {
    cwd: root,
    env: cleanEnv({ CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: '' }),
    encoding: 'utf8',
  });
  const whoamiOut = `${whoamiRes.stdout || ''}\n${whoamiRes.stderr || ''}`;
  const whoamiHex = extractHex32(whoamiOut);
  if (whoamiHex) {
    console.log('> Resolved Cloudflare Account ID via wrangler whoami');
    return whoamiHex;
  }

  // 4. Fall back to extracted 32-hex from CLOUDFLARE_ACCOUNT_ID if valid
  if (envCandidate) {
    console.log('> Using 32-hex Account ID extracted from CLOUDFLARE_ACCOUNT_ID');
    return envCandidate;
  }

  const errDetails = accRes.errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'No valid 32-character hex Account ID found';
  throw new Error(
    `Invalid Cloudflare Account ID (${errDetails}). Ensure CLOUDFLARE_ACCOUNT_ID in GitHub Secrets is your 32-character hex Account ID from the Cloudflare Dashboard URL (dash.cloudflare.com/<ACCOUNT_ID>), and CLOUDFLARE_API_TOKEN is valid.`
  );
}

function putWorkerSecret(name, value, envVars) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return;
  console.log(`> Setting Cloudflare Worker secret: ${name}`);
  const res = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    cwd: root,
    env: cleanEnv(envVars),
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
    ghaNotice('Cloudflare Deploy Skipped', 'CLOUDFLARE_API_TOKEN is empty in GitHub Secrets.');
    return;
  }

  // 1. Resolve and validate 32-hex Cloudflare Account ID
  const accountId = await resolveAccountId(apiToken);
  const cfEnv = {
    CLOUDFLARE_API_TOKEN: apiToken,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };

  // 2. Find or create D1 database "medbot"
  let wrangler = fs.readFileSync(wranglerPath, 'utf8');
  let d1Id = extractUuid(process.env.CF_D1_DATABASE_ID);
  if (d1Id) {
    const checkDb = await cfApi(apiToken, `/accounts/${accountId}/d1/database/${d1Id}`);
    if (!checkDb.ok) {
      console.warn('> CF_D1_DATABASE_ID was not found on this account; searching for "medbot" D1 database instead.');
      d1Id = '';
    }
  }

  if (!d1Id && !/REPLACE_WITH_D1_DATABASE_ID/i.test(wrangler)) {
    d1Id = extractUuid(wrangler);
  }

  if (!d1Id) {
    console.log('> Listing D1 databases via Cloudflare API...');
    const listRes = await cfApi(apiToken, `/accounts/${accountId}/d1/database`);
    if (listRes.ok && Array.isArray(listRes.result)) {
      const existing = listRes.result.find((db) => db.name === 'medbot') || listRes.result[0];
      if (existing?.uuid) {
        d1Id = existing.uuid;
        console.log(`> Found existing D1 database "${existing.name}": ${d1Id}`);
      }
    }
  }

  if (!d1Id) {
    console.log('> Creating D1 database "medbot" via Cloudflare API...');
    const createRes = await cfApi(apiToken, `/accounts/${accountId}/d1/database`, {
      method: 'POST',
      body: { name: 'medbot' },
    });
    if (createRes.ok && createRes.result?.uuid) {
      d1Id = createRes.result.uuid;
      console.log(`> Created D1 database "medbot": ${d1Id}`);
    } else {
      console.log('> Falling back to wrangler d1 create medbot...');
      const cliCreate = spawnSync('npx', ['wrangler', 'd1', 'create', 'medbot'], {
        cwd: root,
        env: cleanEnv(cfEnv),
        encoding: 'utf8',
      });
      const cliOut = `${cliCreate.stdout || ''}\n${cliCreate.stderr || ''}`;
      d1Id = extractUuid(cliOut);
      if (!d1Id) {
        const errMsg = createRes.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
        throw new Error(`Failed to create/find D1 database "medbot": ${errMsg}. Ensure CLOUDFLARE_API_TOKEN has D1:Edit permission.`);
      }
    }
  }

  // 3. Check/Create R2 bucket "medbot-files" (gracefully disable R2 binding if R2 is not enabled on the account)
  console.log('> Checking R2 bucket "medbot-files"...');
  const r2Check = await cfApi(apiToken, `/accounts/${accountId}/r2/buckets/medbot-files`);
  let r2Available = r2Check.ok;
  if (!r2Available) {
    const r2Create = await cfApi(apiToken, `/accounts/${accountId}/r2/buckets`, {
      method: 'POST',
      body: { name: 'medbot-files' },
    });
    r2Available = r2Create.ok || r2Create.errors.some((e) => Number(e.code) === 10004 || /already exists/i.test(e.message));
  }

  // 4. Patch wrangler.jsonc with real D1 UUID (and strip R2 binding if R2 is not enabled on account)
  wrangler = wrangler.replace(/REPLACE_WITH_D1_DATABASE_ID/g, d1Id);
  if (!r2Available) {
    console.log('> R2 is not enabled on this Cloudflare account; deploying Worker with D1 only.');
    wrangler = wrangler.replace(/,\s*"r2_buckets"\s*:\s*\[[\s\S]*?\]/m, '');
  }
  fs.writeFileSync(wranglerPath, wrangler, 'utf8');

  // 5. Generate and apply D1 schema
  console.log('> Generating and applying D1 schema v18...');
  execSync('node scripts/d1-apply-schema.mjs --output ./artifacts/d1-schema.sql', { stdio: 'inherit', cwd: root });
  if (fs.existsSync(schemaFile)) {
    const rawSql = fs.readFileSync(schemaFile, 'utf8');
    const remoteSql = rawSql
      .split('\n')
      .filter((line) => !/^\s*PRAGMA\b/i.test(line) && !/^\s*--/.test(line) && line.trim())
      .join('\n');
    fs.writeFileSync(remoteSchemaFile, remoteSql, 'utf8');

    const d1Query = await cfApi(apiToken, `/accounts/${accountId}/d1/database/${d1Id}/query`, {
      method: 'POST',
      body: { sql: remoteSql },
    });
    if (!d1Query.ok) {
      console.log('> Applying D1 schema via wrangler d1 execute...');
      spawnSync('npx', ['wrangler', 'd1', 'execute', 'medbot', '--remote', '--yes', '--file=./artifacts/d1-schema-remote.sql'], {
        cwd: root,
        env: cleanEnv(cfEnv),
        stdio: 'inherit',
      });
    }
    try {
      fs.unlinkSync(remoteSchemaFile);
    } catch {}
  }

  // 6. Deploy Cloudflare Worker
  console.log('> Deploying Cloudflare Worker...');
  const deployRes = spawnSync('npx', ['wrangler', 'deploy'], {
    cwd: root,
    env: cleanEnv(cfEnv),
    encoding: 'utf8',
  });
  const deployOut = `${deployRes.stdout || ''}\n${deployRes.stderr || ''}`;
  console.log(deployOut);
  if (deployRes.status !== 0) {
    throw new Error(`Wrangler deploy failed: ${deployOut.slice(-600)}`);
  }

  // Ensure workers.dev route is enabled for medbot-js
  await cfApi(apiToken, `/accounts/${accountId}/workers/scripts/medbot-js/subdomain`, {
    method: 'POST',
    body: { enabled: true },
  }).catch(() => {});

  // 7. Push runtime secrets to Worker
  const botToken = String(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const explicitSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '').trim();
  const webhookSecret = explicitSecret || (
    botToken
      ? crypto.createHmac('sha256', botToken).update('medbot-cloudflare-webhook').digest('hex')
      : ''
  );

  putWorkerSecret('BOT_TOKEN', botToken, cfEnv);
  putWorkerSecret('TELEGRAM_BOT_TOKEN', botToken, cfEnv);
  putWorkerSecret('ADMIN_ID', process.env.ADMIN_ID, cfEnv);
  putWorkerSecret('TELEGRAM_WEBHOOK_SECRET', webhookSecret, cfEnv);
  putWorkerSecret('MEDBOT_ARCHIVE_CHANNEL', process.env.MEDBOT_ARCHIVE_CHANNEL || process.env.ARCHIVE_CHANNEL_ID, cfEnv);
  putWorkerSecret('GEMINI_API_KEY', process.env.GEMINI_API_KEY, cfEnv);
  putWorkerSecret('GROQ_API_KEY', process.env.GROQ_API_KEY, cfEnv);
  putWorkerSecret('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY, cfEnv);

  // 8. Discover Worker URL and register Telegram Webhook
  const urlMatch = deployOut.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  let workerBaseUrl = urlMatch ? urlMatch[0] : '';
  if (!workerBaseUrl) {
    const subRes = await cfApi(apiToken, `/accounts/${accountId}/workers/subdomain`);
    if (subRes.ok && subRes.result?.subdomain) {
      workerBaseUrl = `https://medbot-js.${subRes.result.subdomain}.workers.dev`;
    }
  }
  if (!workerBaseUrl && /^https:\/\/[a-z0-9.-]+/i.test(String(process.env.CLOUDFLARE_WORKER_URL || '').trim())) {
    workerBaseUrl = String(process.env.CLOUDFLARE_WORKER_URL).trim().replace(/\/+$/, '');
  }

  if (botToken && workerBaseUrl && webhookSecret) {
    const webhookUrl = workerBaseUrl.endsWith('/telegram/webhook')
      ? workerBaseUrl
      : `${workerBaseUrl}/telegram/webhook`;
    console.log(`> Registering Telegram Webhook -> ${webhookUrl}`);
    execSync('node scripts/cloudflare-webhook.mjs set', {
      stdio: 'inherit',
      cwd: root,
      env: cleanEnv({
        BOT_TOKEN: botToken,
        TELEGRAM_BOT_TOKEN: botToken,
        WEBHOOK_URL: webhookUrl,
        TELEGRAM_WEBHOOK_SECRET: webhookSecret,
        WEBHOOK_SECRET: webhookSecret,
      }),
    });
    ghaNotice('Cloudflare Deploy Success', `Worker deployed and Telegram Webhook bound to ${webhookUrl}`);
  } else {
    ghaNotice('Cloudflare Worker Deployed', `Worker URL: ${workerBaseUrl || 'unknown'} (set BOT_TOKEN to register webhook)`);
  }
}

main().catch((err) => {
  ghaError('Cloudflare Deploy Error', err.message || String(err));
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
