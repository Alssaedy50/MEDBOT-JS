/**
 * Emergency Resource Archive: identity, idempotency and the admin surface.
 *
 * The mirror posts to a real Telegram channel in production, so the tests drive
 * it through the fake transport and assert on the exact DB transitions, because
 * "already published must never post twice" is the contract that keeps the
 * channel from growing duplicates after a restart or a retry.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import * as archive from '../src/archive.js';
import * as db from '../src/db/index.js';
import { adminSettingsCallbackHandler } from '../src/ui/adminSettings.js';
import {
  callbackCtx,
  cleanupDb,
  FakeBot,
  freshDb,
  lastButtons,
  lastEdit,
  makeAdmin,
} from './helpers/harness.js';

let dbPath;
let bot;
let seq = 0;
const admin = 7001;

/**
 * A distinct resource under its own section.
 *
 * Fingerprint identity is (title, file_type, file_id), so tests must not reuse
 * the same resource name: an earlier publish would make a later one legitimately
 * skip as already-mirrored.
 */
function uniqueResource(fileType = 'document') {
  seq += 1;
  const folderId = db.addFolder(0, `قسم ${seq}`, 'general');
  const contentId = db.addContent(folderId, `مورد ${seq}`, `file-${seq}`, fileType);
  return { folderId, contentId };
}

before(() => {
  dbPath = freshDb('archive');
  bot = new FakeBot();
  db.registerUser(admin, 'boss', 'Boss');
  makeAdmin(admin);
});

after(() => {
  delete process.env.MEDBOT_ARCHIVE_CHANNEL;
  delete process.env.ARCHIVE_CHANNEL_ID;
  cleanupDb(dbPath);
});

beforeEach(() => {
  bot.calls.length = 0;
  for (const key of ['MEDBOT_ARCHIVE_CHANNEL', 'ARCHIVE_CHANNEL_ID']) delete process.env[key];
});

describe('archive: configuration', () => {
  it('is off until a channel is configured through the environment', () => {
    assert.equal(archive.resolveChannel(), '');
    assert.equal(archive.isConfigured(), false);
    assert.equal(archive.channelForSend(), null);
    assert.equal(archive.runtimeStatus().enabled, false);
  });

  it('accepts either supported environment variable', () => {
    process.env.ARCHIVE_CHANNEL_ID = '-1001234567890';
    assert.equal(archive.resolveChannel(), '-1001234567890');
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1009999999999';
    assert.equal(archive.resolveChannel(), '-1009999999999');
  });

  it('sends a numeric id as a number and an @username as a string', () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    assert.equal(archive.channelForSend(), -1001234567890);
    process.env.MEDBOT_ARCHIVE_CHANNEL = '@medbot_archive';
    assert.equal(archive.channelForSend(), '@medbot_archive');
  });
});

describe('archive: resource identity', () => {
  it('keys a resource by its own fields, so renaming a folder cannot republish it', () => {
    const original = [1, 5, 'تشريح عملي', 'file-1', 'document', 'الرئيسية 🏠 ⬅️ عملي'];
    const moved = [1, 9, 'تشريح عملي', 'file-1', 'document', 'الرئيسية 🏠 ⬅️ أخرى'];
    assert.equal(archive.contentFingerprint(original), archive.contentFingerprint(moved));
  });

  it('changes the key when the material itself changes', () => {
    const a = [1, 5, 'تشريح عملي', 'file-1', 'document', 'p'];
    const b = [1, 5, 'تشريح عملي', 'file-2', 'document', 'p'];
    const c = [1, 5, 'تشريح عملي', 'file-1', 'video', 'p'];
    assert.notEqual(archive.contentFingerprint(a), archive.contentFingerprint(b));
    assert.notEqual(archive.contentFingerprint(a), archive.contentFingerprint(c));
  });

  it('normalises whitespace and case in the title', () => {
    const a = [1, 5, '  Histology   Lecture  ', 'file-1', 'document', 'p'];
    const b = [1, 5, 'histology lecture', 'file-1', 'document', 'p'];
    assert.equal(archive.contentFingerprint(a), archive.contentFingerprint(b));
  });

  it('names the resource and its real registered path in the caption', () => {
    const caption = archive.buildCaption([
      1,
      5,
      'تشريح عملي',
      'file-1',
      'document',
      'الرئيسية 🏠 ⬅️ عملي',
    ]);
    assert.match(caption, /تشريح عملي/);
    assert.match(caption, /الرئيسية 🏠 ⬅️ عملي/);
    assert.match(caption, /<b>النوع:<\/b> <code>document<\/code>/);
  });
});

