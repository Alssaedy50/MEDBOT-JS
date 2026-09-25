/**
 * Contact Admin messaging: the student -> admin -> reply -> close loop.
 *
 * The lifecycle is NEW -> IN_REVIEW -> REPLIED -> CLOSED, and a CLOSED message is
 * terminal: it can never be replied to again. The category set and the callback
 * namespace are pinned here because they mirror the Python reference exactly
 * (`msg_cat:<category>`, `msg_cancel`, `msg_mine`, `admin_messages`,
 * `msg_open:<id>`, `msg_reply:<id>`, `msg_status:<id>:<STATUS>`).
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
let messages;
let student;
let admin;
let bot;

before(async () => {
  dbPath = freshDb('messages');
  messages = await import('../src/ui/messages.js');

  student = 7001;
  db.registerUser(student, 'student', 'Student');

  admin = 7002;
  db.registerUser(admin, 'msgadmin', 'Msg Admin');
  db.addSubAdmin(admin, 'msgadmin');
  db.setAdminRole(admin, 'owner');
  db.updateAdminPermissions(admin, db.defaultPermissions());

  bot = new FakeBot();
});

after(() => {
  cleanupDb(dbPath);
});

describe('contact admin: student side', () => {
  it('offers exactly the four reference categories', async () => {
    await messages.showContact(callbackCtx(bot, student, 'contact'));
    assert.match(lastEdit(bot), /التواصل مع الإدارة|تواصل مع المنصة/);
    assert.deepEqual(
      [...db.MESSAGE_CATEGORIES],
      ['message', 'summary', 'suggestion', 'report'],
      'the category set matches the Python reference',
    );
  });

  it('sends a typed message end to end, stores it as NEW and pings admins', async () => {
    const userData = {};
    await messages.armMessage(callbackCtx(bot, student, 'msg_cat:suggestion', userData), 'suggestion');
    assert.equal(userData.contact_category, 'suggestion');

    const handled = await messages.handleMessageText(
      messageCtx(bot, student, 'Please add more cardiology resources.', userData),
    );
    assert.equal(handled, true, 'the typed body was consumed');
    assert.equal(userData.contact_category, undefined, 'the armed category was cleared');

    const row = db.getUserMessages(student, 5).find((m) => m[2] === 'Please add more cardiology resources.');
    assert.ok(row, 'the message was stored');
    assert.equal(row[1], 'suggestion', 'the category was preserved');
    assert.equal(row[3], 'NEW', 'a new message starts as NEW');

    assert.ok(
      bot.messagesTo(admin).some((text) => /رسالة جديدة/.test(text)),
      'the admin who can handle messages was notified',
    );
  });

  it('refuses a category outside the reference set', async () => {
    await messages.armMessage(callbackCtx(bot, student, 'msg_cat:bogus', {}), 'bogus');
    assert.match(lastEdit(bot), /غير مدعوم/);
  });

  it('lists a student\u2019s own messages with status and reply', async () => {
    await messages.showMyMessages(callbackCtx(bot, student, 'msg_mine'));
    const text = lastEdit(bot);
    assert.match(text, /رسائلي/);
    assert.match(text, /اقتراح/);
  });

  it('shows an empty state when the student has never written', async () => {
    const quiet = 7003;
    db.registerUser(quiet, 'quiet', 'Quiet');
    await messages.showMyMessages(callbackCtx(bot, quiet, 'msg_mine'));
    assert.match(lastEdit(bot), /لم ترسل أي رسالة بعد/);
  });
});

describe('contact admin: admin side', () => {
  let messageId;

  before(() => {
    messageId = db.createMessage(student, 'Student', 'report', 'A real problem report.');
  });

  it('refuses the inbox to a student', async () => {
    await messages.messagesCallbackHandler(callbackCtx(bot, student, 'admin_messages'));
    assert.match(lastEdit(bot), /غير مصرح/);
  });

  it('lists open messages for an authorized admin', async () => {
    await messages.messagesCallbackHandler(callbackCtx(bot, admin, 'admin_messages'));
    const text = lastEdit(bot);
    assert.match(text, /رسائل الطلاب/);
    assert.match(text, /غير مغلقة: \d+/);

    // Each message is an actionable button in the reference UX.
    const buttons = (lastMarkup(bot)?.inline_keyboard ?? [])
      .flat()
      .map((b) => `${b.text} ${b.callback_data}`);
    assert.ok(
      buttons.some((b) => b.includes(`msg_open:${messageId}`)),
      'the listed message is openable',
    );
  });

  it('walks NEW -> IN_REVIEW through the status callback', async () => {
    await messages.messagesCallbackHandler(
      callbackCtx(bot, admin, `msg_status:${messageId}:IN_REVIEW`),
    );
    assert.equal(db.getMessage(messageId)[5], 'IN_REVIEW');
  });

  it('replies to the student and marks the message REPLIED', async () => {
    const userData = {};
    await messages.messagesCallbackHandler(
      callbackCtx(bot, admin, `msg_reply:${messageId}`, userData),
    );
    assert.equal(userData.contact_reply_id, messageId, 'the reply is armed');

    const handled = await messages.handleReplyText(
      messageCtx(bot, admin, 'Thanks, we will fix it.', userData),
    );
    assert.equal(handled, true, 'the reply body was consumed');

    const stored = db.getMessage(messageId);
    assert.equal(stored[6], 'Thanks, we will fix it.', 'the reply was saved');
    assert.equal(stored[5], 'REPLIED');

    assert.ok(
      bot.messagesTo(student).some((text) => /Thanks, we will fix it/.test(text)),
      'the student received the reply',
    );
  });

  it('closes a message and then refuses any further reply', async () => {
    await messages.messagesCallbackHandler(
      callbackCtx(bot, admin, `msg_status:${messageId}:CLOSED`),
    );
    assert.equal(db.getMessage(messageId)[5], 'CLOSED');

    await messages.messagesCallbackHandler(
      callbackCtx(bot, admin, `msg_reply:${messageId}`, {}),
    );
    assert.match(lastEdit(bot), /مغلقة/);

    const userData = { contact_reply_id: messageId };
    await messages.handleReplyText(messageCtx(bot, admin, 'Too late.', userData));
    assert.equal(db.getMessage(messageId)[5], 'CLOSED', 'a closed message stays closed');
    assert.equal(userData.contact_reply_id, undefined, 'the reply state was cleared');
  });

  it('rejects an unknown status', async () => {
    await messages.messagesCallbackHandler(
      callbackCtx(bot, admin, `msg_status:${messageId}:NOT_A_STATUS`),
    );
    assert.match(lastEdit(bot), /حالة غير معروفة/);
    assert.equal(db.getMessage(messageId)[5], 'CLOSED', 'the status was left untouched');
  });

  it('reports a missing message instead of crashing', async () => {
    await messages.messagesCallbackHandler(callbackCtx(bot, admin, 'msg_open:999999'));
    assert.match(lastEdit(bot), /غير موجودة/);
  });
});
