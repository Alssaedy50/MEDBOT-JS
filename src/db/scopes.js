/**
 * Phase 3 — scope storage and resolution.
 *
 * Touches only `admin_scopes` plus the live registry. A scope restricts an
 * admin to a real registry object:
 *
 *   folder   -> that folder and all of its descendants
 *   topic    -> every folder linked to that Search Topic (and descendants)
 *   resource -> that one content row
 *
 * No foreign key is declared on `scope_id` on purpose: it is a polymorphic
 * reference. Every read validates against the live registry, so a scope whose
 * target was later deleted simply matches nothing (fail-closed).
 *
 * An admin with NO scope rows is platform-wide (the pre-Phase-3 behaviour), so
 * the scope layer is opt-in and revokes nothing by its mere existence.
 */

import { get, run, withDb } from './core.js';
import { SCOPE_TYPES, intOrNull } from '../constants.js';

const SCOPE_TABLE = { folder: 'folders', topic: 'topics', resource: 'content' };

/**
 * Grant an admin a scope over a real registry object.
 *
 * Validates the target against the live registry before persisting, so a scope
 * can never point at a non-existent folder/topic/resource. Idempotent via the
 * UNIQUE constraint.
 */
export function addAdminScope(adminId, scopeType, scopeId, createdBy = null) {
  const admin = intOrNull(adminId);
  const target = intOrNull(scopeId);
  if (admin === null || target === null) return false;
  if (!SCOPE_TYPES.includes(scopeType)) return false;

  try {
    return withDb((db) => {
      const table = SCOPE_TABLE[scopeType];
      if (!get(db, `SELECT id FROM ${table} WHERE id = ?`, [target])) return false;
      try {
        run(
          db,
          'INSERT INTO admin_scopes (admin_id, scope_type, scope_id, created_by) VALUES (?, ?, ?, ?)',
          [admin, scopeType, target, intOrNull(createdBy)],
        );
      } catch {
        return true; // already present (UNIQUE) -> idempotent success
      }
      return true;
    });
  } catch {
    return false;
  }
}

/** Revoke one scope. True when a row was removed. */
export function removeAdminScope(adminId, scopeType, scopeId) {
  const admin = intOrNull(adminId);
  const target = intOrNull(scopeId);
  if (admin === null || target === null || !SCOPE_TYPES.includes(scopeType)) return false;
  try {
    return withDb(
      (db) =>
        run(
          db,
          'DELETE FROM admin_scopes WHERE admin_id = ? AND scope_type = ? AND scope_id = ?',
          [admin, scopeType, target],
        ).changes > 0,
    );
  } catch {
    return false;
  }
}

/** Remove every scope of an admin. Returns the number removed. */
export function clearAdminScopes(adminId) {
  const admin = intOrNull(adminId);
  if (admin === null) return 0;
  try {
    return withDb(
      (db) => run(db, 'DELETE FROM admin_scopes WHERE admin_id = ?', [admin]).changes,
    );
  } catch {
    return 0;
  }
}

/** The admin's scope rows as objects (empty array when none). */
export function getAdminScopes(adminId) {
  const admin = intOrNull(adminId);
  if (admin === null) return [];
  return withDb((db) =>
    db
      .prepare(
        'SELECT scope_type, scope_id, created_at FROM admin_scopes ' +
          'WHERE admin_id = ? ORDER BY scope_type ASC, scope_id ASC',
      )
      .all(admin)
      .map((row) => ({ scope_type: row[0], scope_id: row[1], created_at: row[2] })),
  );
}

/** True when the admin is *restricted* by at least one scope. */
export function adminHasScopes(adminId) {
  const admin = intOrNull(adminId);
  if (admin === null) return false;
  return withDb((db) =>
    Boolean(get(db, 'SELECT 1 FROM admin_scopes WHERE admin_id = ? LIMIT 1', [admin])),
  );
}

