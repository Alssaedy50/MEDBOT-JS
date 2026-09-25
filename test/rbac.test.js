/**
 * RBAC and Scoped RBAC tests.
 *
 * The scope layer is security-relevant, so these tests assert the *denials* as
 * carefully as the grants: deny-by-default, fail-closed on a deleted target, and
 * the opt-in nature of scoping.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as authorization from '../src/authorization.js';
import { cleanupDb, freshDb } from './helpers/harness.js';

let dbPath;
let registry;
let ownerId;
let adminId;
let scopedAdminId;

describe('RBAC: roles and capabilities', () => {
  before(() => {
    dbPath = freshDb('rbac');
    ownerId = 8001;
    adminId = 8002;
    scopedAdminId = 8003;

    db.addFolder(0, 'Second Year', 'general');
    registry = {
      yearId: db.addFolder(0, 'First Year', 'general'),
    };
    registry.subjectId = db.addFolder(registry.yearId, 'Anatomy', 'general');
    registry.sectionId = db.addFolder(registry.subjectId, 'Practical', 'general');
    registry.otherId = db.addFolder(0, 'Other Year', 'general');
    registry.resourceId = db.addContent(
      registry.sectionId,
      'Anatomy lecture',
      'file-1',
      'document',
    );
    registry.otherResourceId = db.addContent(registry.otherId, 'Other', 'file-2', 'document');
  });

  after(() => {
    cleanupDb(dbPath);
  });

  it('grants the configured owner full authority', () => {
    db.ensureConfiguredAdmin(ownerId, 'owner');
    assert.equal(db.isOwner(ownerId), true);
    for (const key of db.PERMISSION_KEYS) {
      assert.equal(db.userHasPermission(ownerId, key), true, `owner must hold ${key}`);
    }
  });

  it('never mints a second owner', () => {
    db.ensureConfiguredAdmin(ownerId, 'owner');
    db.ensureConfiguredAdmin(ownerId, 'owner');

    const owners = db.withDb((conn) =>
      conn.prepare("SELECT COUNT(*) FROM admins WHERE role = 'owner'").get(),
    );
    assert.equal(owners[0], 1);
  });

  it('refuses to demote the only owner', () => {
    const ok = db.setAdminRole(ownerId, 'admin');
    assert.equal(ok, false, 'the singleton owner must not be demotable');
    assert.equal(db.isOwner(ownerId), true);
  });

  it('grants an admin every capability except can_admins', () => {
    db.addSubAdmin(adminId, 'admin');
    db.applyRolePreset(adminId, 'admin');

    assert.equal(db.userHasPermission(adminId, 'can_folders'), true);
    assert.equal(db.userHasPermission(adminId, 'can_admins'), false);
    assert.equal(db.isOwner(adminId), false);
  });

  it('restricts a reviewer to contributions and messages', () => {
    const reviewerId = 8004;
    db.addSubAdmin(reviewerId, 'reviewer');
    db.applyRolePreset(reviewerId, 'reviewer');

    assert.equal(db.userHasPermission(reviewerId, 'can_contributions'), true);
    assert.equal(db.userHasPermission(reviewerId, 'can_messages'), true);
    assert.equal(db.userHasPermission(reviewerId, 'can_admins'), false);
    assert.equal(db.userHasPermission(reviewerId, 'can_folders'), false);
  });

  it('revokes access while keeping the admin row', () => {
    const revokedId = 8005;
    db.addSubAdmin(revokedId, 'revoked');
    db.applyRolePreset(revokedId, 'admin');

    assert.equal(db.removeSubAdmin(revokedId), true);
    assert.equal(db.isUserAdmin(revokedId), false);
    assert.equal(db.adminAccessDenied(revokedId), true);

    // The identity row survives so the username is not lost.
    assert.notEqual(db.getAdminRecord(revokedId), null);
  });

  it('denies an unknown operation outright', () => {
    assert.equal(db.userHasPermission(adminId, 'can_teleport'), false);
    // An unknown scoped operation is denied even for a fully-capable admin.
    assert.equal(
      authorization.can(adminId, 'resource.teleport', 'resource', registry.resourceId),
      false,
    );
    // A known one is allowed for an unscoped admin holding the capability.
    assert.equal(
      authorization.can(adminId, 'resource.view', 'resource', registry.resourceId),
      true,
    );
  });

  it('returns the decision codes for a missing capability', async () => {
    const reviewerId = 8007;
    db.addSubAdmin(reviewerId, 'plain-reviewer');
    db.applyRolePreset(reviewerId, 'reviewer');

    // The reviewer holds can_contributions but not can_notifications.
    const denied = await authorization.require(reviewerId, 'notification.send');
    assert.equal(denied, authorization.DECISION_NO_PERMISSION);

    const allowed = await authorization.require(reviewerId, 'contribution.review');
    assert.equal(allowed, authorization.DECISION_ALLOW);

    // A non-admin is reported as such, not as a missing capability.
    const stranger = await authorization.require(999999, 'resource.view');
    assert.equal(stranger, authorization.DECISION_NOT_ADMIN);
  });

  it('transfers ownership atomically', () => {
    const newOwnerId = 8006;
    db.addSubAdmin(newOwnerId, 'heir');
    db.applyRolePreset(newOwnerId, 'admin');

    const [ok] = db.transferOwnership(ownerId, newOwnerId);
    assert.equal(ok, true);
    assert.equal(db.isOwner(newOwnerId), true);
    assert.equal(db.isOwner(ownerId), false);

    // Only the active owner may transfer.
    const [denied] = db.transferOwnership(ownerId, adminId);
    assert.equal(denied, false);

    // Restore the original owner for the remaining tests.
    const [restored] = db.transferOwnership(newOwnerId, ownerId);
    assert.equal(restored, true);
  });
});

describe('Scoped RBAC', () => {
  let scopes;

  before(() => {
    dbPath = freshDb('scopes');
    ownerId = 8100;
    scopedAdminId = 8101;
    db.ensureConfiguredAdmin(ownerId, 'owner');

    const year = db.addFolder(0, 'Scoped Year', 'general');
    const subject = db.addFolder(year, 'Scoped Subject', 'general');
    const section = db.addFolder(subject, 'Scoped Section', 'general');
    const otherYear = db.addFolder(0, 'Other Scoped Year', 'general');

    scopes = {
      year,
      subject,
      section,
      otherYear,
      resource: db.addContent(section, 'Scoped resource', 'file-s1', 'document'),
      otherResource: db.addContent(otherYear, 'Other resource', 'file-s2', 'document'),
    };

    db.addSubAdmin(scopedAdminId, 'scoped');
    db.applyRolePreset(scopedAdminId, 'admin');
  });

  after(() => {
    cleanupDb(dbPath);
  });

  it('is platform-wide before any scope is assigned (opt-in)', () => {
    assert.equal(db.adminHasScopes(scopedAdminId), false);
    assert.equal(authorization.isScopeRestricted(scopedAdminId), false);

    // With no scope rows, the coarse capability alone decides.
    assert.equal(
      authorization.can(scopedAdminId, 'resource.edit', 'resource', scopes.otherResource),
      true,
    );
  });

  it('grants a folder scope over its whole subtree only', () => {
    assert.equal(db.addAdminScope(scopedAdminId, 'folder', scopes.subject, ownerId), true);
    assert.equal(db.adminHasScopes(scopedAdminId), true);

    // Inside the subtree: allowed.
    assert.equal(
      authorization.can(scopedAdminId, 'resource.edit', 'resource', scopes.resource),
      true,
    );
    assert.equal(authorization.can(scopedAdminId, 'section.manage', 'folder', scopes.section), true);
    assert.equal(authorization.can(scopedAdminId, 'section.manage', 'folder', scopes.subject), true);

    // Outside: denied.
    assert.equal(
      authorization.can(scopedAdminId, 'resource.edit', 'resource', scopes.otherResource),
      false,
    );
    assert.equal(authorization.can(scopedAdminId, 'section.manage', 'folder', scopes.otherYear), false);
  });

  it('denies a destination outside the scope on write', () => {
    assert.equal(
      authorization.can(scopedAdminId, 'resource.create', 'folder', scopes.otherYear),
      false,
    );
    assert.equal(
      authorization.can(scopedAdminId, 'resource.create', 'folder', scopes.section),
      true,
    );
  });

  it('never lets a scoped admin broadcast globally', () => {
    // notification.send has no folder target, so a scope restriction denies it.
    assert.equal(authorization.can(scopedAdminId, 'notification.send'), false);
  });

  it('keeps the owner unrestricted', () => {
    assert.equal(authorization.isScopeRestricted(ownerId), false);
    assert.equal(
      authorization.can(ownerId, 'resource.edit', 'resource', scopes.otherResource),
      true,
    );
  });

  it('rejects a scope pointing at a non-existent target', () => {
    assert.equal(db.addAdminScope(scopedAdminId, 'folder', 999999, ownerId), false);
    assert.equal(db.addAdminScope(scopedAdminId, 'bogus', scopes.year, ownerId), false);
  });

  it('fails closed when the scoped target is deleted', () => {
    const admin = 8102;
    db.addSubAdmin(admin, 'deletable');
    db.applyRolePreset(admin, 'admin');

    const year = db.addFolder(0, 'Deletable Year', 'general');
    const contentId = db.addContent(year, 'Deletable resource', 'file-d1', 'document');

    assert.equal(db.addAdminScope(admin, 'resource', contentId, ownerId), true);
    assert.equal(authorization.can(admin, 'resource.edit', 'resource', contentId), true);

    // A direct resource scope whose target is later removed must deny.
    db.deleteFile(contentId);
    assert.equal(authorization.can(admin, 'resource.edit', 'resource', contentId), false);
  });

  it('resolves a topic scope onto its linked folders', () => {
    const admin = 8103;
    db.addSubAdmin(admin, 'topic-admin');
    db.applyRolePreset(admin, 'admin');

    const topicId = db.addTopic('Scoped topic');
    const subject = db.addFolder(0, 'Topic Subject', 'general');
    db.addFolder(subject, 'Topic Child', 'general');
    db.linkTopicFolder(topicId, subject);

    assert.equal(db.addAdminScope(admin, 'topic', topicId, ownerId), true);
    assert.equal(db.isTopicInAdminScope(admin, topicId), true);
    assert.equal(authorization.can(admin, 'section.manage', 'folder', subject), true);
  });

  it('can grant multiple scopes to the same admin', () => {
    const scopesList = db.getAdminScopes(scopedAdminId);
    assert.ok(scopesList.length >= 1);

    const extra = db.addFolder(0, 'Extra Scoped', 'general');
    assert.equal(db.addAdminScope(scopedAdminId, 'folder', extra, ownerId), true);

    const after = db.getAdminScopes(scopedAdminId);
    assert.equal(after.length, scopesList.length + 1);
    assert.equal(authorization.can(scopedAdminId, 'section.manage', 'folder', extra), true);
  });

  it('removes one scope and restores platform-wide access when cleared', () => {
    const admin = 8104;
    db.addSubAdmin(admin, 'clearable');
    db.applyRolePreset(admin, 'admin');

    const folder = db.addFolder(0, 'Clearable', 'general');
    db.addAdminScope(admin, 'folder', folder, ownerId);
    assert.equal(authorization.isScopeRestricted(admin), true);

    assert.equal(db.clearAdminScopes(admin), 1);
    assert.equal(authorization.isScopeRestricted(admin), false);

    // Platform-wide again.
    assert.equal(authorization.can(admin, 'section.manage', 'folder', scopes.otherYear), true);
  });

  it('lists only in-scope news for a restricted admin', () => {
    const admin = 8105;
    db.addSubAdmin(admin, 'news-admin');
    db.applyRolePreset(admin, 'admin');

    const section = db.addFolder(0, 'News Section', 'general');
    const otherSection = db.addFolder(0, 'Other News Section', 'general');

    const inScope = db.createNews({
      newsType: 'section',
      title: 'In scope',
      sectionFolderId: section,
      status: 'published',
    });
    const outOfScope = db.createNews({
      newsType: 'section',
      title: 'Out of scope',
      sectionFolderId: otherSection,
      status: 'published',
    });

    db.addAdminScope(admin, 'folder', section, ownerId);

    const ids = db.listNewsIdsForAdmin(admin);
    assert.ok(ids.has(inScope), 'in-scope news must be listed');
    assert.ok(!ids.has(outOfScope), 'out-of-scope news must not be listed');

    assert.equal(authorization.can(admin, 'news.edit', 'news', inScope), true);
    assert.equal(authorization.can(admin, 'news.edit', 'news', outOfScope), false);
  });

  it('audits a denial without throwing', async () => {
    const decision = await authorization.require(
      scopedAdminId,
      'resource.edit',
      'resource',
      scopes.otherResource,
    );
    assert.equal(decision, authorization.DECISION_OUT_OF_SCOPE);

    const entries = db.getAuditEntries(50, 'authz_denied');
    assert.ok(entries.some((row) => String(row[6] ?? '').includes('resource.edit')));
  });
});
