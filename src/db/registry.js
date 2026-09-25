/**
 * Registry: folders, content, breadcrumbs and the folder hierarchy.
 *
 * The registry is MEDBOT's single source of truth. Every read here returns
 * positional arrays in the same column order the Python implementation used, so
 * the calling code (and the tests) match one-for-one.
 *
 * Root folders are stored with `parent_id IS NULL` (never 0).
 */

import { get, run, withDb } from './core.js';

const FOLDER_COLS = 'id, parent_id, name, node_type, accepts_contributions';

/** Children of `parentId` (0/null = roots). */
export function getFolders(parentId = null) {
  return withDb((db) => {
    if (parentId === null || parentId === undefined || parentId === 0) {
      return db
        .prepare(
          'SELECT id, name, node_type, accepts_contributions FROM folders ' +
            'WHERE parent_id IS NULL ORDER BY id ASC',
        )
        .all();
    }
    return db
      .prepare(
        'SELECT id, name, node_type, accepts_contributions FROM folders ' +
          'WHERE parent_id = ? ORDER BY id ASC',
      )
      .all(parentId);
  });
}

/** Resources directly inside `folderId`, newest first. */
export function getFiles(folderId) {
  return withDb((db) =>
    db
      .prepare(
        'SELECT id, title, file_id, file_type, source_type, source_contribution_id, created_by ' +
          'FROM content WHERE folder_id = ? ORDER BY id DESC',
      )
      .all(folderId),
  );
}

export function getFolder(folderId) {
  return withDb((db) =>
    get(db, `SELECT ${FOLDER_COLS} FROM folders WHERE id = ?`, [folderId]),
  );
}

/** Parent folder id, or 0 for a root / missing folder. */
export function getParentId(folderId) {
  const row = withDb((db) =>
    get(db, 'SELECT parent_id FROM folders WHERE id = ?', [folderId]),
  );
  if (!row || row[0] === null || row[0] === undefined) return 0;
  return row[0];
}

/**
 * Resolve many folder paths with one connection and no N+1 queries.
 *
 * Returns `{folderId: "الرئيسية 🏠 ⬅️ A ⬅️ B"}`. Root is "الرئيسية 🏠".
 * Cycle-safe: a corrupted parent chain stops repeating a node.
 */
export function buildBreadcrumbPaths(db, folderIds) {
  const parents = new Map();
  const names = new Map();

  for (const row of db.prepare('SELECT id, parent_id, name FROM folders').all()) {
    parents.set(row[0], row[1]);
    names.set(row[0], row[2]);
  }

  const paths = { 0: 'الرئيسية 🏠' };

  for (const folderId of folderIds) {
    if (folderId in paths) continue;

    const chain = [];
    const visited = new Set();
    let current = folderId;

    while (current && !visited.has(current)) {
      visited.add(current);
      chain.push(names.get(current) ?? String(current));
      current = parents.get(current);
    }

    chain.push('الرئيسية 🏠');
    chain.reverse();
    paths[folderId] = chain.join(' ⬅️ ');
  }

  return paths;
}

/** Breadcrumb path for one folder, opening its own connection. */
export function getBreadcrumbs(folderId) {
  if (!folderId) return 'الرئيسية 🏠';
  return withDb((db) => {
    const paths = buildBreadcrumbPaths(db, [folderId]);
    return paths[folderId] ?? 'الرئيسية 🏠';
  });
}

/**
 * Everything the library folder screen needs, in one connection.
 *
 * Returns `{folder, children, files, parentId, breadcrumb}`.
 */
export function getFolderView(folderId) {
  return withDb((db) => {
    const folder = get(db, `SELECT ${FOLDER_COLS} FROM folders WHERE id = ?`, [
      folderId,
    ]);
    const children = db
      .prepare(
        'SELECT id, name, node_type, accepts_contributions FROM folders ' +
          'WHERE parent_id = ? ORDER BY id ASC',
      )
      .all(folderId);
    const files = db
      .prepare(
        'SELECT id, title, file_id, file_type, source_type, source_contribution_id, created_by ' +
          'FROM content WHERE folder_id = ? ORDER BY id DESC',
      )
      .all(folderId);

    const parentId = folder && folder[1] !== null && folder[1] !== undefined ? folder[1] : 0;
    const paths = buildBreadcrumbPaths(db, [folderId]);

    return {
      folder,
      children,
      files,
      parentId,
      breadcrumb: paths[folderId] ?? 'الرئيسية 🏠',
    };
  });
}

/**
 * Rows for intent-aware search, in one connection.
 *
 * Folder rows:  (id, parent_id, name, node_type, description, keywords)
 * Content rows: (id, folder_id, title, file_type, description, keywords)
 */
export function getSearchableRecords() {
  return withDb((db) => {
    const folders = db
      .prepare(
        'SELECT id, parent_id, name, node_type, description, keywords ' +
          'FROM folders ORDER BY id ASC',
      )
      .all();
    const contents = db
      .prepare(
        'SELECT id, folder_id, title, file_type, description, keywords ' +
          'FROM content ORDER BY id DESC',
      )
      .all();

    const ids = new Set([
      ...folders.map((row) => row[0]),
      ...contents.map((row) => row[1]),
    ]);
    const paths = buildBreadcrumbPaths(db, ids);

    return { folders, contents, paths };
  });
}

