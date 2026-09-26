/**
 * Handler context abstraction.
 *
 * MEDBOT handlers are written against a small, explicit context object rather
 * than Telegraf's rich `ctx`. That keeps every handler testable without a
 * network (the tests build the same object the adapter builds) and keeps the
 * business logic independent of the Telegram client library.
 *
 * A context exposes exactly what the UI needs:
 *
 *   ctx.from       { id, username, first_name, full_name }
 *   ctx.data       callback_data (callback contexts only)
 *   ctx.text       message text (message contexts only)
 *   ctx.userData   per-user scratch space (workflow state)
 *   ctx.chatId     chat to reply into
 *   ctx.bot        the transport (sendMessage/sendDocument/...)
 *   ctx.answer()              acknowledge a callback
 *   ctx.editMessageText(t,o)  edit the message a callback came from
 *   ctx.reply(t,o)            send a new message
 *   ctx.getBot()              the transport
 *
 * A callback context also carries the two Telegram identifiers the Bot API
 * requires but the UI never names: `callbackQueryId` (to acknowledge the tap)
 * and `messageId` (to edit the message the tap came from). The adapter sets
 * both from the raw update; they are never reconstructed from other state.
 *
 * `src/telegram/adapter.js` maps real Telegraf updates onto this shape; the
 * test harness builds it directly.
 */

import { normalizeReplyMarkup, ParseMode } from './ui.js';

/** Bot transport contract every implementation (Telegraf, test double) meets. */
export const BOT_METHODS = Object.freeze([
  'sendMessage',
  'sendDocument',
  'sendPhoto',
  'sendAudio',
  'sendVideo',
  'sendVoice',
  'editMessageText',
  'answerCallbackQuery',
]);

function normaliseUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username ?? null,
    first_name: user.first_name ?? user.firstName ?? null,
    full_name:
      user.full_name ??
      user.fullName ??
      [user.first_name ?? user.firstName, user.last_name ?? user.lastName]
        .filter(Boolean)
        .join(' '),
    last_name: user.last_name ?? user.lastName ?? null,
    language_code: user.language_code ?? user.languageCode ?? null,
  };
}

/**
 * Build a context for a callback query.
 *
 * `bot` may be null for handlers that never send anything; `getBot()` then
 * returns a throwing stub so a mistake surfaces immediately instead of silently
 * dropping a message.
 */
export function buildCallbackContext({
  from,
  data,
  bot = null,
  chatId = null,
  userData = {},
  callbackQueryId = null,
  messageId = null,
}) {
  const context = {
    kind: 'callback',
    from: normaliseUser(from),
    data: String(data ?? ''),
    userData,
    chatId: chatId ?? from?.id ?? null,
    bot,
    callbackQueryId,
    messageId,
    answered: false,
    edited: false,
    lastText: null,
    lastMarkup: null,
    lastParseMode: null,

    async answer() {
      this.answered = true;
      if (bot?.answerCallbackQuery) {
        try {
          await bot.answerCallbackQuery(this.callbackQueryId);
        } catch {
          // A callback acknowledgement is best-effort, exactly like Python.
        }
      }
    },

    async editMessageText(text, options = {}) {
      this.edited = true;
      this.lastText = text;
      this.lastMarkup = options.reply_markup ?? null;
      this.lastParseMode = options.parse_mode ?? null;
      if (bot?.editMessageText) {
        try {
          await bot.editMessageText(text, {
            chat_id: this.chatId,
            message_id: options.message_id ?? this.messageId,
            parse_mode: options.parse_mode ?? ParseMode.HTML,
            // Never a `null` markup: Telegram rejects it outright. Omitting the
            // key keeps the previous keyboard, which is the intended behaviour.
            reply_markup: normalizeReplyMarkup(options.reply_markup),
          });
        } catch {
          // An edit can fail if the text is unchanged; never fatal.
        }
      }
    },

    async reply(text, options = {}) {
      this.lastText = text;
      this.lastMarkup = options.reply_markup ?? null;
      if (bot?.sendMessage) {
        return bot.sendMessage(this.chatId, text, {
          parse_mode: options.parse_mode ?? ParseMode.HTML,
          reply_markup: normalizeReplyMarkup(options.reply_markup),
        });
      }
      return null;
    },

    getBot() {
      if (!bot) {
        throw new Error('This handler needs a bot transport but none was provided.');
      }
      return bot;
    },
  };

  return context;
}

/** Build a context for a plain text message. */
export function buildMessageContext({
  from,
  text,
  bot = null,
  chatId = null,
  userData = {},
}) {
  const context = {
    kind: 'message',
    from: normaliseUser(from),
    text: String(text ?? ''),
    data: null,
    userData,
    chatId: chatId ?? from?.id ?? null,
    bot,
    replied: false,
    lastText: null,
    lastMarkup: null,

    async answer() {
      // Messages have no callback to acknowledge.
    },

    async editMessageText() {
      // A message context cannot edit; fall through to a reply.
    },

    async reply(text2, options = {}) {
      this.replied = true;
      this.lastText = text2;
      this.lastMarkup = options.reply_markup ?? null;
      if (bot?.sendMessage) {
        return bot.sendMessage(this.chatId, text2, {
          parse_mode: options.parse_mode ?? ParseMode.HTML,
          reply_markup: normalizeReplyMarkup(options.reply_markup),
        });
      }
      return null;
    },

    getBot() {
      if (!bot) {
        throw new Error('This handler needs a bot transport but none was provided.');
      }
      return bot;
    },
  };

  return context;
}

/** Build a context for a message carrying media (upload flows). */
export function buildMediaContext({ from, message, bot = null, chatId = null, userData = {} }) {
  const context = buildMessageContext({ from, text: message?.caption ?? '', bot, chatId, userData });
  context.kind = 'media';
  context.message = message;
  return context;
}
