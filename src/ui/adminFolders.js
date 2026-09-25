/**
 * Admin dashboard (🛠 إدارة المنصة) and the structured section/resource editor.
 *
 * The dashboard only renders entries the admin's capabilities and scopes
 * actually allow, so a scoped admin never sees a surface they cannot use.
 *
 * Section editing lives here: create, rename, retype, toggle contribution
 * acceptance, move (guarded against cycles) and delete (empty folders only).
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as authorization from '../authorization.js';
import * as workflow from '../workflow.js';
import { btn, contentIcon, escHtml, keyboard, resourceIcon } from '../telegram/ui.js';

export const ADMIN_UPLOAD_WORKFLOW = 'admin_upload';
export const ADMIN_FILE_RENAME_WORKFLOW = 'admin_file_rename';
export const ADMIN_FILE_MOVE_PICKER = 'admin_file_move';

export const ADMIN_FOLDER_WORKFLOW = 'admin_folder_create';
export const ADMIN_RENAME_WORKFLOW = 'admin_folder_rename';

/**
 * The folder-type vocabulary, matching the Python reference's
 * `FOLDER_TYPE_OPTIONS` exactly: `books`, `summaries` (plural), and no
 * `document`. A mismatch here would write a `node_type` the Python data model
 * never produces.
 */
const NODE_TYPES = Object.freeze([
  ['general', '📁 عام'],
  ['books', '📚 كتب'],
  ['audio', '🎧 صوتيات'],
  ['video', '🎥 فيديو'],
  ['mcq', '📝 MCQ'],
  ['summaries', '📑 ملخصات'],
]);

const FOLDER_TYPE_KEYS = new Set(NODE_TYPES.map(([value]) => value));

/** The six type choices, one per row, plus the shared cancel. */
function folderTypeRows() {
  const rows = NODE_TYPES.map(([value, label]) => [
    btn(label, `admin_folder_type:${value}`),
  ]);
  rows.push([btn('❌ إلغاء', 'admin_folders')]);
  return rows;
}

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

/**
 * The dashboard, built from the caller's real capabilities.
 *
 * Hiding an entry is a courtesy; each destination re-checks the capability, so
 * a hand-crafted callback id cannot reach a forbidden surface.
 */
