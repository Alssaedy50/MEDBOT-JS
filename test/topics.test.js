/**
 * Search Topics: student browse plus scoped admin management.
 *
 * Topics link to registered folders rather than copying the hierarchy, so the
 * invariants that matter are: an inactive topic is invisible to students, the
 * link picker navigates the real tree, and unlinking/deleting a topic never
 * touches the folders or resources themselves.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import {
  callbackCtx,
  cleanupDb,
  FakeBot,
  freshDb,
  lastEdit,
  lastMarkup,
  messageCtx,
} from './helpers/harness.js';

let dbPath;
let topics;
let admin;
let student;
let bot;

before(async () => {
  dbPath = freshDb('topics');
  topics = await import('../src/ui/topics.js');

  student = 8001;
  db.registerUser(student, 'student', 'Student');

  admin = 8002;
  db.registerUser(admin, 'topadmin', 'Topic Admin');
  db.addSubAdmin(admin, 'topadmin');
  db.setAdminRole(admin, 'owner');
  db.updateAdminPermissions(admin, db.defaultPermissions());

  bot = new FakeBot();
});

after(() => {
  cleanupDb(dbPath);
});

function buttons(botRef) {
  return (lastMarkup(botRef)?.inline_keyboard ?? [])
    .flat()
    .map((b) => ({ text: b.text, data: b.callback_data }));
}

describe('search topics: student browse', () => {
  it('links to the library and lists each active topic with a real count', async () => {
    const topicId = db.addTopic('علم وظائف الأعضاء', 'Physiology');
    const folderId = db.addFolder(0, 'الفسيولوجيا', 'general');
    db.linkTopicFolder(topicId, folderId);
    db.addContent(folderId, 'محاضرة', 'file-1', 'document');

    await topics.topicsCallbackHandler(callbackCtx(bot, student, 'topics'));
    const text = lastEdit(bot);
    assert.match(text, /مواضيع البحث/);

    const found = buttons(bot);
    assert.ok(found.some((b) => b.data === 'library:0'), 'the library stays reachable');
    assert.ok(
      found.some((b) => b.data === `topic_open:${topicId}` && /\(1\)/.test(b.text)),
      'the count reflects registered resources, not just linked folders',
    );
  });

  it('shows the empty state when no topics are registered', async () => {
    const previous = db.getTopics(true);
    for (const topic of previous) db.deleteTopic(topic.id);

    await topics.topicsCallbackHandler(callbackCtx(bot, student, 'topics'));
    assert.match(lastEdit(bot), /لا توجد مواضيع مسجلة/);

    // Restore one topic for the admin suites below.
    const restored = db.addTopic('المستعاد');
    assert.ok(restored);
  });

  it('refuses an inactive topic and offers a way back', async () => {
    const topicId = db.addTopic('معطّل');
    db.updateTopic(topicId, { active: false });

    await topics.topicsCallbackHandler(callbackCtx(bot, student, `topic_open:${topicId}`));
    assert.match(lastEdit(bot), /غير متاح/);
    assert.ok(buttons(bot).some((b) => b.data === 'topics'));
  });

  it('opens an active topic and drills into its linked real sections', async () => {
    const topicId = db.addTopic('نشط');
    const folderId = db.addFolder(0, 'قسم حقيقي', 'general');
    db.linkTopicFolder(topicId, folderId);

    await topics.topicsCallbackHandler(callbackCtx(bot, student, `topic_open:${topicId}`));
    assert.match(lastEdit(bot), /اختر القسم الذي تريد فتحه/);
    assert.ok(
      buttons(bot).some((b) => b.data === `folder:${folderId}` && /قسم حقيقي/.test(b.text)),
      'the linked section is offered and opens as a normal folder',
    );
    assert.ok(buttons(bot).some((b) => b.data === 'topics'));
  });

  it('tells the student when a topic has no linked sections yet', async () => {
    const topicId = db.addTopic('فارغ');
    await topics.topicsCallbackHandler(callbackCtx(bot, student, `topic_open:${topicId}`));
    assert.ok(
      buttons(bot).some((b) => b.data === 'noop' && /لا توجد أقسام مرتبطة/.test(b.text)),
      'a non-actionable placeholder explains the empty topic',
    );
  });

  it('rejects a malformed topic id instead of crashing', async () => {
    await topics.topicsCallbackHandler(callbackCtx(bot, student, 'topic_open:abc'));
    assert.match(lastEdit(bot), /معرف غير صالح/);
  });
});

describe('search topics: admin management', () => {
  it('refuses the manager surface to a plain student', async () => {
    await topics.topicsCallbackHandler(callbackCtx(bot, student, 'admin_topics'));
    assert.match(lastEdit(bot), /غير مصرح/);
  });

  it('lists every topic, active or not, for an authorized admin', async () => {
    const off = db.addTopic('موضوع معطّل');
    db.updateTopic(off, { active: false });

    await topics.topicsCallbackHandler(callbackCtx(bot, admin, 'admin_topics'));
    const text = lastEdit(bot);
    assert.match(text, /مواضيع البحث/);
    const buttonsFound = buttons(bot);
    assert.ok(buttonsFound.some((b) => b.data === `topics_view:${off}`));
    assert.ok(buttonsFound.some((b) => b.data === 'topics_create'));
  });

  it('creates a topic from a typed name and an optional description', async () => {
    const userData = {};
    await topics.topicsCallbackHandler(callbackCtx(bot, admin, 'topics_create', userData));
    assert.equal(userData.topics_create, true, 'the create flow is armed');

    const handled = await topics.handleTopicsText(
      messageCtx(bot, admin, 'علم الأدوية\nPharmacology basics', userData),
    );
    assert.equal(handled, true, 'the typed name was consumed');

    const created = db.getTopics(false).find((t) => t.name === 'علم الأدوية');
    assert.ok(created, 'the topic was created');
    assert.equal(created.description, 'Pharmacology basics');
    assert.equal(userData.topics_create, undefined, 'the armed flag was cleared');
  });

  it('rejects an empty topic name', async () => {
    const userData = { topics_create: true };
    await topics.handleTopicsText(messageCtx(bot, admin, '   ', userData));
    assert.ok(bot.messagesTo(admin).some((t) => /اسم غير صالح/.test(t)));
  });

  it('navigates the real folder tree in the link picker and links a section', async () => {
    const topicId = db.addTopic('لربط قسم');
    const parent = db.addFolder(0, 'الأم', 'general');
    const child = db.addFolder(parent, 'الطفل', 'general');

    await topics.topicsCallbackHandler(callbackCtx(bot, admin, `topics_link:${topicId}`));
    const found = buttons(bot);
    assert.ok(found.some((b) => b.data === `topics_pick:${topicId}:${parent}`));
    assert.ok(found.some((b) => b.data === `topics_pick_child:${topicId}:${parent}`));

    // Drill down, then commit the child link.
    await topics.topicsCallbackHandler(
      callbackCtx(bot, admin, `topics_pick_child:${topicId}:${parent}`),
    );
    assert.ok(buttons(bot).some((b) => b.data === `topics_pick_root:${topicId}:0`), 'a back button appears');

    await topics.topicsCallbackHandler(callbackCtx(bot, admin, `topics_pick:${topicId}:${child}`));
    assert.deepEqual(
      db.getTopicFolders(topicId).map((row) => row[0]),
      [child],
      'the child section is linked',
    );
    assert.match(lastEdit(bot), /إدارة الموضوع/, 'the picker returns to the topic detail');
  });

  it('unlinks a section without touching the folder itself', async () => {
    const topicId = db.addTopic('إلغاء ربط');
    const folderId = db.addFolder(0, 'يبقى', 'general');
    db.linkTopicFolder(topicId, folderId);

    await topics.topicsCallbackHandler(
      callbackCtx(bot, admin, `topics_unlink:${topicId}:${folderId}`),
    );
    assert.deepEqual(db.getTopicFolders(topicId), [], 'the link row was removed');
    assert.ok(
      db.getFolders(0).some((row) => row[0] === folderId),
      'the real folder still exists',
    );
  });

  it('toggles a topic active flag from the detail screen', async () => {
    const topicId = db.addTopic('تبديل');
    assert.equal(db.getTopic(topicId).active, true);

    await topics.topicsCallbackHandler(callbackCtx(bot, admin, `topics_toggle:${topicId}`));
    assert.equal(db.getTopic(topicId).active, false);

    await topics.topicsCallbackHandler(callbackCtx(bot, admin, `topics_toggle:${topicId}`));
    assert.equal(db.getTopic(topicId).active, true);
  });

  it('reorders a topic and never goes below zero', async () => {
    const topicId = db.addTopic('ترتيب');
    assert.equal(db.getTopic(topicId).display_order, 0);

    await topics.topicsCallbackHandler(callbackCtx(bot, admin, `topics_order:${topicId}:-1`));
    assert.equal(db.getTopic(topicId).display_order, 0, 'clamped at the floor');

    await topics.topicsCallbackHandler(callbackCtx(bot, admin, `topics_order:${topicId}:1`));
    assert.equal(db.getTopic(topicId).display_order, 1);
  });

  it('deletes a topic while leaving linked folders and resources intact', async () => {
    const topicId = db.addTopic('للحذف');
    const folderId = db.addFolder(0, 'محفوظ', 'general');
    db.linkTopicFolder(topicId, folderId);

    await topics.topicsCallbackHandler(callbackCtx(bot, admin, `topics_delete:${topicId}`));
    assert.equal(db.getTopic(topicId), null, 'the topic is gone');
    assert.ok(db.getFolders(0).some((row) => row[0] === folderId), 'the folder survived');
    assert.match(lastEdit(bot), /مواضيع البحث/, 'back on the manager list');
  });

  it('rejects malformed multi-part callbacks', async () => {
    await topics.topicsCallbackHandler(callbackCtx(bot, admin, 'topics_unlink:abc'));
    assert.match(lastEdit(bot), /طلب غير صالح/);
  });

  it('reports an unknown topics action', async () => {
    await topics.topicsCallbackHandler(callbackCtx(bot, admin, 'topics_bogus'));
    assert.match(lastEdit(bot), /غير معروف/);
  });
});
