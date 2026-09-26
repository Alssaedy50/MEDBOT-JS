/**
 * `reply_markup` normalization tests.
 *
 * Telegram rejects a call whose `reply_markup` is present but is not a JSON
 * object — "Bad Request: object expected as reply markup" — which is what a
 * serialized `null` (from a no-markup reply) or a bare row array produces. These
 * tests pin the two defences: the context never emits `null`, and the transport
 * sanitizes whatever it is handed before serialization.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { btn, keyboard, normalizeReplyMarkup } from '../src/telegram/ui.js';
import { TelegramTransport } from '../src/telegram/client.js';
import { buildCallbackContext, buildMessageContext } from '../src/telegram/context.js';

/** A transport whose `fetch` records the parsed request body. */
function recordingTransport() {
  const bodies = [];
  const transport = new TelegramTransport('token', {
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  return { transport, bodies };
}

describe('normalizeReplyMarkup', () => {
  it('drops null and undefined so no null markup is serialized', () => {
    assert.equal(normalizeReplyMarkup(null), undefined);
    assert.equal(normalizeReplyMarkup(undefined), undefined);
  });

  it('wraps a bare row array into an inline_keyboard object', () => {
    const rows = [[btn('🏠 الرئيسية', 'home')]];
    const markup = normalizeReplyMarkup(rows);
    assert.deepEqual(markup, { inline_keyboard: rows });
  });

  it('passes an already-shaped markup object through untouched', () => {
    const markup = keyboard([[btn('❌ إلغاء', 'home')]]);
    assert.equal(normalizeReplyMarkup(markup), markup);
  });

  it('drops a non-object, non-array value (e.g. a stray string)', () => {
    assert.equal(normalizeReplyMarkup('inline_keyboard'), undefined);
    assert.equal(normalizeReplyMarkup(42), undefined);
  });
});

describe('transport payload sanitization', () => {
  it('omits reply_markup entirely when a reply carries none', async () => {
    const { transport, bodies } = recordingTransport();
    await transport.sendMessage(1, 'hello');

    assert.equal(bodies.length, 1);
    assert.ok(
      !('reply_markup' in bodies[0]),
      'a null/undefined markup must not appear in the payload',
    );
  });

  it('omits reply_markup when the caller explicitly passes null', async () => {
    const { transport, bodies } = recordingTransport();
    await transport.sendMessage(1, 'hello', { reply_markup: null });
    assert.ok(!('reply_markup' in bodies[0]));
  });

  it('wraps a raw row array into an inline_keyboard object', async () => {
    const { transport, bodies } = recordingTransport();
    await transport.sendMessage(1, 'choose', {
      reply_markup: [[btn('🏠 الرئيسية', 'home')]],
    });

    assert.deepEqual(bodies[0].reply_markup, {
      inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]],
    });
  });

  it('keeps a valid keyboard object on sendPhoto and editMessageText', async () => {
    const { transport, bodies } = recordingTransport();
    const markup = keyboard([[btn('🏠 الرئيسية', 'home')]]);

    await transport.sendPhoto(1, 'file-id', { reply_markup: markup });
    await transport.editMessageText('edited', { chat_id: 1, message_id: 2, reply_markup: markup });

    assert.deepEqual(bodies[0].reply_markup, markup);
    assert.deepEqual(bodies[1].reply_markup, markup);
  });

  it('never serializes a null markup on editMessageText without one', async () => {
    const { transport, bodies } = recordingTransport();
    await transport.editMessageText('edited', { chat_id: 1, message_id: 2 });
    assert.ok(!('reply_markup' in bodies[0]));
  });
});

describe('context markup forwarding', () => {
  class CapturingBot {
    constructor() {
      this.calls = [];
    }

    async sendMessage(chatId, text, options = {}) {
      this.calls.push({ method: 'sendMessage', options });
      return { message_id: 1 };
    }

    async editMessageText(text, options = {}) {
      this.calls.push({ method: 'editMessageText', options });
      return { message_id: 1 };
    }

    async answerCallbackQuery() {
      return true;
    }
  }

  it('forwards an omitted markup as undefined, never null, on reply', async () => {
    const bot = new CapturingBot();
    const ctx = buildMessageContext({ from: { id: 7 }, text: 'hi', bot });
    await ctx.reply('plain');

    assert.equal(bot.calls[0].options.reply_markup, undefined);
  });

  it('forwards an omitted markup as undefined on editMessageText', async () => {
    const bot = new CapturingBot();
    const ctx = buildCallbackContext({
      from: { id: 7 },
      data: 'home',
      bot,
      callbackQueryId: 'cb',
      messageId: 9,
    });
    await ctx.editMessageText('plain');

    assert.equal(bot.calls[0].options.reply_markup, undefined);
  });

  it('still forwards a real markup object untouched', async () => {
    const bot = new CapturingBot();
    const markup = keyboard([[btn('🏠 الرئيسية', 'home')]]);
    const ctx = buildMessageContext({ from: { id: 7 }, text: 'hi', bot });
    await ctx.reply('choose', { reply_markup: markup });

    assert.deepEqual(bot.calls[0].options.reply_markup, markup);
  });
});
