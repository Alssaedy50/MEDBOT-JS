import { all, get, run, batch } from './core.js';
import { buildBreadcrumbPaths } from './registry.js';
import {
  CONTRIBUTION_FILE_TYPES,
  MAX_CONTRIBUTION_FILE_ID_LENGTH,
  MAX_CONTRIBUTION_TITLE_LENGTH,
  REVIEWABLE_STATUSES,
} from '../../constants.js';

export class ContributionValidationError extends Error {}

export async function validateContributionSubmission(db, folderId, title, fileId, fileType, userId = null) {
  if (typeof fileId !== 'string' || !fileId.trim()) return '⚠️ لم يتم العثور على الملف المرفق. أعد إرساله.';
  if (fileId.length > MAX_CONTRIBUTION_FILE_ID_LENGTH) return '⚠️ مُعرّف الملف غير صالح.';
  if (!CONTRIBUTION_FILE_TYPES.includes(fileType)) return '⚠️ نوع الملف غير مدعوم. الأنواع المسموحة: Document / Audio / Video / Photo.';
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) return '⚠️ عنوان المورد مطلوب.';
  if (cleanTitle.length > MAX_CONTRIBUTION_TITLE_LENGTH) return `⚠️ العنوان طويل جداً. الحد الأقصى ${MAX_CONTRIBUTION_TITLE_LENGTH} حرفاً.`;
  const folder = await get(db, 'SELECT id, accepts_contributions FROM folders WHERE id=?', [folderId]);
  if (!folder) return '⚠️ القسم الهدف لم يعد موجوداً.';
  if (!folder[1]) return '⚠️ هذا القسم لا يستقبل مساهمات.';
  if (userId !== null && userId !== undefined) {
    const duplicate = await get(db, "SELECT 1 FROM contributions WHERE user_id=? AND folder_id=? AND title=? AND file_id=? AND status IN ('pending','approved','needs_revision') LIMIT 1", [userId, folderId, cleanTitle, fileId]);
    if (duplicate) return '⚠️ هذه المساهمة مسجلة مسبقاً.';
  }
  return null;
}

export async function addContribution(db, userId, userName, folderId, title, fileId, fileType) {
  const clean = String(title ?? '').trim();
  const error = await validateContributionSubmission(db, folderId, clean, fileId, fileType, userId);
  if (error) throw new ContributionValidationError(error);
  const r = await run(db, "INSERT INTO contributions (user_id,user_name,folder_id,title,file_id,file_type,status) VALUES (?,?,?,?,?,?,'pending')", [userId, userName, folderId, clean, fileId, fileType]);
  return r.lastInsertRowid;
}