describe('archive: publication', () => {
  it('does nothing when the channel is unset', async () => {
    const { contentId } = uniqueResource();
    const result = await archive.publishResource(bot, contentId);
    assert.equal(result.status, 'skipped');
    assert.equal(bot.calls.length, 0);
  });

  it('publishes a registered resource once and is idempotent afterwards', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    const { contentId } = uniqueResource();

    const first = await archive.publishResource(bot, contentId);
    assert.equal(first.status, 'published');
    assert.equal(first.message_id !== null, true);
    assert.equal(bot.calls.filter((c) => c.method === 'sendDocument').length, 1);

    const second = await archive.publishResource(bot, contentId);
    assert.equal(second.status, 'published');
    assert.equal(second.message_id, first.message_id);
    assert.equal(
      bot.calls.filter((c) => c.method === 'sendDocument').length,
      1,
      'a repeat publish must not post a second copy',
    );
  });

  it('records a failed send without ever throwing', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    const { contentId } = uniqueResource();
    bot.failFor.add('sendDocument');

    const result = await archive.publishResource(bot, contentId);
    assert.equal(result.status, 'failed');
    assert.ok(result.error);

    const row = db.getArchiveSync(result.fingerprint);
    assert.equal(row[7], 'failed');
    assert.ok(row[8] >= 1, 'the attempt is counted');

    bot.failFor.clear();
  });

  it('picks the media method matching the registered file type', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    const { contentId } = uniqueResource('video');
    await archive.publishResource(bot, contentId);
    assert.equal(bot.calls.filter((c) => c.method === 'sendVideo').length, 1);
  });

  it('posts a section header once per folder when asked', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    const { folderId, contentId } = uniqueResource();

    await archive.publishResource(bot, contentId, true);
    const headers = bot.calls.filter(
      (c) => c.method === 'sendMessage' && /📁/.test(c.args.text),
    );
    assert.equal(headers.length, 1);
    assert.match(headers[0].args.text, new RegExp(`قسم ${seq}`));

    const row = db.getArchiveSync(archive.folderFingerprint(folderId));
    assert.equal(row[7], 'published');
  });
});