/**
 * Folder ids that anchor the admin's scopes, inside an existing connection.
 *
 * `folder` scopes contribute their id directly; `topic` scopes expand to every
 * folder linked to that topic; `resource` scopes contribute nothing here — they
 * are matched directly by the resource tester, never by folder containment.
 */
export function scopeRootFolderIds(db, adminId) {
  const roots = new Set();
  const scopes = db
    .prepare('SELECT scope_type, scope_id FROM admin_scopes WHERE admin_id = ?')
    .all(adminId);

  for (const [scopeType, scopeId] of scopes) {
    if (scopeType === 'folder') {
      roots.add(scopeId);
    } else if (scopeType === 'topic') {
      for (const row of db
        .prepare('SELECT folder_id FROM topic_folders WHERE topic_id = ?')
        .all(scopeId)) {
        roots.add(row[0]);
      }
    }
  }
  return roots;
}

/** Folder ids anchoring the admin's scopes (the resolution entry point). */
export function topicFolderRoots(adminId) {
  const admin = intOrNull(adminId);
  if (admin === null) return new Set();
  return withDb((db) => scopeRootFolderIds(db, admin));
}

/** True when `folderId` is at or beneath any of the admin's scope roots. */
export function folderInAdminScope(adminId, folderId) {
  const admin = intOrNull(adminId);
  const target = intOrNull(folderId);
  if (admin === null || target === null) return false;

  return withDb((db) => {
    const roots = scopeRootFolderIds(db, admin);
    if (!roots.size) return false;

    // Walk the target's ancestor chain once; a root anywhere on it means the
    // target lies inside the scope. Cycle-safe.
    let current = target;
    const visited = new Set();
    while (current !== null && current !== undefined && !visited.has(current)) {
      if (roots.has(current)) return true;
      visited.add(current);
      const row = get(db, 'SELECT parent_id FROM folders WHERE id = ?', [current]);
      if (!row) break;
      current = row[0];
    }
    return false;
  });
}

/**
 * True when an admin's scopes cover this specific resource.
 *
 * Covered when a `resource` scope names it directly OR when a folder/topic
 * scope contains the resource's real folder.
 */
export function resourceInAdminScope(adminId, contentId) {
  const admin = intOrNull(adminId);
  const target = intOrNull(contentId);
  if (admin === null || target === null) return false;

  return withDb((db) => {
    const row = get(db, 'SELECT folder_id FROM content WHERE id = ?', [target]);
    // The target no longer exists: a dangling scope must not grant access
    // (fail-closed), even a direct `resource` scope.
    if (!row) return false;

    if (
      get(
        db,
        "SELECT 1 FROM admin_scopes WHERE admin_id = ? AND scope_type = 'resource' AND scope_id = ? LIMIT 1",
        [admin, target],
      )
    ) {
      return true;
    }

    const roots = scopeRootFolderIds(db, admin);
    if (!roots.size) return false;

    let current = row[0];
    const visited = new Set();
    while (current !== null && current !== undefined && !visited.has(current)) {
      if (roots.has(current)) return true;
      visited.add(current);
      const parent = get(db, 'SELECT parent_id FROM folders WHERE id = ?', [current]);
      if (!parent) break;
      current = parent[0];
    }
    return false;
  });
}

/** True when the admin holds a `topic` scope on this exact topic. */
export function isTopicInAdminScope(adminId, topicId) {
  const admin = intOrNull(adminId);
  const target = intOrNull(topicId);
  if (admin === null || target === null) return false;
  return withDb((db) =>
    Boolean(
      get(
        db,
        "SELECT 1 FROM admin_scopes WHERE admin_id = ? AND scope_type = 'topic' AND scope_id = ? LIMIT 1",
        [admin, target],
      ),
    ),
  );
}

/**
 * All folder ids in the subtree rooted at any of `roots` (inclusive).
 *
 * Breadth-first so a deep branch is covered in one pass; cycle-safe.
 */
