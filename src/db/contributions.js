/**
 * Student contributions: submission validation, the review workflow and the
 * contributor-facing history.
 *
 * Lifecycle: pending -> approved | rejected | needs_revision.
 * A `needs_revision` contribution may be resubmitted by its own contributor,
 * which replaces the media and returns it to `pending`.
 */

import { get, run, withDb, withTransaction } from './core.js';
import { buildBreadcrumbPaths } from './registry.js';
import {
  CONTRIBUTION_FILE_TYPES,
  MAX_CONTRIBUTION_FILE_ID_LENGTH,
  MAX_CONTRIBUTION_TITLE_LENGTH,
  REVIEWABLE_STATUSES,
} from '../constants.js';

export class ContributionValidationError extends Error {}

/**
 * Return an error message, or null when the submission is acceptable.
 *
 * Checks (all local, no network): target folder exists and accepts
 * contributions, file id present and within length, title present and within
 * length, file type allowed, and no obvious duplicate from the same user in the
 * same folder.
 */
export function validateContributionSubmission(
  folderId,
  title,
  fileId,
  fileType,
  userId = null,
) {
  if (typeof fileId !== 'string' || !fileId.trim()) {
    return '⚠️ لم يتم العثور على الملف المرفق. أعد إرساله.';
  }
  if (fileId.length > MAX_CONTRIBUTION_FILE_ID_LENGTH) {
    return '⚠️ مُعرّف الملف غير صالح.';
  }
  if (!CONTRIBUTION_FILE_TYPES.includes(fileType)) {
    return '⚠️ نوع الملف غير مدعوم. الأنواع المسموحة: Document / Audio / Video / Photo.';
  }

  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) return '⚠️ عنوان المورد مطلوب.';
  if (cleanTitle.length > MAX_CONTRIBUTION_TITLE_LENGTH) {
    return `⚠️ العنوان طويل جداً. الحد الأقصى ${MAX_CONTRIBUTION_TITLE_LENGTH} حرفاً.`;
  }

  return withDb((db) => {
    const folder = get(db, 'SELECT id, accepts_contributions FROM folders WHERE id = ?', [
      folderId,
    ]);
    if (!folder) return '⚠️ القسم الهدف لم يعد موجوداً.';
    if (!folder[1]) return '⚠️ هذا القسم لا يستقبل مساهمات.';

    if (userId !== null && userId !== undefined) {
      const duplicate = get(
        db,
        `SELECT 1 FROM contributions
         WHERE user_id = ? AND folder_id = ? AND title = ? AND file_id = ?
           AND status IN ('pending', 'approved', 'needs_revision') LIMIT 1`,
        [userId, folderId, cleanTitle, fileId],
      );
      if (duplicate) return '⚠️ هذه المساهمة مسجلة مسبقاً.';
    }

    return null;
  });
}

/** Register a new contribution. Throws ContributionValidationError. */
export function addContribution(userId, userName, folderId, title, fileId, fileType) {
  const cleanTitle = String(title ?? '').trim();
  const error = validateContributionSubmission(
    folderId,
    cleanTitle,
    fileId,
    fileType,
    userId,
  );
  if (error) throw new ContributionValidationError(error);

  return withDb(
    (db) =>
      run(
        db,
        "INSERT INTO contributions (user_id, user_name, folder_id, title, file_id, file_type, status) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'pending')",
        [userId, userName, folderId, cleanTitle, fileId, fileType],
      ).lastInsertRowid,
  );
}

/**
 * Approve a contribution: promote it into `content`.
 *
 * Returns `[folderId, title, fileId, fileType, userId, contentId]`, or null
 * when the row is missing or no longer reviewable.
 */
export function approveContribution(contribId, reviewerId = null) {
  return withTransaction((db) => {
    const row = get(
      db,
      'SELECT folder_id, title, file_id, file_type, user_id, status FROM contributions WHERE id = ?',
      [contribId],
    );
    if (!row) return null;

    const [folderId, title, fileId, fileType, userId, status] = row;
    if (!REVIEWABLE_STATUSES.includes(status)) return null;

    const contentId = run(
      db,
      "INSERT INTO content (folder_id, title, file_id, file_type, source_type, " +
        "source_contribution_id, created_by) VALUES (?, ?, ?, ?, 'contribution', ?, ?)",
      [folderId, title, fileId, fileType, contribId, userId],
    ).lastInsertRowid;

    run(
      db,
      `UPDATE contributions SET status = 'approved', reviewed_by = ?,
         reviewed_at = CURRENT_TIMESTAMP, rejection_reason = NULL
       WHERE id = ? AND status IN ('pending', 'needs_revision')`,
      [reviewerId, contribId],
    );

    return [folderId, title, fileId, fileType, userId, contentId];
  });
}

/** Reject a contribution. Returns `[userId, title]`, or null. */
export function rejectContribution(contribId, reviewerId = null, reason = null) {
  return withTransaction((db) => {
    const row = get(db, 'SELECT user_id, title, status FROM contributions WHERE id = ?', [
      contribId,
    ]);
    if (!row) return null;

    const [userId, title, status] = row;
    if (!REVIEWABLE_STATUSES.includes(status)) return null;

    run(
      db,
      `UPDATE contributions SET status = 'rejected', reviewed_by = ?,
         reviewed_at = CURRENT_TIMESTAMP, rejection_reason = ?
       WHERE id = ? AND status IN ('pending', 'needs_revision')`,
      [reviewerId, reason, contribId],
    );

    return [userId, title];
  });
}

