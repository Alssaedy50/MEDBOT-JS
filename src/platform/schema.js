/**
 * Central Platform Control-Plane Schema (Cloudflare D1 / SQLite compatible).
 *
 * Kept additive and separate from the per-college MEDBOT v18 schema contract so
 * existing college schema migrations and export parity tests remain 100% intact.
 */

import { run } from '../db/d1/core.js';

export const PLATFORM_CONTROL_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS platform_colleges (
    college_id TEXT PRIMARY KEY,
    name_ar TEXT NOT NULL,
    name_en TEXT DEFAULT NULL,
    manager_telegram_id INTEGER DEFAULT NULL,
    manager_username TEXT DEFAULT NULL,
    bot_id INTEGER DEFAULT NULL,
    bot_username TEXT DEFAULT NULL,
    bot_token_encrypted TEXT DEFAULT NULL,
    webhook_secret TEXT NOT NULL,
    managed_bot_mode TEXT NOT NULL DEFAULT 'managed_bot',
    db_binding TEXT DEFAULT NULL,
    archive_channel_id TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'pending_setup',
    suspension_reason TEXT DEFAULT NULL,
    webhook_url TEXT DEFAULT NULL,
    created_by INTEGER DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS platform_channel_memberships (
    channel_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'member',
    is_member INTEGER NOT NULL DEFAULT 1,
    checked_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS platform_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_role TEXT NOT NULL DEFAULT 'platform_owner',
    college_id TEXT DEFAULT NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE INDEX IF NOT EXISTS idx_platform_colleges_status ON platform_colleges(status)`,
  `CREATE INDEX IF NOT EXISTS idx_platform_colleges_manager ON platform_colleges(manager_telegram_id)`,
  `CREATE INDEX IF NOT EXISTS idx_platform_memberships_expires ON platform_channel_memberships(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_platform_audit_college ON platform_audit_log(college_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_log(created_at DESC)`,
];

const initializedPlatformDbs = new WeakSet();

export async function ensurePlatformSchema(db) {
  if (!db || typeof db !== 'object' || initializedPlatformDbs.has(db)) return;
  if (typeof db.batch === 'function' && typeof db.prepare === 'function') {
    try {
      await db.batch(PLATFORM_CONTROL_TABLES_SQL.map((sql) => db.prepare(sql)));
      initializedPlatformDbs.add(db);
      return;
    } catch {
      // Fall back to sequential execution if mock DB doesn't support batch DDL
    }
  }
  if (typeof db.prepare === 'function') {
    for (const sql of PLATFORM_CONTROL_TABLES_SQL) {
      try {
        await run(db, sql);
      } catch {
        // Ignore if mock DB does not execute DDL
      }
    }
    initializedPlatformDbs.add(db);
  }
}
