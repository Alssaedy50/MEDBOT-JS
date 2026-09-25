/**
 * Section (folder) management: the dashboard, the detail screen, and the
 * multi-step creation flow.
 *
 * The creation flow is the piece worth pinning: Python asks for a parent
 * through a hierarchical tree picker, then a name, then a type, then whether
 * the section accepts student contributions. A shortcut that created the
 * section with a hard-coded `general` type and no contribution prompt would
 * look fine in a screenshot while silently dropping two user choices.
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
  lastEdit,
  mediaCtx,
  messageCtx,
} from './helpers/harness.js';

let dbPath;
let folders;
let ownerId;
let tree;

/** The text of the last `sendMessage` (a reply) recorded by a fake bot. */
function lastReply(bot) {
  const calls = bot.calls.filter((call) => call.method === 'sendMessage');
  return calls.length ? calls[calls.length - 1].args.text : '';
}

/** All callback_data values in the last rendered keyboard. */
function lastButtons(bot) {
  const rows = lastMarkup(bot)?.inline_keyboard ?? [];
  return rows.flat().map((button) => button.callback_data);
}

/** Callback data from the last reply (a `sendMessage`), not the last edit. */
function replyButtons(bot) {
  const calls = bot.calls.filter((call) => call.method === 'sendMessage');
  if (!calls.length) return [];
  const rows = calls[calls.length - 1].args.options?.reply_markup?.inline_keyboard ?? [];
  return rows.flat().map((button) => button.callback_data);
}

function lastMarkup(bot) {
  const call = bot.last('editMessageText');
  return call?.args?.options?.reply_markup ?? null;
}

before(async () => {
  dbPath = freshDb('folders');
  folders = await import('../src/ui/adminFolders.js');

  ownerId = 1;
  db.registerUser(ownerId, 'owner', 'Owner');
  db.ensureConfiguredAdmin(ownerId, 'owner');

  const year = db.addFolder(0, 'Second Year', 'general');
  const subject = db.addFolder(year, 'Physiology', 'books');
  tree = { year, subject };
});

after(() => {
  cleanupDb(dbPath);
});

describe('section dashboard', () => {
  it('offers a hierarchical parent picker, not a flat create button', async () => {
    const bot = new FakeBot();
    await folders.adminFoldersCallbackHandler(callbackCtx(bot, ownerId, 'admin_folders'));

    const createButton = lastButtons(bot).find((data) => data === 'admin_folder_create');
    assert.ok(createButton, 'the dashboard offers the top-level create entry point');

    await folders.adminFoldersCallbackHandler(callbackCtx(bot, ownerId, 'admin_folder_create'));

    const text = lastEdit(bot);
    assert.match(text, /اختيار القسم الأب/, 'the picker asks for a parent, not a name first');
    assert.ok(
      lastButtons(bot).includes(`admin_folder_parent:${tree.year}`),
      'the picker descends into the real hierarchy',
    );
    assert.ok(
      lastButtons(bot).includes('admin_folder_select_parent:0'),
      'the root itself is selectable',
    );
  });

  it('never asks Section / Topic / Resource up front', async () => {
    const bot = new FakeBot();
    await folders.adminFoldersCallbackHandler(callbackCtx(bot, ownerId, 'admin_folder_create'));

    const text = lastEdit(bot);
    assert.ok(!/نوع القسم|اختر نوع/.test(text), 'type is not asked before the parent is chosen');
  });

  it('hides top-level creation from a scoped admin', async () => {
    const bot = new FakeBot();
    const scopedAdmin = 7100;
    db.addSubAdmin(scopedAdmin, 'scoped');
    db.applyRolePreset(scopedAdmin, 'admin');
    db.addAdminScope(scopedAdmin, 'folder', tree.subject, ownerId);

    await folders.adminFoldersCallbackHandler(callbackCtx(bot, scopedAdmin, 'admin_folders'));

    assert.ok(
      !lastButtons(bot).includes('admin_folder_create'),
      'a scoped admin cannot create a platform-wide top-level section',
    );
  });
});

