import { all, get, run } from '../db/d1/core.js';
import {
  hasPermission,
  isAdmin,
  isOwner,
  getAdminRecord,
  getAdminsFullRecords,
  setAdminRole,
} from '../db/d1/admins.js';
import {
  getPendingContributionsCount,
  getReviewableContributionsList,
  approveContribution,
  rejectContribution,
} from '../db/d1/contributions.js';
import {
  getFolders,
  getFolderView,
  addFolder,
  updateFolderName,
  updateFolderAcceptsContributions,
  addContent,
  deleteFile,
  getResourceSnapshot,
  getAllResourceSnapshots,
} from '../db/d1/registry.js';
import {
  createNews,
  listNews,
  deleteNews,
  createResourceNewsForContent,
  publishNews,
} from '../db/d1/news.js';
import {
  getTopics,
  getTopic,
  getTopicFolders,
  createTopic,
  toggleTopicActive,
  linkTopicFolder,
  unlinkTopicFolder,
  deleteTopic,
} from '../db/d1/topics.js';
import { recordNotification, getNotifications } from '../db/d1/notifications.js';
import { aiUsageStats, aiRegistryGetAll } from '../db/d1/aiRegistry.js';
import { adminHasScopes, folderInAdminScope } from '../db/d1/scopes.js';
import {
  FEATURES,
  FEATURE_LABELS,
  FOLDER_NODE_TYPES,
  NODE_TYPE_LABELS,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  PLATFORM_SETTING_DEFAULTS,
  ROLE_PERMISSION_PRESETS,
  permissionsToString,
} from '../constants.js';

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, callback_data) => ({ text, callback_data });
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const home = [[btn('🏠 الرئيسية', 'home')]];

function packButtons(buttons, cols = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += cols) {
    rows.push(buttons.slice(i, i + cols));
  }
  return rows;
}

function nodeIcon(type) {
  return ({
    books: '📚', book: '📚', video: '🎥', audio: '🎧',
    mcq: '📝', summary: '📑', summaries: '📑', photo: '🖼',
    document: '📄', doc: '📄',
  }[String(type ?? '').toLowerCase()] ?? '📁');
}

export async function buildWorkerAdmin(db, user) {
  const id = Number(user.id);
  if (!(await isAdmin(db, id))) {
    return { text: '🔒 هذه المنطقة مخصصة للمشرفين المعتمدين فقط.', reply_markup: kb(home) };
  }
  const pending = await getPendingContributionsCount(db);
  const openMsgsRow = await get(db, "SELECT COUNT(*) FROM messages WHERE status='NEW'").catch(() => [0]);
  const openMsgs = Number(openMsgsRow?.[0] ?? 0);

  const items = [];
  if ((await hasPermission(db, id, 'can_folders')) || (await hasPermission(db, id, 'can_content'))) {
    items.push(btn('🗂 الأقسام والمحتوى', 'admin_folders'));
  }
  if (await hasPermission(db, id, 'can_contributions')) {
    items.push(btn('📥 المساهمات' + (pending ? ` (${pending})` : ''), 'admin_pending'));
  }
  if (await hasPermission(db, id, 'can_messages')) {
    items.push(btn('📬 رسائل الطلاب' + (openMsgs ? ` (${openMsgs})` : ''), 'admin_messages'));
  }
  if (await hasPermission(db, id, 'can_news')) {
    items.push(btn('📰 الأخبار', 'admin_news'));
  }
  if (await hasPermission(db, id, 'can_topics')) {
    items.push(btn('🧭 المواضيع', 'admin_topics'));
  }
  if (await hasPermission(db, id, 'can_notifications')) {
    items.push(btn('🔔 الإشعارات', 'admin_notifications'));
  }
  if (await hasPermission(db, id, 'can_archive')) {
    items.push(btn('🗄 أرشيف القناة', 'admin_archive'));
  }
  if (await hasPermission(db, id, 'can_settings')) {
    items.push(btn('⚙️ إعدادات المنصة', 'admin_settings'));
  }
  if (await hasPermission(db, id, 'can_visibility')) {
    items.push(btn('🙈 إظهار/إخفاء الأقسام', 'admin_vis'));
  }
  if (await hasPermission(db, id, 'can_ai')) {
    items.push(btn('🤖 سجل الذكاء الاصطناعي', 'admin_ai'));
  }
  if (await hasPermission(db, id, 'can_admins')) {
    items.push(btn('👥 إدارة المشرفين', 'admin_admins'));
  }

  const rows = packButtons(items, 2);
  rows.push([btn('📊 حالة التشغيل', 'admin_runtime'), btn('🏠 الرئيسية', 'home')]);
  return {
    text: '🛠 <b>إدارة المنصة</b>\n\nاختر القسم أو الأداة التي تريد إدارتها:',
    reply_markup: kb(rows),
  };
}

// ---------------------------------------------------------------------------
// 1. Folders & Content Management (إنشاء مواد وأقسام ورفع داتا)
// ---------------------------------------------------------------------------

