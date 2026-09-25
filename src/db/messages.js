/**
 * Contact Admin messaging storage. Isolated from content/contributions.
 *
 * Lifecycle: NEW -> IN_REVIEW -> REPLIED -> CLOSED. A CLOSED message can never
 * be replied to again.
 */

import { get, run, withDb, withTransaction } from './core.js';
import {
  MAX_MESSAGE_BODY_LENGTH,
  MAX_MESSAGE_REPLY_LENGTH,
  MESSAGE_CATEGORIES,
  MESSAGE_OPEN_STATUSES,
  MESSAGE_STATUSES,
} from '../constants.js';

export class MessageValidationError extends Error {}

/** Store a new student message. Throws MessageValidationError. */
export function createMessage(userId, userName, category, body) {
  if (!MESSAGE_CATEGORIES.includes(category)) {
    throw new MessageValidationError('⚠️ نوع الرسالة غير مدعوم.');
  }

  const cleanBody = String(body ?? '').trim();
  if (!cleanBody) throw new MessageValidationError('⚠️ لا يمكن إرسال رسالة فارغة.');
  if (cleanBody.length > MAX_MESSAGE_BODY_LENGTH) {
    throw new MessageValidationError(
      `⚠️ الرسالة طويلة جداً. الحد الأقصى ${MAX_MESSAGE_BODY_LENGTH} حرفاً.`,
    );
  }

  return withDb(
    (db) =>
      run(
        db,
        "INSERT INTO messages (user_id, user_name, category, body, status) VALUES (?, ?, ?, ?, 'NEW')",
        [userId, userName, category, cleanBody],
      ).lastInsertRowid,
  );
}

/** Fetch a message by id. Non-numeric input yields null (never a crash). */
export function getMessage(messageId) {
  const id = Number.parseInt(messageId, 10);
  if (Number.isNaN(id)) return null;
  return withDb((db) =>
    get(
      db,
      'SELECT id, user_id, user_name, category, body, status, admin_reply, ' +
        'reviewed_by, created_at, updated_at FROM messages WHERE id = ?',
      [id],
    ),
  );
}

/** A student's own messages, newest first. */
export function getUserMessages(userId, limit = 20) {
  return withDb((db) =>
    db
      .prepare(
        'SELECT id, category, body, status, admin_reply, created_at FROM messages ' +
          'WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(userId, limit),
  );
}

/** Admin view: messages filtered by status, or all when status is null. */
export function getMessagesByStatus(status = null, limit = 50) {
  return withDb((db) => {
    if (status) {
      return db
        .prepare(
          'SELECT id, user_id, user_name, category, body, status, created_at ' +
            'FROM messages WHERE status = ? ORDER BY id DESC LIMIT ?',
        )
        .all(status, limit);
    }
    return db
      .prepare(
        'SELECT id, user_id, user_name, category, body, status, created_at ' +
          'FROM messages ORDER BY id DESC LIMIT ?',
      )
      .all(limit);
  });
}

/** Count of messages still awaiting an admin (NEW or IN_REVIEW). */
export function getOpenMessagesCount() {
  const row = withDb((db) =>
    get(
      db,
      `SELECT COUNT(*) FROM messages WHERE status IN ('${MESSAGE_OPEN_STATUSES.join("', '")}')`,
    ),
  );
  return row ? row[0] : 0;
}

/**
 * Record an admin reply and set status REPLIED. Atomic.
 *
 * Returns `[ownerId, messageId]`, or null when the message is missing or
 * already CLOSED.
 */
export function replyToMessage(messageId, adminId, reply) {
  const cleanReply = String(reply ?? '').trim();
  if (!cleanReply) return null;
  if (cleanReply.length > MAX_MESSAGE_REPLY_LENGTH) return null;

  return withTransaction((db) => {
    const row = get(db, 'SELECT user_id, status FROM messages WHERE id = ?', [messageId]);
    if (!row) return null;

    const [ownerId, status] = row;
    if (status === 'CLOSED') return null;

    run(
      db,
      "UPDATE messages SET admin_reply = ?, status = 'REPLIED', reviewed_by = ?, " +
        "updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'CLOSED'",
      [cleanReply, adminId, messageId],
    );
    return [ownerId, messageId];
  });
}

/** Move a message between lifecycle states. */
export function setMessageStatus(messageId, status) {
  if (!MESSAGE_STATUSES.includes(status)) return false;

  return withTransaction((db) => {
    if (!get(db, 'SELECT 1 FROM messages WHERE id = ?', [messageId])) return false;
    run(
      db,
      'UPDATE messages SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, messageId],
    );
    return true;
  });
}
