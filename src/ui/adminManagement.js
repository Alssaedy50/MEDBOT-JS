/**
 * Admin & RBAC management (👥 إدارة المشرفين) and the Scoped RBAC scope picker.
 *
 * Ownership is singleton: the UI never offers `owner` as an assignable role —
 * it is reached only through the explicit, audited transfer flow.
 *
 * ## Scope picker (Phase 3)
 *
 * When adding a scope, the admin is shown ONE hierarchical browser starting at
 * the root of the real MEDBOT hierarchy. There is no initial "Section / Topic /
 * Resource" question: the admin navigates DOWNWARD from the root, and every
 * selectable node carries its own selection button. A node is selectable when
 * it is a real registry object:
 *
 *   * any folder in the tree -> a `folder` scope (covers its whole subtree)
 *   * a topic entry         -> a `topic` scope (covers every folder it links)
 *   * any resource          -> a `resource` scope (covers that one item)
 *
 * Multiple scopes may be assigned to the same admin. Topics are surfaced as
 * extra entry points at the root level, and resources appear alongside the
 * folders that hold them, so the whole model is reachable from one tree.
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as workflow from '../workflow.js';
import { btn, escHtml, keyboard, resourceIcon } from '../telegram/ui.js';

export const ADMIN_ADD_WORKFLOW = 'admin_add';

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

function canManageAdmins(userId) {
  try {
    return db.userHasPermission(userId, 'can_admins');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Admin list
// ---------------------------------------------------------------------------

/** The admin roster: roles, revocation state and per-admin scope counts. */
export async function showAdmins(ctx) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let records = [];
  try {
    records = db.getAdminsFullRecords();
  } catch {
    records = [];
  }

  const ownerCount = records.filter((record) => record.role === 'owner').length;

  const lines = [
    '👥 <b>إدارة المشرفين</b>',
    '',
    `👑 المالك: ${ownerCount} · 🛡 المشرفون: ${records.filter((r) => r.role === 'admin').length}` +
      ` · 🔎 المراجعون: ${records.filter((r) => r.role === 'reviewer').length}` +
      ` · ⛔ الملغون: ${records.filter((r) => r.role === 'none').length}`,
    '',
    'اختر مشرفاً لإدارة دوره وصلاحياته ونطاقه:',
  ];

  const rows = [];
  for (const record of records) {
    let scopeNote = '';
    if (record.role !== 'owner' && record.role !== 'none') {
      try {
        const scopes = db.getAdminScopes(record.telegram_id);
        if (scopes.length) scopeNote = ` · 🧭 ${scopes.length}`;
      } catch {
        scopeNote = '';
      }
    }

    const label = `${db.ROLE_LABELS[record.role] ?? record.role} · ${
      record.username ? `@${record.username}` : record.telegram_id
    }${scopeNote}`;
    lines.push(`• ${esc(label)}`);
    rows.push([btn(label.slice(0, 38), `admin_view:${record.telegram_id}`)]);
  }

  rows.push([btn('➕ إضافة مشرف', 'admin_add')]);
  if (ownerCount <= 1) {
    rows.push([btn('👑 نقل الملكية', 'admin_transfer')]);
  }
  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** One admin: role/revoke actions plus the scope entry point. */
