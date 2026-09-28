/**
 * D1-backed MEDBOT library/registry domain functions.
 *
 * The return shapes intentionally match the SQLite registry module so the
 * eventual Worker router can reuse presentation logic without a second data
 * contract.
 */
import { all, get, run } from './core.js';

const FOLDER_COLS = 'id, parent_id, name, node_type, accepts_contributions';

export async function getFolders(db, parentId = null) {
  if (parentId === null || parentId === undefined || parentId === 0) {
    return all(
      db,
      'SELECT id, name, node_type, accepts_contributions FROM folders ' +
        'WHERE parent_id IS NULL ORDER BY id ASC',
    );
  }
  return all(
    db,
    'SELECT id, name, node_type, accepts_contributions FROM folders ' +
      'WHERE parent_id = ? ORDER BY id ASC',
    [parentId],
  );
}

export async function getFiles(db, folderId) {
  return all(
    db,
    'SELECT id, title, file_id, file_type, source_type, source_contribution_id, created_by ' +
      'FROM content WHERE folder_id = ? ORDER BY id DESC',
    [folderId],
  );
}

export async function getFolder(db, folderId) {
  return get(db, `SELECT ${FOLDER_COLS} FROM folders WHERE id = ?`, [folderId]);
}

export async function getParentId(db, folderId) {
  const row = await get(db, 'SELECT parent_id FROM folders WHERE id = ?', [folderId]);
  return row && row[0] !== null && row[0] !== undefined ? row[0] : 0;
}

export async function buildBreadcrumbPaths(db, folderIds) {
  const rows = await all(db, 'SELECT id, parent_id, name FROM folders');
  const parents = new Map();
  const names = new Map();
  for (const [id, parentId, name] of rows) {
    parents.set(id, parentId);
    names.set(id, name);
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

export async function getBreadcrumbs(db, folderId) {
  if (!folderId) return 'الرئيسية 🏠';
  const paths = await buildBreadcrumbPaths(db, [folderId]);
  return paths[folderId] ?? 'الرئيسية 🏠';
}

export async function getFolderView(db, folderId) {
  const [folder, children, files, paths] = await Promise.all([
    getFolder(db, folderId),
    all(
      db,
      'SELECT id, name, node_type, accepts_contributions FROM folders ' +
        'WHERE parent_id = ? ORDER BY id ASC',
      [folderId],
    ),
    getFiles(db, folderId),
    buildBreadcrumbPaths(db, [folderId]),
  ]);

  const parentId = folder && folder[1] !== null && folder[1] !== undefined ? folder[1] : 0;
  return {
    folder,
    children,
    files,
    parentId,
    breadcrumb: paths[folderId] ?? 'الرئيسية 🏠',
  };
}

export async function getSearchableRecords(db) {
  const [folders, contents] = await Promise.all([
    all(
      db,
      'SELECT id, parent_id, name, node_type, description, keywords FROM folders ORDER BY id ASC',
    ),
    all(
      db,
      'SELECT id, folder_id, title, file_type, description, keywords FROM content ORDER BY id DESC',
    ),
  ]);
  const ids = new Set([...folders.map((row) => row[0]), ...contents.map((row) => row[1])]);
  const paths = await buildBreadcrumbPaths(db, ids);
  return { folders, contents, paths };
}

export async function addFolder(db, parentId, name, nodeType, acceptsContributions = 0) {
  const pid = parentId === null || parentId === undefined || parentId === 0 ? null : parentId;
  return (await run(
    db,
    'INSERT INTO folders (parent_id, name, node_type, accepts_contributions) VALUES (?, ?, ?, ?)',
    [pid, name, nodeType, acceptsContributions],
  )).lastInsertRowid;
}

export async function updateFolderName(db, folderId, newName) {
  return (await run(db, 'UPDATE folders SET name = ? WHERE id = ?', [newName, folderId])).changes > 0;
}

export async function updateFolderType(db, folderId, nodeType) {
  return (await run(db, 'UPDATE folders SET node_type = ? WHERE id = ?', [nodeType, folderId])).changes > 0;
}

export async function updateFolderAcceptsContributions(db, folderId, value) {
  await run(db, 'UPDATE folders SET accepts_contributions = ? WHERE id = ?', [value, folderId]);
}

export async function folderAcceptsContributions(db, folderId) {
  const row = await get(db, 'SELECT accepts_contributions FROM folders WHERE id = ?', [folderId]);
  return Boolean(row?.[0]);
}

export async function getFolderChildrenCount(db, folderId) {
  const row = await get(db, 'SELECT COUNT(*) FROM folders WHERE parent_id = ?', [folderId]);
  return Number(row?.[0] ?? 0);
}

export async function addContent(
  db,
  folderId,
  title,
  fileId,
  fileType,
  sourceType = 'direct',
  sourceContributionId = null,
  createdBy = null,
) {
  return (await run(
    db,
    'INSERT INTO content (folder_id, title, file_id, file_type, source_type, ' +
      'source_contribution_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [folderId, title, fileId, fileType, sourceType, sourceContributionId, createdBy],
  )).lastInsertRowid;
}

export async function getFileRecord(db, contentId) {
  return get(
    db,
    'SELECT id, folder_id, title, file_id, file_type, source_type, ' +
      'source_contribution_id, created_by FROM content WHERE id = ?',
    [contentId],
  );
}

export async function updateFileTitle(db, contentId, newTitle) {
  return (await run(db, 'UPDATE content SET title = ? WHERE id = ?', [newTitle, contentId])).changes > 0;
}

export async function updateContentType(db, contentId, fileType) {
  return (await run(db, 'UPDATE content SET file_type = ? WHERE id = ?', [fileType, contentId])).changes > 0;
}

export async function deleteFile(db, contentId) {
  return (await run(db, 'DELETE FROM content WHERE id = ?', [contentId])).changes > 0;
}

export async function getResourceSnapshot(db, contentId) {
  const row = await get(
    db,
    'SELECT id, folder_id, title, file_id, file_type FROM content WHERE id = ?',
    [contentId],
  );
  if (!row) return null;
  const paths = await buildBreadcrumbPaths(db, [row[1]]);
  return [row[0], row[1], row[2], row[3], row[4], paths[row[1]] ?? 'الرئيسية 🏠'];
}

export async function getAllResourceSnapshots(db) {
  const rows = await all(
    db,
    'SELECT id, folder_id, title, file_id, file_type FROM content ORDER BY folder_id ASC, id ASC',
  );
  const paths = await buildBreadcrumbPaths(db, new Set(rows.map((row) => row[1])));
  return rows.map((row) => [
    row[0],
    row[1],
    row[2],
    row[3],
    row[4],
    paths[row[1]] ?? 'الرئيسية 🏠',
  ]);
}

/**
 * Search remains SQL-backed rather than filtering an in-memory copy.
 * This keeps the Worker memory footprint bounded by the result limit.
 */
export async function searchContent(db, keyword) {
  const trimmed = String(keyword ?? '').trim();
  if (!trimmed) return [];
  const like = `%${trimmed}%`;
  return all(
    db,
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
    [like, like],
  );
}
