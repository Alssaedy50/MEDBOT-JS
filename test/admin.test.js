/**
 * Admin surface tests: the roster, role/permission editing, ownership transfer,
 * and — the piece the migration brief calls out explicitly — the SINGLE
 * hierarchical scope picker.
 *
 * The scope picker's contract:
 *   Add Scope -> the root of the real MEDBOT hierarchy -> navigate downward ->
 *   every selectable node carries its own selection button.
 * It must NOT first ask "Section / Topic / Resource".
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import {
  callbackCtx,
  cleanupDb,
  FakeBot,
  freshDb,
  lastButtons,
  lastEdit,
  lastMarkup,
} from './helpers/harness.js';

let dbPath;
let adminMgmt;
let ownerId;
let tree;

before(async () => {
  dbPath = freshDb('admin');
  adminMgmt = await import('../src/ui/adminManagement.js');

  ownerId = 1;
  db.registerUser(ownerId, 'owner', 'Owner');
  // The configured-admin bootstrap is the real path that mints the owner.
  db.ensureConfiguredAdmin(ownerId, 'owner');

  // A real three-level tree plus a resource at the leaf.
  const year = db.addFolder(0, 'Second Year', 'general');
  const subject = db.addFolder(year, 'Physiology', 'general');
  const lecture = db.addFolder(subject, 'Cardiac', 'general');
  const resource = db.addContent(lecture, 'Cardiac Cycle Notes', 'f-cardiac', 'pdf');
  tree = { year, subject, lecture, resource };
});

after(() => {
  cleanupDb(dbPath);
});

describe('admin roster', () => {
  it('rejects a non-admin at the door', async () => {
    const bot = new FakeBot();
    const stranger = 4001;
    db.registerUser(stranger, 'stranger', 'Stranger');

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, stranger, 'admin_admins'),
    );
    assert.match(lastEdit(bot), /غير مصرح|🔒/);
  });

  it('never mints a second owner and lists real admins only', async () => {
    const bot = new FakeBot();
    const adminId = 4002;
    db.addSubAdmin(adminId, 'helper');

    await adminMgmt.adminManagementCallbackHandler(callbackCtx(bot, ownerId, 'admin_admins'));

    const text = lastEdit(bot);
    assert.match(text, /Owner|helper/);
    assert.equal(db.getOwnerIds().length, 1);
  });
});

describe('role and permission editing', () => {
  it('applies a role preset and shows the resulting capabilities', async () => {
    const bot = new FakeBot();
    const adminId = 4010;
    db.addSubAdmin(adminId, 'role-target');

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `admin_setrole:${adminId}:reviewer`),
    );

    const record = db.getAdminRecord(adminId);
    assert.equal(record.role, 'reviewer');
    assert.equal(db.userHasPermission(adminId, 'can_contributions'), true);
    assert.equal(db.userHasPermission(adminId, 'can_admins'), false);
  });

  it('toggles one capability without disturbing the others', async () => {
    const bot = new FakeBot();
    const adminId = 4011;
    db.addSubAdmin(adminId, 'perm-target');
    db.applyRolePreset(adminId, 'reviewer');

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `admin_perm:${adminId}:can_notifications`),
    );
    assert.equal(db.userHasPermission(adminId, 'can_notifications'), true);
    assert.equal(db.userHasPermission(adminId, 'can_contributions'), true);

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `admin_perm:${adminId}:can_notifications`),
    );
    assert.equal(db.userHasPermission(adminId, 'can_notifications'), false);
  });

  it('refuses to demote the only owner', async () => {
    const bot = new FakeBot();
    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `admin_setrole:${ownerId}:admin`),
    );
    assert.equal(db.getAdminRecord(ownerId).role, 'owner');
  });

  it('transfers ownership atomically, leaving exactly one owner', async () => {
    const bot = new FakeBot();
    const heir = 4012;
    db.addSubAdmin(heir, 'heir');

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `admin_transfer_do:${heir}`),
    );

    assert.equal(db.getAdminRecord(heir).role, 'owner');
    assert.equal(db.getOwnerIds().length, 1);
    assert.equal(db.getOwnerIds()[0], heir);

    // Hand ownership back (as the new owner) so later suites keep a stable
    // owner. The transfer must be performed by the current owner.
    const [ok] = db.transferOwnership(heir, ownerId);
    assert.equal(ok, true);
    assert.deepEqual(db.getOwnerIds(), [ownerId]);
  });
});

describe('scoped RBAC — the single hierarchical scope picker', () => {
  it('opens at the real hierarchy root without asking for a scope type first', async () => {
    const bot = new FakeBot();
    const adminId = 4020;
    db.addSubAdmin(adminId, 'scoped');

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_add:${adminId}`),
    );

    const text = lastEdit(bot);
    assert.match(text, /إضافة نطاق/);
    // It never pre-asks the scope type; the tree itself is the entry point.
    assert.doesNotMatch(text, /اختر نوع النطاق|نوع النطاق:/i);

    // Real registry nodes are offered with a selection button each.
    const buttons = lastButtons(bot);
    assert.ok(
      buttons.includes(`scope_set:${adminId}:folder:${tree.year}`),
      'the root section must be selectable as a whole',
    );
    assert.ok(
      buttons.includes(`scope_browse:${adminId}:${tree.year}`),
      'the root section must be drillable',
    );
  });

  it('navigates downward and offers folder, child and resource selections', async () => {
    const bot = new FakeBot();
    const adminId = 4021;
    db.addSubAdmin(adminId, 'scoped-navigator');

    // One level down from the subject: the child section is selectable as a whole.
    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_browse:${adminId}:${tree.subject}`),
    );
    assert.ok(
      lastButtons(bot).includes(`scope_set:${adminId}:folder:${tree.lecture}`),
      'a child section must be selectable as a whole section',
    );

    // A further level down: the specific resource is selectable in its own right.
    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_browse:${adminId}:${tree.lecture}`),
    );
    assert.ok(
      lastButtons(bot).includes(`scope_set:${adminId}:resource:${tree.resource}`),
      'a specific resource must be selectable at its level',
    );

    // The resource is offered under its real registry title, and the breadcrumb
    // confirms the picker stayed inside the browsed branch.
    const labels = lastMarkup(bot).inline_keyboard.flat().map((b) => b.text);
    assert.ok(
      labels.some((label) => label.includes('Cardiac Cycle Notes')),
      'the resource must be offered under its real title',
    );
    assert.match(lastEdit(bot), /Cardiac/);
  });

  it('grants a whole parent section, covering its subtree', async () => {
    const bot = new FakeBot();
    const adminId = 4022;
    db.addSubAdmin(adminId, 'parent-grant');

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_set:${adminId}:folder:${tree.subject}`),
    );

    const scopes = db.getAdminScopes(adminId);
    assert.ok(scopes.some((s) => s.scope_type === 'folder' && s.scope_id === tree.subject));

    // The scope covers the subtree...
    assert.equal(db.folderInAdminScope(adminId, tree.lecture), true);
    assert.equal(db.resourceInAdminScope(adminId, tree.resource), true);
    // ...but not a sibling branch.
    const other = db.addFolder(0, 'Third Year', 'general');
    assert.equal(db.folderInAdminScope(adminId, other), false);
  });

  it('grants a single child section and a single resource independently', async () => {
    const bot = new FakeBot();
    const adminId = 4023;
    db.addSubAdmin(adminId, 'leaf-grant');

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_set:${adminId}:folder:${tree.lecture}`),
    );
    // Stay in the picker so a second scope can be added immediately.
    assert.match(lastEdit(bot), /إضافة نطاق/);

    const before = db.getAdminScopes(adminId).length;
    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_set:${adminId}:resource:${tree.resource}`),
    );
    const after = db.getAdminScopes(adminId);

    assert.equal(after.length, before + 1, 'multiple scopes can be assigned to one admin');
    assert.ok(after.some((s) => s.scope_type === 'resource' && s.scope_id === tree.resource));
    assert.ok(after.some((s) => s.scope_type === 'folder' && s.scope_id === tree.lecture));
  });

  it('marks already-granted nodes and lists them in the manager', async () => {
    const bot = new FakeBot();
    const adminId = 4024;
    db.addSubAdmin(adminId, 'marked-grant');
    db.addAdminScope(adminId, 'folder', tree.subject, ownerId);

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_menu:${adminId}`),
    );
    // The scope manager resolves the granted id to its real registry name.
    assert.match(lastEdit(bot), /Physiology/);

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_add:${adminId}`),
    );
    const rootRow = lastButtons(bot).filter((data) => data === `scope_set:${adminId}:folder:${tree.year}`);
    assert.equal(rootRow.length, 1);
  });

  it('rejects a scope for an id that is not in the registry', async () => {
    const adminId = 4025;
    db.addSubAdmin(adminId, 'bogus-grant');

    assert.equal(db.addAdminScope(adminId, 'folder', 999999, ownerId), false);
    assert.equal(db.addAdminScope(adminId, 'resource', 999999, ownerId), false);
    assert.deepEqual(db.getAdminScopes(adminId), []);
  });

  it('removes a scope cleanly', async () => {
    const bot = new FakeBot();
    const adminId = 4026;
    db.addSubAdmin(adminId, 'removable');
    db.addAdminScope(adminId, 'folder', tree.subject, ownerId);

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, ownerId, `scope_del:${adminId}:folder:${tree.subject}`),
    );
    assert.deepEqual(db.getAdminScopes(adminId), []);
  });

  it('refuses scope management to a non-owner manager', async () => {
    const bot = new FakeBot();
    const plainAdmin = 4027;
    db.addSubAdmin(plainAdmin, 'plain-admin');
    db.applyRolePreset(plainAdmin, 'admin');
    assert.equal(db.userHasPermission(plainAdmin, 'can_admins'), false);

    await adminMgmt.adminManagementCallbackHandler(
      callbackCtx(bot, plainAdmin, `scope_add:${plainAdmin}`),
    );
    assert.match(lastEdit(bot), /غير مصرح/);
  });
});
