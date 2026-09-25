/**
 * Database, schema and migration tests.
 *
 * These are the load-bearing tests: if the schema or a migration regresses,
 * every other subsystem fails in a confusing way, so they are asserted directly.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import { cleanupDb, freshDb } from './helpers/harness.js';

let dbPath;

describe('database schema and migrations', () => {
  before(() => {
    dbPath = freshDb('migrations');
  });

  after(() => {
    cleanupDb(dbPath);
  });

  it('creates every expected table', () => {
    const tables = new Set(db.listTables());
    for (const table of [
      'users',
      'folders',
      'content',
      'contributions',
      'about_us',
      'settings',
      'daily_ai_usage',
      'admins',
      'ai_registry',
      'ai_model_usage',
      'messages',
      'audit_log',
      'topics',
      'topic_folders',
      'notifications',
      'archive_sync',
      'news',
      'news_reads',
      'news_subscriptions',
      'news_deliveries',
      'admin_scopes',
    ]) {
      assert.ok(tables.has(table), `missing table: ${table}`);
    }
  });

  it('is idempotent across repeated initialisation', () => {
    const before = db.listTables().length;
    db.initDb();
    db.initDb();
    assert.equal(db.listTables().length, before);
  });

  it('adds every additive column', () => {
    const columns = (table) =>
      new Set(
        db
          .withDb((conn) => conn.prepare(`PRAGMA table_info(${table})`).all())
          .map((row) => row[1]),
      );

    const contentCols = columns('content');
    assert.ok(contentCols.has('source_type'));
    assert.ok(contentCols.has('source_contribution_id'));
    assert.ok(contentCols.has('created_by'));
    assert.ok(contentCols.has('description'));
    assert.ok(contentCols.has('keywords'));

    const adminCols = columns('admins');
    assert.ok(adminCols.has('role'));
    assert.ok(adminCols.has('permissions'));

    const contributionCols = columns('contributions');
    assert.ok(contributionCols.has('reviewed_by'));
    assert.ok(contributionCols.has('reviewed_at'));
    assert.ok(contributionCols.has('review_note'));
    assert.ok(contributionCols.has('rejection_reason'));
    assert.ok(contributionCols.has('resubmitted_count'));

    const userCols = columns('users');
    assert.ok(userCols.has('language'));
  });

  it('migration v17 folds the legacy resource kind into section', () => {
    // A row written under the old model, then re-migrated.
    db.withDb((conn) => {
      conn
        .prepare(
          `INSERT INTO folders (id, parent_id, name, node_type) VALUES (900, NULL, 'Legacy', 'general')`,
        )
        .run();
      conn
        .prepare(
          `INSERT INTO news (id, news_type, title, section_folder_id, status, source, published_at)
           VALUES (900, 'resource', 'Legacy news', 900, 'published', 'manual', CURRENT_TIMESTAMP)`,
        )
        .run();
      conn
        .prepare(
          `INSERT INTO news_subscriptions (user_id, topic_kind, topic_value) VALUES (1, 'type', 'resource')`,
        )
        .run();
    });

    // Re-run the migration chain (idempotent + the v17 rewrite).
    db.initDb();

    const row = db.withDb((conn) =>
      conn.prepare('SELECT news_type FROM news WHERE id = 900').get(),
    );
    assert.equal(row[0], 'section', 'legacy resource news must become section');

    const subs = db.withDb((conn) =>
      conn.prepare('SELECT topic_value FROM news_subscriptions WHERE user_id = 1').all(),
    );
    const values = subs.map((r) => r[0]);
    assert.ok(!values.includes('resource'), 'the legacy resource subscription must be gone');
    assert.ok(values.includes('section'), 'it must be folded into the section subscription');
  });

  it('enforces the partial unique index on auto resource news', () => {
    db.addFolder(0, 'Index test', 'general');
    const folderId = db.withDb((conn) => conn.prepare('SELECT MAX(id) FROM folders').get())[0];
    const contentId = db.addContent(folderId, 'R', 'file-x', 'document');

    const first = db.createResourceNewsForContent(contentId, null, 'draft');
    const second = db.createResourceNewsForContent(contentId, null, 'draft');
    assert.equal(first, second, 'auto resource news must be created only once');

    // Two *manual* section news rows may share a null resource_id freely.
    const manualA = db.createNews({ newsType: 'section', title: 'A', sectionFolderId: folderId });
    const manualB = db.createNews({ newsType: 'section', title: 'B', sectionFolderId: folderId });
    assert.notEqual(manualA, manualB);
  });

  it('heals a database left with more than one owner', () => {
    // Two owners persisted directly (bypassing the singleton helper).
    db.withDb((conn) => {
      conn
        .prepare(
          `INSERT OR REPLACE INTO admins (telegram_id, username, role, permissions) VALUES (7001, 'o1', 'owner', '')`,
        )
        .run();
      conn
        .prepare(
          `INSERT OR REPLACE INTO admins (telegram_id, username, role, permissions) VALUES (7002, 'o2', 'owner', '')`,
        )
        .run();
      conn
        .prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('owner_id', '7002')`)
        .run();
    });

    db.initDb();

    const owners = db.withDb((conn) =>
      conn.prepare("SELECT telegram_id FROM admins WHERE role = 'owner' ORDER BY telegram_id").all(),
    );
    assert.equal(owners.length, 1, 'exactly one owner must survive');
    assert.equal(owners[0][0], 7002, 'the persisted owner id must be kept');
  });
});

describe('registry accessors', () => {
  before(() => {
    dbPath = freshDb('registry');
  });

  after(() => {
    cleanupDb(dbPath);
  });

  it('stores roots with a NULL parent and browses children', () => {
    const root = db.addFolder(0, 'Year', 'general');
    const child = db.addFolder(root, 'Subject', 'general');

    const roots = db.getFolders(0);
    assert.equal(roots.length, 1);
    assert.equal(roots[0][0], root);

    const children = db.getFolders(root);
    assert.equal(children.length, 1);
    assert.equal(children[0][0], child);
  });

  it('builds the canonical breadcrumb path', () => {
    const root = db.addFolder(0, 'السنة الثانية', 'general');
    const subject = db.addFolder(root, 'الفسيولوجيا', 'general');
    const section = db.addFolder(subject, 'عملي', 'general');

    const path = db.getBreadcrumbs(section);
    assert.equal(path, 'الرئيسية 🏠 ⬅️ السنة الثانية ⬅️ الفسيولوجيا ⬅️ عملي');
  });

  it('refuses to delete a non-empty folder', () => {
    const root = db.addFolder(0, 'NonEmpty', 'general');
    db.addFolder(root, 'Child', 'general');
    assert.equal(db.deleteFolder(root), false);

    const empty = db.addFolder(0, 'Empty', 'general');
    assert.equal(db.deleteFolder(empty), true);
  });

  it('refuses to move a folder into its own descendant', () => {
    const root = db.addFolder(0, 'MoveRoot', 'general');
    const child = db.addFolder(root, 'MoveChild', 'general');

    const [ok, message] = db.moveFolder(root, child);
    assert.equal(ok, false);
    assert.match(message, /تفرعاته/);

    // Moving to the root is legitimate (the Python reference allows it).
    const [okRoot] = db.moveFolder(child, 0);
    assert.equal(okRoot, true);

    // Moving a folder into itself is refused.
    const [okSelf, selfMessage] = db.moveFolder(child, child);
    assert.equal(okSelf, false);
    assert.match(selfMessage, /نفسه/);
  });

  it('finds contribution targets through descendants', () => {
    const root = db.addFolder(0, 'ContribRoot', 'general', 0);
    const mid = db.addFolder(root, 'Mid', 'general', 0);
    const leaf = db.addFolder(mid, 'Leaf', 'general', 1);

    assert.equal(db.folderHasContributionTarget(root), true);
    assert.equal(db.folderAcceptsContributions(leaf), true);

    const dead = db.addFolder(0, 'Dead', 'general', 0);
    assert.equal(db.folderHasContributionTarget(dead), false);
  });

  it('searches by title, folder name and ancestor path', () => {
    const root = db.addFolder(0, 'SearchYear', 'general');
    const subject = db.addFolder(root, 'SearchSubject', 'general');
    db.addContent(subject, 'UniqueResourceTitle', 'file-s1', 'document');

    const byTitle = db.searchContent('UniqueResourceTitle');
    assert.equal(byTitle.length, 1);

    const byFolder = db.searchContent('SearchSubject');
    assert.equal(byFolder.length, 1);

    const byPath = db.searchContent('SearchYear');
    assert.ok(byPath.length >= 1, 'an ancestor folder name must match');

    assert.equal(db.searchContent('   ').length, 0);
  });

  it('returns a resource snapshot with its real path', () => {
    const root = db.addFolder(0, 'SnapYear', 'general');
    const section = db.addFolder(root, 'SnapSection', 'general');
    const contentId = db.addContent(section, 'SnapTitle', 'file-snap', 'document');

    const snapshot = db.getResourceSnapshot(contentId);
    assert.equal(snapshot[0], contentId);
    assert.equal(snapshot[2], 'SnapTitle');
    assert.match(snapshot[5], /SnapYear/);
    assert.match(snapshot[5], /SnapSection/);

    assert.equal(db.getResourceSnapshot(999999), null);
  });
});