export async function buildWorkerAdminFolders(db, user, folderId = 0) {
  const uid = Number(user.id);
  if (!(await hasPermission(db, uid, 'can_folders')) && !(await hasPermission(db, uid, 'can_content'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const fid = Number(folderId) || 0;
  if (!fid) {
    const roots = await getFolders(db, 0);
    const rows = roots.map(([id, name, type, contrib]) => [
      btn(`${nodeIcon(type)} ${String(name).slice(0, 32)}${contrib ? ' 📤' : ''}`, `admin_folder:${id}`),
    ]);
    rows.push([btn('➕ إنشاء مادة / قسم رئيسي', 'admin_fnew:0')]);
    rows.push([btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')]);
    return {
      text: `🗂 <b>إدارة المواد والأقسام الرئيسية</b>\n\nعدد المواد الحالية: ${roots.length}\nاختر مادة لإدارة فروعها وملفاتها أو أنشئ مادة جديدة:`,
      reply_markup: kb(rows),
    };
  }

  const view = await getFolderView(db, fid);
  if (!view?.folder) {
    return { text: '⚠️ القسم غير موجود.', reply_markup: kb([[btn('⬅️ الأقسام', 'admin_folders')]]) };
  }
  const [, parentId, name, nodeType, acceptsContrib] = view.folder;
  const lines = [
    `${nodeIcon(nodeType)} <b>${esc(name)}</b>`,
    `📍 المسار: ${esc(view.breadcrumb)}`,
    `🏷 النوع: ${esc(NODE_TYPE_LABELS[nodeType] ?? nodeType)}`,
    `📤 استقبال مساهمات الطلاب: ${acceptsContrib ? '✅ مفعل' : '❌ متوقف'}`,
    `📁 الأقسام الفرعية: ${view.children.length} · 📄 الملفات: ${view.files.length}`,
  ];

  const rows = [];
  for (const [cid, cname, ctype, ccontrib] of view.children) {
    rows.push([btn(`${nodeIcon(ctype)} ${String(cname).slice(0, 32)}${ccontrib ? ' 📤' : ''}`, `admin_folder:${cid}`)]);
  }
  for (const [fileId, title, , ftype] of view.files.slice(0, 25)) {
    rows.push([btn(`${nodeIcon(ftype)} ${String(title).slice(0, 30)}`, `admin_ffile:${fileId}`)]);
  }

  rows.push([
    btn('➕ قسم فرعي', `admin_fnew:${fid}`),
    btn('📤 رفع ملف هنا', `admin_fupload:${fid}`),
  ]);
  rows.push([
    btn('✏️ إعادة تسمية', `admin_frename:${fid}`),
    btn(acceptsContrib ? '🔕 إيقاف المساهمات' : '🔔 تفعيل المساهمات', `admin_fcontrib:${fid}`),
  ]);
  rows.push([btn('🗑 حذف هذا القسم', `admin_fdel:${fid}`)]);
  rows.push([
    btn('⬅️ رجوع', parentId ? `admin_folder:${parentId}` : 'admin_folders'),
    btn('🛠 الإدارة', 'admin'),
  ]);
  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

export function buildWorkerFolderTypePicker(parentId = 0, folderName = '') {
  const rows = FOLDER_NODE_TYPES.map((type) => [
    btn(NODE_TYPE_LABELS[type] ?? type, `admin_ftype:${Number(parentId) || 0}:${type}`),
  ]);
  rows.push([btn('❌ إلغاء', parentId ? `admin_folder:${parentId}` : 'admin_folders')]);
  return {
    text: `🏷 <b>اختر نوع القسم الجديد:</b>\n\nالاسم: <b>${esc(folderName)}</b>`,
    reply_markup: kb(rows),
  };
}

export async function createWorkerFolder(db, user, parentId, name, nodeType = 'general') {
  if (!(await hasPermission(db, Number(user.id), 'can_folders'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }
  const cleanName = String(name ?? '').trim();
  if (!cleanName) return { ok: false, text: '⚠️ اسم القسم لا يمكن أن يكون فارغاً.' };
  const pid = Number(parentId) || 0;
  const accepts = nodeType !== 'general' ? 1 : 0;
  const newId = await addFolder(db, pid, cleanName, nodeType, accepts);
  return { ok: true, folderId: newId, parentId: pid };
}

export async function renameWorkerFolder(db, user, folderId, newName) {
  if (!(await hasPermission(db, Number(user.id), 'can_folders'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }
  const clean = String(newName ?? '').trim();
  if (!clean) return { ok: false, text: '⚠️ الاسم الجديد فارغ.' };
  await updateFolderName(db, Number(folderId), clean);
  return { ok: true };
}

export async function toggleWorkerFolderContributions(db, user, folderId) {
  if (!(await hasPermission(db, Number(user.id), 'can_folders'))) return false;
  const row = await get(db, 'SELECT accepts_contributions FROM folders WHERE id=?', [Number(folderId)]);
  if (!row) return false;
  const next = Number(row[0]) ? 0 : 1;
  await updateFolderAcceptsContributions(db, Number(folderId), next);
  return true;
}

export async function deleteWorkerFolder(db, user, folderId) {
  if (!(await hasPermission(db, Number(user.id), 'can_folders'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }
  const fid = Number(folderId);
  const view = await getFolderView(db, fid);
  if (!view?.folder) return { ok: false, text: '⚠️ القسم غير موجود.', parentId: 0 };
  if (view.children.length > 0 || view.files.length > 0) {
    return {
      ok: false,
      text: '⚠️ لا يمكن حذف قسم يحتوي على أقسام فرعية أو ملفات. احذف محتوياته أولاً.',
      parentId: fid,
    };
  }
  await run(db, 'DELETE FROM folders WHERE id=?', [fid]);
  return { ok: true, text: '✅ تم حذف القسم بنجاح.', parentId: view.parentId || 0 };
}

export async function buildWorkerAdminFile(db, user, contentId) {
  if (!(await hasPermission(db, Number(user.id), 'can_content')) && !(await hasPermission(db, Number(user.id), 'can_folders'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const snap = await getResourceSnapshot(db, Number(contentId));
  if (!snap) return { text: '⚠️ الملف غير موجود.', reply_markup: kb([[btn('⬅️ الأقسام', 'admin_folders')]]) };
  const [id, folderId, title, , fileType, path] = snap;
  return {
    text: `📄 <b>${esc(title)}</b>\n\n📍 المسار: ${esc(path)}\n🎞 النوع: ${esc(fileType)}\n🆔 #${id}`,
    reply_markup: kb([
      [btn('📥 إرسال نسخة لي للمعاينة', `file:${id}`)],
      [btn('🗑 حذف هذا الملف', `admin_fdel_file:${id}:${folderId}`)],
      [btn('⬅️ رجوع للقسم', `admin_folder:${folderId}`)],
    ]),
  };
}

export async function deleteWorkerAdminFile(db, user, contentId) {
  if (!(await hasPermission(db, Number(user.id), 'can_content')) && !(await hasPermission(db, Number(user.id), 'can_folders'))) {
    return false;
  }
  return deleteFile(db, Number(contentId));
}

export async function uploadWorkerAdminMedia(db, user, message, folderId, bot = null, env = {}) {
  const uid = Number(user.id);
  if (!(await hasPermission(db, uid, 'can_content')) && !(await hasPermission(db, uid, 'can_folders'))) {
    return { ok: false, text: '🔒 غير مصرح برفع المحتوى.' };
  }
  const fid = Number(folderId);
  let fileId = null;
  let fileType = 'doc';
  let defaultTitle = 'مورد تعليمي';
  if (message?.document) {
    fileId = message.document.file_id;
    fileType = 'doc';
    defaultTitle = message.document.file_name || defaultTitle;
  } else if (Array.isArray(message?.photo) && message.photo.length) {
    fileId = message.photo[message.photo.length - 1].file_id;
    fileType = 'photo';
    defaultTitle = 'صورة تعليمية';
  } else if (message?.video) {
    fileId = message.video.file_id;
    fileType = 'video';
    defaultTitle = message.video.file_name || 'فيديو تعليمي';
  } else if (message?.audio) {
    fileId = message.audio.file_id;
    fileType = 'audio';
    defaultTitle = message.audio.file_name || 'ملف صوتي';
  }
  if (!fileId) return { ok: false, text: '⚠️ يرجى إرسال ملف أو صورة أو فيديو أو مقطع صوتي صالح.' };
  const title = String(message?.caption || defaultTitle).trim().slice(0, 160);
  const contentId = await addContent(db, fid, title, fileId, fileType, 'direct', null, uid);

  try {
    const newsId = await createResourceNewsForContent(db, contentId, uid, 'published');
    if (newsId) await publishNews(db, newsId);
  } catch {
    // Non-fatal
  }

  let archived = false;
  try {
    const arc = await publishResourceToWorkerArchive(db, bot, env, contentId);
    archived = Boolean(arc?.ok);
  } catch {
    archived = false;
  }

  return {
    ok: true,
    contentId,
    folderId: fid,
    text: `✅ <b>تم رفع ونشر المورد للطلاب بنجاح!</b>\n\n📄 <b>${esc(title)}</b>${archived ? '\n🗄 تم أرشفته تلقائياً في قناة الأرشيف.' : ''}\n\nيمكنك إرسال ملف آخر لنفس القسم الآن، أو العودة للقسم:`,
    reply_markup: kb([
      [btn('⬅️ عرض القسم', `admin_folder:${fid}`), btn('🏠 الرئيسية', 'home')],
    ]),
  };
}

// ---------------------------------------------------------------------------
// 2. Archive Channel Sync (نجاح عمل القناة والأرشفة)
// ---------------------------------------------------------------------------

export function resolveWorkerArchiveChannel(env = {}) {
  const raw = String(env?.MEDBOT_ARCHIVE_CHANNEL || env?.ARCHIVE_CHANNEL_ID || '').trim();
  if (!raw) return '';
  let val = raw.replace(/^["']|["']$/g, '').trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i.exec(val);
  if (link) val = link[1].split(/[/?#]/)[0].trim();
  if (/^[-+]?[\d\s]+$/.test(val)) val = val.replace(/\s+/g, '');
  if (val && !val.startsWith('@') && !/^[-+]?\d+$/.test(val) && /^[A-Za-z0-9_]{4,}$/.test(val)) {
    val = `@${val}`;
  }
  return val;
}

export async function publishResourceToWorkerArchive(db, bot, env, contentId) {
  const channel = resolveWorkerArchiveChannel(env);
  if (!channel || !bot) return { ok: false, reason: 'not_configured' };
  const snap = await getResourceSnapshot(db, Number(contentId));
  if (!snap) return { ok: false, reason: 'not_found' };
  const [id, folderId, title, fileId, fileType, path] = snap;
  const fingerprint = `${fileType}:${fileId}:${title}`.slice(0, 240);

  const existing = await get(db, "SELECT status FROM archive_sync WHERE content_fingerprint=? AND status='published'", [fingerprint]).catch(() => null);
  if (existing) return { ok: true, skipped: true };

  const caption = `🗄 <b>MEDBOT Emergency Resource Archive</b>\n\n📄 <b>${esc(title)}</b>\n📍 ${esc(path)}\n🆔 #${id}`;
  const target = /^-\d+$/.test(channel) ? Number(channel) : channel;
  try {
    let sent = null;
    if (fileType === 'photo') sent = await bot.sendPhoto(target, fileId, { caption, parse_mode: 'HTML' });
    else if (fileType === 'video') sent = await bot.sendVideo(target, fileId, { caption, parse_mode: 'HTML' });
    else if (fileType === 'audio') sent = await bot.sendAudio(target, fileId, { caption, parse_mode: 'HTML' });
    else sent = await bot.sendDocument(target, fileId, { caption, parse_mode: 'HTML' });

    await run(
      db,
      `INSERT INTO archive_sync (object_type, content_fingerprint, folder_id, content_ids, channel_id, channel_message_id, status, attempts, published_at)
       VALUES ('content', ?, ?, ?, ?, ?, 'published', 1, CURRENT_TIMESTAMP)
       ON CONFLICT(content_fingerprint) DO UPDATE SET status='published', channel_id=excluded.channel_id, channel_message_id=excluded.channel_message_id, error=NULL, updated_at=CURRENT_TIMESTAMP, published_at=CURRENT_TIMESTAMP`,
      [fingerprint, folderId, String(id), String(channel), sent?.message_id ?? null],
    );
    return { ok: true };
  } catch (err) {
    await run(
      db,
      `INSERT INTO archive_sync (object_type, content_fingerprint, folder_id, content_ids, channel_id, status, attempts, error)
       VALUES ('content', ?, ?, ?, ?, 'failed', 1, ?)
       ON CONFLICT(content_fingerprint) DO UPDATE SET status='failed', attempts=archive_sync.attempts+1, error=excluded.error, updated_at=CURRENT_TIMESTAMP`,
      [fingerprint, folderId, String(id), String(channel), String(err?.message ?? err).slice(0, 300)],
    ).catch(() => {});
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function buildWorkerArchiveAdmin(db, user, env = {}) {
  if (!(await hasPermission(db, Number(user.id), 'can_archive'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const channel = resolveWorkerArchiveChannel(env);
  const totalRes = Number((await get(db, 'SELECT COUNT(*) FROM content'))?.[0] ?? 0);
  const pubRes = Number((await get(db, "SELECT COUNT(*) FROM archive_sync WHERE status='published'"))?.[0] ?? 0);
  const failRes = Number((await get(db, "SELECT COUNT(*) FROM archive_sync WHERE status='failed'"))?.[0] ?? 0);

  const lines = [
    '🗄 <b>أرشيف الطوارئ وقناة التلجرام</b>',
    '',
    `📡 حالة القناة: ${channel ? `✅ متصلة (<code>${esc(channel)}</code>)` : '⚠️ غير مضبوطة (أضف MEDBOT_ARCHIVE_CHANNEL)'}`,
    `📚 إجمالي الموارد في البوت: ${totalRes}`,
    `✅ المؤرشف في القناة: ${pubRes}`,
    `⚠️ فشل أرشفته: ${failRes}`,
  ];
  const rows = [];
  if (channel) {
    rows.push([btn('🔄 مزامنة ونشر كافة الملفات غير المؤرشفة', 'admin_archive_sync')]);
  }
  rows.push([btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')]);
  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

export async function syncWorkerArchiveAll(db, user, bot, env = {}) {
  if (!(await hasPermission(db, Number(user.id), 'can_archive'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const channel = resolveWorkerArchiveChannel(env);
  if (!channel) {
    return {
      text: '⚠️ لم يتم ضبط متغير <code>MEDBOT_ARCHIVE_CHANNEL</code> بعد.',
      reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive')]]),
    };
  }
  const snapshots = await getAllResourceSnapshots(db);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const snap of snapshots.slice(0, 50)) {
    const res = await publishResourceToWorkerArchive(db, bot, env, snap[0]);
    if (res.skipped) skipped++;
    else if (res.ok) sent++;
    else failed++;
  }
  return {
    text: `✅ <b>اكتملت مزامنة الأرشيف</b>\n\n📤 تم نشر جديد: ${sent}\n⏭ مؤرشف مسبقاً: ${skipped}\n⚠️ فشل: ${failed}`,
    reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive'), btn('🏠 الرئيسية', 'home')]]),
  };
}

// ---------------------------------------------------------------------------
// 3. Student Contributions Review (مراجعة مساهمات الطلاب)
// ---------------------------------------------------------------------------

async function canReviewFolder(db, userId, folderId) {
  if (!(await hasPermission(db, userId, 'can_contributions'))) return false;
  return !(await adminHasScopes(db, userId)) || (await folderInAdminScope(db, userId, folderId));
}

export async function buildWorkerPending(db, user) {
  if (!(await hasPermission(db, user.id, 'can_contributions'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const rows = await getReviewableContributionsList(db);
  const visible = [];
  for (const r of rows) {
    if (await canReviewFolder(db, user.id, r[6])) visible.push(r);
  }
  const buttons = visible.slice(0, 30).map((r) => [
    btn('📥 #' + r[0] + ' ' + String(r[3]).slice(0, 32), 'admin_contrib:' + r[0]),
  ]);
  buttons.push([btn('⬅️ إدارة المنصة', 'admin'), btn('🏠 الرئيسية', 'home')]);
  return {
    text: '📥 <b>مراجعة المساهمات</b>\n\nالعناصر القابلة للمراجعة: ' + visible.length,
    reply_markup: kb(buttons),
  };
}

export async function buildWorkerContributionReview(db, user, id) {
  if (!(await hasPermission(db, user.id, 'can_contributions'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const r = await get(
    db,
    'SELECT id,user_id,user_name,folder_id,title,file_id,file_type,status,created_at,review_note,rejection_reason FROM contributions WHERE id=?',
    [Number(id)],
  );
  if (!r) {
    return { text: '⚠️ المساهمة غير موجودة.', reply_markup: kb([[btn('⬅️ المساهمات', 'admin_pending')]]) };
  }
  if (!(await canReviewFolder(db, user.id, r[3]))) {
    return { text: '🚫 هذه المساهمة خارج نطاق مسؤوليتك.', reply_markup: kb([[btn('⬅️ المساهمات', 'admin_pending')]]) };
  }
  return {
    text:
      '📥 <b>مساهمة #' + r[0] + '</b>\n\n👤 ' + esc(r[2] || r[1]) +
      '\n📄 ' + esc(r[4]) + '\n🗂 Folder #' + r[3] +
      '\n🎞 ' + esc(r[6]) + '\n📌 الحالة: ' + esc(r[7]) + '\n🕒 ' + esc(r[8]),
    reply_markup: kb([
      [btn('👁 معاينة المرفق', 'admin_preview_contrib:' + r[0])],
      [btn('✅ قبول ونشر', 'admin_approve:' + r[0]), btn('❌ رفض', 'admin_reject:' + r[0])],
      [btn('⬅️ المساهمات', 'admin_pending'), btn('🏠 الرئيسية', 'home')],
    ]),
  };
}

export async function reviewWorkerContribution(db, user, id, action, bot = null, env = {}) {
  if (!(await hasPermission(db, user.id, 'can_contributions'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }
  const row = await get(db, 'SELECT folder_id, user_id, title FROM contributions WHERE id=?', [Number(id)]);
  if (!row || !(await canReviewFolder(db, user.id, row[0]))) {
    return { ok: false, text: '🚫 هذه المساهمة خارج نطاق مسؤوليتك.' };
  }
  const result = action === 'approve'
    ? await approveContribution(db, Number(id), Number(user.id))
    : await rejectContribution(db, Number(id), Number(user.id), 'رفض من لوحة الإدارة');

  if (result && bot) {
    const studentId = Number(row[1]);
    const title = String(row[2] || '');
    if (action === 'approve') {
      if (result.contentId) {
        await publishResourceToWorkerArchive(db, bot, env, result.contentId).catch(() => {});
      }
      await bot.sendMessage(
        studentId,
        `🎉 <b>تم قبول مساهمتك ونشرها في المنصة!</b>\n\n📄 <b>${esc(title)}</b>\nشكراً لمساهمتك العلمية.`,
      ).catch(() => {});
    } else {
      await bot.sendMessage(
        studentId,
        `ℹ️ <b>تحديث بخصوص مساهمتك:</b>\n\n📄 <b>${esc(title)}</b>\nتعذر قبول المساهمة حالياً.`,
      ).catch(() => {});
    }
  }

  return {
    ok: Boolean(result),
    text: result
      ? (action === 'approve' ? '✅ تم قبول المساهمة ونشر المورد للطلاب.' : '✅ تم رفض المساهمة.')
      : '⚠️ تعذر تغيير حالة المساهمة.',
  };
}

// ---------------------------------------------------------------------------
// 4. Student Messages (رسائل الطلاب والرد عليها)
// ---------------------------------------------------------------------------

export async function buildWorkerMessages(db, user) {
  if (!(await hasPermission(db, Number(user.id), 'can_messages'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const rows = await all(
    db,
    "SELECT id, user_id, user_name, body, status, created_at FROM messages WHERE status='NEW' ORDER BY id DESC LIMIT 25",
  );
  const buttons = rows.map((r) => [
    btn(`📩 #${r[0]} ${String(r[2] || r[1]).slice(0, 14)}: ${String(r[3]).slice(0, 20)}`, `admin_msg:${r[0]}`),
  ]);
  buttons.push([btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')]);
  return {
    text: `📬 <b>رسائل واستفسارات الطلاب</b>\n\nالرسائل الجديدة المفتوحة: ${rows.length}`,
    reply_markup: kb(buttons),
  };
}

export async function buildWorkerMessageDetail(db, user, msgId) {
  if (!(await hasPermission(db, Number(user.id), 'can_messages'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const r = await get(
    db,
    'SELECT id, user_id, user_name, body, status, admin_reply, created_at FROM messages WHERE id=?',
    [Number(msgId)],
  );
  if (!r) return { text: '⚠️ الرسالة غير موجودة.', reply_markup: kb([[btn('⬅️ الرسائل', 'admin_messages')]]) };
  const lines = [
    `📩 <b>رسالة طالب #${r[0]}</b>`,
    `👤 المرسل: ${esc(r[2] || r[1])} (<code>${r[1]}</code>)`,
    `🕒 التاريخ: ${esc(r[6])}`,
    `📌 الحالة: ${esc(r[4])}`,
    '',
    `💬 <b>النص:</b>\n${esc(r[3])}`,
  ];
  if (r[5]) lines.push('', `✅ <b>الرد السابق:</b>\n${esc(r[5])}`);
  return {
    text: lines.join('\n'),
    reply_markup: kb([
      [btn('✍️ الرد على الطالب', `admin_msg_reply:${r[0]}`), btn('✅ إغلاق الرسالة', `admin_msg_close:${r[0]}`)],
      [btn('⬅️ الرسائل', 'admin_messages'), btn('🏠 الرئيسية', 'home')],
    ]),
  };
}

export async function replyWorkerMessage(db, user, msgId, replyText, bot = null) {
  if (!(await hasPermission(db, Number(user.id), 'can_messages'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }
  const r = await get(db, 'SELECT id, user_id, body FROM messages WHERE id=?', [Number(msgId)]);
  if (!r) return { ok: false, text: '⚠️ الرسالة غير موجودة.' };
  const cleanReply = String(replyText ?? '').trim();
  if (!cleanReply) return { ok: false, text: '⚠️ يرجى كتابة نص الرد.' };
  await run(
    db,
    "UPDATE messages SET status='ANSWERED', admin_reply=?, reviewed_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [cleanReply, Number(user.id), Number(msgId)],
  );
  if (bot) {
    await bot.sendMessage(
      Number(r[1]),
      `📬 <b>رد إدارة المنصة على رسالتك:</b>\n\n💬 رسالتك: ${esc(String(r[2]).slice(0, 120))}\n\n✅ <b>الرد:</b>\n${esc(cleanReply)}`,
    ).catch(() => {});
  }
  return { ok: true, text: '✅ تم إرسال الرد للطالب وإغلاق الرسالة بنجاح.' };
}

// ---------------------------------------------------------------------------
// 5. News & Broadcasts (إدارة الأخبار والإشعارات)
// ---------------------------------------------------------------------------

export async function buildWorkerNewsAdmin(db, user) {
  if (!(await hasPermission(db, Number(user.id), 'can_news'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const items = await listNews(db, { status: 'all', limit: 15 });
  const rows = [[btn('➕ نشر خبر / إعلان جديد للطلاب', 'admin_news_new')]];
  for (const item of items) {
    rows.push([
      btn(`${item.status === 'published' ? '🟢' : '📝'} ${String(item.title).slice(0, 28)}`, `admin_news_del:${item.id}`),
    ]);
  }
  rows.push([btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')]);
  return {
    text: `📰 <b>إدارة الأخبار والإعلانات</b>\n\nالأخبار المسجلة: ${items.length}\nاضغط على "نشر خبر جديد" لإرسال إعلان للطلاب، أو اضغط على خبر لحذفه:`,
    reply_markup: kb(rows),
  };
}

export async function createWorkerNewsItem(db, user, rawText) {
  if (!(await hasPermission(db, Number(user.id), 'can_news'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }
  const lines = String(rawText ?? '').trim().split('\n');
  const title = String(lines[0] ?? '').trim().slice(0, 140);
  const body = lines.slice(1).join('\n').trim() || title;
  if (!title) return { ok: false, text: '⚠️ يرجى كتابة عنوان الخبر في السطر الأول.' };
  const id = await createNews(db, {
    newsType: 'notify',
    title,
    body,
    senderId: Number(user.id),
    status: 'published',
  });
  return {
    ok: Boolean(id),
    text: id ? `✅ تم نشر الخبر للطلاب بنجاح (#${id}).` : '⚠️ تعذر نشر الخبر.',
  };
}

export async function deleteWorkerNewsItem(db, user, newsId) {
  if (!(await hasPermission(db, Number(user.id), 'can_news'))) return false;
  return deleteNews(db, Number(newsId));
}

export async function buildWorkerNotificationsAdmin(db, user) {
  if (!(await hasPermission(db, Number(user.id), 'can_notifications'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const history = await getNotifications(db, 5);
  const lines = ['🔔 <b>إرسال الإشعارات الجماعية</b>', ''];
  if (history.length) {
    lines.push('آخر الإشعارات المرسلة:');
    for (const h of history) {
      lines.push(`• ${esc(String(h[3]).slice(0, 50))} (وصل لـ ${h[6]}/${h[5]})`);
    }
  } else {
    lines.push('لم يتم إرسال إشعارات جماعية بعد.');
  }
  return {
    text: lines.join('\n'),
    reply_markup: kb([
      [btn('📢 إرسال إشعار لجميع الطلاب', 'admin_notify_all')],
      [btn('🛡 إرسال إشعار للمشرفين فقط', 'admin_notify_admins')],
      [btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')],
    ]),
  };
}

export async function sendWorkerBroadcastNotification(db, user, text, audience = 'all', bot = null) {
  if (!(await hasPermission(db, Number(user.id), 'can_notifications'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }
  const clean = String(text ?? '').trim();
  if (!clean) return { ok: false, text: '⚠️ نص الإشعار فارغ.' };
  const recipients = audience === 'admins'
    ? await all(db, "SELECT telegram_id FROM admins WHERE role IS NULL OR role!='none'")
    : await all(db, 'SELECT user_id FROM users');
  let delivered = 0;
  if (bot) {
    for (const [uid] of recipients) {
      const ok = await bot.sendMessage(Number(uid), `🔔 <b>إشعار من إدارة المنصة</b>\n\n${esc(clean)}`).then(() => true).catch(() => false);
      if (ok) delivered++;
    }
  }
  await recordNotification(db, Number(user.id), 'إشعار إداري', clean, audience, recipients.length, delivered);
  return {
    ok: true,
    text: `✅ تم إرسال الإشعار بنجاح إلى ${delivered} من أصل ${recipients.length} مستخدم.`,
  };
}

// ---------------------------------------------------------------------------
// 6. Search Topics Admin (إدارة مواضيع البحث)
// ---------------------------------------------------------------------------

export async function buildWorkerTopicsAdmin(db, user) {
  if (!(await hasPermission(db, Number(user.id), 'can_topics'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const topics = await getTopics(db, false);
  const rows = [[btn('➕ إنشاء موضوع جديد', 'admin_topic_new')]];
  for (const [id, name, , icon, , active] of topics) {
    rows.push([btn(`${active ? '🟢' : '⚪️'} ${icon || '🧭'} ${String(name).slice(0, 30)}`, `admin_topic_item:${id}`)]);
  }
  rows.push([btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')]);
  return {
    text: `🧭 <b>إدارة مواضيع البحث</b>\n\nالمواضيع المسجلة: ${topics.length}`,
    reply_markup: kb(rows),
  };
}

export async function buildWorkerTopicAdminDetail(db, user, topicId) {
  if (!(await hasPermission(db, Number(user.id), 'can_topics'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const topic = await getTopic(db, Number(topicId));
  if (!topic) return { text: '⚠️ الموضوع غير موجود.', reply_markup: kb([[btn('⬅️ المواضيع', 'admin_topics')]]) };
  const [id, name, desc, icon, , active] = topic;
  const linked = await getTopicFolders(db, id);
  const lines = [
    `${icon || '🧭'} <b>${esc(name)}</b>`,
    desc ? `📝 ${esc(desc)}` : '',
    `📌 الحالة: ${active ? '🟢 مفعل' : '⚪️ مخفي'}`,
    `🗂 الأقسام المرتبطة: ${linked.length}`,
  ].filter(Boolean);

  const rows = linked.map(([fid, fname]) => [btn(`🔗 إلغاء ربط: ${String(fname).slice(0, 26)}`, `admin_topic_unlink:${id}:${fid}`)]);
  rows.push([
    btn('🔗 ربط قسم بالموضوع', `admin_topic_pick:${id}`),
    btn(active ? '🙈 إخفاء' : '👁 تفعيل', `admin_topic_toggle:${id}`),
  ]);
  rows.push([btn('🗑 حذف الموضوع', `admin_topic_del:${id}`)]);
  rows.push([btn('⬅️ المواضيع', 'admin_topics'), btn('🏠 الرئيسية', 'home')]);
  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

export async function buildWorkerTopicLinkPicker(db, user, topicId) {
  const folders = await all(db, 'SELECT id, name FROM folders ORDER BY id ASC LIMIT 30');
  const rows = folders.map(([fid, fname]) => [
    btn(`📁 ${String(fname).slice(0, 32)}`, `admin_topic_link:${Number(topicId)}:${fid}`),
  ]);
  rows.push([btn('⬅️ رجوع للموضوع', `admin_topic_item:${Number(topicId)}`)]);
  return {
    text: '🔗 <b>اختر القسم الذي تريد ربطه بهذا الموضوع:</b>',
    reply_markup: kb(rows),
  };
}

export async function createWorkerTopicItem(db, user, rawText) {
  if (!(await hasPermission(db, Number(user.id), 'can_topics'))) return { ok: false };
  const lines = String(rawText ?? '').trim().split('\n');
  const name = String(lines[0] ?? '').trim();
  const desc = lines.slice(1).join('\n').trim() || null;
  if (!name) return { ok: false, text: '⚠️ يرجى كتابة اسم الموضوع.' };
  const id = await createTopic(db, name, desc);
  return { ok: Boolean(id), topicId: id };
}

export async function toggleWorkerTopicItem(db, user, topicId) {
  if (!(await hasPermission(db, Number(user.id), 'can_topics'))) return false;
  await toggleTopicActive(db, Number(topicId));
  return true;
}

export async function linkWorkerTopicFolderItem(db, user, topicId, folderId, unlink = false) {
  if (!(await hasPermission(db, Number(user.id), 'can_topics'))) return false;
  if (unlink) return unlinkTopicFolder(db, Number(topicId), Number(folderId));
  return linkTopicFolder(db, Number(topicId), Number(folderId));
}

export async function deleteWorkerTopicItem(db, user, topicId) {
  if (!(await hasPermission(db, Number(user.id), 'can_topics'))) return false;
  return deleteTopic(db, Number(topicId));
}

// ---------------------------------------------------------------------------
// 7. Settings & Feature Visibility (إعدادات المنصة وإظهار/إخفاء الأقسام)
// ---------------------------------------------------------------------------

async function getSettingVal(db, key) {
  const r = await get(db, 'SELECT value FROM settings WHERE key=?', [key]);
  return r?.[0] ?? PLATFORM_SETTING_DEFAULTS[key] ?? '';
}

export async function buildWorkerSettingsAdmin(db, user) {
  if (!(await hasPermission(db, Number(user.id), 'can_settings'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const name = await getSettingVal(db, 'platform_name');
  const about = await getSettingVal(db, 'platform_about');
  const contact = await getSettingVal(db, 'contact_text');
  return {
    text:
      `⚙️ <b>إعدادات المنصة</b>\n\n` +
      `🏷 <b>اسم المنصة:</b> ${esc(name)}\n\n` +
      `ℹ️ <b>عن المنصة:</b>\n${esc(String(about).slice(0, 200))}\n\n` +
      `📬 <b>نص التواصل:</b>\n${esc(String(contact).slice(0, 200))}`,
    reply_markup: kb([
      [btn('✏️ تعديل اسم المنصة', 'admin_set_edit:platform_name')],
      [btn('✏️ تعديل نبذة عن المنصة', 'admin_set_edit:platform_about')],
      [btn('✏️ تعديل نص التواصل', 'admin_set_edit:contact_text')],
      [btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')],
    ]),
  };
}

export async function saveWorkerSetting(db, user, key, value) {
  if (!(await hasPermission(db, Number(user.id), 'can_settings'))) return false;
  if (!['platform_name', 'platform_about', 'contact_text'].includes(key)) return false;
  const clean = String(value ?? '').trim();
  if (!clean) return false;
  await run(
    db,
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, clean],
  );
  return true;
}

export async function buildWorkerVisibilityAdmin(db, user) {
  if (!(await hasPermission(db, Number(user.id), 'can_visibility'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const raw = await getSettingVal(db, 'hidden_features');
  const hidden = new Set(String(raw).split(',').map((x) => x.trim()).filter(Boolean));
  const buttons = FEATURES.filter((f) => f !== 'admin_panel').map((f) =>
    btn(`${hidden.has(f) ? '🙈 مخفي:' : '🟢 ظاهر:'} ${FEATURE_LABELS[f] ?? f}`, `admin_vis_toggle:${f}`),
  );
  const rows = packButtons(buttons, 2);
  rows.push([btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')]);
  return {
    text: '🙈 <b>إظهار وإخفاء أقسام القائمة الرئيسية</b>\n\nاضغط على أي قسم لتغيير حالته فوراً للطلاب:',
    reply_markup: kb(rows),
  };
}

export async function toggleWorkerFeatureVisibility(db, user, feature) {
  if (!(await hasPermission(db, Number(user.id), 'can_visibility'))) return false;
  if (!FEATURES.includes(feature) || feature === 'admin_panel') return false;
  const raw = await getSettingVal(db, 'hidden_features');
  const hidden = new Set(String(raw).split(',').map((x) => x.trim()).filter(Boolean));
  if (hidden.has(feature)) hidden.delete(feature);
  else hidden.add(feature);
  await run(
    db,
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ['hidden_features', [...hidden].join(',')],
  );
  return true;
}

// ---------------------------------------------------------------------------
// 8. AI Registry & Admins Management (إدارة الذكاء الاصطناعي والمشرفين)
// ---------------------------------------------------------------------------

export async function buildWorkerAiAdmin(db, user) {
  if (!(await hasPermission(db, user.id, 'can_ai'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const stats = await aiUsageStats(db, 1);
  const reg = await aiRegistryGetAll(db);
  const lines = ['🤖 <b>AI Registry / Runtime</b>', '', 'النماذج المسجلة: ' + reg.length, ''];
  for (const r of stats.slice(0, 10)) {
    lines.push('• ' + r[1] + ' / ' + r[2] + ' — ' + r[4] + ' طلب · ' + r[5] + ' ناجح · avg ' + (r[7] ?? '—') + 'ms');
  }
  return {
    text: lines.join('\n'),
    reply_markup: kb([
      [btn('🔄 تحديث', 'admin_ai')],
      [btn('⬅️ إدارة المنصة', 'admin'), btn('🏠 الرئيسية', 'home')],
    ]),
  };
}

export async function buildWorkerAdmins(db, user) {
  if (!(await hasPermission(db, user.id, 'can_admins'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const rows = await getAdminsFullRecords(db);
  const lines = ['👥 <b>إدارة المشرفين والصلاحيات</b>', ''];
  for (const admin of rows) {
    lines.push('• ' + (admin.username ? '@' + admin.username : admin.telegram_id) + ' — ' + admin.role);
  }
  const buttons = [[btn('➕ إضافة مشرف جديد', 'admin_add_new')]];
  for (const r of rows) {
    buttons.push([
      btn((r.username ? '@' + r.username : r.telegram_id) + ' · ' + r.role, 'admin_user:' + r.telegram_id),
    ]);
  }
  buttons.push([btn('⬅️ إدارة المنصة', 'admin'), btn('🏠 الرئيسية', 'home')]);
  return { text: lines.join('\n'), reply_markup: kb(buttons) };
}

export async function addWorkerNewAdmin(db, user, rawInput) {
  if (!(await isOwner(db, Number(user.id))) && !(await hasPermission(db, Number(user.id), 'can_admins'))) {
    return { ok: false, text: '🔒 غير مصرح بإضافة مشرفين.' };
  }
  const input = String(rawInput ?? '').trim();
  let targetId = null;
  let username = null;
  if (/^\d+$/.test(input)) {
    targetId = Number(input);
    const u = await get(db, 'SELECT username FROM users WHERE user_id=?', [targetId]);
    username = u?.[0] ?? null;
  } else if (input.startsWith('@')) {
    const cleanUser = input.slice(1);
    const u = await get(db, 'SELECT user_id, username FROM users WHERE LOWER(username)=LOWER(?)', [cleanUser]);
    if (u) {
      targetId = Number(u[0]);
      username = u[1];
    }
  }
  if (!targetId) {
    return { ok: false, text: '⚠️ يرجى إرسال الرقم التعريفي (Telegram ID) للمشرف الجديد (مثال: <code>123456789</code>).' };
  }
  const perms = permissionsToString(ROLE_PERMISSION_PRESETS.admin);
  await run(
    db,
    "INSERT INTO admins(telegram_id, username, role, permissions) VALUES(?, ?, 'admin', ?) ON CONFLICT(telegram_id) DO UPDATE SET role='admin', permissions=excluded.permissions",
    [targetId, username, perms],
  );
  return { ok: true, targetId, text: `✅ تمت إضافة المشرف <code>${targetId}</code> بنجاح.` };
}

export async function buildWorkerAdminUser(db, user, id) {
  if (!(await hasPermission(db, user.id, 'can_admins'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const rec = await getAdminRecord(db, Number(id));
  if (!rec) {
    return { text: '⚠️ المشرف غير موجود.', reply_markup: kb([[btn('⬅️ المشرفون', 'admin_admins')]]) };
  }
  const permButtons = PERMISSION_KEYS.map((k) =>
    btn(`${rec.permissions[k] ? '✅' : '⬜️'} ${PERMISSION_LABELS[k] ?? k}`, `admin_perm:${rec.telegram_id}:${k}`),
  );
  const rows = [
    [btn('🛡 مشرف كامل', `admin_role:${rec.telegram_id}:admin`), btn('🔎 مراجع فقط', `admin_role:${rec.telegram_id}:reviewer`)],
    ...packButtons(permButtons, 2),
    [btn('⛔ سحب صلاحيات الإشراف', `admin_role:${rec.telegram_id}:none`)],
    [btn('⬅️ المشرفون', 'admin_admins'), btn('🏠 الرئيسية', 'home')],
  ];
  return {
    text: `👤 <b>إدارة المشرف: ${esc(rec.username ? '@' + rec.username : rec.telegram_id)}</b>\n\n🆔 <code>${rec.telegram_id}</code>\n👑 الدور الحالي: <b>${esc(rec.role)}</b>\n\nيمكنك تغيير الدور أو تخصيص الصلاحيات التفصيلية بالضغط عليها:`,
    reply_markup: kb(rows),
  };
}

export async function applyWorkerAdminRole(db, user, target, role) {
  if (!(await isOwner(db, user.id))) return { text: '🔒 المالك فقط.' };
  const ok = await setAdminRole(db, Number(target), role);
  return { text: ok ? '✅ تم تحديث الدور.' : '⚠️ تعذر تحديث الدور.' };
}

export async function toggleWorkerAdminPermission(db, user, target, permKey) {
  if (!(await isOwner(db, Number(user.id)))) return { ok: false, text: '🔒 المالك فقط.' };
  if (!PERMISSION_KEYS.includes(permKey)) return { ok: false };
  const rec = await getAdminRecord(db, Number(target));
  if (!rec || rec.role === 'owner') return { ok: false };
  rec.permissions[permKey] = !rec.permissions[permKey];
  await run(db, 'UPDATE admins SET permissions=? WHERE telegram_id=?', [
    permissionsToString(rec.permissions),
    Number(target),
  ]);
  return { ok: true };
}
