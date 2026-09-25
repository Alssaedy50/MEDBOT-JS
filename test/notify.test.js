/**
 * Notifications, visibility and audit tests.
 *
 * These are the cross-cutting subsystems: the notification log (the Python
 * "notifications compatibility" layer), the hidden-feature navigation control,
 * and the audit trail. Each is reachable from the admin surface, so a
 * regression here is quiet but real.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as notifications from '../src/notifications.js';
import * as audit from '../src/audit.js';
import { FakeBot, freshDb, cleanupDb } from './helpers/harness.js';

let dbPath;
let owner;

before(() => {
  dbPath = freshDb('notify');
  db.ensureConfiguredAdmin(90201, 'owner_admin');
  owner = db.getOwnerIds()[0];
});

after(() => {
  cleanupDb(dbPath);
});

describe('notification log', () => {
  it('records a broadcast with its audience and delivery counts', () => {
    const id = db.recordNotification(owner, 'Notice', 'Maintenance tonight', 'all', 12, 10);
    assert.ok(id > 0);

    const rows = db.getNotifications(5);
    const row = rows.find((r) => Number(r.id ?? r[0]) === Number(id));
    assert.ok(row, 'the notification is listed');
    assert.ok(String(JSON.stringify(row)).includes('Maintenance tonight'));
  });

  it('ignores a notification with no body', () => {
    assert.equal(db.recordNotification(owner, 'Empty', '   '), null);
  });
});

describe('broadcast delivery', () => {
  it('broadcasts to every registered student and reports delivery counts', async () => {
    const bot = new FakeBot();
    const students = [];
    for (let i = 0; i < 3; i += 1) {
      const id = 90300 + i;
      db.registerUser(id, `bcast${i}`, `Broadcast ${i}`);
      students.push(id);
    }

    const result = await notifications.broadcast(bot, 'Platform update', owner, 'Update');
    assert.equal(result.recipients, students.length);
    assert.equal(result.delivered, students.length);

    const reached = bot.calls
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.args.chatId);
    for (const id of students) assert.ok(reached.includes(id), `${id} was notified`);
  });

  it('a blocked student does not stop the broadcast to the rest', async () => {
    const bot = new FakeBot();
    const blocked = 90310;
    const fine = 90311;
    db.registerUser(blocked, 'bcast_blocked', 'Blocked');
    db.registerUser(fine, 'bcast_fine', 'Fine');
    bot.failFor.add(`sendMessage:${blocked}`);

    const result = await notifications.broadcast(bot, 'Resilient', owner, 'Resilient');
    assert.equal(result.delivered, result.recipients - 1, 'only the blocked one was lost');
  });

  it('targets only admins holding the permission', async () => {
    const bot = new FakeBot();
    const result = await notifications.broadcastToAdmins(bot, 'can_news', 'News alert');

    // The owner holds every permission, so it must be included.
    const reached = bot.calls
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.args.chatId);
    assert.ok(reached.includes(owner), 'the owner is notified');
    assert.equal(result.delivered, reached.length);
  });

  it('an unknown permission targets nobody rather than everyone', async () => {
    const bot = new FakeBot();
    const result = await notifications.broadcastToAdmins(bot, 'can_nonsense', 'Hi');
    assert.equal(result.recipients, 0);
    assert.equal(bot.calls.length, 0);
  });
});

describe('feature visibility', () => {
  it('ships with every feature visible', () => {
    assert.equal(db.getHiddenFeatures().size, 0);
    assert.equal(db.isFeatureHidden('resources'), false);
  });

  it('hides and restores a feature round-trip', () => {
    db.setHiddenFeatures(['resources', 'assistant']);
    assert.equal(db.isFeatureHidden('resources'), true);
    assert.equal(db.isFeatureHidden('assistant'), true);
    assert.equal(db.isFeatureHidden('account'), false, 'an unhidden feature is unaffected');

    db.setHiddenFeatures([]);
    assert.equal(db.isFeatureHidden('resources'), false, 'restoring brings the feature back');
  });

  it('ignores feature keys that are not real features', () => {
    db.setHiddenFeatures(['resources', 'not_a_feature']);
    assert.equal(db.isFeatureHidden('resources'), true);
    assert.equal(db.getHiddenFeatures().has('not_a_feature'), false);
    db.setHiddenFeatures([]);
  });
});

describe('audit trail', () => {
  it('records an admin action with its actor and target', async () => {
    const before = db.getAuditCount();
    const ok = await audit.logAction(owner, 'news.publish', {
      targetType: 'news',
      targetId: 7,
      details: 'published',
    });

    assert.equal(ok, true);
    assert.equal(db.getAuditCount(), before + 1, 'the log grew by exactly one entry');

    const entries = db.getAuditEntries(5);
    const row = entries[0];
    assert.ok(String(JSON.stringify(row)).includes('news.publish'));
  });

  it('is append-only: entries are never rewritten by later reads', async () => {
    await audit.logAction(owner, 'folder.create', { targetType: 'folder', targetId: 1 });
    const first = db.getAuditEntries(100).length;
    db.getAuditEntries(100);
    assert.equal(db.getAuditEntries(100).length, first);
  });

  it('filters the log by action', async () => {
    await audit.logAction(owner, 'settings.update', { targetType: 'settings', targetId: 1 });
    const rows = db.getAuditEntries(50, 'settings.update');
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => String(JSON.stringify(row)).includes('settings.update')));
  });

  it('an empty action is rejected rather than logged', async () => {
    const before = db.getAuditCount();
    assert.equal(await audit.logAction(owner, ''), false);
    assert.equal(db.getAuditCount(), before);
  });
});
