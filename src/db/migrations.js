/**
 * MEDBOT schema and additive migrations (v1 … v17).
 *
 * This is a faithful port of the Python MEDBOT `database.py` schema: the core
 * tables are created first, then every migration runs in order. Each migration
 * is additive and idempotent — it uses `CREATE TABLE/INDEX IF NOT EXISTS` or
 * tolerates a duplicate-column error — so re-running `initDb()` on an existing
 * database never rewrites or drops data.
 *
 * Migration history (never rewrite v1..v4):
 *   v1  content.source_type / source_contribution_id / created_by
 *   v2  ai_registry diagnostics columns
 *   v3  contribution review workflow metadata
 *   v4  `messages` (Contact Admin)
 *   v5  admins.role / admins.permissions (RBAC)
 *   v6  `audit_log` (isolated)
 *   v7  normalise NULL/empty admin roles to 'admin'
 *   v8  folders/content description + keywords (intent-aware search)
 *   v9  `topics` / `topic_folders` (Search Topics)
 *   v10 `notifications` + users.language
 *   v11 heal a database left with more than one owner row
 *   v12 `archive_sync` (Emergency Resource Archive mirror)
 *   v13 `news` / `news_reads` / `news_subscriptions` (News Core)
 *   v14 `news_deliveries` (private delivery tracking)
 *   v15 partial unique index for auto resource news (DB-level idempotency)
 *   v16 `admin_scopes` (Scoped RBAC)
 *   v17 fold the legacy `resource` news kind into `section`
 */

import { exec, get, run, withDb } from './core.js';
import {
  NEWS_SOURCE_AUTO,
  SETTING_OWNER_ID,
  permissionsToString,
  ROLE_PERMISSION_PRESETS,
} from '../constants.js';