describe('section detail screen', () => {
  it('lists the real actions and walks into child sections', async () => {
    const bot = new FakeBot();
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, `admin_folder:${tree.year}`),
    );

    const buttons = lastButtons(bot);
    for (const expected of [
      `admin_folder_create:${tree.year}`,
      `admin_upload:${tree.year}`,
      `admin_folder_rename:${tree.year}`,
      `admin_folder_retype_existing:${tree.year}`,
      `admin_folder_toggle:${tree.year}`,
      `admin_folder_move:${tree.year}`,
      `admin_folder_delete:${tree.year}`,
    ]) {
      assert.ok(buttons.includes(expected), `detail screen offers ${expected}`);
    }

    assert.ok(
      buttons.includes(`admin_folder:${tree.subject}`),
      'a child section is reachable without leaving the panel',
    );
  });

  it('offers the parent link at a child and the menu link at the root', async () => {
    const childBot = new FakeBot();
    await folders.adminFoldersCallbackHandler(
      callbackCtx(childBot, ownerId, `admin_folder:${tree.subject}`),
    );
    assert.ok(lastButtons(childBot).includes(`admin_folder:${tree.year}`));

    const rootBot = new FakeBot();
    await folders.adminFoldersCallbackHandler(
      callbackCtx(rootBot, ownerId, `admin_folder:${tree.year}`),
    );
    assert.ok(lastButtons(rootBot).includes('admin_folders'));
  });
});

