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
      `admin_folder_retype:${tree.year}`,
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
