/**
 * Telegram routing and workflow-state tests.
 *
 * These exercise the callback router — the layer every button tap flows
 * through — plus the single-owner workflow marker, the piece that stops two
 * overlapping admin flows from stealing each other's typed message.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

import * as db from '../src/db/index.js';
import * as workflow from '../src/workflow.js';
import {
  callbackCtx,
  cleanupDb,
  FakeBot,
  freshDb,
  lastButtons,
  lastEdit,
  messageCtx,
} from './helpers/harness.js';

let dbPath;
let router;
let botModule;
let adapter;
let ownerId;
let registry;

before(async () => {
  dbPath = freshDb('router');
  router = await import('../src/telegram/router.js');
  botModule = await import('../src/telegram/bot.js');
  adapter = await import('../src/telegram/adapter.js');
  // Routes only exist after the bot wires them up; tests must use the real
  // registration, not a hand-built stub router.
  botModule.registerHandlers();

  ownerId = 9001;
  db.registerUser(ownerId, 'owner', 'Owner');
  db.ensureConfiguredAdmin(ownerId, 'owner');

  const year = db.addFolder(0, 'Router Year', 'general');
  const subject = db.addFolder(year, 'Router Subject', 'general', 1);
  registry = { year, subject };
});

after(() => {
  cleanupDb(dbPath);
});

describe('callback routing', () => {
  it('routes a student home tap to the home screen', async () => {
    const bot = new FakeBot();
    const studentId = 9100;
    db.registerUser(studentId, 'student', 'Student');

    await router.routeCallback(callbackCtx(bot, studentId, 'home'));
    assert.ok(lastEdit(bot).length > 0, 'home must render something');
  });

  it('routes a nested namespace prefix to exactly one handler', async () => {
    // `contrib_browse:<id>` must reach the contributions handler, not the
    // generic `contribute` route.
    const bot = new FakeBot();
    const studentId = 9101;
    db.registerUser(studentId, 'student2', 'Student2');

    await router.routeCallback(callbackCtx(bot, studentId, `contrib_browse:${registry.year}`));
    assert.ok(lastEdit(bot), 'the contributions handler responded');
  });

  it('does not let a callback route fire for a non-prefixed payload', async () => {
    const bot = new FakeBot();
    const studentId = 9102;
    db.registerUser(studentId, 'student3', 'Student3');

    await router.routeCallback(callbackCtx(bot, studentId, 'definitely_not_a_route'));
    // The catch-all must answer rather than silently drop the tap.
    assert.ok(lastEdit(bot).length > 0);
  });

  it('presents only real registered ids in the student library', async () => {
    const bot = new FakeBot();
    const studentId = 9103;
    db.registerUser(studentId, 'student4', 'Student4');

    await router.routeCallback(callbackCtx(bot, studentId, 'resources'));
    for (const data of lastButtons(bot)) {
      const match = /^(?:folder|file):(\d+)$/.exec(data);
      if (!match) continue;
      const id = Number.parseInt(match[1], 10);
      assert.ok(db.getFolder(id) || db.getFileRecord(id), `button ${data} must be a real row`);
    }
  });

  it('opens the library root when a button emits library:0', async () => {
    // The topics menu and the home screen both emit `library:0`; Python routes
    // it to show_library(0), so it must not fall through to the catch-all.
    const bot = new FakeBot();
    const studentId = 9104;
    db.registerUser(studentId, 'student5', 'Student5');

    await router.routeCallback(callbackCtx(bot, studentId, 'library:0'));

    const text = lastEdit(bot);
    assert.ok(!/لم يعد صالحاً/.test(text), 'must not hit the stale-button catch-all');
    const buttons = lastButtons(bot);
    assert.ok(
      buttons.some((data) => data === `folder:${registry.year}`),
      'the library root lists the registered top-level folder',
    );
  });

  it('walks back from a child folder through library:<parent>', async () => {
    const bot = new FakeBot();
    const studentId = 9105;
    db.registerUser(studentId, 'student6', 'Student6');

    await router.routeCallback(callbackCtx(bot, studentId, `folder:${registry.subject}`));

    const back = lastButtons(bot).find((data) => data.startsWith('library:'));
    assert.ok(back, 'a folder screen offers a back button');
    assert.equal(back, `library:${registry.year}`, 'back targets the real parent, not the folder');

    await router.routeCallback(callbackCtx(bot, studentId, back));
    const text = lastEdit(bot);
    assert.ok(!/لم يعد صالحاً/.test(text), 'back must resolve, not hit the catch-all');
    assert.ok(text.includes('Router Year'), 'back lands on the parent folder screen');
    assert.ok(
      lastButtons(bot).some((data) => data === `folder:${registry.subject}`),
      'the parent screen lists its child',
    );
  });
});

/**
 * A family prefix such as `msg_` marks many callbacks that share a stem rather
 * than one `stem:` namespace. These tests pin the trailing-underscore rule and
 * the callback families that depend on it; when it regressed, every contact and
 * every folder-management button silently fell to the catch-all.
 */
