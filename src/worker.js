import { handleTelegramWebhook } from './telegram/webhook.js';
import { createD1TelegramIdempotencyStore, initTelegramWebhookStore } from './db/d1/telegramUpdates.js';
import { createR2Storage } from './storage/r2.js';
import { createWorkerTelegramDispatcher } from './telegram/workerDispatcher.js';
import { buildWorkerHome, buildWorkerAccount } from './telegram/workerHome.js';

function json(data, status = 200) {
  return new globalThis.Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function healthResponse(env = {}) {
  return json({
    ok: true, service: 'MEDBOT', runtime: 'cloudflare-worker', phase: 10,
    telegram_webhook: 'adapter_enabled', telegram_domain_router: 'partial',
    database: env.DB ? 'd1-bound' : 'd1-missing',
    object_storage: env.FILES ? 'r2-bound' : 'r2-missing',
  });
}

function telegramBot(token) {
  if (!token) return null;
  async function call(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`telegram_${method}_failed`);
    const body = await response.json();
    if (!body.ok) throw new Error(`telegram_${method}_rejected`);
    return body.result;
  }
  return {
    sendMessage: (chatId, text, options = {}) => call('sendMessage', { chat_id: chatId, text, ...options }),
    editMessageText: (text, options = {}) => call('editMessageText', { text, ...options }),
    answerCallbackQuery: (id) => call('answerCallbackQuery', { callback_query_id: id }),
  };
}

async function dispatchTelegramUpdate(update, { env }) {
  const bot = telegramBot(env.TELEGRAM_BOT_TOKEN);
  if (!bot) throw new Error('telegram_bot_token_not_configured');
  const handlers = {
    command: async (ctx) => {
      const command = String(ctx.text).trim().split(/\\s+/, 1)[0].split('@', 1)[0].slice(1);
      if (command === 'start') { const menu = await buildWorkerHome(ctx.db, ctx.from); return ctx.reply(menu.text, { reply_markup: menu.reply_markup }); }
      throw new Error('worker_command_not_migrated');
    },
    callback: async (ctx) => {
      if (ctx.data === 'home') {
        const menu = await buildWorkerHome(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'account') {
        const account = await buildWorkerAccount(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(account.text, { reply_markup: account.reply_markup, parse_mode: 'HTML' });
      }
      throw new Error('worker_callback_not_migrated');
    },
  };
  const dispatch = createWorkerTelegramDispatcher({ bot, db: env.DB, handlers });
  return dispatch(update);
}

async function webhookResponse(request, env) {
  if (!env.DB) return json({ ok: false, error: 'd1_not_configured' }, 503);
  await initTelegramWebhookStore(env.DB);
  const idempotency = createD1TelegramIdempotencyStore(env.DB);
  return handleTelegramWebhook(request, { env, idempotency, dispatch: dispatchTelegramUpdate });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return healthResponse(env);
    if (url.pathname === '/telegram/webhook') return webhookResponse(request, env);
    if (url.pathname === '/storage/status') {
      return json({ ok: Boolean(env.FILES), storage: env.FILES ? 'r2' : 'unconfigured', adapter: env.FILES ? Boolean(createR2Storage(env.FILES)) : false });
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
};
