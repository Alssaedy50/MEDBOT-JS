/**
 * News delivery engine tests: planning, batching, rate limiting and recovery.
 *
 * The delivery engine is the part students actually feel — a missed or
 * duplicated notification is visible. These tests drive it with the fake
 * transport, including the failure modes (429 with `retry_after`, a hard send
 * failure) that the Python suite also pins down.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as delivery from '../src/newsDelivery.js';
import { FakeBot, freshDb, cleanupDb } from './helpers/harness.js';

let dbPath;
let root;

before(() => {
  dbPath = freshDb('delivery');
  root = db.addFolder(0, 'Delivery Section', 'general');
});

after(() => {
  cleanupDb(dbPath);
});

beforeEach(() => {
  delivery.setSleep(async () => {});
});

let nextUser = 7000;
function newStudent(label) {
  nextUser += 1;
  db.registerUser(nextUser, label, label);
  return nextUser;
}

function publishSection(title, sectionFolderId = root) {
  return db.createNews({
    newsType: 'section',
    title,
    body: 'Body',
    sectionFolderId,
    status: 'published',
  });
}

function publishImportant(title) {
  return db.createNews({
    newsType: 'notify',
    title,
    body: 'Body',
    status: 'published',
  });
}

const sentTo = (bot) =>
  bot.calls.filter((c) => c.method === 'sendMessage').map((c) => c.args.chatId);

describe('delivery planning', () => {
  it('reserves nothing for an unknown news id', () => {
    const plan = delivery.planDelivery(999999);
    assert.equal(plan.news, null);
    assert.deepEqual(plan.reserved, []);
  });

  it('reserves nothing for a draft, because drafts are not delivered', () => {
    const newsId = db.createNews({ newsType: 'notify', title: 'Draft', status: 'draft' });
    assert.deepEqual(delivery.planDelivery(newsId).reserved, []);
  });

  it('plans an important news delivery for every type subscriber', () => {
    const a = newStudent('plan-a');
    const b = newStudent('plan-b');
    db.addNewsSubscription(a, 'type', 'notify');
    db.addNewsSubscription(b, 'type', 'notify');

    const plan = delivery.planDelivery(publishImportant('Urgent plan'));
    assert.ok(plan.reserved.includes(a));
    assert.ok(plan.reserved.includes(b));
  });

  it('restricts a section news delivery to followers of that section', () => {
    const follower = newStudent('plan-follower');
    const outsider = newStudent('plan-outsider');
    db.addNewsSubscription(follower, 'section', String(root));
    db.addNewsSubscription(outsider, 'type', 'notify');

    const plan = delivery.planDelivery(publishSection('Section update'));
    assert.ok(plan.reserved.includes(follower), 'the section follower is planned');
    assert.ok(!plan.reserved.includes(outsider), 'a non-follower is not planned');
  });

  it('reserving the same audience twice does not queue duplicate rows', () => {
    const student = newStudent('plan-once');
    db.addNewsSubscription(student, 'type', 'notify');
    const newsId = publishImportant('Reserve once');

    const first = delivery.planDelivery(newsId).reserved;
    const second = delivery.planDelivery(newsId).reserved;
    assert.ok(first.includes(student));
    assert.ok(!second.includes(student), 'the second reservation is a no-op');
  });
});

describe('delivery execution', () => {
  it('delivers to every planned student and records success', async () => {
    const bot = new FakeBot();
    const student = newStudent('exec-one');
    const newsId = publishImportant('Broadcast');

    const result = await delivery.deliver(bot, newsId, [student], false);
    assert.equal(result.sent, 1);
    assert.deepEqual(sentTo(bot), [student]);
  });

  it('records a failed delivery when the send permanently fails', async () => {
    const bot = new FakeBot();
    const student = newStudent('exec-blocked');
    bot.failFor.add(`sendMessage:${student}`);
    const newsId = publishImportant('Blocked');

    const result = await delivery.deliver(bot, newsId, [student], false);
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);
    assert.ok(
      db.getPendingNewsDeliveries(newsId).includes(student),
      'a blocked student stays pending for recovery',
    );
  });

  it('a terminal sent row is never sent again', async () => {
    const bot = new FakeBot();
    const student = newStudent('exec-terminal');
    const newsId = publishImportant('Terminal');

    assert.equal((await delivery.deliver(bot, newsId, [student], false)).sent, 1);
    bot.reset();

    const again = await delivery.deliver(bot, newsId, [student], false);
    assert.equal(again.sent, 0, 'a sent delivery is skipped on a second pass');
    assert.equal(again.skipped, 1);
    assert.equal(sentTo(bot).length, 0);
  });

  it('retries a failed recipient after the block is lifted', async () => {
    const bot = new FakeBot();
    const student = newStudent('exec-retry');
    bot.failFor.add(`sendMessage:${student}`);
    const newsId = publishImportant('Retry me');

    await delivery.deliver(bot, newsId, [student], false);
    bot.reset();
    bot.failFor.delete(`sendMessage:${student}`);

    const retried = await delivery.retryFailed(bot, newsId);
    assert.equal(retried.sent, 1, 'the previously failed recipient is retried');
  });

  it('batches a large audience rather than sending all at once', async () => {
    const bot = new FakeBot();
    const ids = [];
    for (let i = 0; i < 60; i += 1) ids.push(newStudent(`exec-bulk-${i}`));
    const newsId = publishImportant('Big audience');

    const result = await delivery.deliver(bot, newsId, ids, true);
    assert.equal(result.sent, ids.length, 'every student is still reached');
    assert.equal(sentTo(bot).length, ids.length, 'exactly one message each');
  });
});

describe('delivery recovery after a restart', () => {
  it('picks up a delivery left mid-claim by a crash', async () => {
    const bot = new FakeBot();
    const student = newStudent('rec-over');
    const newsId = publishImportant('Interrupted');

    // A crash mid-send leaves a `sending` row rather than a false `sent`.
    db.claimNewsDelivery(newsId, student);
    bot.reset();

    // The startup path resets every stale claim, then resumes delivery.
    await delivery.recoverPendingDeliveries(bot, true);
    assert.ok(sentTo(bot).includes(student), 'the student finally received the news');
  });

  it('leaves a fresh in-flight claim alone outside the startup path', async () => {
    const bot = new FakeBot();
    const student = newStudent('rec-inflight');
    const newsId = publishImportant('In flight');

    db.claimNewsDelivery(newsId, student);
    bot.reset();

    // A normal recovery must not steal a claim another worker is still using.
    await delivery.recoverPendingDeliveries(bot);
    assert.equal(sentTo(bot).length, 0, 'the active claim is respected');
  });

  it('does not double-deliver an already-sent record', async () => {
    const bot = new FakeBot();
    const student = newStudent('rec-sent');
    const newsId = publishImportant('Already sent');

    db.markNewsDelivery(newsId, student, 'sent');
    bot.reset();

    await delivery.recoverPendingDeliveries(bot);
    assert.equal(sentTo(bot).length, 0, 'a sent record must not be re-delivered');
  });

  it('honours a 429 retry_after hint, capped', () => {
    assert.equal(delivery.retryAfterSeconds({ retry_after: 5 }), 5);
    assert.equal(
      delivery.retryAfterSeconds({ retry_after: 9999 }),
      delivery.DELIVERY_RETRY_AFTER_CAP,
      'an absurd wait is capped',
    );
    assert.equal(delivery.retryAfterSeconds(new Error('nope')), delivery.DELIVERY_RETRY_AFTER_CAP);
  });

  it('gives up after bounded retries on a persistent 429', async () => {
    const bot = new FakeBot();
    const student = newStudent('rec-429');
    const newsId = publishImportant('Throttled');

    // The fake throws before recording, so count the attempts directly.
    let attempts = 0;
    const transport = {
      async sendMessage() {
        attempts += 1;
        const error = new Error('429 Too Many Requests');
        error.retry_after = 0;
        throw error;
      },
    };
    bot.sendMessage = transport.sendMessage;

    const result = await delivery.deliver(bot, newsId, [student], false);

    assert.equal(result.failed, 1, 'a never-recovering throttle is recorded as failed');
    assert.equal(
      attempts,
      delivery.DELIVERY_MAX_SEND_RETRIES + 1,
      'retries are bounded, never an infinite loop',
    );
    assert.ok(
      db.getPendingNewsDeliveries(newsId).includes(student),
      'it stays recoverable for a later pass',
    );
  });
});

describe('private delivery text and markup', () => {
  it('renders the news with its type, title and body', () => {
    const text = delivery.buildDeliveryText({
      id: 1,
      news_type: 'notify',
      title: 'Private title',
      body: 'Private body',
      subject_name: 'Physiology',
    });
    assert.match(text, /Private title/);
    assert.match(text, /Private body/);
    assert.match(text, /Physiology/);
    assert.match(text, /مركز الأخبار/);
  });

  it('links a resource-bearing section news to its live resource', () => {
    const folder = db.addFolder(0, 'Markup Section', 'general');
    const resourceId = db.addContent(folder, 'Markup Resource', 'f-markup', 'document');
    const newsId = db.createNews({
      newsType: 'section',
      title: 'With resource',
      sectionFolderId: folder,
      resourceId,
      status: 'published',
    });

    const news = db.getNewsDetail(newsId);
    assert.equal(news.resource_present, true, 'the resource is still in the registry');

    const flat = delivery
      .buildDeliveryMarkup(news)
      .inline_keyboard.flat()
      .map((b) => b.callback_data);
    assert.ok(flat.includes(`file:${resourceId}`), 'the resource button is offered');
    assert.ok(flat.includes(`folder:${folder}`), 'the section button is offered');
  });

  it('degrades to the News Center when the linked resource is gone', () => {
    const folder = db.addFolder(0, 'Ghost Section', 'general');
    const resourceId = db.addContent(folder, 'Ghost Resource', 'f-ghost', 'document');
    const newsId = db.createNews({
      newsType: 'section',
      title: 'Ghost resource',
      sectionFolderId: folder,
      resourceId,
      status: 'published',
    });
    db.deleteFile(resourceId);

    const news = db.getNewsDetail(newsId);
    const flat = delivery
      .buildDeliveryMarkup(news)
      .inline_keyboard.flat()
      .map((b) => b.callback_data);
    assert.ok(flat.includes(`news_open:${newsId}`), 'the News Center entry always remains');
    assert.ok(!flat.includes(`file:${resourceId}`), 'no dead link to a removed resource');
  });
});
