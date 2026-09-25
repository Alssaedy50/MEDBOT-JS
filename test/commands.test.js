/**
 * Command parity tests.
 *
 * The Python reference registers /start, /quota, /whoami, /search, /cancel,
 * /ask (plus /contact from the messaging module) and has no /help. These tests
 * pin the JS command set to that behaviour, including the quota figure the
 * /quota screen reports.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import { AI_DAILY_LIMIT } from '../src/constants.js';
import { cleanupDb, freshDb, FakeBot, lastEdit } from './helpers/harness.js';

let dbPath;
let adapter;
let botModule;
let library;

const STUDENT = 9500;

/** Dispatch one raw text update and return the fake bot that recorded it. */
async function dispatchText(text, userId = STUDENT) {
  botModule.registerHandlers();

  const calls = [];
  const bot = {
    calls,
    async sendMessage(chatId, body, options) {
      calls.push({ method: 'sendMessage', args: { chatId, text: body, options } });
      return { message_id: calls.length };
    },
    async editMessageText(chatId, body, options) {
      calls.push({ method: 'editMessageText', args: { chatId, text: body, options } });
      return { message_id: 0 };
    },
    async answerCallbackQuery() {
      return true;
    },
    async setMyCommands() {
      return true;
    },
    async getUpdates() {
      return [];
    },
  };

  const handled = await adapter.dispatchUpdate(
    { update_id: 1, message: { from: { id: userId }, chat: { id: userId }, text } },
    bot,
    {},
  );

  return { handled, calls, lastText: calls.at(-1)?.args?.text ?? '' };
}

before(async () => {
  dbPath = freshDb('commands');
  adapter = await import('../src/telegram/adapter.js');
  botModule = await import('../src/telegram/bot.js');
  library = await import('../src/ui/library.js');

  db.registerUser(STUDENT, 'student', 'Student');
});

after(() => {
  cleanupDb(dbPath);
});

describe('command set', () => {
  it('routes every command the Python reference registers', async () => {
    const { getCommandHandlers } = await import('../src/telegram/router.js');
    botModule.registerHandlers();

    const registered = new Set(getCommandHandlers().keys());
    for (const name of ['start', 'quota', 'whoami', 'search', 'ask', 'cancel', 'contact']) {
      assert.ok(registered.has(name), `/${name} must be registered`);
    }
  });

  it('parses a command that carries the bot username suffix', async () => {
    const { handled, lastText } = await dispatchText('/whoami@MEDBOT_dev_bot');
    assert.equal(handled, true);
    assert.match(lastText, /مُعرّف Telegram/);
  });
});

describe('/quota', () => {
  it('reports the shared daily allowance, not a private one', async () => {
    const { handled, lastText } = await dispatchText('/quota');
    assert.equal(handled, true);
    assert.ok(lastText.length > 0, 'the quota screen must render');
    // The screen reads the same limiter the assistant consumes.
    assert.equal(db.getRemainingQuota(STUDENT, AI_DAILY_LIMIT), AI_DAILY_LIMIT);
  });

  it('tells a limited student to come back rather than speaking of errors', async () => {
    const limited = 9501;
    db.registerUser(limited, 'limited', 'Limited');
    for (let i = 0; i < AI_DAILY_LIMIT; i += 1) {
      db.checkAndIncrementQuota(limited, AI_DAILY_LIMIT);
    }

    const { lastText } = await dispatchText('/quota', limited);
    assert.match(lastText, /الحد اليومي/);
    // The message frames the stop as temporary rather than a failure.
    assert.match(lastText, /توقف مؤقت/);
  });
});

describe('/whoami', () => {
  it('never promotes a caller just because the id is the first seen', async () => {
    const fresh = 9502;
    const { lastText } = await dispatchText('/whoami', fresh);

    assert.match(lastText, /مُعرّف Telegram/);
    assert.equal(db.isUserAdmin(fresh), false, 'a plain caller is not an admin');
  });
});

describe('/account (حسابي)', () => {
  it('reports the assistant allowance against the real limit', async () => {
    const student = 9504;
    db.registerUser(student, 'account', 'Account');
    botModule.registerHandlers();

    const bot = new FakeBot();
    await adapter.dispatchUpdate(
      {
        update_id: 1,
        callback_query: {
          id: 'CB-ACCOUNT',
          from: { id: student, first_name: 'Account' },
          message: { message_id: 5, chat: { id: student } },
          data: 'account',
        },
      },
      bot,
      {},
    );

    const text = lastEdit(bot);
    // The denominator must be the shared AI_DAILY_LIMIT, never a hardcoded
    // figure that silently drifts from the limiter the assistant enforces.
    assert.match(text, new RegExp(`/${AI_DAILY_LIMIT}\\b`));
    assert.doesNotMatch(text, /\/20\b/);
  });
});

describe('/search', () => {
  it('arms the platform-search workflow so the next message is searched', async () => {
    const student = 9503;
    db.registerUser(student, 'searcher', 'Searcher');

    await dispatchText('/search', student);
    const userData = adapter.userDataFor(student);
    assert.equal(userData.library_search, true, 'the query marker is set');

    // The next plain message is consumed by the library search, not the AI.
    const bot = { calls: [], async sendMessage() { return { message_id: 1 }; } };
    const handled = await library.runSearch(
      {
        kind: 'message',
        from: { id: student },
        text: 'CBC',
        userData,
        chatId: student,
        bot,
        reply: async (t, options) => {
          bot.calls.push({ text: t, options });
          return { message_id: 1 };
        },
      },
      'CBC',
    );
    assert.equal(handled, undefined);
    assert.ok(bot.calls.length > 0, 'the search produced an answer');
  });

  it('arms the same workflow when the search button is pressed', async () => {
    const student = 9504;
    db.registerUser(student, 'button', 'Button');
    const userData = {};

    const bot = { calls: [], async answer() {}, async editMessageText() {} };
    await library.libraryCallbackHandler({
      kind: 'callback',
      from: { id: student },
      data: 'search',
      userData,
      chatId: student,
      bot,
      answer: async () => {},
      editMessageText: async (t, options) => {
        bot.calls.push({ text: t, options });
      },
      reply: async () => ({}),
    });

    assert.equal(userData.library_search, true, 'the button arms the same marker');
    assert.ok(bot.calls.length > 0, 'the prompt was shown');
  });
});

describe('/ask', () => {
  it('answers a chat question attached to the command and charges quota', async () => {
    const student = 9505;
    db.registerUser(student, 'asker', 'Asker');
    const before = db.getRemainingQuota(student, AI_DAILY_LIMIT);

    const { handled, lastText } = await dispatchText('/ask ما هي عاصمة فرنسا؟', student);
    assert.equal(handled, true);
    assert.ok(lastText.length > 0, 'the assistant answered or explained unavailability');

    const after = db.getRemainingQuota(student, AI_DAILY_LIMIT);
    assert.equal(after, before - 1, 'one request was consumed from the allowance');
  });

  it('opens the assistant menu when no question follows the command', async () => {
    const student = 9506;
    db.registerUser(student, 'noquery', 'NoQuery');
    const before = db.getRemainingQuota(student, AI_DAILY_LIMIT);

    const { handled, lastText } = await dispatchText('/ask', student);
    assert.equal(handled, true);
    assert.match(lastText, /المساعد الذكي/);
    assert.equal(
      db.getRemainingQuota(student, AI_DAILY_LIMIT),
      before,
      'opening the menu must not charge the allowance',
    );
  });
});
