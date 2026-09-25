/**
 * Telegram routing and workflow-state tests.
 *
 * These exercise the callback router — the layer every button tap flows
 * through — plus the single-owner workflow marker, the piece that stops two
 * overlapping admin flows from stealing each other's typed message.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
let ownerId;
let registry;

before(async () => {
  dbPath = freshDb('router');
  router = await import('../src/telegram/router.js');
  botModule = await import('../src/telegram/bot.js');
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
