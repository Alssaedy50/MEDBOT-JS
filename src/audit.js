/**
 * Audit log subsystem for MEDBOT.
 *
 * `logAction()` is best-effort by contract: it never throws into the caller and
 * never blocks the audited operation, so a failing audit write can never break
 * an admin action. Every entry records actor + action + target + time.
 *
 * The read-only viewer lives in `src/ui/auditView.js`.
 */

import * as db from './db/index.js';

// Important admin operations worth recording. Extend by adding entries here.
export const AUDIT_ACTIONS = Object.freeze([
  'folder_create',
  'folder_rename',
  'folder_move',
  'folder_retype',
  'folder_toggle',
  'folder_delete',
  'content_upload',
  'content_rename',
  'content_move',
  'content_retype',
  'content_delete',
  'contribution_approve',
  'contribution_reject',
  'contribution_revise',
  'message_reply',
  'message_status',
  'admin_add',
  'admin_remove',
  'admin_role',
  'admin_permissions',
  'owner_bootstrap',
  'ownership_transfer',
  'platform_setting',
  'topic_create',
  'topic_link',
  'topic_unlink',
  'topic_toggle',
  'topic_delete',
  'notification_send',
  'language_set',
  'feature_visibility',
  'news_create',
  'news_publish',
  'news_archive',
  'news_restore',
  'news_delete',
  'news_reference',
  'news_delivery_retry',
  'news_resource_auto',
  'scope_grant',
  'scope_revoke',
  'admin_preview',
  'authz_denied',
]);

export const ACTION_LABELS = Object.freeze({
  folder_create: '🗂 إنشاء مجلد',
  folder_rename: '✏️ إعادة تسمية مجلد',
  folder_move: '📦 نقل مجلد',
  folder_retype: '🏷 تغيير نوع مجلد',
  folder_toggle: '🔀 تبديل استقبال المساهمات',
  folder_delete: '🗑 حذف مجلد',
  content_upload: '📤 رفع محتوى',
  content_rename: '✏️ إعادة تسمية محتوى',
  content_move: '📦 نقل محتوى',
  content_retype: '🏷 تغيير نوع محتوى',
  content_delete: '🗑 حذف محتوى',
  contribution_approve: '✅ قبول مساهمة',
  contribution_reject: '❌ رفض مساهمة',
  contribution_revise: '🔁 طلب تعديل مساهمة',
  message_reply: '💬 الرد على رسالة',
  message_status: '🔄 تغيير حالة رسالة',
  admin_add: '➕ إضافة مشرف',
  admin_remove: '➖ إزالة مشرف',
  admin_role: '👑 تغيير دور',
  admin_permissions: '🔐 تغيير صلاحيات',
  owner_bootstrap: '🔑 تهيئة المالك',
  ownership_transfer: '👑 نقل الملكية',
  platform_setting: '⚙️ تعديل إعداد المنصة',
  topic_create: '🧭 إنشاء موضوع',
  topic_link: '🔗 ربط قسم بموضوع',
  topic_unlink: '✂️ إزالة رابط موضوع',
  topic_toggle: '🔀 تفعيل/تعطيل موضوع',
  topic_delete: '🗑 حذف موضوع',
  notification_send: '🔔 إرسال إشعار',
  language_set: '🌐 تغيير اللغة',
  feature_visibility: '🙈 إظهار/إخفاء قسم',
  news_create: '📝 إنشاء خبر',
  news_publish: '📰 نشر خبر',
  news_archive: '🗄 أرشفة خبر',
  news_restore: '♻️ استرجاع خبر',
  news_delete: '🗑 حذف خبر',
  news_reference: '🔗 ربط خبر بقسم/مورد',
  news_delivery_retry: '🔁 إعادة إرسال خبر',
  news_resource_auto: '🟢 خبر مورد تلقائي',
  scope_grant: '🧭 منح نطاق',
  scope_revoke: '✂️ سحب نطاق',
  admin_preview: '👁 معاينة واجهة مشرف',
  authz_denied: '🚫 رفض تصريح',
});

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Record one admin operation. Never throws; returns true on success.
 *
 * `actor_role` is resolved from the existing admin identity. Malformed input
 * (unknown action, non-numeric actor, null details) is tolerated so auditing
 * can never break the operation being audited.
 */
export async function logAction(
  actorId,
  action,
  { targetType = null, targetId = null, details = null } = {},
) {
  try {
    if (!action) return false;

    let actorRole = null;
    try {
      const record = db.getAdminRecord(actorId);
      if (record) actorRole = record.role;
    } catch {
      actorRole = null;
    }

    let numericActor = null;
    if (actorId !== null && actorId !== undefined) {
      const parsed = Number.parseInt(actorId, 10);
      numericActor = Number.isNaN(parsed) ? null : parsed;
    }

    return db.addAuditEntry(
      numericActor,
      actorRole,
      String(action),
      targetType === null ? null : String(targetType),
      targetId,
      details === null ? null : String(details),
    );
  } catch {
    // Auditing is best-effort: swallow everything, including a bad actor_id.
    return false;
  }
}

/** Read-only access check (owner + can_admins only). */
export function canViewAudit(userId) {
  try {
    if (db.isOwner(userId)) return true;
    return db.userHasPermission(userId, 'can_admins');
  } catch {
    return false;
  }
}
