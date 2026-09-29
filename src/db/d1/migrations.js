/**
 * Fresh D1 schema contract for MEDBOT schema version 17.
 *
 * This is intentionally separate from the existing SQLite migration runner.
 * It creates the final schema on an empty D1 database; it does not import or
 * delete production data.
 */

export const D1_SCHEMA_VERSION = 17;

export const D1_SCHEMA_SQL = [
  "PRAGMA foreign_keys = ON",

  "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",

  "CREATE TABLE IF NOT EXISTS users (" +
    "user_id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, " +
    "joined_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, language TEXT DEFAULT NULL)",

  "CREATE TABLE IF NOT EXISTS folders (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, name TEXT NOT NULL, " +
    "node_type TEXT DEFAULT 'general', accepts_contributions INTEGER DEFAULT 0, " +
    "description TEXT DEFAULT NULL, keywords TEXT DEFAULT NULL, " +
    "FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE)",

  "CREATE TABLE IF NOT EXISTS content (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER NOT NULL, title TEXT NOT NULL, " +
    "file_id TEXT NOT NULL, file_type TEXT DEFAULT 'doc', " +
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, source_type TEXT DEFAULT 'direct', " +
    "source_contribution_id INTEGER DEFAULT NULL, created_by INTEGER DEFAULT NULL, " +
    "description TEXT DEFAULT NULL, keywords TEXT DEFAULT NULL, " +
    "FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE)",

  "CREATE TABLE IF NOT EXISTS contributions (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT, " +
    "folder_id INTEGER NOT NULL, title TEXT NOT NULL, file_id TEXT NOT NULL, " +
    "file_type TEXT DEFAULT 'doc', status TEXT DEFAULT 'pending', " +
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, reviewed_by INTEGER DEFAULT NULL, " +
    "reviewed_at TIMESTAMP DEFAULT NULL, review_note TEXT DEFAULT NULL, " +
    "rejection_reason TEXT DEFAULT NULL, resubmitted_count INTEGER DEFAULT 0, " +
    "FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE)",

  "CREATE TABLE IF NOT EXISTS about_us (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), content TEXT NOT NULL, " +
    "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",

  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",

  "CREATE TABLE IF NOT EXISTS daily_ai_usage (" +
    "user_id INTEGER, usage_date TEXT, request_count INTEGER DEFAULT 0, " +
    "PRIMARY KEY (user_id, usage_date))",

  "CREATE TABLE IF NOT EXISTS admins (" +
    "telegram_id INTEGER PRIMARY KEY, username TEXT, " +
    "added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, role TEXT DEFAULT 'admin', " +
    "permissions TEXT DEFAULT '')",

  "CREATE TABLE IF NOT EXISTS ai_registry (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT, endpoint TEXT, " +
    "availability TEXT, auth_status TEXT, latency_ms REAL, success_rate REAL, capabilities TEXT, " +
    "last_success TIMESTAMP, last_failure TIMESTAMP, last_test TIMESTAMP, notes TEXT, " +
    "error_category TEXT, timeout_behavior TEXT, rate_limit_behavior TEXT)",

  "CREATE TABLE IF NOT EXISTS ai_model_usage (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, registry_id INTEGER NOT NULL, user_id INTEGER, " +
    "latency_ms REAL, success INTEGER NOT NULL DEFAULT 0, error_category TEXT, " +
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
    "FOREIGN KEY (registry_id) REFERENCES ai_registry(id) ON DELETE CASCADE)",

  "CREATE TABLE IF NOT EXISTS messages (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT, " +
    "category TEXT NOT NULL DEFAULT 'message', body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'NEW', " +
    "admin_reply TEXT, reviewed_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
    "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",

  "CREATE TABLE IF NOT EXISTS audit_log (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_role TEXT, action TEXT NOT NULL, " +
    "target_type TEXT, target_id TEXT, details TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",

  "CREATE TABLE IF NOT EXISTS topics (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT NULL, " +
    "icon TEXT DEFAULT NULL, display_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1, " +
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",

  "CREATE TABLE IF NOT EXISTS topic_folders (" +
    "topic_id INTEGER NOT NULL, folder_id INTEGER NOT NULL, " +
    "PRIMARY KEY (topic_id, folder_id), " +
    "FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE, " +
    "FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE)",

  "CREATE TABLE IF NOT EXISTS notifications (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER, title TEXT, body TEXT NOT NULL, " +
    "audience TEXT NOT NULL DEFAULT 'all', recipients INTEGER DEFAULT 0, delivered INTEGER DEFAULT 0, " +
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",

  "CREATE TABLE IF NOT EXISTS archive_sync (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL DEFAULT 'content', " +
    "content_fingerprint TEXT NOT NULL, folder_id INTEGER, content_ids TEXT, channel_id TEXT, " +
    "channel_message_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER DEFAULT 0, " +
    "error TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
    "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, published_at TIMESTAMP)",

  "CREATE TABLE IF NOT EXISTS news (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, news_type TEXT NOT NULL DEFAULT 'notify', title TEXT NOT NULL, " +
    "body TEXT, sender_id INTEGER, subject_folder_id INTEGER, section_folder_id INTEGER, folder_id INTEGER, " +
    "doctor TEXT, event_at TEXT, resource_id INTEGER, visibility TEXT NOT NULL DEFAULT 'all', " +
    "status TEXT NOT NULL DEFAULT 'draft', delivery_scope TEXT NOT NULL DEFAULT 'all', " +
    "source TEXT NOT NULL DEFAULT 'manual', payload TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
    "published_at TIMESTAMP, archived_at TIMESTAMP, " +
    "FOREIGN KEY (subject_folder_id) REFERENCES folders(id) ON DELETE SET NULL, " +
    "FOREIGN KEY (section_folder_id) REFERENCES folders(id) ON DELETE SET NULL, " +
    "FOREIGN KEY (resource_id) REFERENCES content(id) ON DELETE SET NULL)",

  "CREATE TABLE IF NOT EXISTS news_reads (" +
    "user_id INTEGER NOT NULL, news_id INTEGER NOT NULL, read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (user_id, news_id), FOREIGN KEY (news_id) REFERENCES news(id) ON DELETE CASCADE)",

  "CREATE TABLE IF NOT EXISTS news_subscriptions (" +
    "user_id INTEGER NOT NULL, topic_kind TEXT NOT NULL DEFAULT 'type', " +
    "topic_value TEXT NOT NULL DEFAULT '*', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (user_id, topic_kind, topic_value))",

  "CREATE TABLE IF NOT EXISTS news_deliveries (" +
    "news_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', " +
    "kind TEXT, channel TEXT NOT NULL DEFAULT 'private', attempts INTEGER NOT NULL DEFAULT 0, " +
    "error TEXT, channel_message_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
    "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (news_id, user_id), " +
    "FOREIGN KEY (news_id) REFERENCES news(id) ON DELETE CASCADE)",

  "CREATE TABLE IF NOT EXISTS admin_scopes (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, scope_type TEXT NOT NULL, " +
    "scope_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_by INTEGER, " +
    "UNIQUE (admin_id, scope_type, scope_id))",

  "CREATE INDEX IF NOT EXISTS idx_ai_usage_registry ON ai_model_usage(registry_id)",
  "CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_model_usage(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_model_usage(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_content_folder ON content(folder_id)",
  "CREATE INDEX IF NOT EXISTS idx_contrib_status ON contributions(status)",
  "CREATE INDEX IF NOT EXISTS idx_contrib_user_status ON contributions(user_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_registry_avail ON ai_registry(availability)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_registry_provider_model_endpoint ON ai_registry(provider, model, endpoint)",
  "CREATE INDEX IF NOT EXISTS idx_content_created ON content(created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_content_contribution ON content(source_contribution_id) WHERE source_type = 'contribution' AND source_contribution_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)",
  "CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)",
  "CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_topics_order ON topics(active, display_order, id)",
  "CREATE INDEX IF NOT EXISTS idx_topic_folders_folder ON topic_folders(folder_id)",
  "CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_fingerprint ON archive_sync(content_fingerprint)",
  "CREATE INDEX IF NOT EXISTS idx_archive_status ON archive_sync(status)",
  "CREATE INDEX IF NOT EXISTS idx_news_status_created ON news(status, created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_news_type ON news(news_type, status)",
  "CREATE INDEX IF NOT EXISTS idx_news_section ON news(section_folder_id)",
  "CREATE INDEX IF NOT EXISTS idx_news_resource ON news(resource_id)",
  "CREATE INDEX IF NOT EXISTS idx_news_reads_user ON news_reads(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_news_subs_user ON news_subscriptions(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_news_deliveries_status ON news_deliveries(status)",
  "CREATE INDEX IF NOT EXISTS idx_news_deliveries_user ON news_deliveries(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_news_deliveries_news ON news_deliveries(news_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_news_subs_topic ON news_subscriptions(topic_kind, topic_value)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_news_auto_resource_unique ON news(resource_id) WHERE source = 'resource' AND resource_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_admin_scopes_admin ON admin_scopes(admin_id)",
  "CREATE INDEX IF NOT EXISTS idx_admin_scopes_target ON admin_scopes(scope_type, scope_id)",

  "INSERT INTO schema_meta(key, value) VALUES ('schema_version', '17') " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
].join(";\n") + ";\n";

export function getD1SchemaSql() {
  return D1_SCHEMA_SQL;
}

export async function initD1(db) {
  if (!db || typeof db.exec !== 'function') {
    throw new TypeError('A Cloudflare D1 database binding is required');
  }
  return db.exec(D1_SCHEMA_SQL);
}
