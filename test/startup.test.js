/**
 * Startup and polling-path tests.
 *
 * `createBot` is the whole boot sequence in one call: migrate, register the
 * routes, warm caches, start delivery recovery. These tests boot it against a
 * stubbed transport so the real wiring is exercised without a network.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as contributions from '../src/ui/contributions.js';
import { callbackCtx, cleanupDb, FakeBot, freshDb } from './helpers/harness.js';

let dbPath;
let botModule;
let adapter;

before(async () => {
  dbPath = freshDb('startup');
  botModule = await import('../src/telegram/bot.js');
  adapter = await import('../src/telegram/adapter.js');
});

after(() => {
  cleanupDb(dbPath);
});

describe('createBot startup path', () => {
  it('initialises the schema, registers routes and reports ready', async () => {
    const { bot, ready } = await botModule.createBot({ transport: new FakeBot() });

    assert.equal(ready, true);
    assert.ok(bot, 'a transport is returned');
    // The schema really exists after boot, not merely "the process started".
    assert.ok(Array.isArray(db.getFolders(0)));
    assert.ok(Array.isArray(db.getOwnerIds()));
  });

  it('does not start delivering or polling during a botless boot', async () => {
    const { bot } = await botModule.createBot({ token: null });
    assert.equal(bot, null, 'no token and no transport means no bot to run');
  });

  it('registers a route for every subsystem the bot wires up', async () => {
    await botModule.createBot({ transport: new FakeBot() });
    const names = adapter.registeredRoutes
      ? adapter.registeredRoutes().map((r) => r.name)
      : [];
    // router introspection lives on the router module, not the adapter
    const router = await import('../src/telegram/router.js');
    const routeNames = router.registeredRoutes().map((r) => r.name);
    assert.ok(routeNames.length >= names.length);
    for (const expected of ['home', 'admin', 'noop']) {
      assert.ok(routeNames.includes(expected), `route ${expected} must be registered`);
    }
  });

  it('returns a 429 backoff hint from the transport error', async () => {
    const { BotApiError } = await import('../src/telegram/client.js');
    const error = new BotApiError('sendMessage', 429, 'Too Many Requests', {
      retry_after: 7,
    });
    assert.equal(error.retry_after, 7);
    assert.equal(error.status, 429);
  });
});

describe('media routing', () => {
  it('routes an uploaded document into the armed contribution flow', async () => {
    const bot = new FakeBot();
    await botModule.createBot({ transport: bot });

    const student = 8500;
    db.registerUser(student, 'uploader', 'Uploader');
    const folder = db.addFolder(0, 'Uploads Section', 'general');
    db.updateFolderAcceptsContributions(folder, 1);

    // Arm through the real UI path, sharing the adapter's per-user store so the
    // dispatch below sees the armed state.
    const userData = adapter.userDataFor(student);
    await contributions.armContribution(
      callbackCtx(bot, student, `contrib_arm:${folder}`, userData),
      folder,
    );
    assert.equal(userData.contrib_state, 'await_file', 'the flow is armed for a file');

    const handled = await adapter.dispatchUpdate(
      {
        update_id: 1,
        message: {
          from: { id: student },
          chat: { id: student },
          document: { file_id: 'doc-1', file_name: 'lecture.pdf' },
        },
      },
      bot,
      {},
    );

    assert.equal(handled, true, 'the media message was handled by the contribution flow');
    assert.equal(userData.contrib_file_id, 'doc-1', 'the file reference was captured');
    assert.equal(userData.contrib_state, 'await_title', 'the flow advanced to the title step');
  });

  it('answers an out-of-flow upload with the "no upload in progress" notice', async () => {
    const bot = new FakeBot();
    await botModule.createBot({ transport: bot });
    const student = 8501;
    db.registerUser(student, 'nomedia', 'NoMedia');

    const handled = await adapter.dispatchUpdate(
      {
        update_id: 1,
        message: {
          from: { id: student },
          chat: { id: student },
          document: { file_id: 'doc-2', file_name: 'x.pdf' },
        },
      },
      bot,
      {},
    );

    // Media is always claimed by the catch-all, which must tell the student
    // how to start a real upload rather than silently dropping the message.
    assert.equal(handled, true);
    assert.match(bot.calls.at(-1).args.text, /لا توجد عملية رفع/);
    assert.equal(adapter.userDataFor(student).contrib_file_id, undefined);
  });
});

describe('polling loop', () => {
  it('advances the offset past every handled update and can be stopped', async () => {
    await botModule.createBot({ transport: new FakeBot() });

    const seen = [];
    const transport = {
      async getUpdates(offset) {
        if (offset === 0) {
          return [
            { update_id: 10, message: { from: { id: 1 }, chat: { id: 1 }, text: '/start' } },
            { update_id: 11, message: { from: { id: 1 }, chat: { id: 1 }, text: '/help' } },
          ];
        }
        return [];
      },
      async sendMessage(chatId, text, _options) {
        seen.push({ chatId, text });
        return { message_id: seen.length };
      },
      async editMessageText() {
        return { message_id: 0 };
      },
      async answerCallbackQuery() {
        return true;
      },
      async setMyCommands() {
        return true;
      },
    };

    let iterations = 0;
    const finalOffset = await adapter.pollUpdates(transport, {
      shouldStop: () => iterations++ > 2,
    });

    assert.ok(finalOffset >= 12, `offset must pass the last update id, got ${finalOffset}`);
    assert.ok(seen.length > 0, 'the /start update was actually handled');
  });

  it('keeps polling after a transient transport failure', async () => {
    await botModule.createBot({ transport: new FakeBot() });

    let calls = 0;
    const errors = [];
    const transport = {
      async getUpdates() {
        calls += 1;
        if (calls === 1) throw new Error('network blip');
        return [];
      },
    };

    await adapter.pollUpdates(transport, {
      shouldStop: () => calls >= 3,
      onError: (error) => errors.push(error.message),
    });

    assert.equal(errors.length, 1, 'the failure was reported, not swallowed');
    assert.ok(calls >= 3, 'polling resumed after the error');
  });

  it('dispatches a callback query through the router', async () => {
    const bot = new FakeBot();
    await botModule.createBot({ transport: bot });

    const studentId = 9400;
    db.registerUser(studentId, 'poll_student', 'Poll Student');

    await adapter.dispatchUpdate(
      {
        update_id: 1,
        callback_query: {
          from: { id: studentId },
          data: 'home',
          message: { chat: { id: studentId } },
        },
      },
      bot,
      {},
    );

    assert.ok(bot.last('editMessageText'), 'the callback produced a rendered screen');
  });
});
