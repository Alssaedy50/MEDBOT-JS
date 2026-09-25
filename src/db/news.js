/**
 * News Core service layer: news rows, read tracking, subscriptions and the
 * private-delivery bookkeeping.
 *
 * The News Center reads real registry entities only. A news row never stores a
 * copy of a folder/resource name: it stores the id, and the accessors join the
 * live `folders`/`content` tables. That keeps MEDBOT's registry the single
 * source of truth and means an admin's rename shows up automatically.
 *
 * Two news kinds only: `notify` (🚨 Important/Urgent) and `section`
 * (📚 Section News). A resource is an optional *linked reference* on a section
 * item, never a kind of its own.
 */

import { get, isIntegrityError, run, withDb, withTransaction } from './core.js';
import { buildBreadcrumbPaths } from './registry.js';
import {
  MAX_NEWS_BODY_LENGTH,
  MAX_NEWS_DOCTOR_LENGTH,
  MAX_NEWS_EVENT_LENGTH,
  MAX_NEWS_TITLE_LENGTH,
  NEWS_DELIVERY_SCOPES,
  NEWS_DELIVERY_STATUSES,
  NEWS_DELIVERY_STALE_SECONDS,
  NEWS_SOURCE_AUTO,
  NEWS_STATUSES,
  NEWS_SUB_SECTION,
  NEWS_SUB_TYPE,
  NEWS_TYPES,
  NEWS_VISIBILITIES,
  intOrNull,
  normalizeNewsType,
} from '../constants.js';

// Column list kept in one place so every SELECT stays in `newsRowToDict` order
// even when the schema grows.
const NEWS_COLUMNS =
  'id, news_type, title, body, sender_id, subject_folder_id, ' +
  'section_folder_id, folder_id, doctor, event_at, resource_id, ' +
  'visibility, status, delivery_scope, source, payload, ' +
  'created_at, published_at, archived_at';

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, '');
}

/** Map a `news` row (full column order) to a plain object. */
function newsRowToDict(row) {
  if (!row) return null;
  return {
    id: row[0],
    news_type: row[1],
    title: row[2],
    body: row[3],
    sender_id: row[4],
    subject_folder_id: row[5],
    section_folder_id: row[6],
    folder_id: row[7],
    doctor: row[8],
    event_at: row[9],
    resource_id: row[10],
    visibility: row[11],
    status: row[12],
    delivery_scope: row[13],
    source: row[14],
    payload: row[15],
    created_at: row[16],
    published_at: row[17],
    archived_at: row[18],
  };
}

/**
 * Create a news row and return its id (or null on invalid input).
 *
 * `status` defaults to `draft`: the admin surface publishes explicitly with
 * `publishNews`, so nothing leaks to students before the admin has seen it.
 * Folder/resource references are validated against the real registry: a bogus
 * id is rejected rather than stored.
 */
