/**
 * Contribution workflow tests: the student submission path and the admin review
 * decisions (approve / reject / request revision / resubmit).
 *
 * The approve path is the important one: it must promote the contribution into
 * the real registry exactly once and generate the Section News item.
 *
 * Handlers are driven through `contributionsCallbackHandler`, so the callback
 * routing (the part students actually touch) is exercised, not just the helpers.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as newsDelivery from '../src/newsDelivery.js';
import {
  callbackCtx,
  cleanupDb,
  FakeBot,
  freshDb,
  lastEdit,
  mediaCtx,
  messageCtx,
} from './helpers/harness.js';

let dbPath;
let registry;
let adminId;
let contributions;

before(async () => {
  dbPath = freshDb('contributions');
  newsDelivery.setSleep(async () => {});
  contributions = await import('../src/ui/contributions.js');

  const year = db.addFolder(0, 'Contrib Year', 'general', 0);
  const subject = db.addFolder(year, 'Contrib Subject', 'general', 1);
  registry = { year, subject };

  adminId = 3001;
  db.addSubAdmin(adminId, 'contrib-admin');
  db.applyRolePreset(adminId, 'admin');
});

after(() => {
  newsDelivery.resetSleep();
  cleanupDb(dbPath);
});

describe('contribution targets', () => {
  it('offers only branches leading to an accepting folder', () => {
    const root = db.addFolder(0, 'Tree Root', 'general', 0);
    const mid = db.addFolder(root, 'Tree Mid', 'general', 0);
    const accepting = db.addFolder(mid, 'Tree Accepting', 'general', 1);
    const dead = db.addFolder(root, 'Tree Dead', 'general', 0);

    assert.equal(db.folderHasContributionTarget(root), true);
    assert.equal(db.folderHasContributionTarget(mid), true);
    assert.equal(db.folderAcceptsContributions(accepting), true);
    assert.equal(db.folderHasContributionTarget(dead), false);
  });
});

describe('student submission', () => {
  it('records a contribution and notifies a reviewer', async () => {
    const bot = new FakeBot();
    const studentId = 3100;
    const reviewerId = 3002;
    db.registerUser(studentId, 'student', 'Student');
    db.addSubAdmin(reviewerId, 'reviewer');
    db.applyRolePreset(reviewerId, 'reviewer');

    const userData = {};
    // Exercise the real callback path a student taps.
    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, studentId, `contrib_folder:${registry.subject}`, userData),
    );
    assert.equal(userData.contrib_state, 'await_file');

    // A media message supplies the file...
    const handledMedia = await contributions.handleContributionMedia(
      mediaCtx(bot, studentId, { document: { file_id: 'file-contrib-1' } }, userData),
    );
    assert.equal(handledMedia, true);
    assert.equal(userData.contrib_state, 'await_title');

    // ...and a text message supplies the title.
    const handledText = await contributions.handleContributionText(
      messageCtx(bot, studentId, 'My contributed lecture', userData),
    );
    assert.equal(handledText, true);

    const mine = db.getUserContributions(studentId);
    assert.equal(mine.length, 1);
    // getUserContributions columns: id, title, file_type, status, created_at, ...
    const [id, title, , status] = mine[0];
    assert.equal(title, 'My contributed lecture');
    assert.equal(status, 'pending');

    // The reviewer was notified with a review button.
    const reviewerMessages = bot.messagesTo(reviewerId);
    assert.equal(reviewerMessages.length, 1);
    assert.match(reviewerMessages[0], new RegExp(`#${id}`));
  });

  it('rejects an empty contribution title', async () => {
    const bot = new FakeBot();
    const studentId = 3110;
    db.registerUser(studentId, 'empty', 'Empty');
    const userData = {};

    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, studentId, `contrib_folder:${registry.subject}`, userData),
    );
    await contributions.handleContributionMedia(
      mediaCtx(bot, studentId, { document: { file_id: 'f' } }, userData),
    );
    await contributions.handleContributionText(messageCtx(bot, studentId, '   ', userData));

    assert.equal(db.getUserContributions(studentId).length, 0);
  });

  it('refuses to arm on a folder that does not accept contributions', async () => {
    const bot = new FakeBot();
    const studentId = 3120;
    db.registerUser(studentId, 'nope', 'Nope');

    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, studentId, `contrib_folder:${registry.year}`),
    );
    assert.match(lastEdit(bot), /لا يستقبل/);
  });
});

describe('admin review', () => {
  let contributionId;

  before(() => {
    const studentId = 3200;
    db.registerUser(studentId, 'reviewee', 'Reviewee');
    contributionId = db.addContribution(
      studentId,
      'Reviewee',
      registry.subject,
      'Reviewable item',
      'file-review-1',
      'document',
    );
  });

  it('approves a contribution into the real registry exactly once', async () => {
    const bot = new FakeBot();

    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, adminId, `approve:${contributionId}`),
    );

    // getContribution columns: id, user_id, user_name, folder_id, title, file_id,
    // file_type, status, ...
    assert.equal(db.getContribution(contributionId)[7], 'approved');

    const contentId = db.contentIdForContribution(contributionId);
    assert.ok(contentId, 'a real content row must be linked');

    const snapshot = db.getResourceSnapshot(contentId);
    assert.equal(snapshot[0], contentId);
    assert.equal(snapshot[1], registry.subject, 'the resource lands in the target section');
    assert.equal(snapshot[2], 'Reviewable item');

    // A Section News item was generated and links the resource.
    const news = db.getResourceNewsForContent(contentId);
    assert.ok(news, 'approving generates a Section News item');
    assert.equal(news.news_type, 'section');
    assert.equal(news.resource_id, contentId);

    // Approving again must not create a second resource or second news item.
    const contentsBefore = db.getSearchableRecords().contents.length;
    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, adminId, `approve:${contributionId}`),
    );
    assert.equal(
      db.getSearchableRecords().contents.length,
      contentsBefore,
      'a repeated approval must not duplicate the resource',
    );
    assert.equal(db.contentIdForContribution(contributionId), contentId);
  });

  it('rejects a contribution with a reason and notifies the student', async () => {
    const bot = new FakeBot();
    const studentId = 3201;
    db.registerUser(studentId, 'rejectee', 'Rejectee');
    const id = db.addContribution(
      studentId,
      'Rejectee',
      registry.subject,
      'To reject',
      'file-reject',
      'document',
    );

    const userData = {};
    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, adminId, `reject:${id}`, userData),
    );
    assert.equal(userData.review_note_kind, 'reject');
    assert.equal(userData.review_note_id, id);

    await contributions.handleReviewNoteText(
      messageCtx(bot, adminId, 'Not a real medical source', userData),
    );

    assert.equal(db.getContribution(id)[7], 'rejected');
    assert.equal(db.getContribution(id)[12], 'Not a real medical source');

    const studentMessages = bot.messagesTo(studentId);
    assert.ok(studentMessages.some((text) => text.includes('رفض')));
    assert.ok(studentMessages.some((text) => text.includes('Not a real medical source')));
  });

  it('requests a revision, then lets the student resubmit', async () => {
    const bot = new FakeBot();
    const studentId = 3202;
    db.registerUser(studentId, 'reviser', 'Reviser');
    const id = db.addContribution(
      studentId,
      'Reviser',
      registry.subject,
      'Needs revision',
      'file-revise-1',
      'document',
    );

    const adminData = {};
    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, adminId, `revise:${id}`, adminData),
    );
    await contributions.handleReviewNoteText(
      messageCtx(bot, adminId, 'Please add a clearer title', adminData),
    );
    assert.equal(db.getContribution(id)[7], 'needs_revision');
    assert.equal(db.getContribution(id)[11], 'Please add a clearer title');

    // The student taps resubmit, then sends a new file and title.
    const userData = {};
    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, studentId, `resubmit:${id}`, userData),
    );
    assert.equal(userData.contrib_state, 'resubmit_file');

    await contributions.handleResubmitMedia(
      mediaCtx(bot, studentId, { document: { file_id: 'file-revise-2' } }, userData),
    );
    await contributions.handleResubmitText(
      messageCtx(bot, studentId, 'Clearer title now', userData),
    );

    const row = db.getContribution(id);
    assert.equal(row[7], 'pending', 'resubmission returns to the queue');
    assert.equal(row[4], 'Clearer title now');
    assert.equal(row[5], 'file-revise-2');
  });

  it('refuses to resubmit someone else\u2019s contribution', async () => {
    const bot = new FakeBot();
    const owner = 3203;
    const other = 3204;
    db.registerUser(owner, 'owner3', 'Owner3');
    db.registerUser(other, 'other3', 'Other3');

    const id = db.addContribution(owner, 'Owner3', registry.subject, 'Mine', 'f', 'document');
    db.requestContributionRevision(id, adminId, null);

    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, other, `resubmit:${id}`),
    );
    assert.match(lastEdit(bot), /صاحب المساهمة/);
  });

  it('refuses review actions outside a scoped admin\u2019s scope', async () => {
    const bot = new FakeBot();
    const scopedAdmin = 3205;
    db.addSubAdmin(scopedAdmin, 'scoped-reviewer');
    db.applyRolePreset(scopedAdmin, 'admin');

    // The folder accepts contributions, so the only reason a review can fail is
    // that it sits outside the admin's scope.
    const outside = db.addFolder(0, 'Outside Scope', 'general', 1);
    const id = db.addContribution(9999, 'X', outside, 'Outside', 'f', 'document');

    // Restrict the admin to registry.subject, which does not contain `outside`.
    db.addAdminScope(scopedAdmin, 'folder', registry.subject, adminId);

    await contributions.contributionsCallbackHandler(
      callbackCtx(bot, scopedAdmin, `approve:${id}`),
    );

    assert.match(lastEdit(bot), /خارج نطاق/);
    assert.equal(db.getContribution(id)[7], 'pending', 'it must not have been approved');
    assert.equal(db.contentIdForContribution(id), null, 'no resource was created');
  });
});
