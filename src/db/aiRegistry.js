/**
 * AI registry and model-usage observability.
 *
 * `ai_registry` holds every discovered/registered provider+model endpoint;
 * `ai_model_usage` records one row per generation attempt so latency, success
 * and error category are auditable per model and per student.
 */

import { get, run, withDb } from './core.js';

/**
 * Insert a registry row if the (provider, model, endpoint) triple is new, and
 * return its id.
 */
export function aiRegistryEnsure(
  provider,
  model,
  endpoint,
  availability = 'AVAILABLE',
  authStatus = null,
  capabilities = 'text_generation',
) {
  return withDb((db) => {
    run(
      db,
      'INSERT INTO ai_registry (provider, model, endpoint, availability, auth_status, capabilities) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, model, endpoint) DO NOTHING',
      [provider, model, endpoint, availability, authStatus, capabilities],
    );
    const row = get(
      db,
      'SELECT id FROM ai_registry WHERE provider = ? AND model = ? AND endpoint = ? LIMIT 1',
      [provider, model, endpoint],
    );
    return row ? row[0] : null;
  });
}

export function aiRegistryGetAll() {
  return withDb((db) =>
    db
      .prepare(
        'SELECT id, provider, model, endpoint, availability, auth_status, latency_ms, ' +
          'success_rate, capabilities, last_success, last_failure, last_test, notes, ' +
          'error_category, timeout_behavior, rate_limit_behavior FROM ai_registry ORDER BY id ASC',
      )
      .all(),
  );
}

export function aiRegistryGetHealthy() {
  return withDb((db) =>
    db
      .prepare(
        "SELECT id, provider, model, endpoint, availability, auth_status, latency_ms, " +
          "success_rate, capabilities FROM ai_registry WHERE availability = 'AVAILABLE' " +
          'ORDER BY success_rate DESC, latency_ms ASC',
      )
      .all(),
  );
}

export function aiRegistryAdd({
  provider,
  model = null,
  endpoint = null,
  availability = null,
  authStatus = null,
  latencyMs = null,
  successRate = null,
  capabilities = null,
  notes = null,
} = {}) {
  return withDb(
    (db) =>
      run(
        db,
        'INSERT INTO ai_registry (provider, model, endpoint, availability, auth_status, ' +
          'latency_ms, success_rate, capabilities, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [provider, model, endpoint, availability, authStatus, latencyMs, successRate, capabilities, notes],
      ).lastInsertRowid,
  );
}

export function aiRegistryUpdate(id, fields = {}) {
  const allowed = new Set([
    'provider',
    'model',
    'endpoint',
    'availability',
    'auth_status',
    'latency_ms',
    'success_rate',
    'capabilities',
    'notes',
  ]);
  const updates = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!updates.length) return false;

  const assignments = updates.map(([key]) => `${key} = ?`).join(', ');
  const params = [...updates.map(([, value]) => value), id];
  return withDb(
    (db) => run(db, `UPDATE ai_registry SET ${assignments} WHERE id = ?`, params).changes > 0,
  );
}

export function aiRegistryMarkSuccess(id, latencyMs = null) {
  withDb((db) =>
    run(
      db,
      'UPDATE ai_registry SET availability = ?, auth_status = ?, latency_ms = ?, ' +
        'success_rate = COALESCE(success_rate, 1.0), last_success = CURRENT_TIMESTAMP, ' +
        'last_test = CURRENT_TIMESTAMP WHERE id = ?',
      ['AVAILABLE', 'AUTHENTICATED', latencyMs, id],
    ),
  );
}

export function aiRegistryMarkFailure(id, errorCategory = null, availability = null, authStatus = null) {
  withDb((db) =>
    run(
      db,
      'UPDATE ai_registry SET last_failure = CURRENT_TIMESTAMP, last_test = CURRENT_TIMESTAMP, ' +
        'error_category = COALESCE(?, error_category), ' +
        'availability = COALESCE(?, availability), ' +
        'auth_status = COALESCE(?, auth_status) WHERE id = ?',
      [errorCategory, availability, authStatus, id],
    ),
  );
}

/** Record one generation attempt. Best-effort: never raises. */
export function aiUsageRecord(
  registryId,
  { userId = null, latencyMs = null, success = false, errorCategory = null } = {},
) {
  try {
    withDb((db) =>
      run(
        db,
        'INSERT INTO ai_model_usage (registry_id, user_id, latency_ms, success, error_category) ' +
          'VALUES (?, ?, ?, ?, ?)',
        [registryId, userId, latencyMs, success ? 1 : 0, errorCategory],
      ),
    );
  } catch {
    // Observability must never break a generation.
  }
}

/** Per-model aggregates over the last `days` days. */
export function aiUsageStats(days = 1) {
  return withDb((db) =>
    db
      .prepare(
        `SELECT
           r.id, r.provider, r.model, r.availability,
           COUNT(u.id) AS total_requests,
           COALESCE(SUM(u.success), 0) AS successful_requests,
           COUNT(DISTINCT u.user_id) AS unique_students,
           ROUND(AVG(u.latency_ms), 1) AS avg_latency_ms,
           MAX(u.created_at) AS last_used
         FROM ai_registry r
         LEFT JOIN ai_model_usage u
           ON u.registry_id = r.id AND u.created_at >= datetime('now', ?)
         GROUP BY r.id, r.provider, r.model, r.availability
         ORDER BY unique_students DESC, total_requests DESC, avg_latency_ms ASC`,
      )
      .all(`-${Number.parseInt(days, 10)} days`),
  );
}

/** Top students by AI request count over the last `days` days. */
export function aiUsageTopStudents(days = 1, limit = 10) {
  return withDb((db) =>
    db
      .prepare(
        `SELECT user_id, COUNT(*) AS total_requests, SUM(success) AS successful_requests,
                ROUND(AVG(latency_ms), 1) AS avg_latency_ms
         FROM ai_model_usage
         WHERE user_id IS NOT NULL AND created_at >= datetime('now', ?)
         GROUP BY user_id ORDER BY total_requests DESC LIMIT ?`,
      )
      .all(`-${Number.parseInt(days, 10)} days`, Number.parseInt(limit, 10)),
  );
}