describe('family prefix routing', () => {
  it('routes every msg_* callback to the messaging handler', async () => {
    const bot = new FakeBot();
    const studentId = 9200;
    db.registerUser(studentId, 'contact', 'Contact');

    for (const data of ['msg_cat:report', 'msg_cat:message', 'msg_cancel', 'msg_mine']) {
      await router.routeCallback(callbackCtx(bot, studentId, data));
      const text = lastEdit(bot);
      assert.ok(
        !/لم يعد صالحاً/.test(text),
        `${data} must reach the messaging handler, got the catch-all`,
      );
    }
  });

  it('routes both admin_folder_* and admin_folder:<id> to the folder handler', async () => {
    const bot = new FakeBot();
    db.ensureConfiguredAdmin(ownerId, 'owner');
    // A throwaway folder: toggling the shared registry folder would leak into
    // the contribution tests below.
    const scratch = db.addFolder(0, 'Scratch Family', 'general');

    for (const data of [
      `admin_folder_toggle:${scratch}`,
      `admin_folder_create:${scratch}`,
      `admin_folder:${scratch}`,
      `admin_file_move:1`,
    ]) {
      await router.routeCallback(callbackCtx(bot, ownerId, data));
      const text = lastEdit(bot);
      assert.ok(
        !/لم يعد صالحاً/.test(text),
        `${data} must reach the folder handler, got the catch-all`,
      );
    }
  });

  it('routes the owner transfer confirmation callbacks', async () => {
    const bot = new FakeBot();
    db.ensureConfiguredAdmin(ownerId, 'owner');
    const target = 9201;
    db.registerUser(target, 'heir', 'Heir');

    await router.routeCallback(callbackCtx(bot, ownerId, `admin_transfer_confirm:${target}`));
    assert.ok(
      !/لم يعد صالحاً/.test(lastEdit(bot)),
      'the confirm screen must resolve, not hit the catch-all',
    );
    assert.ok(
      lastButtons(bot).some((data) => data === `admin_transfer_do:${target}`),
      'the confirmation offers the execute button',
    );
  });

  it('routes the student-messages inbox button to the messaging handler', async () => {
    const bot = new FakeBot();
    db.ensureConfiguredAdmin(ownerId, 'owner');

    await router.routeCallback(callbackCtx(bot, ownerId, 'admin_messages'));
    assert.ok(
      !/لم يعد صالحاً/.test(lastEdit(bot)),
      'admin_messages must reach the messaging handler, not the generic admin route',
    );
  });

  it('routes the new admin reference, preview and retype callbacks', async () => {
    const bot = new FakeBot();
    db.ensureConfiguredAdmin(ownerId, 'owner');
    const scratch = db.addFolder(0, 'Alias Family', 'general');

    for (const data of [
      'admin_roles',
      'admin_perms_guide',
      `admin_preview:${ownerId}`,
      `admin_folder_retype_existing:${scratch}`,
      'audit_log',
    ]) {
      await router.routeCallback(callbackCtx(bot, ownerId, data));
      assert.ok(
        !/لم يعد صالحاً/.test(lastEdit(bot)),
        `${data} must resolve, not hit the stale-button catch-all`,
      );
    }
  });

  it('never dead-ends the legacy assistant gateway callbacks', async () => {
    const bot = new FakeBot();
    const studentId = 9202;
    db.registerUser(studentId, 'legacy', 'Legacy');

    const legacy = {
      assistant_search: /بحث في موارد المنصة/,
      assistant_start: /بحث في موارد المنصة/,
      assistant_medical: /اسأل المساعد الذكي/,
    };

    for (const [data, expected] of Object.entries(legacy)) {
      await router.routeCallback(callbackCtx(bot, studentId, data));
      const text = lastEdit(bot);
      assert.match(text, expected, `${data} lands on its surviving mode`);
      assert.ok(!/لم يعد صالحاً/.test(text), `${data} must not hit the catch-all`);
    }
  });
});