export async function approveContribution(db, contribId, reviewerId = null) {
  const row = await get(db, 'SELECT folder_id,title,file_id,file_type,user_id,status FROM contributions WHERE id=?', [contribId]);
  if (!row) return null;
  const [folderId, title, fileId, fileType, userId, status] = row;
  const existing = await get(db, "SELECT id FROM content WHERE source_contribution_id=? AND source_type='contribution' LIMIT 1", [contribId]);
  if (status === 'approved') return existing ? [folderId, title, fileId, fileType, userId, existing[0]] : null;
  if (!REVIEWABLE_STATUSES.includes(status)) return null;
  if (existing) {
    const updated = await run(db, "UPDATE contributions SET status='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,rejection_reason=NULL WHERE id=? AND status IN ('pending','needs_revision')", [reviewerId, contribId]);
    return updated.changes === 1 ? [folderId, title, fileId, fileType, userId, existing[0]] : null;
  }
  const results = await batch(db, [
    { sql: "INSERT INTO content (folder_id,title,file_id,file_type,source_type,source_contribution_id,created_by) VALUES (?,?,?,?,'contribution',?,?)", params: [folderId, title, fileId, fileType, contribId, userId] },
    { sql: "UPDATE contributions SET status='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,rejection_reason=NULL WHERE id=? AND status IN ('pending','needs_revision')", params: [reviewerId, contribId] },
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) return null;
  const content = await get(db, "SELECT id FROM content WHERE source_contribution_id=? AND source_type='contribution' LIMIT 1", [contribId]);
  return content ? [folderId, title, fileId, fileType, userId, content[0]] : null;
}

export async function rejectContribution(db, contribId, reviewerId = null, reason = null) {
  const row = await get(db, 'SELECT user_id,title,status FROM contributions WHERE id=?', [contribId]);
  if (!row || !REVIEWABLE_STATUSES.includes(row[2])) return null;
  const r = await run(db, "UPDATE contributions SET status='rejected',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,rejection_reason=? WHERE id=? AND status IN ('pending','needs_revision')", [reviewerId, reason, contribId]);
  return r.changes === 1 ? [row[0], row[1]] : null;
}

export async function requestContributionRevision(db, contribId, reviewerId = null, note = null) {
  const row = await get(db, 'SELECT user_id,title,status FROM contributions WHERE id=?', [contribId]);
  if (!row || !REVIEWABLE_STATUSES.includes(row[2])) return null;
  const r = await run(db, "UPDATE contributions SET status='needs_revision',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_note=? WHERE id=? AND status IN ('pending','needs_revision')", [reviewerId, note, contribId]);
  return r.changes === 1 ? [row[0], row[1]] : null;
}

export async function resubmitContribution(db, contribId, userId, title, fileId, fileType) {
  const row = await get(db, 'SELECT user_id,folder_id,status FROM contributions WHERE id=?', [contribId]);
  if (!row) return [false, '⚠️ المساهمة غير موجودة.'];
  if (Number(row[0]) !== Number(userId)) return [false, '🔒 يمكن لصاحب المساهمة فقط إعادة إرسالها.'];
  if (row[2] !== 'needs_revision') return [false, 'ℹ️ هذه المساهمة ليست بحاجة إلى تعديل.'];
  const clean = String(title ?? '').trim();
  if (typeof fileId !== 'string' || !fileId.trim() || fileId.length > MAX_CONTRIBUTION_FILE_ID_LENGTH) return [false, '⚠️ الملف غير صالح.'];
  if (!CONTRIBUTION_FILE_TYPES.includes(fileType)) return [false, '⚠️ نوع الملف غير مدعوم.'];
  if (!clean || clean.length > MAX_CONTRIBUTION_TITLE_LENGTH) return [false, '⚠️ العنوان غير صالح.'];
  if (!(await get(db, 'SELECT 1 FROM folders WHERE id=? AND accepts_contributions=1', [row[1]]))) return [false, '⚠️ القسم لم يعد يستقبل مساهمات.'];
  const r = await run(db, "UPDATE contributions SET title=?,file_id=?,file_type=?,status='pending',reviewed_by=NULL,reviewed_at=NULL,review_note=NULL,rejection_reason=NULL,resubmitted_count=COALESCE(resubmitted_count,0)+1 WHERE id=? AND status='needs_revision'", [clean, fileId, fileType, contribId]);
  return r.changes === 1 ? [true, clean] : [false, '⚠️ تعذرت إعادة الإرسال.'];
}

export async function getContribution(db, id) {
  return get(db, 'SELECT id,user_id,user_name,folder_id,title,file_id,file_type,status,created_at,reviewed_by,reviewed_at,review_note,rejection_reason,resubmitted_count FROM contributions WHERE id=?', [id]);
}

export async function getUserContributions(db, userId, limit = 20) {
  const rows = await all(db, 'SELECT id,title,file_type,status,created_at,rejection_reason,review_note,folder_id FROM contributions WHERE user_id=? ORDER BY id DESC LIMIT ?', [userId, Math.max(1, Math.min(100, Number(limit) || 20))]);
  const paths = await buildBreadcrumbPaths(db, new Set(rows.map((r) => r[7]).filter(Boolean)));
  return rows.map((r) => [...r, paths[r[7]] ?? null]);
}

export async function getReviewableContributionsList(db) {
  return all(db, "SELECT id,user_id,user_name,title,file_id,file_type,folder_id,status,created_at FROM contributions WHERE status IN ('pending','needs_revision') ORDER BY id DESC");
}

export async function getPendingContributions(db) {
  return all(db, "SELECT id,user_id,user_name,folder_id,title,file_id,file_type FROM contributions WHERE status='pending' ORDER BY created_at ASC");
}

export async function getAllContributions(db, limit = 50) {
  return all(db, 'SELECT id,user_id,user_name,folder_id,title,file_type,status,created_at FROM contributions ORDER BY created_at DESC LIMIT ?', [Math.max(1, Math.min(500, Number(limit) || 50))]);
}

export async function getPendingContributionsCount(db) {
  const r = await get(db, "SELECT COUNT(*) FROM contributions WHERE status IN ('pending','needs_revision')");
  return Number(r?.[0] ?? 0);
}