describe('section creation flow', () => {
  it('collects parent, name, type and accepts before creating', async () => {
    const bot = new FakeBot();
    const userData = {};

    // 1. Choose the parent from the tree picker.
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, `admin_folder_select_parent:${tree.year}`, userData),
    );
    assert.match(lastEdit(bot), /اسم القسم الجديد/);
    assert.equal(userData.admin_folder_parent, tree.year);

    // 2. Type the name; the type menu follows.
    await folders.handleFolderCreateText(messageCtx(bot, ownerId, 'Cardiology', userData));
    assert.match(lastReply(bot), /اختر نوع القسم/);
    assert.equal(userData.admin_folder_name, 'Cardiology');

    const typeButtons = replyButtons(bot);
    for (const value of ['general', 'books', 'audio', 'video', 'mcq', 'summaries']) {
      assert.ok(
        typeButtons.includes(`admin_folder_type:${value}`),
        `the type menu offers ${value}`,
      );
    }

    // 3. Pick a non-default type; the accepts prompt follows.
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_type:books', userData),
    );
    assert.match(lastEdit(bot), /هل يسمح هذا القسم باستقبال مساهمات/);
    assert.equal(userData.admin_folder_type, 'books');

    // 4. Accept contributions and create.
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_accepts:1', userData),
    );

    const created = db.getFolders(tree.year).find(([, name]) => name === 'Cardiology');
    assert.ok(created, 'the section exists under the chosen parent');
    assert.equal(created[2], 'books', 'the chosen type survived, not a default');
    assert.equal(created[3], 1, 'the contribution choice survived');
    assert.match(lastEdit(bot), /تم إنشاء القسم بنجاح/);

    // The workflow releases its state so a later message is not consumed.
    assert.equal(userData.admin_folder_create, undefined);
  });

  it('creates a section that does NOT accept contributions when told so', async () => {
    const bot = new FakeBot();
    const userData = {};

    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, `admin_folder_select_parent:${tree.year}`, userData),
    );
    await folders.handleFolderCreateText(messageCtx(bot, ownerId, 'Read Only', userData));
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_type:general', userData),
    );
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_accepts:0', userData),
    );

    const created = db.getFolders(tree.year).find(([, name]) => name === 'Read Only');
    assert.ok(created, 'the section exists');
    assert.equal(created[3], 0, 'the section does not accept contributions');
  });

  it('lets the admin go back and change the type before creating', async () => {
    const bot = new FakeBot();
    const userData = {};

    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, `admin_folder_select_parent:${tree.year}`, userData),
    );
    await folders.handleFolderCreateText(messageCtx(bot, ownerId, 'Retyped', userData));
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_type:video', userData),
    );
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_retype', userData),
    );
    assert.match(lastEdit(bot), /اختر نوع القسم/, 'the type menu is reachable again');

    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_type:audio', userData),
    );
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_accepts:1', userData),
    );

    const created = db.getFolders(tree.year).find(([, name]) => name === 'Retyped');
    assert.equal(created[2], 'audio', 'the final choice wins');
  });

  it('rejects an unknown type instead of writing it', async () => {
    const bot = new FakeBot();
    const userData = {};

    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, `admin_folder_select_parent:${tree.year}`, userData),
    );
    await folders.handleFolderCreateText(messageCtx(bot, ownerId, 'BadType', userData));

    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_folder_type:not-a-type', userData),
    );

    assert.match(lastEdit(bot), /نوع قسم غير معروف/);
    assert.equal(userData.admin_folder_type, undefined, 'the bad value is not stored');
  });

  it('rejects an empty and an over-long name without leaving the flow', async () => {
    const bot = new FakeBot();
    const userData = {};

    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, `admin_folder_select_parent:${tree.year}`, userData),
    );

    await folders.handleFolderCreateText(messageCtx(bot, ownerId, '   ', userData));
    assert.match(lastReply(bot), /لا يمكن أن يكون فارغاً/);

    await folders.handleFolderCreateText(messageCtx(bot, ownerId, 'x'.repeat(101), userData));
    assert.match(lastReply(bot), /طويل جداً/);

    assert.equal(userData.admin_folder_name, undefined, 'no name was stored');
    assert.equal(userData.admin_folder_create, true, 'the flow is still armed');
  });

  it('refuses to create inside a section outside the admin scope', async () => {
    const bot = new FakeBot();
    const scopedAdmin = 7200;
    const other = db.addFolder(0, 'Third Year', 'general');
    db.addSubAdmin(scopedAdmin, 'scoped-create');
    db.applyRolePreset(scopedAdmin, 'admin');
    db.addAdminScope(scopedAdmin, 'folder', tree.subject, ownerId);

    const userData = {};
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, scopedAdmin, `admin_folder_select_parent:${other}`, userData),
    );
    assert.match(lastEdit(bot), /خارج نطاق مسؤوليتك/);
    assert.equal(userData.admin_folder_create, undefined, 'the flow never armed');
  });

  it('ignores a typed name when the workflow is not the active owner', async () => {
    const bot = new FakeBot();
    const userData = { admin_folder_create: true, admin_folder_parent: tree.year };
    workflow.begin({ userData }, 'ai_chat');

    const handled = await folders.handleFolderCreateText(
      messageCtx(bot, ownerId, 'Should Not Land', userData),
    );

    assert.equal(handled, false, 'a stale create flag does not swallow the message');
    assert.equal(userData.admin_folder_name, undefined);
  });
});

