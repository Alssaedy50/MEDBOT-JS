import { get, run } from './core.js';

export async function addAuditEntry(db, actorId, actorRole, action, targetType = null, targetId = null, details = null) {
  if (!String(action ?? '').trim()) return false;
  try {
    await run(
      db,
      'INSERT INTO audit_log (actor_id,actor_role,action,target_type,target_id,details) VALUES (?,?,?,?,?,?)',
      [actorId, actorRole, String(action).trim(), targetType, targetId === null || targetId === undefined ? null : String(targetId), details],
    );
    return true;
  } catch {
    return false;
  }
}

export async function getAuditEntries(db, limit = 50, action = null, actorId = null) {
  const safe = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 500));
  const clauses = []; const params = [];
  if (action) { clauses.push('action=?'); params.push(action); }
  if (actorId !== null && actorId !== undefined) { clauses.push('actor_id=?'); params.push(actorId); }
  params.push(safe);
  try {
    return (await import('./core.js')).all(
      db,
      'SELECT id,actor_id,actor_role,action,target_type,target_id,details,created_at FROM audit_log' +
        (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '') +
        ' ORDER BY id DESC LIMIT ?',
      params,
    );
  } catch {
    return [];
  }
}

export async function getAuditCount(db) {
  try {
    const row = await get(db, 'SELECT COUNT(*) FROM audit_log');
    return Number(row?.[0] ?? 0);
  } catch {
    return 0;
  }
}
