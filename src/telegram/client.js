/**
 * A minimal, dependency-free transport over the Telegram Bot API.
 *
 * The bot talks to Telegram over plain HTTPS (`fetch`), which keeps the project
 * free of a heavy client library and makes the transport trivially stubbable in
 * tests. It implements exactly the methods the UI uses plus long-polling.
 *
 * Every method returns the Telegram `result` payload, and a BotApiError carries
 * the HTTP status, the Telegram `description` and a `retry_after` where present
 * (so the delivery engine can honour a 429).
 */

import { normalizeReplyMarkup } from './ui.js';

export const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Prepare one Bot API payload for serialization.
 *
 * `undefined` fields are dropped (JSON.stringify already does this) and
 * `reply_markup` is normalised to a valid object or removed. Telegram rejects
 * a present-but-null `reply_markup` with "object expected as reply markup", so
 * this is the last line of defence for every send/edit method.
 */
function sanitizePayload(payload) {
  const clean = { ...payload };
  const markup = normalizeReplyMarkup(clean.reply_markup);
  if (markup === undefined) delete clean.reply_markup;
  else clean.reply_markup = markup;
  return clean;
}

/**
 * Update types the bot subscribes to on every long-poll.
 *
 * Telegram remembers the last `allowed_updates` it was given and reuses it when
 * the parameter is omitted. A restricted set persisted by an earlier run (or a
 * webhook) therefore keeps filtering out `callback_query` forever: `/start`
 * works, but button presses never arrive. Naming the full set on every boot
 * makes that stuck state impossible — this mirrors `Update.ALL_TYPES` in the
 * Python reference.
 */
export const POLLING_ALLOWED_UPDATES = Object.freeze([
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
  'message_reaction',
  'message_reaction_count',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'purchased_paid_media',
  'managed_bot',
  'guest_message',
]);

/** A Telegram API failure, carrying the fields the caller needs to react. */
export class BotApiError extends Error {
  constructor(method, status, description, parameters = null) {
    super(`${method} failed (${status}): ${description}`);
    this.name = 'BotApiError';
    this.method = method;
    this.status = status;
    this.description = description;
    this.parameters = parameters;
    if (parameters && parameters.retry_after !== undefined) {
      this.retry_after = parameters.retry_after;
    }
  }
}

export class TelegramTransport {
  /**
   * @param {string} token Bot token from @BotFather.
   * @param {object} [options] `{ fetchImpl, apiBase }` for testing.
   */
  constructor(token, { fetchImpl = fetch, apiBase = TELEGRAM_API } = {}) {
    if (!token) throw new Error('A Telegram bot token is required.');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    this._meMarker = null;
  }

  url(method) {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  /** Call one Bot API method. Throws BotApiError on a non-ok response. */
  async call(method, payload = {}, { timeoutMs = 35000 } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.url(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitizePayload(payload)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BotApiError(method, 0, `network error: ${error.message}`);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || !data?.ok) {
      const description = data?.description ?? response.statusText ?? 'unknown error';
      throw new BotApiError(method, response.status, description, data?.parameters ?? null);
    }

    return data.result;
  }

  // ---- Methods used by the UI -------------------------------------
  sendMessage(chatId, text, options = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
      message_thread_id: options.message_thread_id,
    });
  }

  editMessageText(text, options = {}) {
    return this.call('editMessageText', {
      chat_id: options.chat_id,
      message_id: options.message_id,
      text,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
    });
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: options.text,
      show_alert: options.show_alert,
    });
  }

  sendDocument(chatId, document, options = {}) {
    return this.call('sendDocument', {
      chat_id: chatId,
      document,
      caption: options.caption,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
      message_thread_id: options.message_thread_id,
    });
  }

  sendPhoto(chatId, photo, options = {}) {
    return this.call('sendPhoto', {
      chat_id: chatId,
      photo,
      caption: options.caption,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
      message_thread_id: options.message_thread_id,
    });
  }

  sendAudio(chatId, audio, options = {}) {
    return this.call('sendAudio', {
      chat_id: chatId,
      audio,
      caption: options.caption,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
      message_thread_id: options.message_thread_id,
    });
  }

  sendVideo(chatId, video, options = {}) {
    return this.call('sendVideo', {
      chat_id: chatId,
      video,
      caption: options.caption,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
      message_thread_id: options.message_thread_id,
    });
  }

  sendVoice(chatId, voice, options = {}) {
    return this.call('sendVoice', {
      chat_id: chatId,
      voice,
      caption: options.caption,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
    });
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  /** Long-poll for updates. `offset` acknowledges everything below it. */
  async getUpdates(offset = 0, timeout = 30) {
    return this.call(
      'getUpdates',
      {
        offset,
        timeout,
        allowed_updates: POLLING_ALLOWED_UPDATES,
      },
      { timeoutMs: (timeout + 10) * 1000 },
    );
  }

  getMe() {
    return this.call('getMe');
  }

  /** Chat metadata (type, title). Used by the archive health diagnostic. */
  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }

  /** One member's status/permissions. Used by the archive health diagnostic. */
  getChatMember(chatId, userId) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }
}
