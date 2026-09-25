/**
 * Notifications log (admin -> users broadcast history) and the Emergency
 * Resource Archive mirror (`archive_sync`).
 *
 * The broadcast itself lives in `src/notifications.js`; this module is storage.
 */

import { get, run, withDb } from './core.js';
import { ARCHIVE_STATUSES } from '../constants.js';

/**
 * Persist a sent notification. Returns its id, or null on failure.
 */
export function recordNotification(
  senderId,
  title,
  body,
  audience = 'all',
  recipients = 0,
  delivered = 0,
) {
  const cleanBody = String(body ?? '').trim();
  if (!cleanBody) return null;

  return withDb(
    (db) =>
      run(
        db,
        'INSERT INTO notifications (sender_id, title, body, audience, recipients, delivered) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        [
          senderId,
          String(title ?? '').trim() || null,
          cleanBody,
          audience,
          Number.parseInt(recipients, 10) || 0,
          Number.parseInt(delivered, 10) || 0,
        ],
      ).lastInsertRowid,
  );
}

/** Most recent notifications first. */
export function getNotifications(limit = 20) {
  let safeLimit = Number.parseInt(limit, 10);
  if (Number.isNaN(safeLimit)) safeLimit = 20;
  safeLimit = Math.max(1, Math.min(safeLimit, 200));

  return withDb((db) =>
    db
      .prepare(
        'SELECT id, sender_id, title, body, audience, recipients, delivered, created_at ' +
          'FROM notifications ORDER BY id DESC LIMIT ?',
      )
      .all(safeLimit),
  );
}

export function getNotificationsCount() {
  const row = withDb((db) => get(db, 'SELECT COUNT(*) FROM notifications'));
  return row ? row[0] : 0;
}

// ---------------------------------------------------------------------------
// Emergency Resource Archive mirror (disaster recovery)
// ---------------------------------------------------------------------------
// MEDBOT's registry is the source of truth. `archive_sync` only records what was
// mirrored into the standalone Telegram archive channel, so publication is
// idempotent, observable and resyncable. The helpers below never touch
// `content` or `folders`.

const ARCHIVE_COLUMNS =
  'id, object_type, content_fingerprint, folder_id, content_ids, channel_id, ' +
  'channel_message_id, status, attempts, error, created_at, updated_at, published_at';

/** Sync row for one fingerprint, or null. */
export function getArchiveSync(fingerprint) {
  return withDb((db) =>
    get(
      db,
      `SELECT ${ARCHIVE_COLUMNS} FROM archive_sync WHERE content_fingerprint = ?`,
      [fingerprint],
    ),
  );
}

/**
 * Register a mirror candidate without clobbering an existing publication.
 *
 * A resource that was already published (or is mid-retry) keeps its row, so
 * re-registering the same resource can never enqueue a second post. The new
 * content id is appended to `content_ids`. Returns the row id.
 */
export function upsertArchivePending(
  fingerprint,
  { folderId = null, contentId = null, objectType = 'content' } = {},
) {
  return withDb((db) => {
    const row = get(
      db,
      'SELECT id, content_ids FROM archive_sync WHERE content_fingerprint = ?',
      [fingerprint],
    );

    if (row) {
      const rowId = row[0];
      const ids = String(row[1] ?? '')
        .split(',')
        .filter((part) => part.trim());
      if (contentId !== null && contentId !== undefined && !ids.includes(String(contentId))) {
        ids.push(String(contentId));
        run(
          db,
          'UPDATE archive_sync SET content_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [ids.join(','), rowId],
        );
      }
      return rowId;
    }

    return run(
      db,
      'INSERT INTO archive_sync (object_type, content_fingerprint, folder_id, content_ids, status) ' +
        "VALUES (?, ?, ?, ?, 'pending')",
      [objectType, fingerprint, folderId, contentId === null ? '' : String(contentId)],
    ).lastInsertRowid;
  });
}

/**
 * Record a successful mirror. Idempotent: only the first publish wins.
 *
 * Returns true when this call performed the transition from a non-published
 * state; false when the row was already published (a duplicate/retry).
 */
export function markArchivePublished(fingerprint, channelId, channelMessageId) {
  return withDb((db) => {
    const row = get(
      db,
      'SELECT id, status FROM archive_sync WHERE content_fingerprint = ?',
      [fingerprint],
    );

    if (!row) {
      run(
        db,
        'INSERT INTO archive_sync (object_type, content_fingerprint, channel_id, ' +
          'channel_message_id, status, attempts, published_at, updated_at) VALUES ' +
          "('content', ?, ?, ?, 'published', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        [fingerprint, String(channelId), channelMessageId],
      );
      return true;
    }

    if (row[1] === 'published') {
      run(
        db,
        'UPDATE archive_sync SET channel_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [channelMessageId, row[0]],
      );
      return false;
    }

    run(
      db,
      "UPDATE archive_sync SET status = 'published', channel_id = ?, channel_message_id = ?, " +
        'error = NULL, attempts = attempts + 1, published_at = CURRENT_TIMESTAMP, ' +
        'updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [String(channelId), channelMessageId, row[0]],
    );
    return true;
  });
}

/** Record a failed mirror attempt without disturbing the resource. */
export function markArchiveFailed(fingerprint, error) {
  withDb((db) =>
    run(
      db,
      "UPDATE archive_sync SET status = 'failed', attempts = attempts + 1, error = ?, " +
        'updated_at = CURRENT_TIMESTAMP WHERE content_fingerprint = ?',
      [String(error).slice(0, 500), fingerprint],
    ),
  );
}

/** List mirror rows, optionally filtered by status (newest first). */
export function getArchiveSyncRows(status = null, limit = 200) {
  return withDb((db) => {
    if (status) {
      return db
        .prepare(
          `SELECT ${ARCHIVE_COLUMNS} FROM archive_sync WHERE status = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(status, Number.parseInt(limit, 10));
    }
    return db
      .prepare(`SELECT ${ARCHIVE_COLUMNS} FROM archive_sync ORDER BY id DESC LIMIT ?`)
      .all(Number.parseInt(limit, 10));
  });
}

/** Counts per status, for the admin dashboard. */
export function getArchiveSyncCounts() {
  const rows = withDb((db) =>
    db.prepare('SELECT status, COUNT(*) FROM archive_sync GROUP BY status').all(),
  );
  const counts = Object.fromEntries(ARCHIVE_STATUSES.map((status) => [status, 0]));
  for (const [status, count] of rows) counts[String(status)] = Number(count);
  counts.total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return counts;
}