/** Create a folder and return its id. `parentId` 0/null means a root. */
export function addFolder(parentId, name, nodeType, acceptsContributions = 0) {
  const pid = parentId === null || parentId === undefined || parentId === 0 ? null : parentId;
  return withDb(
    (db) =>
      run(
        db,
        'INSERT INTO folders (parent_id, name, node_type, accepts_contributions) VALUES (?, ?, ?, ?)',
        [pid, name, nodeType, acceptsContributions],
      ).lastInsertRowid,
  );
}

/**
 * Delete an empty folder only. A non-existent or non-empty folder is refused.
 *
 * Any child folder, content or contribution blocks deletion (contributions are
 * ON DELETE CASCADE and must never be discarded).
 */
export function deleteFolder(folderId) {
  try {
    return withDb((db) => {
      const row = get(
        db,
        `SELECT
           (SELECT COUNT(*) FROM folders WHERE parent_id = ?) AS children,
           (SELECT COUNT(*) FROM content WHERE folder_id = ?) AS content,
           (SELECT COUNT(*) FROM contributions WHERE folder_id = ?) AS contribs,
           (SELECT COUNT(*) FROM folders WHERE id = ?) AS exists_flag`,
        [folderId, folderId, folderId, folderId],
      );
      if (!row || Number(row[3]) === 0) return false;
      if (Number(row[0]) > 0 || Number(row[1]) > 0 || Number(row[2]) > 0) return false;
      run(db, 'DELETE FROM folders WHERE id = ?', [folderId]);
      return true;
    });
  } catch {
    return false;
  }
}

export function getFolderChildrenCount(folderId) {
  const row = withDb((db) =>
    get(db, 'SELECT COUNT(*) FROM folders WHERE parent_id = ?', [folderId]),
  );
  return row ? Number(row[0]) : 0;
}

export function updateFolderName(folderId, newName) {
  return withDb(
    (db) =>
      run(db, 'UPDATE folders SET name = ? WHERE id = ?', [newName, folderId]).changes > 0,
  );
}

export function updateFolderType(folderId, nodeType) {
  return withDb(
    (db) =>
      run(db, 'UPDATE folders SET node_type = ? WHERE id = ?', [nodeType, folderId])
        .changes > 0,
  );
}

export function updateFolderAcceptsContributions(folderId, value) {
  withDb((db) =>
    run(db, 'UPDATE folders SET accepts_contributions = ? WHERE id = ?', [value, folderId]),
  );
}

export function folderAcceptsContributions(folderId) {
  const row = withDb((db) =>
    get(db, 'SELECT accepts_contributions FROM folders WHERE id = ?', [folderId]),
  );
  return Boolean(row && row[0]);
}

/**
 * True if this folder or any descendant accepts contributions.
 *
 * Lets the contribution wizard hide branches that lead nowhere, so a student
 * can never drill into a dead end looking for a place to upload.
 */
export function folderHasContributionTarget(folderId) {
  return withDb((db) => {
    const pending = [folderId];
    const seen = new Set();

    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);

      const row = get(db, 'SELECT accepts_contributions FROM folders WHERE id = ?', [
        current,
      ]);
      if (row && row[0]) return true;

      for (const child of db
        .prepare('SELECT id FROM folders WHERE parent_id = ?')
        .all(current)) {
        pending.push(child[0]);
      }
    }

    return false;
  });
}