describe('section move scope gate', () => {
  it('refuses a destination outside the admin scope', async () => {
    const bot = new FakeBot();
    const scopedAdmin = 7300;
    const outside = db.addFolder(0, 'Fourth Year', 'general');
    db.addSubAdmin(scopedAdmin, 'scoped-move');
    db.applyRolePreset(scopedAdmin, 'admin');
    db.addAdminScope(scopedAdmin, 'folder', tree.subject, ownerId);

    await folders.moveFolder(
      callbackCtx(bot, scopedAdmin, `admin_folder_move_to:${tree.subject}:${outside}`),
      tree.subject,
      outside,
    );

    assert.match(lastEdit(bot), /خارج نطاق مسؤوليتك/);
    assert.equal(db.getParentId(tree.subject), tree.year, 'the move did not happen');
  });

  it('allows a move that stays inside the admin scope', async () => {
    const bot = new FakeBot();
    const scopedAdmin = 7301;
    const branch = db.addFolder(tree.year, 'Branch', 'general');
    db.addSubAdmin(scopedAdmin, 'scoped-move-ok');
    db.applyRolePreset(scopedAdmin, 'admin');
    db.addAdminScope(scopedAdmin, 'folder', tree.year, ownerId);

    await folders.moveFolder(
      callbackCtx(bot, scopedAdmin, `admin_folder_move_to:${branch}:${tree.subject}`),
      branch,
      tree.subject,
    );

    assert.match(lastEdit(bot), /تم نقل القسم بنجاح/);
    assert.equal(db.getParentId(branch), tree.subject);
  });

  it('hides the root destination from a scoped admin but shows it to the owner', async () => {
    const scopedAdmin = 7302;
    db.addSubAdmin(scopedAdmin, 'scoped-root');
    db.applyRolePreset(scopedAdmin, 'admin');
    db.addAdminScope(scopedAdmin, 'folder', tree.year, ownerId);

    const scopedBot = new FakeBot();
    await folders.showMovePicker(
      callbackCtx(scopedBot, scopedAdmin, `admin_folder_move:${tree.subject}`),
      tree.subject,
    );
    assert.ok(
      !lastButtons(scopedBot).includes(`admin_folder_move_to:${tree.subject}:0`),
      'a scoped admin cannot relocate a branch out of scope to the root',
    );

    const ownerBot = new FakeBot();
    await folders.showMovePicker(
      callbackCtx(ownerBot, ownerId, `admin_folder_move:${tree.subject}`),
      tree.subject,
    );
    assert.ok(
      lastButtons(ownerBot).includes(`admin_folder_move_to:${tree.subject}:0`),
      'the owner keeps the root destination',
    );
  });

  it('never offers the moved section itself or one of its descendants', async () => {
    const bot = new FakeBot();
    const parent = db.addFolder(0, 'Cycle Root', 'general');
    const child = db.addFolder(parent, 'Cycle Child', 'general');

    await folders.showMovePicker(
      callbackCtx(bot, ownerId, `admin_folder_move:${parent}`),
      parent,
    );

    const buttons = lastButtons(bot);
    assert.ok(
      !buttons.includes(`admin_folder_move_to:${parent}:${parent}`),
      'the section itself is not a destination',
    );
    assert.ok(
      !buttons.includes(`admin_folder_move_to:${parent}:${child}`),
      'a descendant is not a destination',
    );
  });
});