/**
 * A screen can only offer a button whose callback some route claims. When a
 * rendered callback matches no prefix, the tap hits the "stale button"
 * catch-all — a dead button the user sees as a broken app. This sweep reads
 * every `btn(label, callback_data)` literal in `src` and asserts it is
 * claimable, so the next screen that introduces a new family cannot regress
 * silently.
 */
describe('rendered callbacks are all routable', () => {
  it('claims every static callback_data literal emitted by a btn() call', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const prefixes = router.registeredRoutes().flatMap((route) => route.prefixes);

    const matches = (data, prefix) =>
      data === prefix ||
      data.startsWith(`${prefix}:`) ||
      (prefix.endsWith(':') && data.startsWith(prefix)) ||
      (prefix.endsWith('_') && data.startsWith(prefix));

    const literals = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const source = readFileSync(full, 'utf8');
          const btnRe = /btn\(([^,]+),\s*([^)]*)\)/g;
          let match;
          while ((match = btnRe.exec(source))) {
            const literal = match[2].match(/[`'"]([^`'"]+)[`'"]/);
            if (literal) literals.add(literal[1]);
          }
        }
      }
    };
    walk(path.join(root, 'src'));

    assert.ok(literals.size > 100, 'the sweep found the button vocabulary');

    const dead = [...literals]
      .filter((literal) => !literal.includes('${'))
      .filter((literal) => {
        const concrete = literal.replace(/\$\{[^}]*\}/g, '0');
        return !prefixes.some((prefix) => matches(concrete, prefix));
      })
      .sort();

    assert.deepEqual(dead, [], `these rendered callbacks match no route: ${dead.join(', ')}`);
  });
});

describe('single-owner workflow state', () => {
  it('lets only the active workflow consume a typed message', () => {
    const ctx = { userData: {} };

    workflow.begin(ctx, 'ai_chat');
    assert.equal(workflow.owns(ctx, 'ai_chat'), true);
    assert.equal(workflow.owns(ctx, 'contact_message'), false);
  });

  it('cancels the previous workflow when a new one starts', () => {
    const ctx = { userData: {} };

    workflow.begin(ctx, 'ai_chat');
    ctx.userData.ai_mode = 'stale';
    workflow.begin(ctx, 'contact_message');

    // The stale flow's keys are gone and it no longer owns the marker.
    assert.equal(ctx.userData.ai_mode, undefined);
    assert.equal(workflow.owns(ctx, 'ai_chat'), false);
    assert.equal(workflow.owns(ctx, 'contact_message'), true);
  });

  it('treats an unset marker as owned, so direct calls keep working', () => {
    const ctx = { userData: {} };
    assert.equal(workflow.owns(ctx, 'news_draft'), true);
  });

  it('re-entering the same workflow is idempotent', () => {
    const ctx = { userData: {} };
    workflow.begin(ctx, 'admin_upload');
    const marker = ctx.userData[workflow.ACTIVE_KEY];
    workflow.begin(ctx, 'admin_upload');
    assert.equal(ctx.userData[workflow.ACTIVE_KEY], marker);
    assert.equal(workflow.owns(ctx, 'admin_upload'), true);
  });

  it('clears every key the workflow owns', () => {
    const ctx = { userData: {} };
    workflow.begin(ctx, 'admin_upload');
    const keys = workflow.WORKFLOWS.admin_upload;
    for (const key of keys) ctx.userData[key] = 'x';

    workflow.clear(ctx);
    for (const key of keys) assert.equal(ctx.userData[key], undefined);
    assert.equal(ctx.userData[workflow.ACTIVE_KEY], undefined);
  });
});