export function listFolderIdsUnder(roots) {
  const rootSet = new Set([...(roots ?? [])].filter(Boolean));
  if (!rootSet.size) return new Set();

  return withDb((db) => {
    const seen = new Set();
    const pending = [...rootSet];
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const row of db
        .prepare('SELECT id FROM folders WHERE parent_id = ?')
        .all(current)) {
        pending.push(row[0]);
      }
    }
    return seen;
  });
}

/** The content id a news row references, or null. */
export function newsResourceId(newsId) {
  const id = intOrNull(newsId);
  if (id === null) return null;
  const row = withDb((db) => get(db, 'SELECT resource_id FROM news WHERE id = ?', [id]));
  return row && row[0] ? row[0] : null;
}

/**
 * Every real folder id a news row points at (subject/section/anchor + the
 * folder of its referenced resource).
 */
export function newsScopeFolderIds(newsId) {
  const id = intOrNull(newsId);
  if (id === null) return new Set();

  return withDb((db) => {
    const row = get(
      db,
      'SELECT subject_folder_id, section_folder_id, folder_id, resource_id FROM news WHERE id = ?',
      [id],
    );
    if (!row) return new Set();

    const folders = new Set(row.slice(0, 3).filter(Boolean));
    if (row[3]) {
      const crow = get(db, 'SELECT folder_id FROM content WHERE id = ?', [row[3]]);
      if (crow) folders.add(crow[0]);
    }
    return folders;
  });
}

/**
 * Ids of news rows anchored in any of `folderIds`.
 *
 * Matches when the section/subject/anchor folder is in the set, or when the
 * referenced resource lives in one of them.
 */
export function listNewsIdsInFolders(folderIds) {
  const ids = new Set([...(folderIds ?? [])].filter(Boolean));
  if (!ids.size) return new Set();

  return withDb((db) => {
    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    const found = new Set();

    for (const row of db
      .prepare(
        `SELECT DISTINCT id FROM news WHERE section_folder_id IN (${placeholders}) ` +
          `OR subject_folder_id IN (${placeholders}) OR folder_id IN (${placeholders})`,
      )
      .all(...list, ...list, ...list)) {
      found.add(row[0]);
    }

    for (const row of db
      .prepare(
        `SELECT DISTINCT n.id FROM news n JOIN content c ON c.id = n.resource_id ` +
          `WHERE c.folder_id IN (${placeholders})`,
      )
      .all(...list)) {
      found.add(row[0]);
    }

    return found;
  });
}

/**
 * News ids a scope-restricted admin may manage.
 *
 * Mirrors the per-news `authorization` test in one pass: a row qualifies when
 * any of its real folder references falls inside the admin's folder/topic
 * scope, OR when its referenced resource is itself a direct `resource` scope.
 * Never returns an out-of-scope row.
 */
export function listNewsIdsForAdmin(adminId) {
  const admin = intOrNull(adminId);
  if (admin === null) return new Set();

  const roots = topicFolderRoots(admin);
  const folders = listFolderIdsUnder(roots);
  const ids = listNewsIdsInFolders(folders);

  return withDb((db) => {
    const resourceIds = db
      .prepare(
        "SELECT scope_id FROM admin_scopes WHERE admin_id = ? AND scope_type = 'resource'",
      )
      .all(admin)
      .map((row) => row[0]);

    if (resourceIds.length) {
      const placeholders = resourceIds.map(() => '?').join(',');
      for (const row of db
        .prepare(`SELECT DISTINCT id FROM news WHERE resource_id IN (${placeholders})`)
        .all(...resourceIds)) {
        ids.add(row[0]);
      }
    }
    return ids;
  });
}

/** The real destination folder of a contribution row, or null. */
export function contributionFolderId(contributionId) {
  const id = intOrNull(contributionId);
  if (id === null) return null;
  const row = withDb((db) =>
    get(db, 'SELECT folder_id FROM contributions WHERE id = ?', [id]),
  );
  return row ? row[0] : null;
}