/** True when `folderId` is `ancestorId` itself or lies beneath it. */
export function isDescendant(db, ancestorId, folderId) {
  let current = folderId;
  const visited = new Set();
  while (current !== null && current !== undefined) {
    if (current === ancestorId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    const row = get(db, 'SELECT parent_id FROM folders WHERE id = ?', [current]);
    if (!row) break;
    current = row[0];
  }
  return false;
}

/** Connection-owning wrapper over `isDescendant`. */
export function isDescendantOf(ancestorId, folderId) {
  return withDb((db) => isDescendant(db, ancestorId, folderId));
}

/** Move a folder. Returns `[ok, message]`. */
export function moveFolder(folderId, newParentId) {
  try {
    return withDb((db) => {
      if (folderId === newParentId) return [false, 'لا يمكن نقل المجلد إلى نفسه'];
      if (newParentId !== 0) {
        const target = get(db, 'SELECT id FROM folders WHERE id = ?', [newParentId]);
        if (!target) return [false, 'المجلد الهدف غير موجود'];
        if (isDescendant(db, folderId, newParentId)) {
          return [false, 'لا يمكن نقل مجلد إلى داخل أحد تفرعاته'];
        }
      }
      const pid = newParentId === 0 ? null : newParentId;
      run(db, 'UPDATE folders SET parent_id = ? WHERE id = ?', [pid, folderId]);
      return [true, 'تم نقل المجلد بنجاح'];
    });
  } catch (error) {
    return [false, `خطأ في النقل: ${error.message}`];
  }
}

/** Register a content row and return its id. */
export function addContent(
  folderId,
  title,
  fileId,
  fileType,
  sourceType = 'direct',
  sourceContributionId = null,
  createdBy = null,
) {
  return withDb(
    (db) =>
      run(
        db,
        'INSERT INTO content (folder_id, title, file_id, file_type, source_type, ' +
          'source_contribution_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [folderId, title, fileId, fileType, sourceType, sourceContributionId, createdBy],
      ).lastInsertRowid,
  );
}

export function getFileRecord(contentId) {
  return withDb((db) =>
    get(
      db,
      'SELECT id, folder_id, title, file_id, file_type, source_type, ' +
        'source_contribution_id, created_by FROM content WHERE id = ?',
      [contentId],
    ),
  );
}

export function updateFileTitle(contentId, newTitle) {
  return withDb(
    (db) =>
      run(db, 'UPDATE content SET title = ? WHERE id = ?', [newTitle, contentId]).changes > 0,
  );
}

export function updateContentType(contentId, fileType) {
  return withDb(
    (db) =>
      run(db, 'UPDATE content SET file_type = ? WHERE id = ?', [fileType, contentId])
        .changes > 0,
  );
}

/** Move a resource to another folder. Returns `[ok, message]`. */
export function moveContent(contentId, newFolderId) {
  try {
    return withDb((db) => {
      if (!get(db, 'SELECT id FROM folders WHERE id = ?', [newFolderId])) {
        return [false, 'المجلد الهدف غير موجود'];
      }
      if (!get(db, 'SELECT id FROM content WHERE id = ?', [contentId])) {
        return [false, 'الملف غير موجود'];
      }
      run(db, 'UPDATE content SET folder_id = ? WHERE id = ?', [newFolderId, contentId]);
      return [true, 'تم نقل الملف بنجاح'];
    });
  } catch (error) {
    return [false, `خطأ: ${error.message}`];
  }
}

export function deleteFile(contentId) {
  return withDb(
    (db) => run(db, 'DELETE FROM content WHERE id = ?', [contentId]).changes > 0,
  );
}

/**
 * Legacy substring search over resource title / folder name / ancestor path.
 *
 * Result shape: (content_id, title, file_type, folder_id, folder_name, full_path)
 */
export function searchContent(keyword) {
  const trimmed = String(keyword ?? '').trim();
  if (!trimmed) return [];

  return withDb((db) => {
    const like = `%${trimmed}%`;
    return db
      .prepare(
        `WITH RECURSIVE folder_paths AS (
           SELECT id AS folder_id, parent_id, name, name AS path_text FROM folders
           UNION ALL
           SELECT fp.folder_id, f.parent_id, f.name, f.name || ' / ' || fp.path_text
           FROM folder_paths fp JOIN folders f ON f.id = fp.parent_id
         ),
         resolved_paths AS (
           SELECT folder_id, MAX(path_text) AS path_text
           FROM folder_paths GROUP BY folder_id
         )
         SELECT DISTINCT
           c.id, c.title, c.file_type, c.folder_id,
           f.name AS folder_name,
           COALESCE(rp.path_text, f.name) AS full_path
         FROM content c
         JOIN folders f ON c.folder_id = f.id
         LEFT JOIN resolved_paths rp ON rp.folder_id = f.id
         WHERE c.title LIKE ?
           OR EXISTS (
             SELECT 1 FROM folder_paths fp
             WHERE fp.folder_id = c.folder_id AND fp.path_text LIKE ?
           )
         ORDER BY c.id DESC
         LIMIT 30`,
      )
      .all(like, like);
  });
}

/**
 * One resource with its real registered path, for the archive mirror.
 *
 * Returns `[contentId, folderId, title, fileId, fileType, path]` or null.
 * `path` is the exact breadcrumb used across the platform, so the archive post
 * follows MEDBOT's real hierarchy; it is never synthesised.
 */
export function getResourceSnapshot(contentId) {
  return withDb((db) => {
    const row = get(
      db,
      'SELECT id, folder_id, title, file_id, file_type FROM content WHERE id = ?',
      [contentId],
    );
    if (!row) return null;
    const paths = buildBreadcrumbPaths(db, [row[1]]);
    return [row[0], row[1], row[2], row[3], row[4], paths[row[1]] ?? 'الرئيسية 🏠'];
  });
}

/** Every registered resource with its registered path, in hierarchy order. */
export function getAllResourceSnapshots() {
  return withDb((db) => {
    const rows = db
      .prepare(
        'SELECT id, folder_id, title, file_id, file_type FROM content ' +
          'ORDER BY folder_id ASC, id ASC',
      )
      .all();
    const paths = buildBreadcrumbPaths(
      db,
      new Set(rows.map((row) => row[1])),
    );
    return rows.map((row) => [
      row[0],
      row[1],
      row[2],
      row[3],
      row[4],
      paths[row[1]] ?? 'الرئيسية 🏠',
    ]);
  });
}

/** The real folder of a content row, or null when it no longer exists. */
export function contentFolderId(contentId) {
  const row = withDb((db) =>
    get(db, 'SELECT folder_id FROM content WHERE id = ?', [contentId]),
  );
  return row ? row[0] : null;
}
