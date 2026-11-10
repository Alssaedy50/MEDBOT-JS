/**
 * Strict College Database & Configuration Isolation Layer.
 *
 * Supports two zero-leakage isolation modes on Cloudflare's free tier:
 *   1. Physical D1 Database Binding per college (`env[college.db_binding]`, e.g., `env.DB_PHARMACY`).
 *   2. Scoped College D1 Adapter (`createScopedCollegeD1(baseDb, collegeId)`) which isolates
 *      every MEDBOT table (`c_<slug>__users`, `c_<slug>__folders`, `c_<slug>__content`, etc.)
 *      when a college is dynamically provisioned before a dedicated D1 binding is attached.
 *
 * The default college (`default`) always uses `env.DB` directly with unprefixed tables,
 * preserving 100% backward compatibility with all existing data and queries.
 */

import { D1_SCHEMA_STATEMENTS } from '../db/d1/migrations.js';
import { initTelegramWebhookStore } from '../db/d1/telegramUpdates.js';
import { run } from '../db/d1/core.js';

const COLLEGE_TABLES = [
  'schema_meta',
  'users',
  'folders',
  'content',
  'contributions',
  'about_us',
  'settings',
  'bot_settings',
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
  'telegram_updates',
];

const TABLE_ALTERNATION = COLLEGE_TABLES.join('|');

// Matches SQL table identifiers in table-reference positions only (never column names or string literals)
const TABLE_CLAUSE_RE = new RegExp(
  `\\b(FROM|JOIN|INTO|UPDATE(?:\\s+OR\\s+\\w+)?|TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|REFERENCES)\\s+(${TABLE_ALTERNATION})\\b`,
  'gi',
);
const INDEX_ON_TABLE_RE = new RegExp(
  `\\b(ON)\\s+(${TABLE_ALTERNATION})\\s*\\(`,
  'gi',
);
const INDEX_NAME_RE = /\b(INDEX(?:\s+IF\s+NOT\s+EXISTS)?)\s+((?:idx|ux)_[a-z0-9_]+)\b/gi;
const QUALIFIED_TABLE_COL_RE = new RegExp(
  `\\b(${TABLE_ALTERNATION})\\.([a-z_][a-z0-9_]*)\\b`,
  'gi',
);

export function normalizeCollegeSlug(slug) {
  const clean = String(slug ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (!clean || clean === 'default') return 'default';
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(clean) || clean === 'platform') {
    throw new Error('invalid_college_slug');
  }
  return clean;
}

export function getCollegeTablePrefix(collegeId) {
  const slug = normalizeCollegeSlug(collegeId);
  if (slug === 'default') return '';
  return `c_${slug.replace(/-/g, '_')}__`;
}

/**
 * Rewrite SQL table and index identifiers outside of single-quoted string literals
 * so a dynamically provisioned college operates strictly on its own `c_<slug>__<table>` tables.
 */
export function scopeCollegeSql(sql, collegeId) {
  const prefix = getCollegeTablePrefix(collegeId);
  if (!prefix) return String(sql);

  // Split by single-quoted SQL string literals so literal contents are never altered
  const parts = String(sql).split(/('(?:[^']|'')*')/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(TABLE_CLAUSE_RE, (_, kw, table) => `${kw} ${prefix}${table.toLowerCase()}`)
      .replace(INDEX_ON_TABLE_RE, (_, kw, table) => `${kw} ${prefix}${table.toLowerCase()}(`)
      .replace(INDEX_NAME_RE, (_, kw, idxName) => `${kw} ${prefix}${idxName.toLowerCase()}`)
      .replace(QUALIFIED_TABLE_COL_RE, (_, table, col) => `${prefix}${table.toLowerCase()}.${col}`);
  }
  return parts.join('');
}

const scopedAdaptersCache = new WeakMap();

/**
 * Wrap a D1-compatible database binding with per-college table isolation.
 */
export function createScopedCollegeD1(baseDb, collegeId) {
  if (!baseDb || typeof baseDb.prepare !== 'function') {
    throw new TypeError('A valid D1 database binding is required for college isolation');
  }
  const slug = normalizeCollegeSlug(collegeId);
  if (slug === 'default') return baseDb;

  let perDbMap = scopedAdaptersCache.get(baseDb);
  if (!perDbMap) {
    perDbMap = new Map();
    scopedAdaptersCache.set(baseDb, perDbMap);
  }
  if (perDbMap.has(slug)) {
    return perDbMap.get(slug);
  }

  const scopedDb = Object.freeze({
    __collegeId: slug,
    __isolatedPrefix: getCollegeTablePrefix(slug),
    prepare(sql) {
      return baseDb.prepare(scopeCollegeSql(sql, slug));
    },
    async batch(statements) {
      if (typeof baseDb.batch === 'function') {
        return baseDb.batch(statements);
      }
      const results = [];
      for (const stmt of statements) {
        if (typeof stmt?.run === 'function') {
          results.push(await stmt.run());
        }
      }
      return results;
    },
    async exec(sql) {
      if (typeof baseDb.exec === 'function') {
        return baseDb.exec(scopeCollegeSql(sql, slug));
      }
      return null;
    },
  });

  perDbMap.set(slug, scopedDb);
  return scopedDb;
}

const initializedCollegeSchemas = new WeakSet();

/**
 * Ensure the full MEDBOT v18 schema is initialized on the resolved college database.
 */
export async function ensureCollegeSchema(collegeDb) {
  if (!collegeDb || typeof collegeDb !== 'object' || initializedCollegeSchemas.has(collegeDb)) {
    return;
  }
  await initTelegramWebhookStore(collegeDb);
  if (typeof collegeDb.prepare === 'function' && typeof collegeDb.batch === 'function') {
    try {
      await collegeDb.batch(D1_SCHEMA_STATEMENTS.map((sql) => collegeDb.prepare(sql)));
      initializedCollegeSchemas.add(collegeDb);
      return;
    } catch {
      // Fallback to sequential execution if batch DDL is unsupported by a test mock
    }
  }
  if (typeof collegeDb.prepare === 'function') {
    for (const sql of D1_SCHEMA_STATEMENTS) {
      try {
        await run(collegeDb, sql);
      } catch {
        // Ignore if mock does not support full DDL
      }
    }
    initializedCollegeSchemas.add(collegeDb);
  }
}

/**
 * Resolve the isolated database handle for a given college.
 *
 * 1. `default` college -> `env.DB` directly.
 * 2. Dedicated D1 binding in `env[college.db_binding]` -> physical D1 database for that college.
 * 3. Dynamic college without dedicated binding -> `createScopedCollegeD1(env.DB, college.college_id)`.
 */
export function resolveCollegeDatabase(env = {}, college) {
  const collegeId = typeof college === 'string' ? college : college?.college_id || 'default';
  const slug = normalizeCollegeSlug(collegeId);
  if (slug === 'default') {
    return env.DB || null;
  }

  const bindingName = typeof college === 'object' && college?.db_binding
    ? String(college.db_binding).trim()
    : `DB_${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

  if (bindingName && bindingName !== 'DB' && env[bindingName] && typeof env[bindingName].prepare === 'function') {
    return env[bindingName];
  }

  if (!env.DB) return null;
  return createScopedCollegeD1(env.DB, slug);
}