export async function showAdminPanel(ctx) {
  const userId = ctx.from.id;

  if (!authorization.isAdmin(userId)) {
    await ctx.editMessageText('🔒 هذه المنطقة مخصصة للمشرفين المعتمدين فقط.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }

  let pending = 0;
  let messages = 0;
  try {
    pending = db.getPendingContributionsCount();
    messages = db.getOpenMessagesCount();
  } catch {
    pending = 0;
    messages = 0;
  }

  const lines = ['🛠 <b>إدارة المنصة</b>', ''];
  const rows = [];

  if (has(userId, 'can_folders')) {
    rows.push([btn('🗂 إدارة الأقسام والفروع', 'admin_folders')]);
  }
  if (has(userId, 'can_content')) {
    rows.push([btn('📄 إدارة المحتوى', 'admin_content')]);
  }
  if (has(userId, 'can_contributions')) {
    rows.push([btn(`📥 مراجعة المساهمات${pending ? ` (${pending})` : ''}`, 'admin_pending')]);
  }
  if (has(userId, 'can_messages')) {
    rows.push([btn(`📬 رسائل الطلاب${messages ? ` (${messages})` : ''}`, 'admin_messages')]);
  }
  if (has(userId, 'can_news')) {
    rows.push([btn('📰 الأخبار', 'admin_news')]);
  }
  if (has(userId, 'can_topics')) {
    rows.push([btn('🧭 مواضيع البحث', 'admin_topics')]);
  }
  if (has(userId, 'can_notifications')) {
    rows.push([btn('🔔 الإشعارات', 'admin_notifications')]);
  }
  if (has(userId, 'can_ai')) {
    rows.push([btn('🤖 سجل الذكاء الاصطناعي', 'admin_ai')]);
  }
  if (has(userId, 'can_archive')) {
    rows.push([btn('🗄 أرشيف الطوارئ', 'admin_archive')]);
  }
  if (has(userId, 'can_settings')) {
    rows.push([btn('⚙️ إعدادات المنصة', 'admin_settings')]);
  }
  if (has(userId, 'can_visibility')) {
    rows.push([btn('🙈 إظهار/إخفاء الأقسام', 'vis_list')]);
  }
  if (has(userId, 'can_admins')) {
    rows.push([btn('👥 إدارة المشرفين', 'admin_admins')]);
    rows.push([btn('👑 نقل الملكية', 'admin_transfer')]);
    rows.push([btn('📜 سجل التدقيق', 'admin_audit')]);
  }

  rows.push([btn('📊 حالة التشغيل', 'admin_runtime')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  lines.push('اختر الإجراء الذي تريد تنفيذه:');

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

// ---------------------------------------------------------------------------
// Section (folder) management
// ---------------------------------------------------------------------------

/** Section browser for management, filtered by the admin's scope. */
export async function showFolderManager(ctx, parentId = 0) {
  if (!has(ctx.from.id, 'can_folders')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const scoped = authorization.isScopeRestricted(ctx.from.id);
  let allowed = null;
  if (scoped) {
    allowed = authorization.scopedFolderIds(ctx.from.id) ?? new Set();
  }

  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
  }

  // A restricted admin can only see folders inside their own scope.
  if (allowed !== null) folders = folders.filter((folder) => allowed.has(folder[0]));

  let breadcrumb = 'الرئيسية 🏠';
  if (parentId) {
    try {
      breadcrumb = db.getBreadcrumbs(parentId);
    } catch {
      breadcrumb = String(parentId);
    }
  }

  const lines = [
    '🗂 <b>إدارة الأقسام</b>',
    '',
    `📍 ${esc(breadcrumb)}`,
    '',
    scoped ? '🔒 تظهر الأقسام داخل نطاق مسؤوليتك فقط.' : '🌐 كل الأقسام.',
    '',
  ];

  if (!folders.length) lines.push('• لا توجد أقسام في هذا المستوى.');

  const rows = [];
  for (const [folderId, name, nodeType, accepts] of folders) {
    lines.push(
      `${resourceIcon(nodeType)} <b>${esc(name)}</b> — ${accepts ? '✅ يستقبل مساهمات' : '⛔ لا يستقبل'}`,
    );
    rows.push([
      btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 20)}`, `admin_folder:${folderId}`),
      btn('↳ دخول', `admin_folder_child:${folderId}`),
    ]);
  }

  if (parentId) {
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `admin_folders:${parent || 0}`)]);
  }

  // Creating a new top-level section is a platform-wide act, so a scoped admin
  // never gets the entry point — matching the Python dashboard.
  if (!scoped) {
    rows.push([btn('➕ إنشاء قسم جديد', 'admin_folder_create')]);
  }
  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** One section: rename / retype / toggle / move / delete. */
export async function showFolderAdmin(ctx, folderId) {
  if (!has(ctx.from.id, 'can_folders')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  // Scope gate: managing a section requires section.manage inside the scope.
  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  let folder;
  try {
    folder = db.getFolder(folderId);
  } catch {
    folder = null;
  }
  if (!folder) {
    await ctx.editMessageText('⚠️ القسم غير موجود.', { reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]) });
    return;
  }

  const [, parentId, name, nodeType, accepts] = folder;

  let childCount = 0;
  let fileCount = 0;
  let children = [];
  try {
    children = db.getFolders(folderId);
    childCount = children.length;
    fileCount = db.getFiles(folderId).length;
  } catch {
    children = [];
    childCount = 0;
    fileCount = 0;
  }

  let breadcrumb = '';
  try {
    breadcrumb = db.getBreadcrumbs(folderId);
  } catch {
    breadcrumb = '';
  }

  const rows = [
    [btn('➕ إضافة قسم فرعي', `admin_folder_create:${folderId}`)],
    [btn('📤 رفع مورد', `admin_upload:${folderId}`)],
    [btn('✏️ إعادة تسمية', `admin_folder_rename:${folderId}`)],
    [btn('📦 تغيير النوع', `admin_folder_retype:${folderId}`)],
    [
      btn(
        accepts ? '⛔ إيقاف استقبال المساهمات' : '✅ تفعيل استقبال المساهمات',
        `admin_folder_toggle:${folderId}`,
      ),
    ],
    [btn('🚚 نقل القسم', `admin_folder_move:${folderId}`)],
  ];

  // Direct navigation into this branch's real sub-sections, so the admin never
  // has to leave the panel to walk the tree.
  for (const [childId, childName, childType] of children) {
    rows.push([
      btn(`${resourceIcon(childType)} ${String(childName).slice(0, 35)}`, `admin_folder:${childId}`),
    ]);
  }

  rows.push([btn('🗑 حذف القسم', `admin_folder_delete:${folderId}`)]);
  if (parentId) {
    rows.push([btn('⬅️ القسم الأب', `admin_folder:${parentId}`)]);
  } else {
    rows.push([btn('⬅️ إدارة الأقسام', 'admin_folders')]);
  }
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    `${resourceIcon(nodeType)} <b>${esc(name)}</b>\n\n` +
      `📍 ${esc(breadcrumb)}\n` +
      `🏷 ${esc(nodeType)}\n` +
      `📂 أقسام فرعية: ${childCount} · 📄 موارد: ${fileCount}\n` +
      `📤 ${accepts ? 'يستقبل مساهمات' : 'لا يستقبل مساهمات'}`,
    { reply_markup: keyboard(rows) },
  );
}

/** Arm folder creation under `parentId`. */
export async function armFolderCreate(ctx, parentId = 0) {
  if (!has(ctx.from.id, 'can_folders')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }
  if (parentId && !authorization.can(ctx.from.id, 'section.manage', 'folder', parentId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  workflow.begin(ctx, ADMIN_FOLDER_WORKFLOW);
  ctx.userData.admin_folder_create = true;
  ctx.userData.admin_folder_parent = parentId;
  delete ctx.userData.admin_folder_name;
  delete ctx.userData.admin_folder_type;

  await ctx.editMessageText(
    '➕ <b>قسم جديد</b>\n\nأرسل اسم القسم في رسالة واحدة.\n\nلإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', parentId ? `admin_folder_child:${parentId}` : 'admin_folders')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/**
 * Hierarchical parent picker for a new folder.
 *
 * The Python reference opens the real tree at `parentId` and lets the admin
 * descend until they reach the branch they want; "create here" commits the
 * current node as the parent. There is no separate "choose a section" question.
 */
export async function showFolderParents(ctx, parentId = 0) {
  if (!has(ctx.from.id, 'can_folders')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const target = Number.isFinite(parentId) ? parentId : 0;
  if (target && !authorization.can(ctx.from.id, 'section.manage', 'folder', target)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  let folders = [];
  try {
    folders = db.getFolders(target);
  } catch {
    folders = [];
  }

  const scoped = authorization.isScopeRestricted(ctx.from.id);
  if (scoped) {
    const allowed = authorization.scopedFolderIds(ctx.from.id) ?? new Set();
    folders = folders.filter((folder) => allowed.has(folder[0]));
  }

  const rows = [[btn('✅ إنشاء القسم هنا', `admin_folder_select_parent:${target}`)]];

  for (const [folderId, name] of folders) {
    rows.push([btn(`📁 ${String(name).slice(0, 35)}`, `admin_folder_parent:${folderId}`)]);
  }

  if (target) {
    let parent = 0;
    try {
      parent = db.getParentId(target);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `admin_folder_parent:${parent || 0}`)]);
  }

  rows.push([btn('⬅️ إدارة الأقسام', 'admin_folders')]);

  await ctx.editMessageText(
    '📂 <b>اختيار القسم الأب</b>\n\n' +
      'ادخل إلى القسم الذي تريد وضع القسم الجديد بداخله، ثم اضغط «إنشاء القسم هنا».',
    { reply_markup: keyboard(rows) },
  );
}

/** Commit `parentId` as the chosen parent and ask for the name. */
export async function selectFolderParent(ctx, parentId) {
  if (!has(ctx.from.id, 'can_folders')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }
  if (parentId && !authorization.can(ctx.from.id, 'section.manage', 'folder', parentId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  workflow.begin(ctx, ADMIN_FOLDER_WORKFLOW);
  ctx.userData.admin_folder_create = true;
  ctx.userData.admin_folder_parent = parentId;
  delete ctx.userData.admin_folder_name;
  delete ctx.userData.admin_folder_type;

  await ctx.editMessageText(
    '✏️ <b>اسم القسم الجديد</b>\n\nأرسل الآن اسم القسم في رسالة نصية.\n\nلإلغاء العملية استخدم الزر أدناه.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'admin_folders')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** The type menu, re-openable from the accepts step via «تغيير النوع». */
export async function showFolderCreateTypes(ctx) {
  if (!has(ctx.from.id, 'can_folders')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const name = ctx.userData?.admin_folder_name;
  const parentId = ctx.userData?.admin_folder_parent;

  if (!name || parentId === undefined || parentId === null) {
    workflow.clear(ctx);
    await ctx.editMessageText('⚠️ انتهت جلسة إنشاء القسم. ابدأ العملية من جديد.', {
      reply_markup: keyboard([
        [btn('🗂 إدارة الأقسام', 'admin_folders')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  await ctx.editMessageText(`📁 القسم: <b>${esc(name)}</b>\n\nاختر نوع القسم:`, {
    reply_markup: keyboard(folderTypeRows()),
  });
}

/** Record the chosen type and ask whether the section accepts contributions. */
export async function chooseFolderCreateType(ctx, nodeType) {
  if (!has(ctx.from.id, 'can_folders')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const name = ctx.userData?.admin_folder_name;
  const parentId = ctx.userData?.admin_folder_parent;

  if (!name || parentId === undefined || parentId === null) {
    workflow.clear(ctx);
    await ctx.editMessageText('⚠️ انتهت جلسة إنشاء القسم. ابدأ العملية من جديد.', {
      reply_markup: keyboard([
        [btn('🗂 إدارة الأقسام', 'admin_folders')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  const value = String(nodeType ?? '');
  if (!FOLDER_TYPE_KEYS.has(value)) {
    await ctx.editMessageText('⚠️ نوع قسم غير معروف.', {
      reply_markup: keyboard(folderTypeRows()),
    });
    return;
  }

  ctx.userData.admin_folder_type = value;

  await ctx.editMessageText(
    `📁 القسم: <b>${esc(name)}</b>\n` +
      `🧩 النوع: <code>${esc(value)}</code>\n\n` +
      'هل يسمح هذا القسم باستقبال مساهمات الطلاب؟',
    {
      reply_markup: keyboard([
        [btn('✅ نعم', 'admin_folder_accepts:1')],
        [btn('❌ لا', 'admin_folder_accepts:0')],
        [btn('⬅️ تغيير النوع', 'admin_folder_retype')],
        [btn('❌ إلغاء', 'admin_folders')],
      ]),
    },
  );
}

/** Create the folder once name, parent, type and accepts are all known. */
export async function finishFolderCreate(ctx, accepts) {
  if (!has(ctx.from.id, 'can_folders')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const name = ctx.userData?.admin_folder_name;
  const parentId = ctx.userData?.admin_folder_parent;
  const nodeType = ctx.userData?.admin_folder_type ?? 'general';

  if (!name || parentId === undefined || parentId === null) {
    workflow.clear(ctx);
    await ctx.editMessageText('⚠️ بيانات إنشاء القسم غير مكتملة. ابدأ العملية من جديد.', {
      reply_markup: keyboard([
        [btn('🗂 إدارة الأقسام', 'admin_folders')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  // Scope gate: a scoped admin may only build inside their own branch.
  if (parentId && !authorization.can(ctx.from.id, 'section.manage', 'folder', parentId)) {
    workflow.clear(ctx);
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  const wantsContributions = accepts ? 1 : 0;

  let folderId;
  try {
    folderId = db.addFolder(parentId, name, nodeType, wantsContributions);
  } catch {
    folderId = null;
  }

  workflow.clear(ctx);

  if (!folderId) {
    await ctx.editMessageText('⚠️ تعذّر إنشاء القسم.', {
      reply_markup: keyboard([
        [btn('🔄 إدارة الأقسام', 'admin_folders')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  await audit.logAction(ctx.from.id, 'folder_create', {
    targetType: 'folder',
    targetId: folderId,
    details: `name=${name}, type=${nodeType}, parent=${parentId}`,
  });

  await ctx.editMessageText(
    '✅ <b>تم إنشاء القسم بنجاح.</b>\n\n' +
      `📁 الاسم: <b>${esc(name)}</b>\n` +
      `🧩 النوع: <code>${esc(nodeType)}</code>\n` +
      `📤 استقبال المساهمات: ${wantsContributions ? 'نعم' : 'لا'}\n\n` +
      'يمكنك الآن رفع الموارد داخله أو إنشاء قسم فرعي.',
    {
      reply_markup: keyboard([
        [btn('🔧 إدارة القسم', `admin_folder:${folderId}`)],
        [btn('⬅️ الأقسام', parentId ? `admin_folder_child:${parentId}` : 'admin_folders')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Consume the new folder name, then move on to the type step. */
export async function handleFolderCreateText(ctx) {
  if (!ctx.userData?.admin_folder_create) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, ADMIN_FOLDER_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();
  if (text === '/cancel') {
    workflow.clear(ctx);
    await ctx.reply('❌ تم إلغاء إنشاء القسم.', { reply_markup: homeKeyboard() });
    return true;
  }

  if (!has(ctx.from.id, 'can_folders')) {
    workflow.clear(ctx);
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  if (!text) {
    await ctx.reply('⚠️ اسم القسم لا يمكن أن يكون فارغاً. أرسل الاسم مرة أخرى.');
    return true;
  }

  if (text.length > 100) {
    await ctx.reply('⚠️ اسم القسم طويل جداً. الحد الأقصى 100 حرف.');
    return true;
  }

  ctx.userData.admin_folder_name = text;
  ctx.userData.admin_folder_create = true;

  await ctx.reply(`📁 اسم القسم:\n<b>${esc(text)}</b>\n\nاختر نوع القسم:`, {
    reply_markup: keyboard(folderTypeRows()),
  });
  return true;
}

/** Arm folder rename. */
export async function armFolderRename(ctx, folderId) {
  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  workflow.begin(ctx, ADMIN_RENAME_WORKFLOW);
  ctx.userData.admin_folder_rename = true;
  ctx.userData.admin_folder_rename_id = folderId;

  await ctx.editMessageText(
    `✏️ <b>إعادة تسمية القسم #${folderId}</b>\n\nأرسل الاسم الجديد.\n\nلإلغاء العملية أرسل /cancel.`,
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', `admin_folder:${folderId}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Consume the new folder name. Returns handled. */
export async function handleFolderRenameText(ctx) {
  if (!ctx.userData?.admin_folder_rename) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, ADMIN_RENAME_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();
  if (text === '/cancel') {
    workflow.clear(ctx);
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  const folderId = ctx.userData.admin_folder_rename_id;

  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    workflow.clear(ctx);
    await ctx.reply('🚫 هذا القسم خارج نطاق مسؤوليتك.', { reply_markup: homeKeyboard() });
    return true;
  }

  const ok = db.updateFolderName(folderId, text);
  workflow.clear(ctx);

  if (ok) {
    await audit.logAction(ctx.from.id, 'folder_rename', {
      targetType: 'folder',
      targetId: folderId,
      details: text,
    });
  }

  await ctx.reply(ok ? `✅ تم تحديث الاسم إلى: <b>${esc(text)}</b>` : '⚠️ تعذّر التحديث.', {
    reply_markup: keyboard([[btn('🔧 إدارة القسم', `admin_folder:${folderId}`)], [btn('⬅️ الأقسام', 'admin_folders')]]),
  });
  return true;
}

/** Change a folder's type. */
export async function showFolderTypeMenu(ctx, folderId) {
  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  const rows = [];
  for (const [value, label] of NODE_TYPES) {
    rows.push([btn(label, `admin_folder_settype:${folderId}:${value}`)]);
  }
  rows.push([btn('⬅️ رجوع', `admin_folder:${folderId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText('🏷 <b>تغيير نوع القسم</b>\n\nاختر النوع الجديد:', {
    reply_markup: keyboard(rows),
  });
}

export async function setFolderType(ctx, folderId, nodeType) {
  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  if (!NODE_TYPES.some(([value]) => value === nodeType)) {
    await showFolderTypeMenu(ctx, folderId);
    return;
  }

  if (db.updateFolderType(folderId, nodeType)) {
    await audit.logAction(ctx.from.id, 'folder_retype', {
      targetType: 'folder',
      targetId: folderId,
      details: nodeType,
    });
  }
  await showFolderAdmin(ctx, folderId);
}

/** Toggle a folder's contribution acceptance. */
export async function toggleFolderAccepts(ctx, folderId) {
  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  const next = !db.folderAcceptsContributions(folderId);
  db.updateFolderAcceptsContributions(folderId, next ? 1 : 0);
  await audit.logAction(ctx.from.id, 'folder_toggle', {
    targetType: 'folder',
    targetId: folderId,
    details: next ? 'on' : 'off',
  });
  await showFolderAdmin(ctx, folderId);
}

/** Delete an empty folder. */
export async function deleteFolder(ctx, folderId) {
  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  const ok = db.deleteFolder(folderId);
  if (ok) {
    await audit.logAction(ctx.from.id, 'folder_delete', { targetType: 'folder', targetId: folderId });
    await ctx.editMessageText('✅ تم حذف القسم.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')], [btn('🏠 الرئيسية', 'home')]]),
    });
    return;
  }

  await ctx.editMessageText(
    '⚠️ لا يمكن حذف القسم إلا إذا كان فارغاً تماماً (بدون أقسام فرعية أو موارد أو مساهمات).',
    { reply_markup: keyboard([[btn('⬅️ رجوع', `admin_folder:${folderId}`)]]) },
  );
}

/** Move picker: navigate the tree and choose the new parent. */
export async function showMovePicker(ctx, folderId, parentId = 0) {
  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  let target;
  try {
    target = db.getFolder(folderId);
  } catch {
    target = null;
  }
  if (!target) {
    await ctx.editMessageText('⚠️ القسم غير موجود.', { reply_markup: homeKeyboard() });
    return;
  }

  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
  }

  // A folder can never be moved into itself or one of its own descendants.
  const candidates = folders.filter((folder) => folder[0] !== folderId);

  let breadcrumb = 'الرئيسية 🏠';
  if (parentId) {
    try {
      breadcrumb = db.getBreadcrumbs(parentId);
    } catch {
      breadcrumb = String(parentId);
    }
  }

  const rows = [];
  for (const [candidateId, name, nodeType] of candidates) {
    rows.push([
      btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 16)}`, `admin_folder_move_browse:${folderId}:${candidateId}`),
      btn('✅ هنا', `admin_folder_move_to:${folderId}:${candidateId}`),
    ]);
  }

  // The currently viewed level itself may be a valid destination.
  if (parentId && parentId !== folderId) {
    rows.push([btn('✅ النقل إلى هنا', `admin_folder_move_to:${folderId}:${parentId}`)]);
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `admin_folder_move_browse:${folderId}:${parent || 0}`)]);
  }

  rows.push([btn('🏠 نقل إلى الجذر', `admin_folder_move_to:${folderId}:0`)]);
  rows.push([btn('⬅️ إلغاء', `admin_folder:${folderId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    `🚚 <b>نقل القسم</b>\n\n📁 القسم: <b>${esc(target[2])}</b>\n📍 ${esc(breadcrumb)}\n\n` +
      'اختر القسم الأب الجديد (الجذر أو أي قسم):',
    { reply_markup: keyboard(rows) },
  );
}

/** Execute a validated folder move. */
export async function moveFolder(ctx, folderId, newParentId) {
  if (!authorization.can(ctx.from.id, 'section.manage', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأقسام', 'admin_folders')]]),
    });
    return;
  }

  const [ok, message] = db.moveFolder(folderId, newParentId);

  if (ok) {
    await audit.logAction(ctx.from.id, 'folder_move', {
      targetType: 'folder',
      targetId: folderId,
      details: `parent=${newParentId}`,
    });
    await ctx.editMessageText(`✅ ${message}`, {
      reply_markup: keyboard([
        [btn('🔧 إدارة القسم', `admin_folder:${folderId}`)],
        [btn('⬅️ الأقسام', 'admin_folders')],
      ]),
    });
    return;
  }

  await ctx.editMessageText(`⚠️ ${message}`, {
    reply_markup: keyboard([[btn('⬅️ رجوع', `admin_folder:${folderId}`)]]),
  });
}

// ---------------------------------------------------------------------------
// Content management
// ---------------------------------------------------------------------------

/** Content browser, filtered by the admin's scope. */
export async function showContentManager(ctx, folderId = 0) {
  if (!has(ctx.from.id, 'can_content')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const scoped = authorization.isScopeRestricted(ctx.from.id);
  let allowed = null;
  if (scoped) allowed = authorization.scopedFolderIds(ctx.from.id) ?? new Set();

  let folders = [];
  try {
    folders = db.getFolders(folderId);
  } catch {
    folders = [];
  }
  if (allowed !== null) folders = folders.filter((folder) => allowed.has(folder[0]));

  let files = [];
  if (folderId) {
    try {
      files = db.getFiles(folderId);
    } catch {
      files = [];
    }
  }
  if (allowed !== null && folderId) files = files.filter(() => allowed.has(folderId));

  let breadcrumb = 'الرئيسية 🏠';
  if (folderId) {
    try {
      breadcrumb = db.getBreadcrumbs(folderId);
    } catch {
      breadcrumb = String(folderId);
    }
  }

  const lines = ['📄 <b>إدارة المحتوى</b>', '', `📍 ${esc(breadcrumb)}`, ''];

  const rows = [];
  for (const [childId, name, nodeType] of folders) {
    rows.push([
      btn(`📂 ${resourceIcon(nodeType)} ${String(name).slice(0, 24)}`, `admin_content:${childId}`),
    ]);
  }
  for (const [contentId, title, , fileType] of files) {
    rows.push([btn(`${contentIcon(fileType)} ${String(title).slice(0, 30)}`, `admin_file:${contentId}`)]);
  }

  if (!folders.length && !files.length) lines.push('• لا توجد أقسام أو موارد في هذا المستوى.');

  if (folderId) {
    let parent = 0;
    try {
      parent = db.getParentId(folderId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `admin_content:${parent || 0}`)]);
  }

  rows.push([btn('⬆️ رفع مورد هنا', `admin_upload:${folderId}`)]);
  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** One resource: rename / retype / move / delete. */
export async function showFileAdmin(ctx, contentId) {
  if (!has(ctx.from.id, 'can_content')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!authorization.can(ctx.from.id, 'resource.edit', 'resource', contentId)) {
    await ctx.editMessageText('🚫 هذا المورد خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]),
    });
    return;
  }

  let record;
  try {
    record = db.getFileRecord(contentId);
  } catch {
    record = null;
  }
  if (!record) {
    await ctx.editMessageText('⚠️ المورد غير موجود.', { reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]) });
    return;
  }

  const [, folderId, title, , fileType, sourceType] = record;

  let path = '';
  try {
    path = db.getBreadcrumbs(folderId);
  } catch {
    path = '';
  }

  const rows = [
    [btn('✏️ إعادة تسمية', `admin_file_rename:${contentId}`)],
    [btn('🏷 تغيير النوع', `admin_file_retype:${contentId}`)],
    [btn('🚚 نقل', `admin_file_move:${contentId}`)],
    [btn('🗑 حذف', `admin_file_delete:${contentId}`)],
    [btn('⬅️ المحتوى', `admin_content:${folderId}`)],
    [btn('🏠 الرئيسية', 'home')],
  ];

  await ctx.editMessageText(
    `${contentIcon(fileType)} <b>${esc(title)}</b>\n\n` +
      `📍 ${esc(path)}\n` +
      `📎 ${esc(fileType)}\n` +
      `🔖 المصدر: ${esc(sourceType ?? 'direct')}`,
    { reply_markup: keyboard(rows) },
  );
}

/** Delete a resource (audited). */
export async function deleteFile(ctx, contentId) {
  if (!authorization.can(ctx.from.id, 'resource.delete', 'resource', contentId)) {
    await ctx.editMessageText('🚫 هذا المورد خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]),
    });
    return;
  }

  let folderId = 0;
  try {
    folderId = db.contentFolderId(contentId) ?? 0;
  } catch {
    folderId = 0;
  }

  if (db.deleteFile(contentId)) {
    await audit.logAction(ctx.from.id, 'content_delete', {
      targetType: 'content',
      targetId: contentId,
    });
  }

  await ctx.editMessageText('✅ تم حذف المورد.', {
    reply_markup: keyboard([[btn('⬅️ المحتوى', `admin_content:${folderId}`)], [btn('🏠 الرئيسية', 'home')]]),
  });
}

// ---------------------------------------------------------------------------
// Content upload
// ---------------------------------------------------------------------------

const FILE_TYPES = Object.freeze([
  ['document', '📄 مستند'],
  ['audio', '🎧 صوتي'],
  ['video', '🎥 فيديو'],
  ['photo', '🖼 صورة'],
  ['mcq', '📝 MCQ'],
]);

/** Arm the upload flow for a folder: the next media message is the file. */
export async function armUpload(ctx, folderId) {
  if (!has(ctx.from.id, 'can_content')) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!authorization.can(ctx.from.id, 'resource.create', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]),
    });
    return;
  }

  let folder;
  try {
    folder = db.getFolder(folderId);
  } catch {
    folder = null;
  }
  if (!folder) {
    await ctx.editMessageText('⚠️ القسم غير موجود.', { reply_markup: homeKeyboard() });
    return;
  }

  workflow.begin(ctx, ADMIN_UPLOAD_WORKFLOW);
  ctx.userData.admin_upload = true;
  ctx.userData.admin_upload_folder = folderId;
  ctx.userData.admin_upload_state = 'await_file';

  await ctx.editMessageText(
    `⬆️ <b>رفع مورد إلى: ${esc(folder[2])}</b>\n\n` +
      'أرسل الآن الملف (مستند / صوت / فيديو / صورة).\n\n' +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', `admin_content:${folderId}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Capture the uploaded media and ask for the title. Returns handled. */
export async function handleUploadMedia(ctx) {
  if (ctx.userData?.admin_upload_state !== 'await_file') return false;
  if (!workflow.owns(ctx, ADMIN_UPLOAD_WORKFLOW)) return false;

  const contributions = await import('./contributions.js');
  const media = contributions.extractMedia(ctx.message);
  if (!media) return false;

  ctx.userData.admin_upload_file_id = media.fileId;
  ctx.userData.admin_upload_file_type = media.fileType;
  ctx.userData.admin_upload_state = 'await_title';
  workflow.begin(ctx, ADMIN_UPLOAD_WORKFLOW);

  await ctx.reply(
    '📄 الملف مستلم.\n\n✍️ أرسل الآن عنوان المورد.\n\nلإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', `admin_content:${ctx.userData.admin_upload_folder}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
  return true;
}

/** Consume the resource title and register the content. Returns handled. */
export async function handleUploadText(ctx) {
  if (ctx.userData?.admin_upload_state !== 'await_title') return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, ADMIN_UPLOAD_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();
  if (text === '/cancel') {
    workflow.clear(ctx);
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  const folderId = ctx.userData.admin_upload_folder;
  const fileId = ctx.userData.admin_upload_file_id;
  const fileType = ctx.userData.admin_upload_file_type;

  if (!authorization.can(ctx.from.id, 'resource.create', 'folder', folderId)) {
    workflow.clear(ctx);
    await ctx.reply('🚫 هذا القسم خارج نطاق مسؤوليتك.', { reply_markup: homeKeyboard() });
    return true;
  }

  let contentId;
  try {
    contentId = db.addContent(folderId, text, fileId, fileType, 'direct', null, ctx.from.id);
  } catch {
    contentId = null;
  }

  workflow.clear(ctx);

  if (!contentId) {
    await ctx.reply('⚠️ تعذّر إضافة المورد.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', `admin_content:${folderId}`)]]),
    });
    return true;
  }

  await audit.logAction(ctx.from.id, 'content_upload', {
    targetType: 'content',
    targetId: contentId,
    details: text,
  });

  // A newly registered resource produces (once) its own 📚 Section News item.
  try {
    const newsUi = await import('./news.js');
    await newsUi.publishNewsForResource(ctx.bot, contentId, ctx.from.id);
  } catch {
    // News generation is best-effort.
  }

  // Best-effort mirror to the Emergency Resource Archive. Isolation is the
  // point: an archive problem must never fail or delay the registration.
  try {
    const { publishResource } = await import('../archive.js');
    await publishResource(ctx.bot, contentId, true);
  } catch {
    // Archive mirroring is best-effort.
  }

  await ctx.reply(`✅ تم إضافة المورد: <b>${esc(text)}</b>`, {
    reply_markup: keyboard([
      [btn('🔧 إدارة المورد', `admin_file:${contentId}`)],
      [btn('⬅️ المحتوى', `admin_content:${folderId}`)],
    ]),
  });
  return true;
}

/** Arm resource rename. */
export async function armFileRename(ctx, contentId) {
  if (!authorization.can(ctx.from.id, 'resource.edit', 'resource', contentId)) {
    await ctx.editMessageText('🚫 هذا المورد خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]),
    });
    return;
  }

  workflow.begin(ctx, ADMIN_FILE_RENAME_WORKFLOW);
  ctx.userData.admin_file_rename = true;
  ctx.userData.admin_file_rename_id = contentId;

  await ctx.editMessageText(
    '✏️ <b>إعادة تسمية المورد</b>\n\nأرسل العنوان الجديد.\n\nلإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', `admin_file:${contentId}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Consume the new resource title. Returns handled. */
export async function handleFileRenameText(ctx) {
  if (!ctx.userData?.admin_file_rename) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, ADMIN_FILE_RENAME_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();
  if (text === '/cancel') {
    workflow.clear(ctx);
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  const contentId = ctx.userData.admin_file_rename_id;

  if (!authorization.can(ctx.from.id, 'resource.edit', 'resource', contentId)) {
    workflow.clear(ctx);
    await ctx.reply('🚫 هذا المورد خارج نطاق مسؤوليتك.', { reply_markup: homeKeyboard() });
    return true;
  }

  const ok = db.updateFileTitle(contentId, text);
  workflow.clear(ctx);

  if (ok) {
    await audit.logAction(ctx.from.id, 'content_rename', {
      targetType: 'content',
      targetId: contentId,
      details: text,
    });
  }

  await ctx.reply(ok ? `✅ تم تحديث العنوان إلى: <b>${esc(text)}</b>` : '⚠️ تعذّر التحديث.', {
    reply_markup: keyboard([[btn('🔧 إدارة المورد', `admin_file:${contentId}`)], [btn('⬅️ المحتوى', 'admin_content')]]),
  });
  return true;
}

/** Change a resource's type. */
export async function showFileTypeMenu(ctx, contentId) {
  if (!authorization.can(ctx.from.id, 'resource.edit', 'resource', contentId)) {
    await ctx.editMessageText('🚫 هذا المورد خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]),
    });
    return;
  }

  const rows = [];
  for (const [value, label] of FILE_TYPES) {
    rows.push([btn(label, `admin_file_settype:${contentId}:${value}`)]);
  }
  rows.push([btn('⬅️ رجوع', `admin_file:${contentId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText('🏷 <b>تغيير نوع المورد</b>\n\nاختر النوع الجديد:', {
    reply_markup: keyboard(rows),
  });
}

export async function setFileType(ctx, contentId, fileType) {
  if (!authorization.can(ctx.from.id, 'resource.edit', 'resource', contentId)) {
    await ctx.editMessageText('🚫 هذا المورد خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]),
    });
    return;
  }

  if (!FILE_TYPES.some(([value]) => value === fileType)) {
    await showFileTypeMenu(ctx, contentId);
    return;
  }

  if (db.updateContentType(contentId, fileType)) {
    await audit.logAction(ctx.from.id, 'content_retype', {
      targetType: 'content',
      targetId: contentId,
      details: fileType,
    });
  }
  await showFileAdmin(ctx, contentId);
}

/** Resource move picker. */
export async function showFileMovePicker(ctx, contentId, folderId = 0) {
  if (!authorization.can(ctx.from.id, 'resource.edit', 'resource', contentId)) {
    await ctx.editMessageText('🚫 هذا المورد خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]),
    });
    return;
  }

  let record;
  try {
    record = db.getFileRecord(contentId);
  } catch {
    record = null;
  }
  if (!record) {
    await ctx.editMessageText('⚠️ المورد غير موجود.', { reply_markup: homeKeyboard() });
    return;
  }

  const scoped = authorization.isScopeRestricted(ctx.from.id);
  let allowed = null;
  if (scoped) allowed = authorization.scopedFolderIds(ctx.from.id) ?? new Set();

  let folders = [];
  try {
    folders = db.getFolders(folderId);
  } catch {
    folders = [];
  }
  if (allowed !== null) folders = folders.filter((folder) => allowed.has(folder[0]));

  let breadcrumb = 'الرئيسية 🏠';
  if (folderId) {
    try {
      breadcrumb = db.getBreadcrumbs(folderId);
    } catch {
      breadcrumb = String(folderId);
    }
  }

  const rows = [];
  for (const [candidateId, name, nodeType] of folders) {
    rows.push([
      btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 16)}`, `admin_file_move_browse:${contentId}:${candidateId}`),
      btn('✅ هنا', `admin_file_move_to:${contentId}:${candidateId}`),
    ]);
  }

  if (folderId) {
    rows.push([btn('✅ النقل إلى هنا', `admin_file_move_to:${contentId}:${folderId}`)]);
    let parent = 0;
    try {
      parent = db.getParentId(folderId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `admin_file_move_browse:${contentId}:${parent || 0}`)]);
  }

  rows.push([btn('⬅️ إلغاء', `admin_file:${contentId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    `🚚 <b>نقل المورد</b>\n\n📄 ${esc(record[2])}\n📍 ${esc(breadcrumb)}\n\n` +
      'اختر المجلد الهدف:',
    { reply_markup: keyboard(rows) },
  );
}

/** Execute a resource move. */
export async function moveFile(ctx, contentId, newFolderId) {
  if (!authorization.can(ctx.from.id, 'resource.edit', 'resource', contentId)) {
    await ctx.editMessageText('🚫 هذا المورد خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المحتوى', 'admin_content')]]),
    });
    return;
  }
  if (!authorization.can(ctx.from.id, 'resource.create', 'folder', newFolderId)) {
    await ctx.editMessageText('🚫 المجلد الهدف خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ رجوع', `admin_file:${contentId}`)]]),
    });
    return;
  }

  const [ok, message] = db.moveContent(contentId, newFolderId);

  if (ok) {
    await audit.logAction(ctx.from.id, 'content_move', {
      targetType: 'content',
      targetId: contentId,
      details: `folder=${newFolderId}`,
    });
  }

  await ctx.editMessageText(ok ? `✅ ${message}` : `⚠️ ${message}`, {
    reply_markup: keyboard([
      [btn('🔧 إدارة المورد', `admin_file:${contentId}`)],
      [btn('⬅️ المحتوى', 'admin_content')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Callback dispatch
// ---------------------------------------------------------------------------

export async function adminFoldersCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  if (data === 'admin_folders' || data.startsWith('admin_folders:')) {
    const parentId = data.includes(':') ? Number.parseInt(data.split(':')[1], 10) || 0 : 0;
    await showFolderManager(ctx, parentId);
    return;
  }
  if (data.startsWith('admin_folder_child:')) {
    await showFolderManager(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data === 'admin_folder_create') {
    await showFolderParents(ctx, 0);
    return;
  }
  if (data.startsWith('admin_folder_create:')) {
    await armFolderCreate(ctx, Number.parseInt(data.split(':')[1], 10) || 0);
    return;
  }
  if (data.startsWith('admin_folder_parent:')) {
    await showFolderParents(ctx, Number.parseInt(data.split(':')[1], 10) || 0);
    return;
  }
  if (data.startsWith('admin_folder_select_parent:')) {
    await selectFolderParent(ctx, Number.parseInt(data.split(':')[1], 10) || 0);
    return;
  }
  if (data === 'admin_folder_retype') {
    await showFolderCreateTypes(ctx);
    return;
  }
  if (data.startsWith('admin_folder_type:')) {
    await chooseFolderCreateType(ctx, data.split(':')[1]);
    return;
  }
  if (data.startsWith('admin_folder_accepts:')) {
    const accepts = Number.parseInt(data.split(':')[1], 10);
    if (accepts !== 0 && accepts !== 1) {
      await ctx.editMessageText('⚠️ تعذّر إكمال إنشاء القسم.', {
        reply_markup: keyboard([[btn('🗂 إدارة الأقسام', 'admin_folders')]]),
      });
      return;
    }
    await finishFolderCreate(ctx, accepts === 1);
    return;
  }
  if (data.startsWith('admin_folder_rename:')) {
    await armFolderRename(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_folder_retype:')) {
    await showFolderTypeMenu(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_folder_settype:')) {
    const [, folderId, nodeType] = data.split(':');
    await setFolderType(ctx, Number.parseInt(folderId, 10), nodeType);
    return;
  }
  if (data.startsWith('admin_folder_toggle:')) {
    await toggleFolderAccepts(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_folder_delete:')) {
    await deleteFolder(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_folder_move_browse:')) {
    const [, folderId, parentId] = data.split(':');
    await showMovePicker(ctx, Number.parseInt(folderId, 10), Number.parseInt(parentId, 10) || 0);
    return;
  }
  if (data.startsWith('admin_folder_move_to:')) {
    const [, folderId, newParentId] = data.split(':');
    await moveFolder(ctx, Number.parseInt(folderId, 10), Number.parseInt(newParentId, 10) || 0);
    return;
  }
  if (data.startsWith('admin_folder_move:')) {
    await showMovePicker(ctx, Number.parseInt(data.split(':')[1], 10), 0);
    return;
  }
  if (data.startsWith('admin_folder:')) {
    await showFolderAdmin(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }

  // ---- Content --------------------------------------------------
  if (data === 'admin_content' || data.startsWith('admin_content:')) {
    const folderId = data.includes(':') ? Number.parseInt(data.split(':')[1], 10) || 0 : 0;
    await showContentManager(ctx, folderId);
    return;
  }
  if (data.startsWith('admin_file_delete:')) {
    await deleteFile(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_file_rename:')) {
    await armFileRename(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_file_retype:')) {
    await showFileTypeMenu(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('admin_file_settype:')) {
    const [, contentId, fileType] = data.split(':');
    await setFileType(ctx, Number.parseInt(contentId, 10), fileType);
    return;
  }
  if (data.startsWith('admin_file_move_browse:')) {
    const [, contentId, folderId] = data.split(':');
    await showFileMovePicker(ctx, Number.parseInt(contentId, 10), Number.parseInt(folderId, 10) || 0);
    return;
  }
  if (data.startsWith('admin_file_move_to:')) {
    const [, contentId, folderId] = data.split(':');
    await moveFile(ctx, Number.parseInt(contentId, 10), Number.parseInt(folderId, 10) || 0);
    return;
  }
  if (data.startsWith('admin_file_move:')) {
    await showFileMovePicker(ctx, Number.parseInt(data.split(':')[1], 10), 0);
    return;
  }
  if (data.startsWith('admin_upload:')) {
    await armUpload(ctx, Number.parseInt(data.split(':')[1], 10) || 0);
    return;
  }
  if (data.startsWith('admin_file:')) {
    await showFileAdmin(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const ADMIN_FOLDER_PREFIXES = [
  'admin_folders',
  'admin_folder_',
  'admin_folder:',
  'admin_content',
  'admin_file:',
  'admin_file_',
  'admin_upload:',
];
