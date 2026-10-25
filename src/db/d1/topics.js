import { all, get, run } from './core.js';

export async function getTopics(db, activeOnly = false) {
  const sql = activeOnly
    ? 'SELECT id,name,description,icon,display_order,active FROM topics WHERE active=1 ORDER BY display_order ASC,id ASC'
    : 'SELECT id,name,description,icon,display_order,active FROM topics ORDER BY display_order ASC,id ASC';
  return all(db, sql);
}

export async function getTopic(db, topicId) {
  return get(db, 'SELECT id,name,description,icon,display_order,active FROM topics WHERE id=?', [Number.parseInt(topicId, 10)]);
}

export async function getTopicFolders(db, topicId) {
  return all(
    db,
    'SELECT f.id,f.name,f.node_type,f.accepts_contributions FROM topic_folders tf JOIN folders f ON f.id=tf.folder_id WHERE tf.topic_id=? ORDER BY f.id ASC',
    [Number.parseInt(topicId, 10)],
  );
}

export async function getTopicResourceCount(db, topicId) {
  const id = Number.parseInt(topicId, 10);
  try {
    const row = await get(
      db,
      `WITH RECURSIVE tree(folder_id) AS (
         SELECT folder_id FROM topic_folders WHERE topic_id=?
         UNION
         SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.folder_id
       )
       SELECT COUNT(*) FROM content WHERE folder_id IN (SELECT folder_id FROM tree)`,
      [id],
    );
    if (row && row[0] !== undefined) return Number(row[0] ?? 0);
  } catch {
    // Fallback for lightweight test mocks
  }
  const rows = await all(db, 'SELECT folder_id FROM topic_folders WHERE topic_id=?', [id]);
  const pending = rows.map((r) => r[0]);
  const seen = new Set();
  let total = 0;
  while (pending.length) {
    const fid = pending.pop();
    if (seen.has(fid)) continue;
    seen.add(fid);
    const c = await get(db, 'SELECT COUNT(*) FROM content WHERE folder_id=?', [fid]);
    total += Number(c?.[0] ?? 0);
    for (const r of await all(db, 'SELECT id FROM folders WHERE parent_id=?', [fid])) pending.push(r[0]);
  }
  return total;
}

export async function createTopic(db, name, description = null, icon = '🧭') {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) return null;
  const maxOrder = await get(db, 'SELECT COALESCE(MAX(display_order), 0) FROM topics');
  const nextOrder = Number(maxOrder?.[0] ?? 0) + 1;
  const r = await run(
    db,
    'INSERT INTO topics (name, description, icon, display_order, active) VALUES (?, ?, ?, ?, 1)',
    [cleanName, String(description ?? '').trim() || null, icon || '🧭', nextOrder],
  );
  return r.lastInsertRowid;
}

export async function toggleTopicActive(db, topicId) {
  const row = await get(db, 'SELECT active FROM topics WHERE id=?', [Number(topicId)]);
  if (!row) return null;
  const next = Number(row[0]) ? 0 : 1;
  await run(db, 'UPDATE topics SET active=? WHERE id=?', [next, Number(topicId)]);
  return Boolean(next);
}

export async function linkTopicFolder(db, topicId, folderId) {
  await run(db, 'INSERT OR IGNORE INTO topic_folders (topic_id, folder_id) VALUES (?, ?)', [Number(topicId), Number(folderId)]);
  return true;
}

export async function unlinkTopicFolder(db, topicId, folderId) {
  await run(db, 'DELETE FROM topic_folders WHERE topic_id=? AND folder_id=?', [Number(topicId), Number(folderId)]);
  return true;
}

export async function deleteTopic(db, topicId) {
  return (await run(db, 'DELETE FROM topics WHERE id=?', [Number(topicId)])).changes > 0;
}