describe('workflow text consumption end to end', () => {
  it('routes a typed review note to the rejection workflow, not another', async () => {
    const bot = new FakeBot();
    const adminId = 9200;
    db.addSubAdmin(adminId, 'note-admin');
    db.applyRolePreset(adminId, 'admin');

    const contributionId = db.addContribution(
      9300,
      'Contributor',
      registry.subject,
      'Router item',
      'f-router',
      'document',
    );

    const userData = {};
    // The admin starts the reject flow...
    await router.routeCallback(callbackCtx(bot, adminId, `reject:${contributionId}`, userData));
    assert.equal(userData.review_note_kind, 'reject');

    // ...then types the reason, which the text router must hand to that flow.
    await router.routeText(messageCtx(bot, adminId, 'Unverified source', userData));

    assert.equal(db.getContribution(contributionId)[7], 'rejected');
    assert.equal(db.getContribution(contributionId)[12], 'Unverified source');
  });

  it('does not let a stale flow swallow a message meant for the active one', async () => {
    const bot = new FakeBot();
    const studentId = 9201;
    db.registerUser(studentId, 'student5', 'Student5');

    // A fresh active flow, plus a stale key written by something else. The
    // key is set after `begin` so it mimics a leftover that survived.
    const userData = {};
    workflow.begin({ userData }, 'ai_chat');
    userData.contact_category = 'inquiry';

    // A plain message must not be treated as a contact-message body now.
    await router.routeText(messageCtx(bot, studentId, 'random text', userData));

    // The stale contact key survives untouched: its flow does not own the
    // marker, so the message was handled as a normal search/chat instead.
    assert.equal(userData.contact_category, 'inquiry');
    assert.equal(workflow.owns({ userData }, 'ai_chat'), true);
  });
});

describe('adapter callback plumbing', () => {
  /**
   * A transport as strict as the real Bot API about the two callback
   * identifiers. The shared `FakeBot` ignores them, which is exactly why the
   * adapter could drop them unnoticed: on Telegram a missing callback_query_id
   * leaves the tap unacknowledged (spinner never stops) and a missing
   * message_id leaves every button dead, because the edit is rejected and the
   * context swallows the error.
   */
  class StrictBot extends FakeBot {
    async answerCallbackQuery(callbackQueryId) {
      if (!callbackQueryId) throw new Error('Bad Request: callback query id empty');
      return this._record('answerCallbackQuery', { callbackQueryId });
    }

    async editMessageText(text, options = {}) {
      if (options.message_id === null || options.message_id === undefined) {
        throw new Error('Bad Request: message id empty');
      }
      return this._record('editMessageText', { text, options });
    }
  }

  function rawCallback(callbackQueryId, messageId, data) {
    return {
      update_id: 1,
      callback_query: {
        id: callbackQueryId,
        from: { id: 9600, first_name: 'Student', username: 's' },
        message: { message_id: messageId, chat: { id: 9600 } },
        data,
      },
    };
  }

  it('forwards the callback query id and the message id from the raw update', async () => {
    const bot = new StrictBot();
    const studentId = 9600;
    db.registerUser(studentId, 'student6', 'Student6');
    await botModule.createBot({ transport: bot });

    const handled = await adapter.dispatchUpdate(
      rawCallback('CB-UNIQUE-1', 4242, 'home'),
      bot,
      {},
    );

    assert.equal(handled, true);
    const ack = bot.calls.find((call) => call.method === 'answerCallbackQuery');
    assert.equal(ack?.args?.callbackQueryId, 'CB-UNIQUE-1', 'the tap is acknowledged by id');

    const edit = bot.last('editMessageText');
    assert.ok(edit, 'the screen is edited, not dropped');
    assert.equal(edit.args.options.message_id, 4242, 'the edit targets the tapped message');
  });

  it('routes every rendered button with a complete callback context', async () => {
    // A pressed button from the home screen must actually edit in place; the
    // strict transport would throw (and the context swallow it) otherwise.
    const bot = new StrictBot();
    const studentId = 9601;
    db.registerUser(studentId, 'student7', 'Student7');

    await router.routeCallback(callbackCtx(bot, studentId, 'home'));
    const other = lastButtons(bot).find((value) => value && value !== 'home');
    if (!other) assert.fail('the home screen renders at least one other button');

    const guided = new StrictBot();
    await adapter.dispatchUpdate(rawCallback('CB-2', 77, other), guided, {});
    assert.ok(guided.last('editMessageText'), `"${other}" must render a screen`);
  });
});