export async function showAdmin(ctx, adminId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let record;
  try {
    record = db.getAdminRecord(adminId);
  } catch {
    record = null;
  }

  if (!record) {
    await ctx.editMessageText('⚠️ المشرف غير موجود.', {
      reply_markup: keyboard([[btn('⬅️ المشرفون', 'admin_admins')]]),
    });
    return;
  }

  const isOwnerTarget = record.role === 'owner';

  let scopes = [];
  if (!isOwnerTarget) {
    try {
      scopes = db.getAdminScopes(adminId);
    } catch {
      scopes = [];
    }
  }

  const lines = [
    `👤 <b>${record.username ? `@${esc(record.username)}` : esc(adminId)}</b>`,
    '',
    `🆔 <code>${adminId}</code>`,
    `👑 ${db.ROLE_LABELS[record.role] ?? record.role}`,
    `📅 منذ ${esc(record.added_at ?? '')}`,
    '',
  ];

  if (isOwnerTarget) {
    lines.push('👑 المالك يملك كل الصلاحيات بلا استثناء، ولا يمكن تخفيضه إلا بنقل الملكية.');
  } else {
    lines.push('🔐 <b>الصلاحيات:</b>');
    for (const key of db.PERMISSION_KEYS) {
      lines.push(`${record.permissions[key] ? '✅' : '⛔'} ${db.PERMISSION_LABELS[key] ?? key}`);
    }

    lines.push('', '🧭 <b>النطاق (Phase 3):</b>');
    if (!scopes.length) {
      lines.push('🌐 غير مقيّد — يملك وصولاً على مستوى المنصة بالكامل.');
    } else {
      for (const scope of scopes) {
        lines.push(`• ${describeScope(scope)}`);
      }
    }
  }

  const rows = [];
  if (!isOwnerTarget) {
    rows.push([btn('👑 تغيير الدور', `admin_role_menu:${adminId}`)]);
    rows.push([btn('🧭 إدارة النطاق', `scope_menu:${adminId}`)]);
    rows.push([btn('🔐 تعديل الصلاحيات', `admin_perms:${adminId}`)]);

    const isRevoked = record.role === 'none';
    if (isRevoked) {
      rows.push([btn('♻️ إعادة التفعيل (مشرف)', `admin_restore:${adminId}`)]);
    } else {
      rows.push([btn('⛔ سحب الوصول', `admin_revoke:${adminId}`)]);
    }
  }

  rows.push([btn('⬅️ المشرفون', 'admin_admins')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Human-readable description of one scope row, resolved from the registry. */
function describeScope(scope) {
  if (scope.scope_type === 'folder') {
    let name = String(scope.scope_id);
    try {
      const folder = db.getFolder(scope.scope_id);
      if (folder) name = folder[2];
    } catch {
      name = String(scope.scope_id);
    }
    return `🗂 قسم: ${esc(name)} (#${scope.scope_id})`;
  }
  if (scope.scope_type === 'topic') {
    let name = String(scope.scope_id);
    try {
      const topic = db.getTopic(scope.scope_id);
      if (topic) name = topic.name;
    } catch {
      name = String(scope.scope_id);
    }
    return `🧭 موضوع: ${esc(name)} (#${scope.scope_id})`;
  }
  let title = String(scope.scope_id);
  try {
    const record = db.getFileRecord(scope.scope_id);
    if (record) title = record[2];
  } catch {
    title = String(scope.scope_id);
  }
  return `📄 مورد: ${esc(title)} (#${scope.scope_id})`;
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

/** Role picker. `owner` is never offered here. */
export async function showRoleMenu(ctx, adminId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const rows = [];
  for (const role of db.ROLE_ASSIGNABLE) {
    rows.push([btn(db.ROLE_LABELS[role] ?? role, `admin_setrole:${adminId}:${role}`)]);
  }
  rows.push([btn('⬅️ رجوع', `admin_view:${adminId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    '👑 <b>تغيير الدور</b>\n\n' +
      'الدور يحدد الحزمة الأساسية للصلاحيات. يمكنك تعديل الصلاحيات فردياً بعد ذلك.\n\n' +
      db.ROLE_DESCRIPTIONS.admin,
    { reply_markup: keyboard(rows) },
  );
}

/** Apply a role preset and audit the change. */
export async function setRole(ctx, adminId, role) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!db.ROLE_ASSIGNABLE.includes(role) || Number(adminId) === Number(ctx.from.id)) {
    await ctx.editMessageText('⚠️ لا يمكن تطبيق هذا الدور.', {
      reply_markup: keyboard([[btn('⬅️ رجوع', `admin_view:${adminId}`)]]),
    });
    return;
  }

  const ok = db.applyRolePreset(adminId, role);
  if (ok) {
    await audit.logAction(ctx.from.id, 'admin_role', {
      targetType: 'admin',
      targetId: adminId,
      details: role,
    });
  }

  await showAdmin(ctx, adminId);
}

/** Grant or revoke one capability. */
export async function togglePermission(ctx, adminId, key) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!db.PERMISSION_KEYS.includes(key)) {
    await ctx.editMessageText('⚠️ صلاحية غير معروفة.', {
      reply_markup: keyboard([[btn('⬅️ رجوع', `admin_view:${adminId}`)]]),
    });
    return;
  }

  let record;
  try {
    record = db.getAdminRecord(adminId);
  } catch {
    record = null;
  }
  if (!record || record.role === 'owner') {
    await ctx.editMessageText('⚠️ لا يمكن تعديل صلاحيات هذا الحساب.', {
      reply_markup: keyboard([[btn('⬅️ رجوع', `admin_view:${adminId}`)]]),
    });
    return;
  }

  const next = { ...record.permissions, [key]: !record.permissions[key] };
  const ok = db.updateAdminPermissions(adminId, next);
  if (ok) {
    await audit.logAction(ctx.from.id, 'admin_permissions', {
      targetType: 'admin',
      targetId: adminId,
      details: `${key}=${next[key]}`,
    });
  }

  await showPermissions(ctx, adminId);
}

/** Per-capability editor for one admin. */
export async function showPermissions(ctx, adminId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let record;
  try {
    record = db.getAdminRecord(adminId);
  } catch {
    record = null;
  }
  if (!record) {
    await ctx.editMessageText('⚠️ المشرف غير موجود.', {
      reply_markup: keyboard([[btn('⬅️ المشرفون', 'admin_admins')]]),
    });
    return;
  }

  const rows = [];
  for (const key of db.PERMISSION_KEYS) {
    const granted = record.permissions[key];
    rows.push([btn(`${granted ? '✅' : '⛔'} ${db.PERMISSION_LABELS[key] ?? key}`, `admin_perm:${adminId}:${key}`)]);
  }
  rows.push([btn('⬅️ رجوع', `admin_view:${adminId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    `🔐 <b>صلاحيات ${record.username ? `@${esc(record.username)}` : esc(adminId)}</b>\n\n` +
      'اضغط على أي صلاحية لمنحها أو سحبها.',
    { reply_markup: keyboard(rows) },
  );
}

/** Revoke all admin access while keeping the row and username. */
export async function revokeAdmin(ctx, adminId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let record;
  try {
    record = db.getAdminRecord(adminId);
  } catch {
    record = null;
  }
  if (!record) {
    await ctx.editMessageText('⚠️ المشرف غير موجود.', { reply_markup: keyboard([[btn('⬅️ المشرفون', 'admin_admins')]]) });
    return;
  }
  if (record.role === 'owner') {
    await ctx.editMessageText('⚠️ لا يمكن سحب وصول المالك.', {
      reply_markup: keyboard([[btn('⬅️ رجوع', `admin_view:${adminId}`)]]),
    });
    return;
  }

  if (db.removeSubAdmin(adminId)) {
    await audit.logAction(ctx.from.id, 'admin_remove', { targetType: 'admin', targetId: adminId });
  }
  await showAdmin(ctx, adminId);
}

/** Restore a revoked account as a plain admin. */
export async function restoreAdmin(ctx, adminId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (db.applyRolePreset(adminId, 'admin')) {
    await audit.logAction(ctx.from.id, 'admin_role', {
      targetType: 'admin',
      targetId: adminId,
      details: 'admin',
    });
  }
  await showAdmin(ctx, adminId);
}

// ---------------------------------------------------------------------------
// Ownership transfer
// ---------------------------------------------------------------------------

/** Owner-only transfer target picker (active admins except the caller). */
export async function showTransferMenu(ctx) {
  if (!db.isOwner(ctx.from.id)) {
    await ctx.editMessageText('🔒 نقل الملكية متاح للمالك الحالي فقط.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }

  let records = [];
  try {
    records = db.getAdminsFullRecords();
  } catch {
    records = [];
  }

  const targets = records.filter(
    (record) =>
      Number(record.telegram_id) !== Number(ctx.from.id) &&
      db.ADMIN_ROLES.includes(record.role),
  );

  const lines = [
    '👑 <b>نقل الملكية</b>',
    '',
    '⚠️ سيصبح الحساب المختار المالك الجديد، وسيتحوّل دورك إلى مشرف.',
    'لا يمكن التراجع إلا بموافقة المالك الجديد.',
    '',
    targets.length ? 'اختر المشرف:': 'ℹ️ لا يوجد مشرف آخر يمكن نقل الملكية إليه.',
  ];

  const rows = [];
  for (const record of targets) {
    rows.push([
      btn(
        `👑 ${record.username ? `@${record.username}` : record.telegram_id}`,
        `admin_transfer_confirm:${record.telegram_id}`,
      ),
    ]);
  }
  rows.push([btn('⬅️ المشرفون', 'admin_admins')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Confirm and execute an ownership transfer. */
export async function confirmTransfer(ctx, newOwnerId) {
  if (!db.isOwner(ctx.from.id)) {
    await ctx.editMessageText('🔒 نقل الملكية متاح للمالك الحالي فقط.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }

  const targetLabel = `<code>${newOwnerId}</code>`;
  await ctx.editMessageText(
    i18nTransferConfirm(targetLabel),
    {
      reply_markup: keyboard([
        [btn('✅ تأكيد النقل', `admin_transfer_do:${newOwnerId}`)],
        [btn('❌ إلغاء', 'admin_transfer')],
      ]),
    },
  );
}

function i18nTransferConfirm(targetLabel) {
  return (
    `⚠️ <b>تأكيد نقل الملكية</b>\n\n` +
    `سيصبح الحساب ${targetLabel} المالك الجديد، ويتحوّل دورك إلى مشرف.\n\n` +
    'هل تريد المتابعة؟'
  );
}

/** Execute the transfer (audited) and re-render the roster. */
export async function doTransfer(ctx, newOwnerId) {
  if (!db.isOwner(ctx.from.id)) {
    await ctx.editMessageText('🔒 نقل الملكية متاح للمالك الحالي فقط.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }

  const [ok, message] = db.transferOwnership(ctx.from.id, newOwnerId);

  if (ok) {
    await audit.logAction(ctx.from.id, 'ownership_transfer', {
      targetType: 'admin',
      targetId: newOwnerId,
    });

    try {
      const bot = ctx.bot;
      if (bot?.sendMessage) {
        await bot.sendMessage(
          newOwnerId,
          '👑 <b>تم نقل ملكية المنصة إليك</b>\n\nأصبحت الآن المالك بحقوق كاملة.',
          { parse_mode: 'HTML' },
        );
      }
    } catch {
      // Notification is best-effort.
    }
  }

  await ctx.editMessageText(message, {
    reply_markup: keyboard([
      [btn('⬅️ المشرفون', 'admin_admins')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Add an admin by @username / ID
// ---------------------------------------------------------------------------

/** Arm the add-admin flow. */
export async function armAddAdmin(ctx) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  workflow.begin(ctx, ADMIN_ADD_WORKFLOW);
  ctx.userData.admin_mgmt_waiting_add = true;

  await ctx.editMessageText(
    '➕ <b>إضافة مشرف</b>\n\n' +
      'أرسل @username أو Telegram ID الرقمي للحساب.\n\n' +
      'ℹ️ يجب أن يكون الحساب قد استخدم البوت من قبل ليظهر في بيانات المنصة.\n\n' +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([[btn('❌ إلغاء', 'admin_admins')], [btn('🏠 الرئيسية', 'home')]]),
    },
  );
}

/** Consume the identifier and add the admin. Returns handled. */
export async function handleAddAdminText(ctx) {
  if (!ctx.userData?.admin_mgmt_waiting_add) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, ADMIN_ADD_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();
  if (text === '/cancel') {
    workflow.clear(ctx);
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  if (!canManageAdmins(ctx.from.id)) {
    workflow.clear(ctx);
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  const [ok, message] = db.addSubAdminByAny(text);
  workflow.clear(ctx);

  if (ok) {
    const [userId] = db.resolveUserByIdentifier(text);
    await audit.logAction(ctx.from.id, 'admin_add', { targetType: 'admin', targetId: userId });
  }

  await ctx.reply(message, {
    reply_markup: keyboard([
      [btn('⬅️ المشرفون', 'admin_admins')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Scoped RBAC — the SINGLE hierarchical scope browser
// ---------------------------------------------------------------------------

/** The scope manager for one admin: list + add entry point. */
export async function showScopeMenu(ctx, adminId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let scopes = [];
  let record;
  try {
    scopes = db.getAdminScopes(adminId);
    record = db.getAdminRecord(adminId);
  } catch {
    scopes = [];
    record = null;
  }

  const lines = [
    '🧭 <b>نطاق المسؤولية</b>',
    '',
    record ? `👤 ${record.username ? `@${esc(record.username)}` : esc(adminId)}` : '',
    '',
  ];

  if (!scopes.length) {
    lines.push(
      '🌐 <b>غير مقيّد</b>',
      '',
      'بدون أي نطاق، يملك المشرف وصولاً على مستوى المنصة بالكامل داخل صلاحياته.',
      'أضف نطاقاً لتقييده على فرع محدد من شجرة المنصة.',
    );
  } else {
    lines.push(`🔒 <b>مقيّد بـ ${scopes.length} نطاق:</b>`, '');
    for (const scope of scopes) lines.push(`• ${describeScope(scope)}`);
  }

  const rows = [
    [btn('➕ إضافة نطاق', `scope_add:${adminId}`)],
  ];
  if (scopes.length) {
    rows.push([btn('🗑 إزالة نطاق', `scope_remove_menu:${adminId}`)]);
    rows.push([btn('🧹 إزالة كل النطاقات', `scope_clear:${adminId}`)]);
  }
  rows.push([btn('⬅️ رجوع', `admin_view:${adminId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.filter((line) => line !== '').join('\n'), {
    reply_markup: keyboard(rows),
  });
}

/**
 * The single hierarchical scope picker.
 *
 * Starts at the root of the REAL hierarchy and navigates downward. There is no
 * initial "Section / Topic / Resource" question: `scope_type` is derived from
 * whichever node the admin selects. Each selectable node carries its own
 * selection button:
 *
 *   * a folder        -> "✅ قسم"
 *   * the topic list  -> topic entries with "✅ موضوع"
 *   * resources       -> each with "✅ مورد"
 *
 * Topics are surfaced at the root level as extra entry points; resources are
 * listed under the folder that holds them.
 */
export async function showScopePicker(ctx, adminId, parentId = 0, showTopics = null) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  // At the root, offer topics as an extra branch (default on, toggleable).
  const atRoot = !parentId;
  const topicsVisible = showTopics === null ? atRoot : showTopics;

  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
  }

  let files = [];
  if (parentId) {
    try {
      files = db.getFiles(parentId);
    } catch {
      files = [];
    }
  }

  let existing = [];
  try {
    existing = db.getAdminScopes(adminId);
  } catch {
    existing = [];
  }
  const existingKeys = new Set(existing.map((scope) => `${scope.scope_type}:${scope.scope_id}`));

  let breadcrumb = 'الرئيسية 🏠';
  if (parentId) {
    try {
      breadcrumb = db.getBreadcrumbs(parentId);
    } catch {
      breadcrumb = String(parentId);
    }
  }

  const lines = [
    '🧭 <b>إضافة نطاق</b>',
    '',
    `📍 ${esc(breadcrumb)}`,
    '',
    'تنقّل داخل شجرة المنصة، ثم اضغط زر التحديد بجانب أي عنصر حقيقي تريد منحه.',
    '• قسم يمنح القسم وكل ما تحته',
    '• موضوع يمنح كل الأقسام المرتبطة به',
    '• مورد يمنح هذا المورد فقط',
    '',
  ];

  const rows = [];

  // Topics branch at the root (real, curated entry points).
  if (topicsVisible) {
    let topics = [];
    try {
      topics = db.getTopics(true);
    } catch {
      topics = [];
    }
    for (const topic of topics) {
      const already = existingKeys.has(`topic:${topic.id}`);
      rows.push([
        btn(`${already ? '✅ ' : ''}🧭 ${String(topic.name).slice(0, 18)}`, `scope_set:${adminId}:topic:${topic.id}`),
      ]);
    }
  }

  // Folders: select (folder scope) plus drill-down.
  for (const [folderId, name, nodeType] of folders) {
    const already = existingKeys.has(`folder:${folderId}`);
    rows.push([
      btn(
        `${already ? '✅ ' : ''}${resourceIcon(nodeType)} ${String(name).slice(0, 14)}`,
        `scope_set:${adminId}:folder:${folderId}`,
      ),
      btn('↳ دخول', `scope_browse:${adminId}:${folderId}`),
    ]);
  }

  // Resources at this level: select the exact item.
  for (const [contentId, title] of files) {
    const already = existingKeys.has(`resource:${contentId}`);
    rows.push([
      btn(`${already ? '✅ ' : ''}📄 ${String(title).slice(0, 26)}`, `scope_set:${adminId}:resource:${contentId}`),
    ]);
  }

  if (parentId) {
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `scope_browse:${adminId}:${parent || 0}`)]);
  }

  rows.push([btn('⬅️ النطاق', `scope_menu:${adminId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  let hasAnyNode = folders.length > 0 || files.length > 0;
  if (topicsVisible) {
    try {
      hasAnyNode = hasAnyNode || db.getTopics(true).length > 0;
    } catch {
      // Topics are optional for the picker.
    }
  }
  if (!hasAnyNode) lines.push('ℹ️ لا توجد عناصر في هذا المستوى.');

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Grant one scope (validated against the live registry) and audit it. */
export async function setScope(ctx, adminId, scopeType, scopeId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const ok = db.addAdminScope(adminId, scopeType, scopeId, ctx.from.id);
  if (ok) {
    await audit.logAction(ctx.from.id, 'scope_grant', {
      targetType: 'admin',
      targetId: adminId,
      details: `${scopeType}:${scopeId}`,
    });
  }

  // Stay in the picker, at the same level, so multiple scopes can be added.
  if (scopeType === 'folder') {
    let parent = 0;
    try {
      parent = db.getParentId(scopeId);
    } catch {
      parent = 0;
    }
    await showScopePicker(ctx, adminId, parent);
    return;
  }
  if (scopeType === 'topic') {
    await showScopePicker(ctx, adminId, 0, true);
    return;
  }
  let folderId = 0;
  try {
    folderId = db.contentFolderId(scopeId) ?? 0;
  } catch {
    folderId = 0;
  }
  await showScopePicker(ctx, adminId, folderId);
}

/** Picker for removing an existing scope. */
export async function showScopeRemoveMenu(ctx, adminId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let scopes = [];
  try {
    scopes = db.getAdminScopes(adminId);
  } catch {
    scopes = [];
  }

  if (!scopes.length) {
    await showScopeMenu(ctx, adminId);
    return;
  }

  const rows = [];
  for (const scope of scopes) {
    rows.push([
      btn(`🗑 ${describeScope(scope).replace(/^[^ ]+ /, '').slice(0, 34)}`, `scope_del:${adminId}:${scope.scope_type}:${scope.scope_id}`),
    ]);
  }
  rows.push([btn('⬅️ النطاق', `scope_menu:${adminId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText('🗑 <b>إزالة نطاق</b>\n\nاختر النطاق الذي تريد إزالته:', {
    reply_markup: keyboard(rows),
  });
}

/** Revoke one scope and audit it. */
export async function removeScope(ctx, adminId, scopeType, scopeId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (db.removeAdminScope(adminId, scopeType, scopeId)) {
    await audit.logAction(ctx.from.id, 'scope_revoke', {
      targetType: 'admin',
      targetId: adminId,
      details: `${scopeType}:${scopeId}`,
    });
  }
  await showScopeMenu(ctx, adminId);
}

/** Revoke every scope: the admin becomes platform-wide again. */
export async function clearScopes(ctx, adminId) {
  if (!canManageAdmins(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const removed = db.clearAdminScopes(adminId);
  if (removed) {
    await audit.logAction(ctx.from.id, 'scope_revoke', {
      targetType: 'admin',
      targetId: adminId,
      details: `all (${removed})`,
    });
  }
  await showScopeMenu(ctx, adminId);
}

// ---------------------------------------------------------------------------
// Callback dispatch
// ---------------------------------------------------------------------------

export async function adminManagementCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  if (data === 'admin_admins') {
    await showAdmins(ctx);
    return;
  }
  if (data === 'admin_add') {
    await armAddAdmin(ctx);
    return;
  }
  if (data === 'admin_transfer') {
    await showTransferMenu(ctx);
    return;
  }
  if (data.startsWith('admin_transfer_confirm:')) {
    await confirmTransfer(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_transfer_do:')) {
    await doTransfer(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_view:')) {
    await showAdmin(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_role_menu:')) {
    await showRoleMenu(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_setrole:')) {
    const [, adminId, role] = data.split(':');
    await setRole(ctx, Number.parseInt(adminId, 10), role);
    return;
  }
  if (data.startsWith('admin_perms:')) {
    await showPermissions(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_perm:')) {
    const [, adminId, key] = data.split(':');
    await togglePermission(ctx, Number.parseInt(adminId, 10), key);
    return;
  }
  if (data.startsWith('admin_revoke:')) {
    await revokeAdmin(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_restore:')) {
    await restoreAdmin(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }

  // ---- Scopes ---------------------------------------------------
  if (data.startsWith('scope_menu:')) {
    await showScopeMenu(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('scope_add:')) {
    await showScopePicker(ctx, Number.parseInt(data.split(':')[1], 10), 0, true);
    return;
  }
  if (data.startsWith('scope_browse:')) {
    const [, adminId, folderId] = data.split(':');
    await showScopePicker(ctx, Number.parseInt(adminId, 10), Number.parseInt(folderId, 10) || 0, false);
    return;
  }
  if (data.startsWith('scope_set:')) {
    const [, adminId, scopeType, scopeId] = data.split(':');
    await setScope(ctx, Number.parseInt(adminId, 10), scopeType, Number.parseInt(scopeId, 10));
    return;
  }
  if (data.startsWith('scope_remove_menu:')) {
    await showScopeRemoveMenu(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('scope_del:')) {
    const [, adminId, scopeType, scopeId] = data.split(':');
    await removeScope(ctx, Number.parseInt(adminId, 10), scopeType, Number.parseInt(scopeId, 10));
    return;
  }
  if (data.startsWith('scope_clear:')) {
    await clearScopes(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const ADMIN_MGMT_PREFIXES = [
  'admin_admins',
  'admin_add',
  'admin_transfer',
  'admin_transfer_confirm:',
  'admin_transfer_do:',
  'admin_view:',
  'admin_role_menu:',
  'admin_setrole:',
  'admin_perms:',
  'admin_perm:',
  'admin_revoke:',
  'admin_restore:',
  'scope_menu:',
  'scope_add:',
  'scope_browse:',
  'scope_set:',
  'scope_remove_menu:',
  'scope_del:',
  'scope_clear:',
];
