/**
 * Audit log access. Isolated: touches only `audit_log`.
 *
 * The viewer lives in `src/audit.js`; this module is pure storage so any
 * subsystem can record an entry without importing UI code.
 */

import { get, run, withDb } from './core.js';

/**
 * Append one audit entry. Returns true on success.
 *
 * `target_id` is stored as text so a polymorphic target (a folder, a news row,
 * a feature key) can all be recorded in one column.
 */
export function addAuditEntry(
  actorId,
  actorRole,
  action,
  targetType = null,
  targetId = null,
  details = null,
) {
  try {
    return withDb((db) => {
      run(
        db,
        'INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, details) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        [
          actorId,
          actorRole,
          action,
          targetType,
          targetId === null || targetId === undefined ? null : String(targetId),
          details,
        ],
      );
      return true;
    });
  } catch {
    return false;
  }
}

/** Most recent audit rows first, optionally filtered. */
export function getAuditEntries(limit = 50, action = null, actorId = null) {
  let safeLimit = Number.parseInt(limit, 10);
  if (Number.isNaN(safeLimit)) safeLimit = 50;
  safeLimit = Math.max(1, Math.min(safeLimit, 500));

  const clauses = [];
  const params = [];
  if (action) {
    clauses.push('action = ?');
    params.push(action);
  }
  if (actorId !== null && actorId !== undefined) {
    clauses.push('actor_id = ?');
    params.push(actorId);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  params.push(safeLimit);

  try {
    return withDb((db) =>
      db
        .prepare(
          'SELECT id, actor_id, actor_role, action, target_type, target_id, details, created_at ' +
            `FROM audit_log${where} ORDER BY id DESC LIMIT ?`,
        )
        .all(...params),
    );
  } catch {
    return [];
  }
}

export function getAuditCount() {
  try {
    const row = withDb((db) => get(db, 'SELECT COUNT(*) FROM audit_log'));
    return row ? row[0] : 0;
  } catch {
    return 0;
  }
}
