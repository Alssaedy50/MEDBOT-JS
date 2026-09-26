/**
 * Telegram output-safety tests (AI Quality V2).
 *
 * Pins three contracts the UI relies on:
 *   * every rendered `reply_markup` is a two-dimensional `inline_keyboard`;
 *   * every `callback_data` fits Telegram's 64-BYTE limit and stays routable;
 *   * dynamically escaped content (Arabic/English, punctuation, RTL) reaches the
 *     transport intact under the HTML parse mode the app uses.
 *
 * No live Telegram is contacted.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import { btn, escHtml, isInlineKeyboard, validateReplyMarkup, byteLength } from '../src/telegram/ui.js';
import {
  callbackCtx,
  cleanupDb,
  FakeBot,
  freshDb,
  lastButtons,
  lastMarkup,
} from './helpers/harness.js';

let dbPath;
let router;
let botModule;
let ownerId;

before(async () => {
  dbPath = freshDb('telegram-safety');
  router = await import('../src/telegram/router.js');
  botModule = await import('../src/telegram/bot.js');
  botModule.registerHandlers();

  ownerId = 9500;
  db.registerUser(ownerId, 'owner', 'Owner');
  db.ensureConfiguredAdmin(ownerId, 'owner');

  // A small registry so the browsing screens render real buttons.
  const year = db.addFolder(0, 'Safety Year', 'general');
  db.addFolder(year, 'Safety Subject', 'general', 1);
});

after(() => {
  cleanupDb(dbPath);
});

/** A broad sweep of screens a student or admin can actually reach. */
const SCREEN_CALLBACKS = [
  'home',
  'admin',
  'admin_settings',
  'admin_runtime',
  'admin_archive',
  'admin_ai',
  'assistant',
  'resources',
  'library:0',
  'account',
  'about',
  'language',
  'topics',
  'contact',
  'admin_messages',
  'admin_management',
];

describe('reply_markup is always a valid two-dimensional inline keyboard', () => {
  for (const data of SCREEN_CALLBACKS) {
    it(`renders a valid keyboard for "${data}"`, async () => {
      const bot = new FakeBot();
      await router.routeCallback(callbackCtx(bot, ownerId, data));

      const markup = lastMarkup(bot);
      if (!markup) return; // some screens legitimately carry no keyboard

      assert.deepEqual(validateReplyMarkup(markup), [], `invalid markup for ${data}`);
      assert.ok(Array.isArray(markup.inline_keyboard), 'inline_keyboard must be an array');
      for (const row of markup.inline_keyboard) {
        assert.ok(Array.isArray(row), 'every row must be an array (2-D, never flat)');
        for (const button of row) {
          assert.equal(typeof button.text, 'string');
        }
      }
    });
  }

  it('rejects a flat row array and a nested-invalid markup in the validator', () => {
    assert.equal(isInlineKeyboard([[{ text: 'a', callback_data: 'home' }]]), true);
    // A one-dimensional array of buttons is not a keyboard.
    assert.equal(isInlineKeyboard([{ text: 'a', callback_data: 'home' }]), false);
    assert.equal(validateReplyMarkup({ inline_keyboard: 'nope' }).length, 1);
  });
});

describe('callback_data fits Telegram’s 64-byte limit and stays routable', () => {
  it('measures the limit in bytes, not characters', () => {
    // 32 Arabic characters are 64 bytes; 33 would exceed the limit.
    const arabic = 'ا'.repeat(32);
    assert.equal(byteLength(arabic), 64);
    assert.equal(byteLength(arabic.repeat(2)), 128);
    assert.ok(byteLength(arabic) > arabic.length);
  });

  it('emits only routable, in-limit callbacks across the reachable screens', async () => {
    const prefixes = router.registeredRoutes().flatMap((route) => route.prefixes);
    const matches = (value, prefix) =>
      value === prefix ||
      value.startsWith(`${prefix}:`) ||
      (prefix.endsWith(':') && value.startsWith(prefix)) ||
      (prefix.endsWith('_') && value.startsWith(prefix));

    for (const data of SCREEN_CALLBACKS) {
      const bot = new FakeBot();
      await router.routeCallback(callbackCtx(bot, ownerId, data));
      for (const callback of lastButtons(bot)) {
        if (callback === undefined || callback === null) continue;
        assert.ok(
          byteLength(callback) <= 64,
          `callback_data "${callback}" is ${byteLength(callback)} bytes`,
        );
        assert.ok(
          prefixes.some((prefix) => matches(callback, prefix)),
          `callback_data "${callback}" is not claimed by any route`,
        );
      }
    }
  });

  it('keeps a long dynamic payload from being silently truncated', () => {
    // A payload over the limit must be rejected, never trimmed (trimming would
    // re-point the button). `btn` stores it as-is; the transport validator flags it.
    const long = `folder:${'9'.repeat(70)}`;
    const markup = { inline_keyboard: [[btn('x', long)]] };
    assert.ok(validateReplyMarkup(markup).length > 0, 'an over-limit callback is reported');
    assert.equal(markup.inline_keyboard[0][0].callback_data, long, 'never truncated in place');
  });
});

describe('dynamic content is escaped for the HTML parse mode', () => {
  it('escapes the characters that would break Telegram HTML', () => {
    const raw = '<b>_*[]()~`>#+-=|{}.!</b>';
    const escaped = escHtml(raw);
    assert.doesNotMatch(escaped, /<b>/);
    assert.match(escaped, /&lt;b&gt;/);
  });

  it('round-trips hostile dynamic text through a real screen without corrupting markup', async () => {
    const bot = new FakeBot();
    const folderId = db.addFolder(0, 'قسم <b>_*[]()~`>#+-=|{}.!</b> اختبار', 'general');
    db.addContent(folderId, 'مورد <i>اختبار</i> _*[]', 'file-x', 'document');

    await router.routeCallback(callbackCtx(bot, ownerId, `folder:${folderId}`));

    const text = bot.last('editMessageText').args.text;
    // The injected tags are escaped, not interpreted: the raw injected sequence
    // must never appear as a live tag.
    assert.doesNotMatch(text, /<b>_\*\[\]/);
    assert.doesNotMatch(text, /<i>اختبار/);
    assert.match(text, /&lt;b&gt;_\*\[\]/);
    // The rendered keyboard is still structurally valid.
    assert.deepEqual(validateReplyMarkup(lastMarkup(bot)), []);
  });

  it('sends every dynamic message under the app parse mode (HTML)', async () => {
    const adapter = await import('../src/telegram/adapter.js');
    const bot = new FakeBot();
    await adapter.dispatchUpdate(
      {
        update_id: 1,
        callback_query: {
          id: 'cb-1',
          from: { id: ownerId },
          message: { message_id: 1, chat: { id: ownerId } },
          data: 'home',
        },
      },
      bot,
      {},
    );
    assert.equal(bot.last('editMessageText').args.options.parse_mode, 'HTML');
  });
});