describe('admin resource upload preview', () => {
  /** Arm the upload state for a folder, as `armUpload` leaves it. */
  function armedState(folderId) {
    return {
      [workflow.ACTIVE_KEY]: 'admin_upload',
      admin_upload: true,
      admin_upload_folder: folderId,
      admin_upload_state: 'await_file',
    };
  }

  const documentMessage = {
    document: { file_id: 'doc-file-1', file_name: 'Anatomy Notes.pdf' },
  };

  it('offers the suggested title with confirm, custom and cancel choices', async () => {
    const bot = new FakeBot();
    const userData = armedState(tree.subject);

    const handled = await folders.handleUploadMedia(
      mediaCtx(bot, ownerId, documentMessage, userData),
    );

    assert.equal(handled, true, 'the media message is consumed');
    const text = lastReply(bot);
    assert.match(text, /العنوان المقترح/, 'the suggested title is shown');
    assert.match(text, /Anatomy Notes\.pdf/, 'the suggested title comes from the file name');

    assert.deepEqual(replyButtons(bot), [
      'admin_upload_confirm',
      'admin_upload_custom_title',
      `admin_folder:${tree.subject}`,
    ]);
  });

  it('registers the resource under the suggested title on confirm', async () => {
    const bot = new FakeBot();
    const userData = armedState(tree.subject);

    await folders.handleUploadMedia(mediaCtx(bot, ownerId, documentMessage, userData));
    await folders.adminFoldersCallbackHandler(callbackCtx(bot, ownerId, 'admin_upload_confirm', userData));

    const rows = db.getFiles(tree.subject);
    const added = rows.find((row) => row[1] === 'Anatomy Notes.pdf');
    assert.ok(added, 'the resource is stored under the suggested title');
    assert.equal(added[2], 'doc-file-1', 'the Telegram file id is preserved');

    assert.match(lastEdit(bot), /تم إضافة المورد/, 'success is confirmed');
    assert.equal(userData.admin_upload_state, undefined, 'the workflow state is cleared');
  });

  it('registers a typed custom title instead of the suggestion', async () => {
    const bot = new FakeBot();
    const userData = armedState(tree.subject);
    const suggestedBefore = db
      .getFiles(tree.subject)
      .filter((row) => row[1] === 'Anatomy Notes.pdf').length;

    await folders.handleUploadMedia(mediaCtx(bot, ownerId, documentMessage, userData));
    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_upload_custom_title', userData),
    );
    assert.equal(userData.admin_upload_state, 'await_custom_title');

    const consumed = await folders.handleUploadCustomTitleText(
      messageCtx(bot, ownerId, 'تشريح - ملخص مخصص', userData),
    );

    assert.equal(consumed, true);
    const rows = db.getFiles(tree.subject);
    assert.ok(
      rows.some((row) => row[1] === 'تشريح - ملخص مخصص'),
      'the custom title is used',
    );
    assert.equal(
      rows.filter((row) => row[1] === 'Anatomy Notes.pdf').length,
      suggestedBefore,
      'the suggested title is not also stored',
    );
  });

  it('does not register anything for a stale confirmation session', async () => {
    const bot = new FakeBot();
    const userData = { [workflow.ACTIVE_KEY]: 'admin_upload' };
    const before = db.getFiles(tree.subject).length;

    await folders.adminFoldersCallbackHandler(
      callbackCtx(bot, ownerId, 'admin_upload_confirm', userData),
    );

    assert.match(lastEdit(bot), /انتهت جلسة الرفع/, 'the stale session is reported');
    assert.equal(
      db.getFiles(tree.subject).length,
      before,
      'no resource is created without an armed preview',
    );
  });

  it('refuses the upload when the target folder is outside the admin scope', async () => {
    const bot = new FakeBot();
    const scopedAdmin = 7200;
    const outside = db.addFolder(0, 'Outside Branch', 'general');
    db.addSubAdmin(scopedAdmin, 'scoped');
    db.applyRolePreset(scopedAdmin, 'admin');
    db.addAdminScope(scopedAdmin, 'folder', tree.year, ownerId);

    const userData = armedState(outside);
    const before = db.getFiles(outside).length;

    const handled = await folders.handleUploadMedia(
      mediaCtx(bot, scopedAdmin, documentMessage, userData),
    );

    assert.equal(handled, true, 'the out-of-scope upload is consumed and stopped');
    assert.match(lastReply(bot), /خارج نطاق مسؤوليتك/);
    assert.equal(
      db.getFiles(outside).length,
      before,
      'nothing is registered outside scope',
    );
  });

  it('refuses a forged confirmation for an out-of-scope folder', async () => {
    const bot = new FakeBot();
    const scopedAdmin = 7300;
    const outside = db.addFolder(0, 'Forged Target', 'general');
    db.addSubAdmin(scopedAdmin, 'scoped');
    db.applyRolePreset(scopedAdmin, 'admin');
    db.addAdminScope(scopedAdmin, 'folder', tree.year, ownerId);

    const userData = {
      [workflow.ACTIVE_KEY]: 'admin_upload',
      admin_upload_preview: {
        fileId: 'forged-file',
        fileType: 'document',
        folderId: outside,
        title: 'forged',
      },
    };
    const before = db.getFiles(outside).length;

    await folders.confirmUpload(callbackCtx(bot, scopedAdmin, 'admin_upload_confirm', userData));

    assert.match(lastEdit(bot), /خارج نطاق مسؤوليتك/);
    assert.equal(db.getFiles(outside).length, before);
  });
});
