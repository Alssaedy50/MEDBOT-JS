/**
 * Remaining admin surfaces: platform settings, notifications broadcast, the
 * audit-log viewer, the Emergency Resource Archive mirror, the AI registry and
 * the runtime health screen.
 *
 * Each entry point re-checks its capability, so a hidden button is never the
 * only thing standing between a caller and a forbidden action.
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as archive from '../archive.js';
import * as notifications from '../notifications.js';
import * as workflow from '../workflow.js';
import { btn, escHtml, keyboard } from '../telegram/ui.js';

export const SETTINGS_WORKFLOW = 'settings_edit';
export const NOTIFICATION_WORKFLOW = 'notification_body';

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

function has(userId, key) {
  try {
    return db.userHasPermission(userId, key);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Platform settings
// ---------------------------------------------------------------------------

/** Editor for the admin-editable platform identity / interface text. */
export async function showSettings(ctx) {
  if (!has(ctx.from.id, 'can_settings')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const settings = db.getPlatformSettings();

  const lines = [
    '⚙️ <b>إعدادات المنصة</b>',
    '',
    'اضغط على أي إعداد لتعديل نصه. تُطبَّق التغييرات فوراً على كل المستخدمين.',
    '',
  ];

  const rows = [];
  for (const key of db.PLATFORM_SETTING_KEYS) {
    const label = db.PLATFORM_SETTING_LABELS[key] ?? key;
    const value = settings[key] ?? '';
    lines.push(`• ${label}: ${esc(String(value).slice(0, 60))}`);
    rows.push([btn(label, `settings_edit:${key}`)]);
  }

  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Arm editing of one setting: the next typed message is the new value. */
export async function armSettingEdit(ctx, key) {
  if (!has(ctx.from.id, 'can_settings')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!db.PLATFORM_SETTING_KEYS.includes(key)) {
    await ctx.editMessageText('⚠️ إعداد غير معروف.', { reply_markup: keyboard([[btn('⬅️ الإعدادات', 'admin_settings')]]) });
    return;
  }

  workflow.begin(ctx, SETTINGS_WORKFLOW);
  ctx.userData.settings_edit_key = key;

  const current = db.getPlatformSetting(key);
  await ctx.editMessageText(
    `⚙️ <b>${esc(db.PLATFORM_SETTING_LABELS[key] ?? key)}</b>\n\n` +
      `القيمة الحالية:\n<code>${esc(String(current).slice(0, 800))}</code>\n\n` +
      `أرسل النص الجديد في رسالة، أو اضغط ❌ إلغاء.\n` +
      `ℹ️ الحد الأقصى ${db.SETTINGS_MAX_LENGTH} حرفاً.\n\n` +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'admin_settings')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Consume the new setting value. Returns handled. */
export async function handleSettingText(ctx) {
  const key = ctx.userData?.settings_edit_key;
  if (!key) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, SETTINGS_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    workflow.clear(ctx);
    delete ctx.userData.settings_edit_key;
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  if (!has(ctx.from.id, 'can_settings')) {
    workflow.clear(ctx);
    delete ctx.userData.settings_edit_key;
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  const ok = db.setPlatformSetting(key, text);
  workflow.clear(ctx);
  delete ctx.userData.settings_edit_key;

  if (ok) {
    await audit.logAction(ctx.from.id, 'platform_setting', {
      targetType: 'setting',
      targetId: key,
      details: text.slice(0, 200),
    });
    await ctx.reply('✅ تم حفظ الإعداد.', {
      reply_markup: keyboard([[btn('⬅️ الإعدادات', 'admin_settings')], [btn('🏠 الرئيسية', 'home')]]),
    });
  } else {
    await ctx.reply(`⚠️ نص غير صالح (فارغ أو يتجاوز ${db.SETTINGS_MAX_LENGTH} حرفاً).`, {
      reply_markup: keyboard([[btn('⬅️ الإعدادات', 'admin_settings')]]),
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Notifications broadcast
// ---------------------------------------------------------------------------

/** Notification broadcaster + sent history. */
export async function showNotifications(ctx) {
  if (!has(ctx.from.id, 'can_notifications')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let history = [];
  try {
    history = db.getNotifications(10);
  } catch {
    history = [];
  }

  const lines = [
    '🔔 <b>الإشعارات</b>',
    '',
    'أرسل إشعاراً لكل مستخدمي المنصة، أو اطّلع على سجل الإشعارات السابقة.',
    '',
  ];

  if (history.length) {
    lines.push('📜 <b>آخر الإشعارات:</b>');
    for (const row of history) {
      const [notificationId, , title, body, , recipients, delivered] = row;
      lines.push(
        `• #${notificationId} ${esc(title ?? '')} — ✅ ${delivered}/${recipients}`,
      );
      lines.push(`   ${esc(String(body).slice(0, 70))}`);
    }
  }

  await ctx.editMessageText(lines.join('\n'), {
    reply_markup: keyboard([
      [btn('✍️ إرسال إشعار', 'notify_new')],
      [btn('📜 سجل الإشعارات', 'notify_history')],
      [btn('⬅️ إدارة المنصة', 'admin')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
}

/** Arm the broadcast: the next typed message is the notification body. */
export async function armNotification(ctx) {
  if (!has(ctx.from.id, 'can_notifications')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  workflow.begin(ctx, NOTIFICATION_WORKFLOW);
  ctx.userData.notifications_body = true;

  await ctx.editMessageText(
    '🔔 <b>إرسال إشعار</b>\n\n' +
      'أرسل نص الإشعار الذي تريد إرساله إلى جميع المستخدمين.\n\n' +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'admin_notifications')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Consume the broadcast body and dispatch it. Returns handled. */
export async function handleNotificationText(ctx) {
  if (!ctx.userData?.notifications_body) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, NOTIFICATION_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    workflow.clear(ctx);
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  if (!has(ctx.from.id, 'can_notifications')) {
    workflow.clear(ctx);
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  workflow.clear(ctx);

  await ctx.reply('⏳ جارٍ إرسال الإشعار...');

  let result = { recipients: 0, delivered: 0 };
  try {
    result = await notifications.broadcast(ctx.getBot(), text, ctx.from.id);
  } catch {
    result = { recipients: 0, delivered: 0 };
  }

  await audit.logAction(ctx.from.id, 'notification_send', {
    targetType: 'notification',
    details: `delivered=${result.delivered}/${result.recipients}`,
  });

  await ctx.reply(
    `✅ تم إرسال الإشعار إلى ${result.delivered} من ${result.recipients} مستخدم.`,
    {
      reply_markup: keyboard([
        [btn('🔔 الإشعارات', 'admin_notifications')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
  return true;
}

/** Notification history. */
export async function showNotificationHistory(ctx) {
  if (!has(ctx.from.id, 'can_notifications')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let history = [];
  try {
    history = db.getNotifications(20);
  } catch {
    history = [];
  }

  const lines = ['📜 <b>سجل الإشعارات</b>', ''];

  if (!history.length) {
    lines.push('ℹ️ لم يتم إرسال أي إشعار بعد.');
  } else {
    for (const row of history) {
      const [notificationId, senderId, title, body, audience, recipients, delivered, createdAt] = row;
      lines.push(
        `• #${notificationId} ${esc(title ?? '')}\n` +
          `   👤 <code>${senderId}</code> · 🎯 ${esc(audience)} · ✅ ${delivered}/${recipients}\n` +
          `   🕒 ${esc(createdAt)}\n   ${esc(String(body).slice(0, 90))}`,
      );
    }
  }

  await ctx.editMessageText(lines.join('\n'), {
    reply_markup: keyboard([
      [btn('✍️ إرسال إشعار', 'notify_new')],
      [btn('⬅️ الإشعارات', 'admin_notifications')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Audit log viewer
// ---------------------------------------------------------------------------

/** Read-only audit-log viewer (owner + can_admins). */
export async function showAudit(ctx) {
  if (!audit.canViewAudit(ctx.from.id)) {
    await ctx.editMessageText('🔒 سجل التدقيق متاح للمالك ومن يملك صلاحية إدارة المشرفين.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }

  let entries = [];
  let total = 0;
  try {
    entries = db.getAuditEntries(20);
    total = db.getAuditCount();
  } catch {
    entries = [];
    total = 0;
  }

  const lines = ['📜 <b>سجل التدقيق</b>', '', `📊 إجمالي الأحداث: ${total}`, ''];

  if (!entries.length) {
    lines.push('ℹ️ لا توجد أحداث مسجلة بعد.');
  } else {
    for (const row of entries) {
      const [, actorId, actorRole, action, targetType, targetId, details, createdAt] = row;
      const label = audit.ACTION_LABELS[action] ?? action;
      lines.push(
        `${label}\n` +
          `   👤 <code>${actorId ?? '—'}</code> · 👑 ${esc(actorRole ?? '—')}\n` +
          `   🎯 ${esc(targetType ?? '—')}: ${esc(targetId ?? '—')}\n` +
          `   🕒 ${esc(createdAt)}` +
          (details ? `\n   📝 ${esc(String(details).slice(0, 80))}` : ''),
      );
    }
  }

  await ctx.editMessageText(lines.join('\n'), {
    reply_markup: keyboard([
      [btn('⬅️ إدارة المنصة', 'admin')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// AI registry
// ---------------------------------------------------------------------------

/** AI registry + model-usage observability. */
export async function showAiRegistry(ctx) {
  if (!has(ctx.from.id, 'can_ai')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let rows = [];
  let stats = [];
  let topStudents = [];
  try {
    rows = db.aiRegistryGetAll();
    stats = db.aiUsageStats(1);
    topStudents = db.aiUsageTopStudents(1, 5);
  } catch {
    rows = [];
    stats = [];
    topStudents = [];
  }

  const byAvailability = {};
  for (const row of rows) {
    const availability = row[4] ?? 'UNKNOWN';
    byAvailability[availability] = (byAvailability[availability] ?? 0) + 1;
  }

  const lines = [
    '🤖 <b>سجل الذكاء الاصطناعي</b>',
    '',
    `📊 إجمالي النماذج المسجّلة: ${rows.length}`,
    Object.entries(byAvailability)
      .map(([availability, count]) => `${availability}: ${count}`)
      .join(' · '),
    '',
    '📈 <b>النماذج المستخدمة اليوم:</b>',
  ];

  if (!stats.length) {
    lines.push('• لا توجد بيانات استخدام بعد.');
  } else {
    for (const row of stats) {
      const [, provider, model, availability, totalRequests, successful, uniqueStudents, avgLatency] = row;
      lines.push(
        `• ${esc(provider)}/${esc(model ?? '—')} · ${esc(availability ?? '—')}\n` +
          `   📨 ${totalRequests} طلب · ✅ ${successful} · 👥 ${uniqueStudents} طالب · ⏱ ${avgLatency ?? '—'}ms`,
      );
    }
  }

  if (topStudents.length) {
    lines.push('', '🏆 <b>أكثر الطلاب استخداماً:</b>');
    for (const [userId, total, successful, avgLatency] of topStudents) {
      lines.push(`• <code>${userId}</code> — ${total} طلب (✅ ${successful}) · ⏱ ${avgLatency ?? '—'}ms`);
    }
  }

  await ctx.editMessageText(lines.join('\n'), {
    reply_markup: keyboard([
      [btn('📊 حالة التشغيل', 'admin_runtime')],
      [btn('⬅️ إدارة المنصة', 'admin')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Runtime health
// ---------------------------------------------------------------------------

/** Runtime health: DB, content, RBAC and archive counters. */
export async function showRuntime(ctx) {
  if (!has(ctx.from.id, 'can_ai') && !has(ctx.from.id, 'can_settings')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let folderCount = 0;
  let contentCount = 0;
  let adminCount = 0;
  let auditCount = 0;
  let archiveCounts = {};
  let pending = 0;

  try {
    folderCount = db.getSearchableRecords().folders.length;
    contentCount = db.getSearchableRecords().contents.length;
    adminCount = db.getAdminsFullRecords().length;
    auditCount = db.getAuditCount();
    archiveCounts = db.getArchiveSyncCounts();
    pending = db.getPendingContributionsCount();
  } catch {
    // Counters degrade to zero rather than failing the screen.
  }

  const runtime = archive.runtimeStatus();

  await ctx.editMessageText(
    '📊 <b>حالة التشغيل</b>\n\n' +
      `🗂 الأقسام: ${folderCount}\n` +
      `📄 الموارد: ${contentCount}\n` +
      `👥 المشرفون: ${adminCount}\n` +
      `📥 مساهمات بانتظار المراجعة: ${pending}\n` +
      `📜 أحداث التدقيق: ${auditCount}\n\n` +
      '🗄 <b>أرشيف الطوارئ:</b>\n' +
      `• ✅ منشور: ${archiveCounts.published ?? 0}\n` +
      `• ⏳ معلّق: ${archiveCounts.pending ?? 0}\n` +
      `• ⚠️ فشل: ${archiveCounts.failed ?? 0}\n` +
      `• 📊 الإجمالي: ${archiveCounts.total ?? 0}\n\n` +
      `⚙️ حالة الأرشيف: ${runtime.enabled ? '✅ مُفعّل' : '⛔ غير مُفعّل'}\n` +
      `🔌 القناة: ${runtime.channelConfigured ? '✅ مضبوطة' : '⛔ غير مضبوطة'}\n` +
      `🤖 مزودو الذكاء الاصطناعي: ${runtime.aiProviders}`,
    {
      reply_markup: keyboard([
        [btn('🗄 أرشيف الطوارئ', 'admin_archive')],
        [btn('🤖 سجل الذكاء الاصطناعي', 'admin_ai')],
        [btn('⬅️ إدارة المنصة', 'admin')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

// ---------------------------------------------------------------------------
// Archive mirror
// ---------------------------------------------------------------------------

/** Archive mirror status + the resync/retry actions. */
export async function showArchive(ctx) {
  if (!has(ctx.from.id, 'can_archive')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let counts = {};
  try {
    counts = db.getArchiveSyncCounts();
  } catch {
    counts = {};
  }

  let configLine;
  let channelLine = '';
  if (archive.isConfigured()) {
    const channel = esc(archive.resolveChannel());
    channelLine = `📡 القناة: <code>${channel}</code>`;
    if (String(archive.resolveChannel()).startsWith('@')) {
      channelLine += `\n🔗 https://t.me/${esc(String(archive.resolveChannel()).replace(/^@/, ''))}`;
    }
    configLine = '🟢 الأرشيف مُهيّأ.';
  } else {
    configLine =
      '🔴 <b>الأرشيف غير مُهيّأ.</b>\n' +
      'حدّد متغير البيئة <code>MEDBOT_ARCHIVE_CHANNEL</code> ' +
      'في منصة الاستضافة (معرّف القناة أو @username)، ' +
      'وتأكد أن البوت مشرف فيها.';
  }

  const text =
    '🗄 <b>أرشيف الطوارئ للموارد</b>\n\n' +
    'نسخة وصول احتياطية للموارد في قناة Telegram مستقلة، تبقى متاحة ' +
    'حتى إذا توقف MEDBOT. السجل في MEDBOT يظل المصدر الأساسي.\n\n' +
    `${configLine}\n` +
    (channelLine ? `${channelLine}\n\n` : '\n') +
    '📊 <b>حالة المزامنة</b>\n' +
    `✅ منشور: ${counts.published ?? 0} | ` +
    `⏳ معلّق: ${counts.pending ?? 0} | ` +
    `⚠️ فشل: ${counts.failed ?? 0}`;

  await ctx.editMessageText(text, { reply_markup: archiveMenu() });
}

function archiveMenu() {
  return keyboard([
    [btn('🔄 إعادة مزامنة الموارد', 'archive_resync')],
    [btn('♻️ إعادة محاولة الفاشلة', 'archive_retry')],
    [btn('📊 حالة المزامنة', 'archive_status')],
    [btn('⬅️ إدارة المنصة', 'admin')],
    [btn('🏠 الرئيسية', 'home')],
  ]);
}

/** Detailed mirror rows: status, object type, attempts and last error. */
export async function showArchiveStatus(ctx) {
  if (!has(ctx.from.id, 'can_archive')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let rows = [];
  try {
    rows = db.getArchiveSyncRows(null, 15);
  } catch {
    rows = [];
  }

  const icons = { published: '✅', pending: '⏳', failed: '⚠️', skipped: '⏭' };
  const lines = ['📊 <b>حالة مزامنة الأرشيف</b>', ''];

  if (!rows.length) {
    lines.push('لا توجد سجلات مزامنة بعد.');
  } else {
    for (const row of rows) {
      const [, objectType, , , contentIds, , , status, attempts, error, , updatedAt] = row;
      const icon = icons[String(status)] ?? '•';
      const detail = error ? ` — ${esc(String(error).slice(0, 60))}` : '';
      lines.push(
        `${icon} <b>${esc(status)}</b> · ${esc(objectType)} ` +
          `· id=${esc(contentIds || '-')} · ${esc(attempts)} محاولة${detail}\n` +
          `   <i>${esc(updatedAt)}</i>`,
      );
    }
  }

  await ctx.editMessageText(lines.join('\n'), { reply_markup: archiveMenu() });
}

/** Re-mirror every resource that is not yet published. */
export async function runArchiveResync(ctx) {
  if (!has(ctx.from.id, 'can_archive')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }
  if (!archive.isConfigured()) {
    await showArchive(ctx);
    return;
  }

  await ctx.editMessageText('🔄 <i>جارٍ إعادة المزامنة...</i>', {
    reply_markup: keyboard([[btn('🏠 الرئيسية', 'home')]]),
  });

  let stats = { total: 0, published: 0, failed: 0, skipped: 0 };
  try {
    stats = await archive.resync(ctx.getBot());
  } catch {
    // Fall through with the zeroed stats.
  }

  await audit.logAction(ctx.from.id, 'archive_resync', {
    targetType: 'archive',
    details:
      `published=${stats.published}, failed=${stats.failed}, ` +
      `skipped=${stats.skipped}, total=${stats.total}`,
  });

  await ctx.editMessageText(
    '✅ <b>اكتملت إعادة المزامنة</b>\n\n' +
      `📦 الإجمالي: ${stats.total}\n` +
      `✅ منشور: ${stats.published}\n` +
      `⚠️ فشل: ${stats.failed}\n` +
      `⏭ تم تخطّيه (منشور مسبقاً): ${stats.skipped}`,
    { reply_markup: archiveMenu() },
  );
}

/** Retry only the rows recorded as failed. */
export async function runArchiveRetry(ctx) {
  if (!has(ctx.from.id, 'can_archive')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }
  if (!archive.isConfigured()) {
    await showArchive(ctx);
    return;
  }

  let stats = { total: 0, published: 0, failed: 0 };
  try {
    stats = await archive.retryFailed(ctx.getBot());
  } catch {
    // Fall through with the zeroed stats.
  }

  await audit.logAction(ctx.from.id, 'archive_retry', {
    targetType: 'archive',
    details: `published=${stats.published}, failed=${stats.failed}, total=${stats.total}`,
  });

  await ctx.editMessageText(
    '♻️ <b>إعادة محاولة النشر الفاشل</b>\n\n' +
      `📦 الإجمالي: ${stats.total}\n` +
      `✅ نجح: ${stats.published}\n` +
      `⚠️ ما زال فاشلاً: ${stats.failed}`,
    { reply_markup: archiveMenu() },
  );
}

// ---------------------------------------------------------------------------
// Callback dispatch
// ---------------------------------------------------------------------------

export async function adminSettingsCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  if (data === 'admin_settings') {
    await showSettings(ctx);
    return;
  }
  if (data.startsWith('settings_edit:')) {
    await armSettingEdit(ctx, data.split(':')[1]);
    return;
  }
  if (data === 'admin_notifications') {
    await showNotifications(ctx);
    return;
  }
  if (data === 'notify_new') {
    await armNotification(ctx);
    return;
  }
  if (data === 'notify_history') {
    await showNotificationHistory(ctx);
    return;
  }
  if (data === 'admin_audit') {
    await showAudit(ctx);
    return;
  }
  if (data === 'admin_ai') {
    await showAiRegistry(ctx);
    return;
  }
  if (data === 'admin_runtime') {
    await showRuntime(ctx);
    return;
  }
  if (data === 'admin_archive') {
    await showArchive(ctx);
    return;
  }
  if (data === 'archive_resync') {
    await runArchiveResync(ctx);
    return;
  }
  if (data === 'archive_retry') {
    await runArchiveRetry(ctx);
    return;
  }
  if (data === 'archive_status') {
    await showArchiveStatus(ctx);
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const ADMIN_SETTINGS_PREFIXES = [
  'admin_settings',
  'settings_edit:',
  'admin_notifications',
  'notify_new',
  'notify_history',
  'admin_audit',
  'admin_ai',
  'admin_runtime',
  'admin_archive',
  'archive_resync',
  'archive_retry',
  'archive_status',
];
