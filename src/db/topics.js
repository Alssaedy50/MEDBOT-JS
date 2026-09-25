/**
 * Search Topics (مواضيع البحث): curated high-level academic entry points.
 *
 * A topic connects to registered resources through the folders it points at;
 * deleting a topic or a folder only removes the link rows (ON DELETE CASCADE),
 * never the folders or their resources.
 */

import { get, run, withDb } from './core.js';

function topicRowToDict(row) {
  if (!row) return null;
  return {
    id: row[0],
    name: row[1],
    description: row[2],
    icon: row[3] || '🧭',
    display_order: row[4] || 0,
    active: Boolean(row[5]),
  };
}

/** Topics in display order. `activeOnly` hides deactivated topics. */
export function getTopics(activeOnly = false) {
  return withDb((db) => {
    let sql =
      'SELECT id, name, description, icon, display_order, active FROM topics';
    if (activeOnly) sql += ' WHERE active = 1';
    sql += ' ORDER BY display_order ASC, id ASC';
    return db.prepare(sql).all().map(topicRowToDict);
  });
}

export function getTopic(topicId) {
  const row = withDb((db) =>
    get(
      db,
      'SELECT id, name, description, icon, display_order, active FROM topics WHERE id = ?',
      [Number.parseInt(topicId, 10)],
    ),
  );
  return topicRowToDict(row);
}

/** Create a topic. Returns the new id, or null on invalid input. */
export function addTopic(name, description = null, icon = null, displayOrder = 0) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.length > 120) return null;

  return withDb(
    (db) =>
      run(
        db,
        'INSERT INTO topics (name, description, icon, display_order, active) VALUES (?, ?, ?, ?, 1)',
        [cleanName, description, icon || '🧭', Number.parseInt(displayOrder, 10) || 0],
      ).lastInsertRowid,
  );
}

/** Update the supplied topic fields only. */
export function updateTopic(
  topicId,
  { name = null, description = null, icon = null, displayOrder = null, active = null } = {},
) {
  const fields = [];
  const params = [];

  if (name !== null && name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName || cleanName.length > 120) return false;
    fields.push('name = ?');
    params.push(cleanName);
  }
  if (description !== null && description !== undefined) {
    fields.push('description = ?');
    params.push(description);
  }
  if (icon !== null && icon !== undefined) {
    fields.push('icon = ?');
    params.push(icon);
  }
  if (displayOrder !== null && displayOrder !== undefined) {
    fields.push('display_order = ?');
    params.push(Number.parseInt(displayOrder, 10));
  }
  if (active !== null && active !== undefined) {
    fields.push('active = ?');
    params.push(active ? 1 : 0);
  }

  if (!fields.length) return false;
  params.push(Number.parseInt(topicId, 10));

  return withDb(
    (db) =>
      run(db, `UPDATE topics SET ${fields.join(', ')} WHERE id = ?`, params).changes > 0,
  );
}

/** Remove a topic. Folder links cascade; folders/resources are untouched. */
export function deleteTopic(topicId) {
  return withDb(
    (db) => run(db, 'DELETE FROM topics WHERE id = ?', [Number.parseInt(topicId, 10)]).changes > 0,
  );
}

/** Associate a folder (and thus its resources) with a topic. */
export function linkTopicFolder(topicId, folderId) {
  return withDb((db) => {
    if (!get(db, 'SELECT id FROM folders WHERE id = ?', [Number.parseInt(folderId, 10)])) {
      return false;
    }
    run(db, 'INSERT OR IGNORE INTO topic_folders (topic_id, folder_id) VALUES (?, ?)', [
      Number.parseInt(topicId, 10),
      Number.parseInt(folderId, 10),
    ]);
    return true;
  });
}

export function unlinkTopicFolder(topicId, folderId) {
  return withDb(
    (db) =>
      run(db, 'DELETE FROM topic_folders WHERE topic_id = ? AND folder_id = ?', [
        Number.parseInt(topicId, 10),
        Number.parseInt(folderId, 10),
      ]).changes > 0,
  );
}

/** Folders linked to a topic, in the same shape `getFolders` returns. */
export function getTopicFolders(topicId) {
  return withDb((db) =>
    db
      .prepare(
        'SELECT f.id, f.name, f.node_type, f.accepts_contributions ' +
          'FROM topic_folders tf JOIN folders f ON f.id = tf.folder_id ' +
          'WHERE tf.topic_id = ? ORDER BY f.id ASC',
      )
      .all(Number.parseInt(topicId, 10)),
  );
}

/**
 * Number of registered resources reachable from a topic.
 *
 * Counts every content row in any linked folder or its descendants, so a topic
 * reports the real size of its academic area.
 */
export function topicResourceCount(topicId) {
  return withDb((db) => {
    const roots = db
      .prepare('SELECT folder_id FROM topic_folders WHERE topic_id = ?')
      .all(Number.parseInt(topicId, 10))
      .map((row) => row[0]);

    let total = 0;
    const visited = new Set();
    const pending = [...roots];

    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);

      const row = get(db, 'SELECT COUNT(*) FROM content WHERE folder_id = ?', [current]);
      total += row ? row[0] : 0;

      for (const child of db
        .prepare('SELECT id FROM folders WHERE parent_id = ?')
        .all(current)) {
        pending.push(child[0]);
      }
    }
    return total;
  });
}
