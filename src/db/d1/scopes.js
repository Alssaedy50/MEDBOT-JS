import { all, get, run } from './core.js';
import { SCOPE_TYPES, intOrNull } from '../../constants.js';

const TABLE = { folder: 'folders', topic: 'topics', resource: 'content' };
const id = (value) => intOrNull(value);

export async function addAdminScope(db, adminId, scopeType, scopeId, createdBy = null) {
  const a = id(adminId); const s = id(scopeId);
  if (a === null || s === null || !SCOPE_TYPES.includes(scopeType)) return false;
  if (!(await get(db, `SELECT id FROM ${TABLE[scopeType]} WHERE id=?`, [s]))) return false;
  try {
    await run(db, 'INSERT INTO admin_scopes (admin_id,scope_type,scope_id,created_by) VALUES (?,?,?,?)', [a, scopeType, s, id(createdBy)]);
    return true;
  } catch {
    return true;
  }
}

export async function removeAdminScope(db, adminId, scopeType, scopeId) {
  const a = id(adminId); const s = id(scopeId);
  if (a === null || s === null || !SCOPE_TYPES.includes(scopeType)) return false;
  return (await run(db, 'DELETE FROM admin_scopes WHERE admin_id=? AND scope_type=? AND scope_id=?', [a, scopeType, s])).changes > 0;
}

export async function clearAdminScopes(db, adminId) {
  const a = id(adminId); if (a === null) return 0;
  return (await run(db, 'DELETE FROM admin_scopes WHERE admin_id=?', [a])).changes;
}

export async function getAdminScopes(db, adminId) {
  const a = id(adminId); if (a === null) return [];
  return (await all(db, 'SELECT scope_type,scope_id,created_at FROM admin_scopes WHERE admin_id=? ORDER BY scope_type,scope_id', [a])).map((r) => ({ scope_type: r[0], scope_id: r[1], created_at: r[2] }));
}

export async function adminHasScopes(db, adminId) {
  return Boolean(await get(db, 'SELECT 1 FROM admin_scopes WHERE admin_id=? LIMIT 1', [id(adminId)]));
}

async function roots(db, adminId) {
  const rows = await all(db, 'SELECT scope_type,scope_id FROM admin_scopes WHERE admin_id=?', [id(adminId)]);
  const out = new Set();
  for (const [type, scopeId] of rows) {
    if (type === 'folder') out.add(scopeId);
    if (type === 'topic') {
      for (const row of await all(db, 'SELECT folder_id FROM topic_folders WHERE topic_id=?', [scopeId])) out.add(row[0]);
    }
  }
  return out;
}

async function contains(db, target, rootSet) {
  let current = target;
  const seen = new Set();
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (rootSet.has(current)) return true;
    seen.add(current);
    const row = await get(db, 'SELECT parent_id FROM folders WHERE id=?', [current]);
    if (!row) break;
    current = row[0];
  }
  return false;
}

export async function folderInAdminScope(db, adminId, folderId) {
  const a = id(adminId); const f = id(folderId);
  if (a === null || f === null) return false;
  return contains(db, f, await roots(db, a));
}

export async function resourceInAdminScope(db, adminId, contentId) {
  const a = id(adminId); const c = id(contentId);
  if (a === null || c === null) return false;
  const row = await get(db, 'SELECT folder_id FROM content WHERE id=?', [c]);
  if (!row) return false;
  if (await get(db, "SELECT 1 FROM admin_scopes WHERE admin_id=? AND scope_type='resource' AND scope_id=?", [a, c])) return true;
  return contains(db, row[0], await roots(db, a));
}

export async function isTopicInAdminScope(db, adminId, topicId) {
  const a = id(adminId); const t = id(topicId);
  if (a === null || t === null) return false;
  return Boolean(await get(db, "SELECT 1 FROM admin_scopes WHERE admin_id=? AND scope_type='topic' AND scope_id=?", [a, t]));
}

export async function listFolderIdsUnder(rootsInput) {
  return rootsInput;
}

export async function scopeRootFolderIds(db, adminId) {
  return roots(db, id(adminId));
}