/** Send a contribution back to the contributor for changes. */
export function requestContributionRevision(contribId, reviewerId = null, note = null) {
  return withTransaction((db) => {
    const row = get(db, 'SELECT user_id, title, status FROM contributions WHERE id = ?', [
      contribId,
    ]);
    if (!row) return null;

    const [userId, title, status] = row;
    if (!REVIEWABLE_STATUSES.includes(status)) return null;

    run(
      db,
      `UPDATE contributions SET status = 'needs_revision', reviewed_by = ?,
         reviewed_at = CURRENT_TIMESTAMP, review_note = ?
       WHERE id = ? AND status IN ('pending', 'needs_revision')`,
      [reviewerId, note, contribId],
    );

    return [userId, title];
  });
}

/**
 * Replace a needs_revision contribution's media and return it to pending.
 *
 * Only the original contributor may resubmit, and only while the contribution
 * is in `needs_revision`. The title/folder stay owned by the server; only media
 * is replaced.
 */
export function resubmitContribution(contribId, userId, title, fileId, fileType) {
  return withTransaction((db) => {
    const row = get(db, 'SELECT user_id, folder_id, status FROM contributions WHERE id = ?', [
      contribId,
    ]);
    if (!row) return [false, '⚠️ المساهمة غير موجودة.'];

    const [ownerId, folderId, status] = row;
    if (Number(ownerId) !== Number(userId)) {
      return [false, '🔒 يمكن لصاحب المساهمة فقط إعادة إرسالها.'];
    }
    if (status !== 'needs_revision') {
      return [false, 'ℹ️ هذه المساهمة ليست بحاجة إلى تعديل.'];
    }

    const cleanTitle = String(title ?? '').trim();
    if (typeof fileId !== 'string' || !fileId.trim()) {
      return [false, '⚠️ لم يتم العثور على الملف المرفق.'];
    }
    if (fileId.length > MAX_CONTRIBUTION_FILE_ID_LENGTH) {
      return [false, '⚠️ مُعرّف الملف غير صالح.'];
    }
    if (!CONTRIBUTION_FILE_TYPES.includes(fileType)) {
      return [false, '⚠️ نوع الملف غير مدعوم.'];
    }
    if (!cleanTitle || cleanTitle.length > MAX_CONTRIBUTION_TITLE_LENGTH) {
      return [false, '⚠️ العنوان غير صالح.'];
    }

    if (!get(db, 'SELECT 1 FROM folders WHERE id = ? AND accepts_contributions = 1', [folderId])) {
      return [false, '⚠️ القسم لم يعد يستقبل مساهمات.'];
    }

    run(
      db,
      `UPDATE contributions SET title = ?, file_id = ?, file_type = ?,
         status = 'pending', reviewed_by = NULL, reviewed_at = NULL,
         review_note = NULL, rejection_reason = NULL,
         resubmitted_count = COALESCE(resubmitted_count, 0) + 1
       WHERE id = ? AND status = 'needs_revision'`,
      [cleanTitle, fileId, fileType, contribId],
    );

    return [true, cleanTitle];
  });
}

export function getContribution(contribId) {
  return withDb((db) =>
    get(
      db,
      'SELECT id, user_id, user_name, folder_id, title, file_id, file_type, status, ' +
        'created_at, reviewed_by, reviewed_at, review_note, rejection_reason, ' +
        'resubmitted_count FROM contributions WHERE id = ?',
      [contribId],
    ),
  );
}

/**
 * A contributor's own contributions, newest first.
 *
 * Each row carries the full destination path so the student can tell which
 * subject/block a contribution belongs to, not just its title.
 */
export function getUserContributions(userId, limit = 20) {
  return withDb((db) => {
    const rows = db
      .prepare(
        'SELECT id, title, file_type, status, created_at, rejection_reason, ' +
          'review_note, folder_id FROM contributions WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(userId, limit);

    const folderIds = new Set(rows.map((row) => row[7]).filter(Boolean));
    const paths = folderIds.size ? buildBreadcrumbPaths(db, folderIds) : {};

    return rows.map((row) => [...row, paths[row[7]] ?? null]);
  });
}

/** Pending and needs_revision contributions awaiting an admin decision. */
export function getReviewableContributionsList() {
  return withDb((db) =>
    db
      .prepare(
        "SELECT id, user_id, user_name, title, file_id, file_type, folder_id, status, " +
          "created_at FROM contributions WHERE status IN ('pending', 'needs_revision') " +
          'ORDER BY id DESC',
      )
      .all(),
  );
}

export function getPendingContributions() {
  return withDb((db) =>
    db
      .prepare(
        "SELECT id, user_id, user_name, folder_id, title, file_id, file_type " +
          "FROM contributions WHERE status = 'pending' ORDER BY created_at ASC",
      )
      .all(),
  );
}

export function getAllContributions(limit = 50) {
  return withDb((db) =>
    db
      .prepare(
        'SELECT id, user_id, user_name, folder_id, title, file_type, status, created_at ' +
          'FROM contributions ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit),
  );
}

/** Count of contributions awaiting review (pending or needs_revision). */
export function getPendingContributionsCount() {
  const row = withDb((db) =>
    get(
      db,
      "SELECT COUNT(*) FROM contributions WHERE status IN ('pending', 'needs_revision')",
    ),
  );
  return row ? row[0] : 0;
}