export function createNews({
  newsType,
  title,
  body = null,
  senderId = null,
  subjectFolderId = null,
  sectionFolderId = null,
  doctor = null,
  eventAt = null,
  resourceId = null,
  visibility = 'all',
  status = 'draft',
  deliveryScope = 'all',
  source = 'manual',
  payload = null,
} = {}) {
  const canonicalType = normalizeNewsType(newsType);
  if (!NEWS_TYPES.includes(canonicalType)) return null;

  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle || cleanTitle.length > MAX_NEWS_TITLE_LENGTH) return null;

  const cleanBody = String(body ?? '').trim() || null;
  if (cleanBody && cleanBody.length > MAX_NEWS_BODY_LENGTH) return null;

  const cleanDoctor = String(doctor ?? '').trim() || null;
  if (cleanDoctor && cleanDoctor.length > MAX_NEWS_DOCTOR_LENGTH) return null;

  const cleanEvent = String(eventAt ?? '').trim() || null;
  if (cleanEvent && cleanEvent.length > MAX_NEWS_EVENT_LENGTH) return null;

  if (!NEWS_VISIBILITIES.includes(visibility)) return null;
  if (!NEWS_STATUSES.includes(status)) return null;
  if (!NEWS_DELIVERY_SCOPES.includes(deliveryScope)) return null;

  const subjectId = intOrNull(subjectFolderId);
  const sectionId = intOrNull(sectionFolderId);
  const resourceRefId = intOrNull(resourceId);
  const cleanSource = String(source ?? 'manual').trim() || 'manual';

  return withDb((db) => {
    // Validate the real references before persisting (registry = truth).
    if (subjectId !== null && !get(db, 'SELECT id FROM folders WHERE id = ?', [subjectId])) {
      return null;
    }
    if (sectionId !== null && !get(db, 'SELECT id FROM folders WHERE id = ?', [sectionId])) {
      return null;
    }
    if (
      resourceRefId !== null &&
      !get(db, 'SELECT id FROM content WHERE id = ?', [resourceRefId])
    ) {
      return null;
    }

    // The canonical navigation anchor: an explicit section wins, then subject.
    const anchor = sectionId !== null ? sectionId : subjectId;

    try {
      return run(
        db,
        `INSERT INTO news (
           news_type, title, body, sender_id, subject_folder_id,
           section_folder_id, folder_id, doctor, event_at, resource_id,
           visibility, status, delivery_scope, source, payload, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          canonicalType,
          cleanTitle,
          cleanBody,
          intOrNull(senderId),
          subjectId,
          sectionId,
          anchor,
          cleanDoctor,
          cleanEvent,
          resourceRefId,
          visibility,
          status,
          deliveryScope,
          cleanSource,
          payload,
          status === 'published' ? nowIso() : null,
        ],
      ).lastInsertRowid;
    } catch (error) {
      // Only the auto-resource partial unique index can conflict here: a
      // concurrent creation won the race, so return the row it created.
      if (!isIntegrityError(error) || cleanSource !== NEWS_SOURCE_AUTO) throw error;
      const row = get(
        db,
        `SELECT ${NEWS_COLUMNS} FROM news WHERE resource_id = ? AND source = ? ORDER BY id ASC LIMIT 1`,
        [resourceRefId, NEWS_SOURCE_AUTO],
      );
      return row ? row[0] : null;
    }
  });
}

/** One news row as a dict, or null. */
export function getNews(newsId, db = null) {
  const read = (conn) => {
    const row = get(conn, `SELECT ${NEWS_COLUMNS} FROM news WHERE id = ?`, [
      intOrNull(newsId),
    ]);
    return newsRowToDict(row);
  };
  if (db) return read(db);
  return withDb(read);
}

/**
 * A news row with its REAL registry context resolved.
 *
 * Adds `subject_name`, `section_name`, `folder_path`, `resource_title`,
 * `resource_folder_id` and `resource_present` from the live tables. A reference
 * whose row was deleted resolves to null (the news survives; it simply offers
 * no access button), so a stale id can never fabricate a path or a resource.
 */
export function getNewsDetail(newsId, db = null) {
  const read = (conn) => {
    const news = getNews(newsId, conn);
    if (!news) return null;

    const folderIds = new Set(
      [news.subject_folder_id, news.section_folder_id, news.folder_id].filter(Boolean),
    );

    const names = {};
    for (const fid of folderIds) {
      const row = get(conn, 'SELECT name FROM folders WHERE id = ?', [fid]);
      if (row) names[fid] = row[0];
    }

    const paths = folderIds.size ? buildBreadcrumbPaths(conn, folderIds) : {};

    news.subject_name = names[news.subject_folder_id] ?? null;
    news.section_name = names[news.section_folder_id] ?? null;
    const anchor = news.folder_id;
    news.folder_path = anchor ? paths[anchor] ?? null : null;

    news.resource_title = null;
    news.resource_folder_id = null;
    news.resource_present = false;
    if (news.resource_id) {
      const row = get(conn, 'SELECT title, folder_id FROM content WHERE id = ?', [
        news.resource_id,
      ]);
      if (row) {
        news.resource_title = row[0];
        news.resource_folder_id = row[1];
        news.resource_present = true;
      }
    }

    return news;
  };

  if (db) return read(db);
  return withDb(read);
}

/**
 * Chronological news feed, newest-first by default.
 *
 * `status='published'` (default) is the student view. `status=null`/`'all'`
 * returns every lifecycle state (admin view); `includeArchived=false` still
 * excludes archived rows in that case so an archived item never leaks into a
 * normal listing.
 */
export function listNews({
  status = 'published',
  newsType = null,
  sectionFolderId = null,
  resourceId = null,
  includeArchived = false,
  limit = 20,
  offset = 0,
  order = 'newest',
} = {}) {
  let safeLimit = Number.parseInt(limit, 10);
  if (Number.isNaN(safeLimit)) safeLimit = 20;
  safeLimit = Math.max(1, Math.min(safeLimit, 200));

  let safeOffset = Number.parseInt(offset, 10);
  if (Number.isNaN(safeOffset)) safeOffset = 0;
  safeOffset = Math.max(0, safeOffset);

  const clauses = [];
  const params = [];

  if (status && status !== 'all') {
    clauses.push('status = ?');
    params.push(status);
  } else if (!includeArchived) {
    clauses.push("status != 'archived'");
  }

  if (newsType) {
    clauses.push('news_type = ?');
    params.push(newsType);
  }
  if (sectionFolderId !== null && sectionFolderId !== undefined) {
    clauses.push('(section_folder_id = ? OR folder_id = ?)');
    params.push(intOrNull(sectionFolderId), intOrNull(sectionFolderId));
  }
  if (resourceId !== null && resourceId !== undefined) {
    clauses.push('resource_id = ?');
    params.push(intOrNull(resourceId));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const direction = String(order).toLowerCase() === 'oldest' ? 'ASC' : 'DESC';

  return withDb((db) =>
    db
      .prepare(
        `SELECT ${NEWS_COLUMNS} FROM news ${where} ` +
          `ORDER BY COALESCE(published_at, created_at) ${direction}, id ${direction} ` +
          'LIMIT ? OFFSET ?',
      )
      .all(...params, safeLimit, safeOffset)
      .map(newsRowToDict),
  );
}

/** Total rows matching `listNews`' filter (for pagination). */
export function countNews({ status = 'published', newsType = null, includeArchived = false } = {}) {
  const clauses = [];
  const params = [];

  if (status && status !== 'all') {
    clauses.push('status = ?');
    params.push(status);
  } else if (!includeArchived) {
    clauses.push("status != 'archived'");
  }
  if (newsType) {
    clauses.push('news_type = ?');
    params.push(newsType);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = withDb((db) => get(db, `SELECT COUNT(*) FROM news ${where}`, params));
  return row ? row[0] : 0;
}

/**
 * Update only the supplied editable fields of a news row.
 *
 * Whitelisted so an admin action can never rewrite lifecycle columns.
 * Folder/resource references are re-validated against the real registry.
 */
export function updateNews(newsId, fields = {}) {
  const editable = new Set([
    'title',
    'body',
    'news_type',
    'subject_folder_id',
    'section_folder_id',
    'doctor',
    'event_at',
    'resource_id',
    'visibility',
    'delivery_scope',
    'source',
    'payload',
  ]);

  const updates = {};
  for (const [key, value] of Object.entries(fields)) {
    if (editable.has(key)) updates[key] = value;
  }
  if (!Object.keys(updates).length) return false;

  const id = intOrNull(newsId);
  if (id === null) return false;

  if ('news_type' in updates) {
    updates.news_type = normalizeNewsType(updates.news_type);
    if (!NEWS_TYPES.includes(updates.news_type)) return false;
  }
  if ('visibility' in updates && !NEWS_VISIBILITIES.includes(updates.visibility)) {
    return false;
  }
  if (
    'delivery_scope' in updates &&
    !NEWS_DELIVERY_SCOPES.includes(updates.delivery_scope)
  ) {
    return false;
  }
  if ('title' in updates) {
    const title = String(updates.title ?? '').trim();
    if (!title || title.length > MAX_NEWS_TITLE_LENGTH) return false;
    updates.title = title;
  }

  return withDb((db) => {
    for (const [table, column] of [
      ['folders', 'subject_folder_id'],
      ['folders', 'section_folder_id'],
      ['content', 'resource_id'],
    ]) {
      if (column in updates && updates[column] !== null && updates[column] !== '') {
        const value = intOrNull(updates[column]);
        if (value === null) return false;
        if (!get(db, `SELECT id FROM ${table} WHERE id = ?`, [value])) return false;
        updates[column] = value;
      }
    }

    // Keep the navigation anchor aligned with the (possibly new) section.
    if ('section_folder_id' in updates) {
      updates.folder_id = updates.section_folder_id;
    } else if ('subject_folder_id' in updates) {
      const row = get(db, 'SELECT section_folder_id FROM news WHERE id = ?', [id]);
      if (!(row && row[0])) updates.folder_id = updates.subject_folder_id;
    }

    const assignments = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(', ');
    const params = [...Object.values(updates), id];
    return run(db, `UPDATE news SET ${assignments} WHERE id = ?`, params).changes > 0;
  });
}

/**
 * Move a news row to `published`. Idempotent: republishing keeps the original
 * `published_at` so the feed order never jumps on a retry.
 */
export function publishNews(newsId) {
  return withDb(
    (db) =>
      run(
        db,
        "UPDATE news SET status = 'published', published_at = COALESCE(published_at, ?), " +
          'archived_at = NULL WHERE id = ?',
        [nowIso(), intOrNull(newsId)],
      ).changes > 0,
  );
}

/** Archive a news row: hidden from the feed, kept for the audit trail. */
export function archiveNews(newsId) {
  return withDb(
    (db) =>
      run(
        db,
        "UPDATE news SET status = 'archived', archived_at = ? WHERE id = ?",
        [nowIso(), intOrNull(newsId)],
      ).changes > 0,
  );
}

/** Return an archived news row to `draft` (never straight to students). */
export function restoreNews(newsId) {
  return withDb(
    (db) =>
      run(
        db,
        "UPDATE news SET status = 'draft', archived_at = NULL WHERE id = ?",
        [intOrNull(newsId)],
      ).changes > 0,
  );
}

/** Hard-delete a news row (its read records and deliveries cascade). */
export function deleteNews(newsId) {
  return withDb(
    (db) => run(db, 'DELETE FROM news WHERE id = ?', [intOrNull(newsId)]).changes > 0,
  );
}

/** Record that `userId` opened `newsId`. Idempotent by primary key. */
export function markNewsRead(userId, newsId) {
  try {
    withDb((db) =>
      run(db, 'INSERT OR IGNORE INTO news_reads (user_id, news_id) VALUES (?, ?)', [
        intOrNull(userId),
        intOrNull(newsId),
      ]),
    );
    return true;
  } catch {
    return false;
  }
}

export function isNewsRead(userId, newsId) {
  const row = withDb((db) =>
    get(db, 'SELECT 1 FROM news_reads WHERE user_id = ? AND news_id = ?', [
      intOrNull(userId),
      intOrNull(newsId),
    ]),
  );
  return Boolean(row);
}

/**
 * Published, not-archived news the user has not opened yet.
 *
 * Counts only published rows, so the home badge can never advertise a draft or
 * an archived item.
 */
export function getUnreadNewsCount(userId) {
  const row = withDb((db) =>
    get(
      db,
      `SELECT COUNT(*) FROM news n
       WHERE n.status = 'published'
         AND NOT EXISTS (
           SELECT 1 FROM news_reads r WHERE r.news_id = n.id AND r.user_id = ?
         )`,
      [intOrNull(userId)],
    ),
  );
  return row ? row[0] : 0;
}

/** The subset of `newsIds` this user has read (empty set when none). */
export function getReadNewsIds(userId, newsIds = []) {
  const ids = (newsIds ?? []).map(intOrNull).filter((id) => id !== null);
  if (!ids.length) return new Set();

  const placeholders = ids.map(() => '?').join(',');
  return withDb(
    (db) =>
      new Set(
        db
          .prepare(
            `SELECT news_id FROM news_reads WHERE user_id = ? AND news_id IN (${placeholders})`,
          )
          .all(intOrNull(userId), ...ids)
          .map((row) => row[0]),
      ),
  );
}

/**
 * Mark every currently-published news row as read.
 *
 * Returns the count of newly created read records.
 */
export function markAllNewsRead(userId) {
  return withDb((db) => {
    const ids = db
      .prepare("SELECT id FROM news WHERE status = 'published'")
      .all()
      .map((row) => row[0]);

    let created = 0;
    for (const newsId of ids) {
      created += run(
        db,
        'INSERT OR IGNORE INTO news_reads (user_id, news_id) VALUES (?, ?)',
        [intOrNull(userId), newsId],
      ).changes;
    }
    return created;
  });
}

/** The user's subscribed topics as `[kind, value]` pairs. */
export function getNewsSubscriptions(userId) {
  return withDb((db) =>
    db
      .prepare(
        'SELECT topic_kind, topic_value FROM news_subscriptions ' +
          'WHERE user_id = ? ORDER BY topic_kind, topic_value',
      )
      .all(intOrNull(userId))
      .map((row) => [row[0], row[1]]),
  );
}

/** `{newsType: count}` over published news (admin overview). */
export function getNewsCountsByType() {
  const rows = withDb((db) =>
    db
      .prepare(
        "SELECT news_type, COUNT(*) FROM news WHERE status = 'published' GROUP BY news_type",
      )
      .all(),
  );
  const result = {};
  for (const [newsType, count] of rows) result[newsType] = count;
  return result;
}

/**
 * Subscribe a user to a news topic. Idempotent and validated.
 *
 * `topic_kind='type'` accepts a real news kind; `'section'` accepts a real
 * folder id. A bogus kind or a folder that does not exist is rejected, so a
 * subscription can never point at a non-existent entity.
 */
export function addNewsSubscription(userId, topicKind, topicValue) {
  const kind = String(topicKind ?? '').trim();
  if (![NEWS_SUB_TYPE, NEWS_SUB_SECTION].includes(kind)) return false;

  let value = String(topicValue ?? '').trim();
  if (!value) return false;

  try {
    return withDb((db) => {
      if (kind === NEWS_SUB_TYPE) {
        value = normalizeNewsType(value);
        if (!NEWS_TYPES.includes(value)) return false;
      } else {
        const folderId = intOrNull(value);
        if (folderId === null) return false;
        if (!get(db, 'SELECT id FROM folders WHERE id = ?', [folderId])) return false;
      }

      run(
        db,
        'INSERT OR IGNORE INTO news_subscriptions (user_id, topic_kind, topic_value) VALUES (?, ?, ?)',
        [intOrNull(userId), kind, value],
      );
      return true;
    });
  } catch {
    return false;
  }
}

/** Unsubscribe a user from a news topic. True when a row was removed. */
export function removeNewsSubscription(userId, topicKind, topicValue) {
  return withDb(
    (db) =>
      run(
        db,
        'DELETE FROM news_subscriptions WHERE user_id = ? AND topic_kind = ? AND topic_value = ?',
        [intOrNull(userId), String(topicKind), String(topicValue)],
      ).changes > 0,
  );
}

/**
 * `{userId: [[kind, value], ...]}` for target resolution without N+1.
 *
 * When `userIds` is given the result is limited to those users (and a user with
 * no rows is simply absent, not filled with an empty list).
 */
export function getNewsSubscriptionsMap(userIds = null) {
  return withDb((db) => {
    let rows;
    if (userIds === null || userIds === undefined) {
      rows = db.prepare('SELECT user_id, topic_kind, topic_value FROM news_subscriptions').all();
    } else {
      const ids = (userIds ?? []).map(intOrNull).filter((id) => id !== null);
      if (!ids.length) return {};
      const placeholders = ids.map(() => '?').join(',');
      rows = db
        .prepare(
          'SELECT user_id, topic_kind, topic_value FROM news_subscriptions ' +
            `WHERE user_id IN (${placeholders})`,
        )
        .all(...ids);
    }

    const mapping = {};
    for (const [userId, kind, value] of rows) {
      if (!mapping[userId]) mapping[userId] = [];
      mapping[userId].push([kind, value]);
    }
    return mapping;
  });
}

/**
 * The user ids subscribed to receive `newsType` privately.
 *
 * Important (`notify`)     -> subscribers of the `notify` type.
 * Section (`section`)      -> subscribers of the `section` type, plus
 *                             subscribers of that exact section folder. A
 *                             section news with no reference reaches only the
 *                             broad `section` subscribers.
 *
 * One query per subscription shape (never per user), de-duplicated.
 */
export function resolveNewsRecipients(newsType, sectionFolderId = null) {
  const kind = String(newsType ?? '').trim();
  if (!NEWS_TYPES.includes(kind)) return [];

  const clauses = ['(topic_kind = ? AND topic_value = ?)'];
  const params = [NEWS_SUB_TYPE, kind];

  if (kind === 'section' && sectionFolderId !== null && sectionFolderId !== undefined) {
    const folderId = intOrNull(sectionFolderId);
    if (folderId !== null) {
      clauses.push('(topic_kind = ? AND topic_value = ?)');
      params.push(NEWS_SUB_SECTION, String(folderId));
    }
  }

  return withDb((db) =>
    db
      .prepare(
        `SELECT DISTINCT user_id FROM news_subscriptions WHERE ${clauses.join(' OR ')} ORDER BY user_id`,
      )
      .all(...params)
      .map((row) => row[0]),
  );
}

/**
 * Create a `pending` delivery row per recipient; return the NEW ones.
 *
 * `INSERT OR IGNORE` on the `(news_id, user_id)` primary key makes the
 * reservation idempotent: a recipient already recorded is not returned again,
 * so a retry or a repeated publish never queues a second delivery.
 */
export function reserveNewsDeliveries(newsId, userIds, kind = null) {
  const id = intOrNull(newsId);
  if (id === null) return [];

  return withDb((db) => {
    const reserved = [];
    for (const rawUserId of userIds ?? []) {
      const userId = intOrNull(rawUserId);
      if (userId === null) continue;
      const info = run(
        db,
        "INSERT OR IGNORE INTO news_deliveries (news_id, user_id, status, kind) VALUES (?, ?, 'pending', ?)",
        [id, userId, kind],
      );
      if (info.changes) reserved.push(userId);
    }
    return reserved;
  });
}

/**
 * Recipient ids still owed the item: `pending` (and `failed` when
 * `retryFailed`). `sent`/`skipped` rows are terminal and never resent.
 */
export function getPendingNewsDeliveries(newsId, retryFailed = true) {
  const id = intOrNull(newsId);
  if (id === null) return [];
  const statuses = retryFailed ? ['pending', 'failed'] : ['pending'];

  return withDb((db) =>
    db
      .prepare(
        'SELECT user_id FROM news_deliveries WHERE news_id = ? AND status IN (?, ?) ORDER BY user_id',
      )
      .all(id, statuses[0], statuses[statuses.length - 1])
      .map((row) => row[0]),
  );
}

/**
 * Reserve a send by moving the row to the transient `sending` state.
 *
 * Returns true when the claim was taken (from `pending`/`failed`/`sending`, or
 * by creating the row) and false for a terminal `sent`/`skipped` row. Written
 * BEFORE the Telegram call, so a crash mid-send leaves a recoverable `sending`
 * row instead of a false `sent` or a silent loss.
 */
export function claimNewsDelivery(newsId, userId) {
  const id = intOrNull(newsId);
  const uid = intOrNull(userId);
  if (id === null || uid === null) return false;

  return withDb((db) => {
    // Single atomic upsert: create the row as `sending`, or move a non-terminal
    // row to `sending`. A terminal `sent`/`skipped` row is left untouched.
    const info = run(
      db,
      "INSERT INTO news_deliveries (news_id, user_id, status) VALUES (?, ?, 'sending') " +
        'ON CONFLICT(news_id, user_id) DO UPDATE SET ' +
        "status = 'sending', updated_at = CURRENT_TIMESTAMP " +
        "WHERE news_deliveries.status IN ('pending', 'failed', 'sending')",
      [id, uid],
    );
    return info.changes > 0;
  });
}

/**
 * Record the outcome of one delivery attempt (upsert semantics).
 *
 * Increments `attempts` on `sent`/`failed` (not on the transient `sending`
 * claim). A `sent` row is terminal: it is never overwritten.
 */
export function markNewsDelivery(
  newsId,
  userId,
  status,
  { error = null, channelMessageId = null, countAttempt = true } = {},
) {
  if (!NEWS_DELIVERY_STATUSES.includes(status)) return false;
  const id = intOrNull(newsId);
  const uid = intOrNull(userId);
  if (id === null || uid === null) return false;

  const cleanError = error === null ? null : String(error).slice(0, 500);
  const bump = countAttempt ? 1 : 0;

  return withDb((db) => {
    const row = get(
      db,
      'SELECT status FROM news_deliveries WHERE news_id = ? AND user_id = ?',
      [id, uid],
    );

    if (!row) {
      run(
        db,
        'INSERT INTO news_deliveries (news_id, user_id, status, attempts, error, ' +
          'channel_message_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [id, uid, status, bump, cleanError, channelMessageId],
      );
      return true;
    }

    if (row[0] === 'sent') return true; // terminal; keep the successful record

    run(
      db,
      'UPDATE news_deliveries SET status = ?, attempts = attempts + ?, error = ?, ' +
        'channel_message_id = COALESCE(?, channel_message_id), updated_at = CURRENT_TIMESTAMP ' +
        'WHERE news_id = ? AND user_id = ?',
      [status, bump, cleanError, channelMessageId, id, uid],
    );
    return true;
  });
}

/**
 * Move crashed `sending` claims back to `pending`. Returns the count.
 *
 * A send that was claimed but never resolved (process crash mid-Telegram call)
 * is otherwise stuck forever. Anything older than `olderThanSeconds` is assumed
 * crashed and becomes recoverable.
 */
export function resetStaleNewsDeliveries(olderThanSeconds = null) {
  let threshold =
    olderThanSeconds === null || olderThanSeconds === undefined
      ? NEWS_DELIVERY_STALE_SECONDS
      : Number.parseInt(olderThanSeconds, 10);
  if (Number.isNaN(threshold)) threshold = NEWS_DELIVERY_STALE_SECONDS;
  threshold = Math.max(0, threshold);

  return withDb(
    (db) =>
      run(
        db,
        "UPDATE news_deliveries SET status = 'pending', updated_at = CURRENT_TIMESTAMP " +
          "WHERE status = 'sending' AND updated_at <= datetime('now', ?)",
        [`-${threshold} seconds`],
      ).changes,
  );
}

/**
 * Published news ids with an undelivered row, oldest first (bounded).
 *
 * The startup-recovery work list: only `pending`/`failed` rows of a *published*
 * item qualify. `sent`/`skipped` never appear, so recovery can never resend a
 * completed delivery.
 */
export function listRecoverableNewsIds(limit = 50) {
  let safeLimit = Number.parseInt(limit, 10);
  if (Number.isNaN(safeLimit)) safeLimit = 50;
  safeLimit = Math.max(1, Math.min(safeLimit, 500));

  return withDb((db) =>
    db
      .prepare(
        'SELECT DISTINCT d.news_id, MIN(d.updated_at) AS oldest ' +
          'FROM news_deliveries d JOIN news n ON n.id = d.news_id ' +
          "WHERE d.status IN ('pending', 'failed') AND n.status = 'published' " +
          'GROUP BY d.news_id ORDER BY oldest ASC LIMIT ?',
      )
      .all(safeLimit)
      .map((row) => row[0]),
  );
}

/** `{status: count}` for one news item (admin delivery log). */
export function getNewsDeliveryCounts(newsId) {
  const id = intOrNull(newsId);
  if (id === null) return {};
  const rows = withDb((db) =>
    db
      .prepare('SELECT status, COUNT(*) FROM news_deliveries WHERE news_id = ? GROUP BY status')
      .all(id),
  );
  const result = {};
  for (const [status, count] of rows) result[status] = count;
  return result;
}

/** Delivery rows for one news item, newest attempt first (bounded). */
export function getNewsDeliveries(newsId, status = null, limit = 50) {
  const id = intOrNull(newsId);
  if (id === null) return [];
  let safeLimit = Number.parseInt(limit, 10);
  if (Number.isNaN(safeLimit)) safeLimit = 50;
  safeLimit = Math.max(1, Math.min(safeLimit, 200));

  const clause = NEWS_DELIVERY_STATUSES.includes(status) ? ' AND status = ?' : '';
  const params = clause ? [id, status, safeLimit] : [id, safeLimit];

  return withDb((db) =>
    db
      .prepare(
        'SELECT user_id, status, kind, attempts, error, updated_at ' +
          `FROM news_deliveries WHERE news_id = ?${clause} ` +
          'ORDER BY updated_at DESC, user_id ASC LIMIT ?',
      )
      .all(...params)
      .map((row) => ({
        user_id: row[0],
        status: row[1],
        kind: row[2],
        attempts: row[3],
        error: row[4],
        updated_at: row[5],
      })),
  );
}

/** The auto-generated resource news row for a content id, or null. */
export function getResourceNewsForContent(contentId) {
  const id = intOrNull(contentId);
  if (id === null) return null;
  const row = withDb((db) =>
    get(
      db,
      `SELECT ${NEWS_COLUMNS} FROM news WHERE resource_id = ? AND source = ? ORDER BY id ASC LIMIT 1`,
      [id, NEWS_SOURCE_AUTO],
    ),
  );
  return newsRowToDict(row);
}

/**
 * Create (once) the auto news row for a registered resource.
 *
 * A resource is no longer a news kind of its own: this produces a 📚 Section
 * News row anchored to the resource's REAL folder and carrying the resource as
 * its optional linked reference.
 *
 * Idempotency is enforced by the database, not by this check: migration v15's
 * partial unique index on `news(resource_id) WHERE source='resource'` makes a
 * second auto row impossible even under a concurrent race. The pre-check is
 * just a fast path; if a concurrent caller wins, `createNews` returns the
 * winner's row. Returns null when the content row does not exist.
 */
export function createResourceNewsForContent(contentId, senderId = null, status = 'draft') {
  const id = intOrNull(contentId);
  if (id === null) return null;

  const existing = getResourceNewsForContent(id);
  if (existing) return existing.id;

  const row = withDb((db) =>
    get(db, 'SELECT id, folder_id, title FROM content WHERE id = ?', [id]),
  );
  if (!row) return null;

  const [, folderId, title] = row;

  let subjectId = null;
  if (folderId !== null) {
    const parent = withDb((db) =>
      get(db, 'SELECT parent_id FROM folders WHERE id = ?', [folderId]),
    );
    if (parent && parent[0] !== null && parent[0] !== undefined) subjectId = parent[0];
  }

  return createNews({
    newsType: 'section',
    title: title || 'مورد جديد',
    senderId,
    subjectFolderId: subjectId,
    sectionFolderId: folderId,
    resourceId: id,
    status,
    source: NEWS_SOURCE_AUTO,
  });
}