// ---------------------------------------------------------------------------
// Core schema
// ---------------------------------------------------------------------------
const CORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    full_name TEXT,
    joined_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    name TEXT NOT NULL,
    node_type TEXT DEFAULT 'general',
    accepts_contributions INTEGER DEFAULT 0,
    FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_type TEXT DEFAULT 'doc',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    source_type TEXT DEFAULT 'direct',
    source_contribution_id INTEGER DEFAULT NULL,
    created_by INTEGER DEFAULT NULL,
    FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    folder_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_type TEXT DEFAULT 'doc',
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS about_us (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_ai_usage (
    user_id INTEGER,
    usage_date TEXT,
    request_count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, usage_date)
  );

  CREATE TABLE IF NOT EXISTS admins (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    availability TEXT,
    auth_status TEXT,
    latency_ms REAL,
    success_rate REAL,
    capabilities TEXT,
    last_success TIMESTAMP,
    last_failure TIMESTAMP,
    last_test TIMESTAMP,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS ai_model_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registry_id INTEGER NOT NULL,
    user_id INTEGER,
    latency_ms REAL,
    success INTEGER NOT NULL DEFAULT 0,
    error_category TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (registry_id) REFERENCES ai_registry(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ai_usage_registry ON ai_model_usage(registry_id);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_model_usage(user_id);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_model_usage(created_at);
`;

// ---------------------------------------------------------------------------
// Performance / integrity indexes (created after the migrations)
// ---------------------------------------------------------------------------
const FINAL_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
  CREATE INDEX IF NOT EXISTS idx_content_folder ON content(folder_id);
  CREATE INDEX IF NOT EXISTS idx_contrib_status ON contributions(status);
  CREATE INDEX IF NOT EXISTS idx_registry_avail ON ai_registry(availability);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_registry_provider_model_endpoint
    ON ai_registry(provider, model, endpoint);
  CREATE INDEX IF NOT EXISTS idx_content_created ON content(created_at);
`;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** Try one DDL/DML statement, ignoring "already applied" style failures. */
function attempt(db, sql, params = []) {
  try {
    run(db, sql, params);
    return true;
  } catch {
    return false;
  }
}

function migrateV1(db) {
  attempt(db, "ALTER TABLE folders ADD COLUMN accepts_contributions INTEGER DEFAULT 0");
  attempt(db, "ALTER TABLE content ADD COLUMN source_type TEXT DEFAULT 'direct'");
  attempt(db, "ALTER TABLE content ADD COLUMN source_contribution_id INTEGER DEFAULT NULL");
  attempt(db, "ALTER TABLE content ADD COLUMN created_by INTEGER DEFAULT NULL");
}

function migrateV2(db) {
  attempt(db, 'ALTER TABLE ai_registry ADD COLUMN error_category TEXT');
  attempt(db, 'ALTER TABLE ai_registry ADD COLUMN timeout_behavior TEXT');
  attempt(db, 'ALTER TABLE ai_registry ADD COLUMN rate_limit_behavior TEXT');
}

/**
 * Phase 2: contribution review workflow.
 *
 * Adds review metadata to `contributions` and widens the accepted status set
 * with `needs_revision`. Existing rows keep their status and get NULL review
 * columns, so old data stays valid without rewriting.
 */
function migrateV3(db) {
  for (const ddl of [
    'ALTER TABLE contributions ADD COLUMN reviewed_by INTEGER DEFAULT NULL',
    'ALTER TABLE contributions ADD COLUMN reviewed_at TIMESTAMP DEFAULT NULL',
    'ALTER TABLE contributions ADD COLUMN review_note TEXT DEFAULT NULL',
    'ALTER TABLE contributions ADD COLUMN rejection_reason TEXT DEFAULT NULL',
    'ALTER TABLE contributions ADD COLUMN resubmitted_count INTEGER DEFAULT 0',
  ]) {
    attempt(db, ddl);
  }
  attempt(
    db,
    'CREATE INDEX IF NOT EXISTS idx_contrib_user_status ON contributions(user_id, status)',
  );
}

/** Contact Admin messaging: isolated from content/contributions. */
function migrateV4(db) {
  attempt(
    db,
    `CREATE TABLE IF NOT EXISTS messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER NOT NULL,
       user_name TEXT,
       category TEXT NOT NULL DEFAULT 'message',
       body TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'NEW',
       admin_reply TEXT,
       reviewed_by INTEGER,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
  );
  attempt(db, 'CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)');
  attempt(db, 'CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)');
}

/** RBAC: extend the existing `admins` identity with role + permissions. */
function migrateV5(db) {
  attempt(db, "ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'admin'");
  attempt(db, "ALTER TABLE admins ADD COLUMN permissions TEXT DEFAULT ''");
}

/** Audit log: isolated from every other subsystem. */
function migrateV6(db) {
  attempt(
    db,
    `CREATE TABLE IF NOT EXISTS audit_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       actor_id INTEGER,
       actor_role TEXT,
       action TEXT NOT NULL,
       target_type TEXT,
       target_id TEXT,
       details TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
  );
  for (const [indexName, column] of [
    ['idx_audit_actor', 'actor_id'],
    ['idx_audit_action', 'action'],
    ['idx_audit_created', 'created_at'],
  ]) {
    attempt(db, `CREATE INDEX IF NOT EXISTS ${indexName} ON audit_log(${column})`);
  }
}

/** Role semantics: revoked admins keep their row with role='none'. */
function migrateV7(db) {
  attempt(
    db,
    "UPDATE admins SET role = 'admin' WHERE role IS NULL OR TRIM(role) = ''",
  );
}

/** AI resource search: optional searchable metadata. */
function migrateV8(db) {
  for (const ddl of [
    'ALTER TABLE folders ADD COLUMN description TEXT DEFAULT NULL',
    'ALTER TABLE folders ADD COLUMN keywords TEXT DEFAULT NULL',
    'ALTER TABLE content ADD COLUMN description TEXT DEFAULT NULL',
    'ALTER TABLE content ADD COLUMN keywords TEXT DEFAULT NULL',
  ]) {
    attempt(db, ddl);
  }
}

/** Search Topics: high-level academic entry points. */
function migrateV9(db) {
  attempt(
    db,
    `CREATE TABLE IF NOT EXISTS topics (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       description TEXT DEFAULT NULL,
       icon TEXT DEFAULT NULL,
       display_order INTEGER DEFAULT 0,
       active INTEGER DEFAULT 1,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
  );
  attempt(
    db,
    `CREATE TABLE IF NOT EXISTS topic_folders (
       topic_id INTEGER NOT NULL,
       folder_id INTEGER NOT NULL,
       PRIMARY KEY (topic_id, folder_id),
       FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE CASCADE,
       FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE
     )`,
  );
  attempt(
    db,
    'CREATE INDEX IF NOT EXISTS idx_topics_order ON topics(active, display_order, id)',
  );
  attempt(
    db,
    'CREATE INDEX IF NOT EXISTS idx_topic_folders_folder ON topic_folders(folder_id)',
  );
}

/** Notifications log + per-user language preference. */
function migrateV10(db) {
  attempt(
    db,
    `CREATE TABLE IF NOT EXISTS notifications (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       sender_id INTEGER,
       title TEXT,
       body TEXT NOT NULL,
       audience TEXT NOT NULL DEFAULT 'all',
       recipients INTEGER DEFAULT 0,
       delivered INTEGER DEFAULT 0,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
  );
  attempt(db, 'ALTER TABLE users ADD COLUMN language TEXT DEFAULT NULL');
  attempt(
    db,
    'CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)',
  );
}

/**
 * Heal databases left with more than one `owner` row.
 *
 * Exactly one owner is a hard invariant: keep the persisted owner (or the
 * earliest owner when none is recorded), demote every other owner to `admin`,
 * and give it the admin baseline so it no longer carries owner-only caps.
 */
function migrateV11(db) {
  let owners;
  try {
    owners = db
      .prepare(
        "SELECT telegram_id FROM admins WHERE role = 'owner' " +
          'ORDER BY added_at ASC, telegram_id ASC',
      )
      .all()
      .map((row) => row[0]);
  } catch {
    return;
  }

  if (owners.length <= 1) return;

  let persisted = 0;
  try {
    const row = get(db, 'SELECT value FROM settings WHERE key = ?', [
      SETTING_OWNER_ID,
    ]);
    persisted = row && String(row[0]).trim() ? Number.parseInt(String(row[0]).trim(), 10) : 0;
    if (Number.isNaN(persisted)) persisted = 0;
  } catch {
    persisted = 0;
  }

  const keeper = owners.includes(persisted) ? persisted : owners[0];
  const adminPerms = permissionsToString({ ...ROLE_PERMISSION_PRESETS.admin });

  attempt(
    db,
    "UPDATE admins SET role = 'admin', permissions = ? WHERE role = 'owner' AND telegram_id != ?",
    [adminPerms, keeper],
  );
}

/** Emergency Resource Archive mirror table. */
function migrateV12(db) {
  attempt(
    db,
    `CREATE TABLE IF NOT EXISTS archive_sync (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       object_type TEXT NOT NULL DEFAULT 'content',
       content_fingerprint TEXT NOT NULL,
       folder_id INTEGER,
       content_ids TEXT,
       channel_id TEXT,
       channel_message_id INTEGER,
       status TEXT NOT NULL DEFAULT 'pending',
       attempts INTEGER DEFAULT 0,
       error TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       published_at TIMESTAMP
     )`,
  );
  attempt(
    db,
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_fingerprint ON archive_sync(content_fingerprint)',
  );
  attempt(
    db,
    'CREATE INDEX IF NOT EXISTS idx_archive_status ON archive_sync(status)',
  );
}

/** DDL statements owned by migration v13, exposed for testing/review. */
export function migrateV13Sql() {
  return [
    `CREATE TABLE IF NOT EXISTS news (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       news_type TEXT NOT NULL DEFAULT 'notify',
       title TEXT NOT NULL,
       body TEXT,
       sender_id INTEGER,
       subject_folder_id INTEGER,
       section_folder_id INTEGER,
       folder_id INTEGER,
       doctor TEXT,
       event_at TEXT,
       resource_id INTEGER,
       visibility TEXT NOT NULL DEFAULT 'all',
       status TEXT NOT NULL DEFAULT 'draft',
       delivery_scope TEXT NOT NULL DEFAULT 'all',
       source TEXT NOT NULL DEFAULT 'manual',
       payload TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       published_at TIMESTAMP,
       archived_at TIMESTAMP,
       FOREIGN KEY (subject_folder_id) REFERENCES folders (id) ON DELETE SET NULL,
       FOREIGN KEY (section_folder_id) REFERENCES folders (id) ON DELETE SET NULL,
       FOREIGN KEY (resource_id) REFERENCES content (id) ON DELETE SET NULL
     )`,
    `CREATE TABLE IF NOT EXISTS news_reads (
       user_id INTEGER NOT NULL,
       news_id INTEGER NOT NULL,
       read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (user_id, news_id),
       FOREIGN KEY (news_id) REFERENCES news (id) ON DELETE CASCADE
     )`,
    `CREATE TABLE IF NOT EXISTS news_subscriptions (
       user_id INTEGER NOT NULL,
       topic_kind TEXT NOT NULL DEFAULT 'type',
       topic_value TEXT NOT NULL DEFAULT '*',
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (user_id, topic_kind, topic_value)
     )`,
    'CREATE INDEX IF NOT EXISTS idx_news_status_created ON news(status, created_at DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_news_type ON news(news_type, status)',
    'CREATE INDEX IF NOT EXISTS idx_news_section ON news(section_folder_id)',
    'CREATE INDEX IF NOT EXISTS idx_news_resource ON news(resource_id)',
    'CREATE INDEX IF NOT EXISTS idx_news_reads_user ON news_reads(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_news_subs_user ON news_subscriptions(user_id)',
  ];
}

/** Phase 1 News Core: `news`, `news_reads` and `news_subscriptions`. */
function migrateV13(db) {
  for (const statement of migrateV13Sql()) {
    attempt(db, statement);
  }
}

/** DDL statements owned by migration v14, exposed for testing/review. */
export function migrateV14Sql() {
  return [
    `CREATE TABLE IF NOT EXISTS news_deliveries (
       news_id INTEGER NOT NULL,
       user_id INTEGER NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',
       kind TEXT,
       channel TEXT NOT NULL DEFAULT 'private',
       attempts INTEGER NOT NULL DEFAULT 0,
       error TEXT,
       channel_message_id INTEGER,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (news_id, user_id),
       FOREIGN KEY (news_id) REFERENCES news (id) ON DELETE CASCADE
     )`,
    'CREATE INDEX IF NOT EXISTS idx_news_deliveries_status ON news_deliveries(status)',
    'CREATE INDEX IF NOT EXISTS idx_news_deliveries_user ON news_deliveries(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_news_deliveries_news ON news_deliveries(news_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_news_subs_topic ON news_subscriptions(topic_kind, topic_value)',
  ];
}

/** Phase 2 News: private-delivery tracking. */
function migrateV14(db) {
  for (const statement of migrateV14Sql()) {
    attempt(db, statement);
  }
}

/**
 * Phase 2 fix: DB-level idempotency for auto-generated resource news.
 *
 * A partial UNIQUE index on `news(resource_id)` for `source='resource'` rows
 * makes a second auto-news row for the same resource impossible even under a
 * concurrent race. Manual news is untouched. Pre-existing duplicates are
 * collapsed (keeping the earliest row) first, so the migration cannot fail.
 */
function migrateV15(db) {
  attempt(
    db,
    'DELETE FROM news WHERE source = ? AND resource_id IS NOT NULL AND id NOT IN (' +
      '  SELECT MIN(id) FROM news WHERE source = ? AND resource_id IS NOT NULL GROUP BY resource_id' +
      ')',
    [NEWS_SOURCE_AUTO, NEWS_SOURCE_AUTO],
  );
  attempt(
    db,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_news_auto_resource_unique ' +
      'ON news(resource_id) ' +
      `WHERE source = '${NEWS_SOURCE_AUTO}' AND resource_id IS NOT NULL`,
  );
}

/** DDL statements owned by migration v16, exposed for testing/review. */
export function migrateV16Sql() {
  return [
    `CREATE TABLE IF NOT EXISTS admin_scopes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       admin_id INTEGER NOT NULL,
       scope_type TEXT NOT NULL,
       scope_id INTEGER NOT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       created_by INTEGER,
       UNIQUE (admin_id, scope_type, scope_id)
     )`,
    'CREATE INDEX IF NOT EXISTS idx_admin_scopes_admin ON admin_scopes(admin_id)',
    'CREATE INDEX IF NOT EXISTS idx_admin_scopes_target ON admin_scopes(scope_type, scope_id)',
  ];
}

/**
 * Phase 3 Scoped RBAC: per-admin scope assignments.
 *
 * No foreign key on `scope_id` on purpose: it is a polymorphic reference
 * (folder OR topic OR content depending on `scope_type`). Resolution is always
 * validated against the live registry by `authorization.js`, so a scope whose
 * target was later deleted simply matches nothing (fail-closed).
 */
function migrateV16(db) {
  for (const statement of migrateV16Sql()) {
    attempt(db, statement);
  }
}

/** DML statements owned by migration v17, exposed for testing/review. */
export function migrateV17Sql() {
  return [
    ["UPDATE news SET news_type = 'section' WHERE news_type = 'resource'", []],
    [
      'INSERT OR IGNORE INTO news_subscriptions (user_id, topic_kind, topic_value) ' +
        "SELECT user_id, topic_kind, 'section' FROM news_subscriptions " +
        "WHERE topic_kind = 'type' AND topic_value = 'resource'",
      [],
    ],
    [
      "DELETE FROM news_subscriptions WHERE topic_kind = 'type' AND topic_value = 'resource'",
      [],
    ],
  ];
}

/**
 * News/Admin merge: fold the legacy `resource` kind into Section News.
 *
 * The product exposes only two news kinds — 🚨 Important/Urgent and 📚 Section
 * News — with a resource being an optional *linked reference* on a Section
 * item. Historical rows and subscriptions are rewritten in place; `resource_id`
 * (and the auto-source idempotency index) is preserved, so nothing about the
 * linked resource or its delivery changes.
 */
function migrateV17(db) {
  for (const [statement, params] of migrateV17Sql()) {
    attempt(db, statement, params);
  }
}

/** Ordered migration list. Never reorder or rewrite v1..v4. */
export const MIGRATIONS = Object.freeze([
  ['v1', migrateV1],
  ['v2', migrateV2],
  ['v3', migrateV3],
  ['v4', migrateV4],
  ['v5', migrateV5],
  ['v6', migrateV6],
  ['v7', migrateV7],
  ['v8', migrateV8],
  ['v9', migrateV9],
  ['v10', migrateV10],
  ['v11', migrateV11],
  ['v12', migrateV12],
  ['v13', migrateV13],
  ['v14', migrateV14],
  ['v15', migrateV15],
  ['v16', migrateV16],
  ['v17', migrateV17],
]);

/**
 * Create the schema and run every migration. Idempotent and safe to re-run.
 */
export function initDb(target = null) {
  withDb((db) => {
    exec(db, CORE_SCHEMA);
    for (const [, migrate] of MIGRATIONS) {
      migrate(db);
    }
    exec(db, FINAL_INDEXES);
  }, target);
  return true;
}

/** List the tables present in the database (test/diagnostic helper). */
export function listTables(target = null) {
  return withDb(
    (db) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row[0]),
    target,
  );
}
