/**
 * News Center tests: the two-kind model, the published/archive lifecycle, read
 * tracking, subscriptions, private delivery and the auto Section News item.
 *
 * The "two kinds, no resource kind" rule is asserted explicitly, because it is
 * the easiest thing for a port to get wrong.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as newsDelivery from '../src/newsDelivery.js';
import { cleanupDb, FakeBot, freshDb } from './helpers/harness.js';

let dbPath;

before(() => {
  dbPath = freshDb('news');
  newsDelivery.setSleep(async () => {});
  for (let i = 0; i < 8; i += 1) {
    db.registerUser(9000 + i, `news${i}`, `News ${i}`);
  }
});

after(() => {
  newsDelivery.resetSleep();
  cleanupDb(dbPath);
});

describe('news model', () => {
  it('has exactly two kinds and no resource kind', () => {
    assert.deepEqual([...db.NEWS_TYPES], ['notify', 'section']);
    assert.ok(!db.NEWS_TYPES.includes('resource'));

    // The legacy value is only tolerated as an alias for section.
    assert.equal(db.normalizeNewsType('resource'), 'section');
    assert.equal(db.normalizeNewsType('notify'), 'notify');
    assert.equal(db.normalizeNewsType('section'), 'section');
  });

  it('creates and reads an important/urgent news item', () => {
    const newsId = db.createNews({
      newsType: 'notify',
      title: 'Urgent exam change',
      body: 'The exam moved to Sunday.',
      doctor: 'Dr. Ahmed',
      eventAt: '2026-01-10',
    });

    const detail = db.getNewsDetail(newsId);
    assert.equal(detail.title, 'Urgent exam change');
    assert.equal(detail.news_type, 'notify');
    assert.equal(detail.status, 'draft');
    assert.equal(detail.doctor, 'Dr. Ahmed');
    assert.equal(detail.event_at, '2026-01-10');
  });

  it('links a resource to Section News without inventing a kind', () => {
    const folderId = db.addFolder(0, 'News Section', 'general');
    const contentId = db.addContent(folderId, 'News resource', 'file-n1', 'document');

    const newsId = db.createNews({
      newsType: 'section',
      title: 'New resource in the section',
      body: 'Added.',
      sectionFolderId: folderId,
      resourceId: contentId,
    });

    const detail = db.getNewsDetail(newsId);
    assert.equal(detail.news_type, 'section', 'a linked resource stays Section News');
    assert.ok(detail.section_folder_id === folderId || detail.folder_id === folderId);
    assert.equal(detail.resource_id, contentId);
    assert.equal(detail.resource_present, true);
    assert.equal(detail.resource_title, 'News resource');
  });

  it('rejects an unknown news kind', () => {
    const newsId = db.createNews({ newsType: 'breaking', title: 'Nope' });
    assert.equal(newsId, null);
  });

  it('refuses to create without a title', () => {
    const newsId = db.createNews({ newsType: 'notify', title: '' });
    assert.equal(newsId, null);
  });
});

describe('news lifecycle', () => {
  it('publishes, archives and restores to draft', () => {
    const newsId = db.createNews({ newsType: 'notify', title: 'Lifecycle' });

    assert.equal(db.getNews(newsId).status, 'draft');
    assert.equal(db.publishNews(newsId), true);
    assert.equal(db.getNews(newsId).status, 'published');
    assert.notEqual(db.getNews(newsId).published_at, null);

    assert.equal(db.archiveNews(newsId), true);
    assert.equal(db.getNews(newsId).status, 'archived');

    // Restoring returns an archived item to draft, never straight to students.
    assert.equal(db.restoreNews(newsId), true);
    assert.equal(db.getNews(newsId).status, 'draft');
  });

  it('excludes drafts and archived items from the student centre', () => {
    const published = db.createNews({
      newsType: 'notify',
      title: 'Visible',
      status: 'published',
    });
    const draft = db.createNews({ newsType: 'notify', title: 'Hidden draft' });
    const archived = db.createNews({
      newsType: 'notify',
      title: 'Hidden archived',
      status: 'published',
    });
    db.archiveNews(archived);

    const visible = db.listNews({ status: 'published', limit: 200 }).map((item) => item.id);
    assert.ok(visible.includes(published));
    assert.ok(!visible.includes(draft));
    assert.ok(!visible.includes(archived));
  });

  it('filters the student centre by kind', () => {
    const urgent = db.createNews({
      newsType: 'notify',
      title: 'Urgent only',
      status: 'published',
    });
    const section = db.createNews({
      newsType: 'section',
      title: 'Section only',
      status: 'published',
    });

    const urgentIds = db
      .listNews({ status: 'published', newsType: 'notify', limit: 200 })
      .map((item) => item.id);
    assert.ok(urgentIds.includes(urgent));
    assert.ok(!urgentIds.includes(section));

    const sectionIds = db
      .listNews({ status: 'published', newsType: 'section', limit: 200 })
      .map((item) => item.id);
    assert.ok(sectionIds.includes(section));
    assert.ok(!sectionIds.includes(urgent));
  });

  it('pages the news list deterministically', () => {
    const pageSize = db.NEWS_PAGE_SIZE;
    // Guarantee more than one page regardless of earlier test state.
    for (let i = 0; i < pageSize + 2; i += 1) {
      db.createNews({ newsType: 'notify', title: `Page item ${i}`, status: 'published' });
    }

    const total = db.countNews({ status: 'published' });
    assert.ok(total > pageSize, 'the fixture must span more than one page');

    const page1 = db.listNews({ status: 'published', limit: pageSize, offset: 0 });
    const page2 = db.listNews({ status: 'published', limit: pageSize, offset: pageSize });
    assert.equal(page1.length, pageSize);
    assert.ok(page2.length > 0, 'there must be a second page to compare');

    const ids1 = new Set(page1.map((item) => item.id));
    for (const item of page2) {
      assert.ok(!ids1.has(item.id), 'pages must not overlap');
    }
  });

  it('counts by kind for the admin overview', () => {
    const counts = db.getNewsCountsByType();
    assert.ok(typeof counts === 'object');
    for (const key of Object.keys(counts)) {
      assert.ok(['notify', 'section'].includes(key), `unexpected kind in counts: ${key}`);
    }
  });
});

describe('read tracking', () => {
  it('marks read and counts unread per user', () => {
    const userId = 9100;
    db.registerUser(userId, 'reader', 'Reader');

    const newsId = db.createNews({
      newsType: 'notify',
      title: 'Read me',
      status: 'published',
    });

    assert.equal(db.isNewsRead(userId, newsId), false);
    db.markNewsRead(userId, newsId);
    assert.equal(db.isNewsRead(userId, newsId), true);

    // Idempotent: re-reading does not duplicate the row.
    db.markNewsRead(userId, newsId);
    const rows = db.withDb((conn) =>
      conn
        .prepare('SELECT COUNT(*) FROM news_reads WHERE user_id = ? AND news_id = ?')
        .get(userId, newsId),
    );
    assert.equal(rows[0], 1);
  });

  it('counts unread published news for a user', () => {
    const userId = 9110;
    db.registerUser(userId, 'counter', 'Counter');
    db.createNews({ newsType: 'notify', title: 'A count', status: 'published' });
    db.markAllNewsRead(userId);
    assert.equal(db.getUnreadNewsCount(userId), 0);

    db.createNews({ newsType: 'notify', title: 'B count', status: 'published' });
    assert.ok(db.getUnreadNewsCount(userId) >= 1);
  });

  it('does not leak read state across users', () => {
    const newsId = db.createNews({
      newsType: 'notify',
      title: 'Private read state',
      status: 'published',
    });

    db.markNewsRead(9200, newsId);
    assert.equal(db.isNewsRead(9201, newsId), false);
  });
});

describe('subscriptions', () => {
  it('subscribes to the two kinds and to specific sections', () => {
    const userId = 9300;
    const sectionId = db.addFolder(0, 'Subscribed Section', 'general');
    db.registerUser(userId, 'sub', 'Sub');

    assert.equal(db.addNewsSubscription(userId, 'type', 'notify'), true);
    assert.equal(db.addNewsSubscription(userId, 'type', 'section'), true);
    assert.equal(db.addNewsSubscription(userId, 'section', sectionId), true);

    // A duplicate subscription is a no-op, not an error.
    assert.equal(db.addNewsSubscription(userId, 'type', 'notify'), true);

    const subs = db.getNewsSubscriptions(userId);
    assert.ok(subs.length >= 3);
  });

  it('folds the legacy resource kind into section on subscribe', () => {
    // The Python reference normalises 'resource' -> 'section' and then accepts
    // it, so the subscription is stored as a section subscription.
    assert.equal(db.addNewsSubscription(9301, 'type', 'resource'), true);
    const subs = db.getNewsSubscriptions(9301);
    assert.deepEqual(subs, [['type', 'section']]);

    // A genuinely unknown kind is still rejected.
    assert.equal(db.addNewsSubscription(9301, 'type', 'breaking'), false);
  });

  it('rejects a section subscription to a folder that does not exist', () => {
    assert.equal(db.addNewsSubscription(9303, 'section', 999999), false);
  });

  it('resolves recipients from kind and section subscriptions', () => {
    const sectionId = db.addFolder(0, 'Resolver Section', 'general');
    const typeUser = 9310;
    const sectionUser = 9311;
    db.registerUser(typeUser, 't', 'T');
    db.registerUser(sectionUser, 's', 'S');

    db.addNewsSubscription(typeUser, 'type', 'section');
    db.addNewsSubscription(sectionUser, 'section', sectionId);

    const recipients = new Set(db.resolveNewsRecipients('section', sectionId));
    assert.ok(recipients.has(typeUser), 'a section-kind subscriber is a recipient');
    assert.ok(recipients.has(sectionUser), 'a section-specific subscriber is a recipient');
  });

  it('unsubscribes cleanly', () => {
    const userId = 9302;
    const sectionId = db.addFolder(0, 'Unsub Section', 'general');
    db.registerUser(userId, 'unsub', 'Unsub');

    db.addNewsSubscription(userId, 'section', sectionId);
    assert.equal(db.removeNewsSubscription(userId, 'section', sectionId), true);

    const subs = db.getNewsSubscriptions(userId);
    assert.ok(
      !subs.some(([kind, value]) => kind === 'section' && Number(value) === sectionId),
    );
  });
});

describe('news delivery engine', () => {
  it('delivers to subscribed users, honouring section specificity', async () => {
    const bot = new FakeBot();
    const sectionId = db.addFolder(0, 'Delivery Section', 'general');

    const generalUser = 9400;
    const sectionUser = 9401;
    const unrelatedUser = 9402;
    for (const userId of [generalUser, sectionUser, unrelatedUser]) {
      db.registerUser(userId, `d${userId}`, `D${userId}`);
    }

    db.addNewsSubscription(generalUser, 'type', 'section');
    db.addNewsSubscription(sectionUser, 'section', sectionId);

    const newsId = db.createNews({
      newsType: 'section',
      title: 'Section specific',
      body: 'Body',
      sectionFolderId: sectionId,
      status: 'published',
    });

    const result = await newsDelivery.enqueuePublishDelivery(bot, newsId);

    assert.ok(result.sent >= 2, 'both subscribers receive it');
    const deliveredChats = bot.calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => call.args.chatId);
    assert.ok(deliveredChats.includes(generalUser));
    assert.ok(deliveredChats.includes(sectionUser));
    assert.ok(!deliveredChats.includes(unrelatedUser), 'a non-subscriber must not receive it');
  });

  it('records one delivery row per recipient and is idempotent', async () => {
    const bot = new FakeBot();
    const userId = 9500;
    db.registerUser(userId, 'once', 'Once');
    db.addNewsSubscription(userId, 'type', 'notify');

    const newsId = db.createNews({
      newsType: 'notify',
      title: 'Once only',
      status: 'published',
    });

    await newsDelivery.enqueuePublishDelivery(bot, newsId);
    const firstCount = bot.messagesTo(userId).length;
    assert.equal(firstCount, 1);

    // Re-running must not deliver this student a second copy.
    await newsDelivery.enqueuePublishDelivery(bot, newsId);
    assert.equal(bot.messagesTo(userId).length, firstCount, 'no duplicate delivery');

    const rows = db.withDb((conn) =>
      conn
        .prepare('SELECT COUNT(*) FROM news_deliveries WHERE news_id = ? AND user_id = ?')
        .get(newsId, userId),
    );
    assert.equal(rows[0], 1);
  });

  it('keeps going when one chat is blocked, and records the failure', async () => {
    const bot = new FakeBot();
    const blocked = 9600;
    const reachable = 9601;
    for (const userId of [blocked, reachable]) {
      db.registerUser(userId, `b${userId}`, `B${userId}`);
      db.addNewsSubscription(userId, 'type', 'notify');
    }
    bot.failFor.add(`sendMessage:${blocked}`);

    const newsId = db.createNews({
      newsType: 'notify',
      title: 'Partial failure',
      status: 'published',
    });

    const result = await newsDelivery.enqueuePublishDelivery(bot, newsId);
    assert.ok(result.sent >= 1, 'the reachable student still gets it');
    assert.ok(result.failed >= 1, 'the blocked chat is recorded as failed');

    const failedRow = db.withDb((conn) =>
      conn
        .prepare('SELECT status FROM news_deliveries WHERE news_id = ? AND user_id = ?')
        .get(newsId, blocked),
    );
    assert.equal(failedRow[0], 'failed');
  });

  it('recovers interrupted pending deliveries after a restart', async () => {
    const bot = new FakeBot();
    const userId = 9700;
    db.registerUser(userId, 'recover', 'Recover');
    db.addNewsSubscription(userId, 'type', 'notify');

    const newsId = db.createNews({
      newsType: 'notify',
      title: 'Recover me',
      status: 'published',
    });

    // Simulate a crash after the row was queued but before it was sent.
    db.withDb((conn) =>
      conn
        .prepare(
          `INSERT INTO news_deliveries (news_id, user_id, status, attempts)
           VALUES (?, ?, 'pending', 0)`,
        )
        .run(newsId, userId),
    );

    await newsDelivery.recoverPendingDeliveries(bot, true);
    assert.equal(bot.messagesTo(userId).length, 1);
  });

  it('publishes an auto Section News item for a new resource exactly once', async () => {
    const bot = new FakeBot();
    const userId = 9800;
    db.registerUser(userId, 'autonews', 'AutoNews');
    db.addNewsSubscription(userId, 'type', 'section');

    const folderId = db.addFolder(0, 'Auto News Section', 'general');
    const contentId = db.addContent(folderId, 'Auto resource', 'file-auto', 'document');

    const newsUi = await import('../src/ui/news.js');
    const first = await newsUi.publishNewsForResource(bot, contentId);
    const second = await newsUi.publishNewsForResource(bot, contentId);

    assert.equal(first, second, 'the auto news item is created only once');
    assert.ok(first, 'an id is returned');

    const detail = db.getNewsDetail(first);
    assert.equal(detail.news_type, 'section', 'it is Section News, never a resource kind');
    assert.equal(detail.resource_id, contentId);
    assert.equal(detail.status, 'published');

    // The subscriber received exactly one copy.
    assert.equal(bot.messagesTo(userId).length, 1);
  });

  it('does not generate a second kind for a resource', () => {
    const rows = db.withDb((conn) => conn.prepare('SELECT DISTINCT news_type FROM news').all());
    for (const row of rows) {
      assert.ok(['notify', 'section'].includes(row[0]), `unexpected news kind: ${row[0]}`);
    }
  });
});
