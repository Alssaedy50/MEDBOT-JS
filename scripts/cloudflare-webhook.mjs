#!/usr/bin/env node
const token = String(process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const action = process.argv[2];
const url = String(process.env.WEBHOOK_URL ?? '').trim();
const secret = String(process.env.WEBHOOK_SECRET ?? '').trim();

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!['set', 'info', 'delete'].includes(action)) throw new Error('Choose: set | info | delete');

if (action === 'set') {
  if (!/^https:\/\//.test(url)) throw new Error('WEBHOOK_URL must be HTTPS');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error('WEBHOOK_SECRET must use Telegram secret-token characters and be <=256 chars');
  }
}

async function telegram(method, payload = {}) {
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Telegram HTTP ' + response.status);
  const body = await response.json();
  if (!body.ok) throw new Error(body.description || ('Telegram rejected ' + method));
  return body.result;
}

if (action === 'set') {
  const result = await telegram('setWebhook', { url, secret_token: secret, drop_pending_updates: false });
  console.log('Webhook set: ' + Boolean(result));
} else if (action === 'info') {
  const result = await telegram('getWebhookInfo');
  console.log(JSON.stringify({
    url: result.url,
    has_custom_certificate: result.has_custom_certificate,
    pending_update_count: result.pending_update_count,
    last_error_date: result.last_error_date,
    last_error_message: result.last_error_message,
    max_connections: result.max_connections,
  }, null, 2));
} else {
  const result = await telegram('deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook deleted: ' + Boolean(result));
}