describe('archive: resync and retry', () => {
  it('skips resources that are already published', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    const { contentId } = uniqueResource();

    await archive.publishResource(bot, contentId);
    const publishedBefore = db.getArchiveSync(
      archive.contentFingerprint(db.getResourceSnapshot(contentId)),
    )[7];
    assert.equal(publishedBefore, 'published');

    const stats = await archive.resync(bot);
    assert.ok(stats.total >= 1);
    assert.ok(stats.skipped >= 1, 'the already-published resource is skipped');
    assert.equal(stats.failed, 0);
  });

  it('mirrors resources that were never published', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    const { contentId } = uniqueResource();

    const stats = await archive.resync(bot);
    assert.ok(stats.published >= 1, 'the pending resource is now published');

    const row = db.getArchiveSync(
      archive.contentFingerprint(db.getResourceSnapshot(contentId)),
    );
    assert.equal(row[7], 'published');
  });

  it('retries only the rows recorded as failed', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    const { contentId } = uniqueResource();

    bot.failFor.add('sendDocument');
    await archive.publishResource(bot, contentId);
    bot.failFor.clear();

    const stats = await archive.retryFailed(bot);
    assert.equal(stats.total, 1);
    assert.equal(stats.published, 1);

    const row = db.getArchiveSync(archive.contentFingerprint(db.getResourceSnapshot(contentId)));
    assert.equal(row[7], 'published');
  });

  it('leaves a failed row untouched when its resource no longer exists', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    db.upsertArchivePending('content:orphaned-handle', { contentId: 999999 });
    db.markArchiveFailed('content:orphaned-handle', 'gone');

    const stats = await archive.retryFailed(bot);
    assert.ok(stats.total >= 1);
    assert.equal(stats.published, 0, 'an unreadable resource is never reconstructed');
    assert.equal(db.getArchiveSync('content:orphaned-handle')[7], 'failed');
  });

  it('does no work when there is nothing configured', async () => {
    assert.deepEqual(await archive.resync(bot), {
      published: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    });
    assert.deepEqual(await archive.retryFailed(bot), {
      published: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    });
  });
});

describe('archive: admin surface', () => {
  it('refuses the archive screen to an unauthorized user', async () => {
    await adminSettingsCallbackHandler(callbackCtx(bot, 9999, 'admin_archive'));
    assert.match(lastEdit(bot), /غير مصرح/);
  });

  it('shows the configured channel and sync counts to an authorized admin', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '@medbot_archive';
    await adminSettingsCallbackHandler(callbackCtx(bot, admin, 'admin_archive'));
    const text = lastEdit(bot);
    assert.match(text, /@medbot_archive/);
    assert.match(text, /https:\/\/t\.me\/medbot_archive/);
    assert.match(text, /حالة المزامنة/);
  });

  it('explains how to enable the archive when it is not configured', async () => {
    await adminSettingsCallbackHandler(callbackCtx(bot, admin, 'admin_archive'));
    const text = lastEdit(bot);
    assert.match(text, /الأرشيف غير مُهيّأ/);
    assert.match(text, /MEDBOT_ARCHIVE_CHANNEL/);
  });

  it('offers the resync, retry and status actions', async () => {
    await adminSettingsCallbackHandler(callbackCtx(bot, admin, 'admin_archive'));
    const buttons = lastButtons(bot);
    assert.ok(buttons.includes('archive_resync'));
    assert.ok(buttons.includes('archive_retry'));
    assert.ok(buttons.includes('archive_status'));
  });

  it('lists mirror rows with their status and attempt count', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    await adminSettingsCallbackHandler(callbackCtx(bot, admin, 'archive_status'));
    const text = lastEdit(bot);
    assert.match(text, /حالة مزامنة الأرشيف/);
    assert.match(text, /محاولة/);
  });

  it('runs a resync and reports the outcome', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    await adminSettingsCallbackHandler(callbackCtx(bot, admin, 'archive_resync'));
    const text = lastEdit(bot);
    assert.match(text, /اكتملت إعادة المزامنة/);
    assert.match(text, /الإجمالي/);
  });

  it('records an audit entry for a resync', async () => {
    process.env.MEDBOT_ARCHIVE_CHANNEL = '-1001234567890';
    const before = db.getAuditCount();
    await adminSettingsCallbackHandler(callbackCtx(bot, admin, 'archive_resync'));
    assert.ok(db.getAuditCount() > before);
  });

  it('falls back to the archive screen when resync runs unconfigured', async () => {
    await adminSettingsCallbackHandler(callbackCtx(bot, admin, 'archive_resync'));
    assert.match(lastEdit(bot), /الأرشيف غير مُهيّأ/);
  });

  it('rejects an unknown archive action rather than guessing', async () => {
    await adminSettingsCallbackHandler(callbackCtx(bot, admin, 'archive_bogus'));
    assert.match(lastEdit(bot), /إجراء غير معروف/);
  });
});
