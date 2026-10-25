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
  const accepts = pid > 0 && nodeType !== 'general' ? 1 : 0;
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
    text: `✅ <b>تم رفع ونشر المورد للطلاب بنجاح!</b>\n\n📄 <b>${esc(title)}</b>${archived ? '\n🗄 تم أرشفته وتحديث نسخة الاسترداد في قناة الأرشيف تلقائياً.' : ''}\n\nيمكنك إرسال ملف آخر لنفس القسم الآن، أو العودة للقسم:`,
    reply_markup: kb([
      [btn('⬅️ عرض القسم', `admin_folder:${fid}`), btn('🏠 الرئيسية', 'home')],
    ]),
  };
}

// ---------------------------------------------------------------------------
// 2. Archive Channel Sync & Cloud Disaster Recovery (نجاح عمل القناة والاسترداد الشامل)
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

export async function resolveWorkerArchiveChannelAsync(db, env = {}) {
  if (db) {
    const row = await get(
      db,
      "SELECT value FROM settings WHERE key IN ('archive_channel_id', 'MEDBOT_ARCHIVE_CHANNEL') AND TRIM(value) != '' ORDER BY CASE WHEN key='archive_channel_id' THEN 0 ELSE 1 END LIMIT 1",
    ).catch(() => null);
    if (row?.[0]) {
      const normalized = resolveWorkerArchiveChannel({ MEDBOT_ARCHIVE_CHANNEL: row[0] });
      if (normalized) return normalized;
    }
  }
  return resolveWorkerArchiveChannel(env);
}

export async function saveWorkerArchiveChannel(db, user, inputOrMessage, bot = null) {
  if (!(await hasPermission(db, Number(user.id), 'can_archive'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }
  let candidate = '';
  if (inputOrMessage && typeof inputOrMessage === 'object') {
    const fwdChat = inputOrMessage.forward_from_chat || inputOrMessage.forward_origin?.chat || inputOrMessage.sender_chat;
    if (fwdChat?.id) {
      candidate = String(fwdChat.id);
    } else if (fwdChat?.username) {
      candidate = `@${fwdChat.username}`;
    } else {
      candidate = String(inputOrMessage.text || inputOrMessage.caption || '').trim();
    }
  } else {
    candidate = String(inputOrMessage ?? '').trim();
  }

  const normalized = resolveWorkerArchiveChannel({ MEDBOT_ARCHIVE_CHANNEL: candidate });
  if (!normalized || (/^\d+$/.test(normalized) && !normalized.startsWith('-'))) {
    return {
      ok: false,
      text: '⚠️ معرّف القناة غير صالح.\nأرسل معرّف القناة بصيغة <code>@channel_username</code> أو معرّف رقمي سالب مثل <code>-1001234567890</code>، أو قم بتوجيه (Forward) أي رسالة من القناة إلى هنا مباشرةً.',
    };
  }

  await run(
    db,
    "INSERT INTO settings(key,value) VALUES('archive_channel_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [normalized],
  );

  let verifyNote = '';
  if (bot?.getChat) {
    try {
      const target = /^-\d+$/.test(normalized) ? Number(normalized) : normalized;
      const chat = await bot.getChat(target);
      verifyNote = `\n✅ تم التحقق من الوصول للقناة: <b>${esc(chat?.title || normalized)}</b>`;
    } catch {
      verifyNote = '\n⚠️ تم حفظ القناة، لكن تأكد من إضافة البوت كمشرف (Admin) داخل القناة مع صلاحية النشر وتثبيت الرسائل.';
    }
  }

  return {
    ok: true,
    channel: normalized,
    text: `✅ <b>تم ربط قناة الأرشيف بنجاح!</b>\n\n📡 القناة: <code>${esc(normalized)}</code>${verifyNote}`,
  };
}

async function getFolderHierarchyChain(db, folderId) {
  const allFolders = await all(db, 'SELECT id, parent_id, name, node_type FROM folders');
  const byId = new Map(allFolders.map((r) => [Number(r[0]), {
    id: Number(r[0]),
    parent_id: r[1] === null || r[1] === undefined ? 0 : Number(r[1]),
    name: String(r[2] || '').trim(),
    node_type: String(r[3] || 'general').trim(),
  }]));
  const chain = [];
  const visited = new Set();
  let cur = byId.get(Number(folderId));
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
  }
  return chain;
}

export function analyzeAcademicHierarchy(chain = []) {
  let level = '';
  let term = '';
  let block = '';
  let subject = '';
  let section = '';
  const used = new Set();

  for (let i = 0; i < chain.length; i++) {
    const f = chain[i];
    const t = String(f.node_type || '').toLowerCase();
    const n = String(f.name || '').trim();
    if (!level && (t === 'year' || /سنة|السنة|مستوى|المستوى|اولى|أولى|ثانية|ثالثة|رابعة|خامسة|سادسة|سابع|امتياز|level|year/i.test(n))) {
      level = n;
      used.add(i);
    } else if (!term && (t === 'term' || /ترم|الترم|فصل|الفصل|سيميستر|semester|term/i.test(n))) {
      term = n;
      used.add(i);
    } else if (!block && (t === 'block' || /بلوك|البلوك|موديول|الموديول|وحدة|جهاز|block|module|system/i.test(n))) {
      block = n;
      used.add(i);
    } else if (!subject && (t === 'subject' || /مادة|المادة|تشريح|فسيولوجي|باثولوجي|فارما|ميكرو|بارا|باطنة|جراحة|أطفال|نساء|كيمياء|هستولوجي|أجنة|مناعة|طب|عظام|عيون|أنف|جلدية|نفسية|طوارئ|أشعة|تخدير|سموم|شرعي|مجتمع|إحصاء|anatomy|physiology|pathology|pharmacology|microbiology|biochemistry|histology|surgery|medicine|pediatrics/i.test(n))) {
      subject = n;
      used.add(i);
    } else if (!section && (t === 'section' || /قسم|محاضرات|عملي|سيميوليشن|ملخصات|اختبارات|امتحانات|تجميعات|بنوك|أسئلة|مراجع|كتب|تسجيلات|فيديوهات|صور|شيتات|تحديدات|مناقشات|ندوات|سلايدات|دفاتر/i.test(n))) {
      section = n;
      used.add(i);
    }
  }

  const remaining = chain.filter((_, idx) => !used.has(idx));
  if (chain.length === 1 && !level && !subject && !section) {
    subject = chain[0].name;
    section = chain[0].name;
  } else {
    if (!level && remaining.length > 0 && !used.has(0)) {
      level = chain[0].name;
      used.add(0);
    }
    if (!section && chain.length > 0 && !used.has(chain.length - 1)) {
      section = chain[chain.length - 1].name;
      used.add(chain.length - 1);
    }
    if (!subject && chain.length >= 2) {
      const idx = chain.length - 2;
      if (!used.has(idx)) {
        subject = chain[idx].name;
        used.add(idx);
      }
    }
    for (let i = 0; i < chain.length; i++) {
      if (used.has(i)) continue;
      if (!term) {
        term = chain[i].name;
        used.add(i);
      } else if (!block) {
        block = chain[i].name;
        used.add(i);
      } else if (!subject) {
        subject = chain[i].name;
        used.add(i);
      } else if (!section) {
        section = chain[i].name;
        used.add(i);
      }
    }
  }

  const fullPath = chain.map((c) => c.name).join(' / ');
  return {
    level: level || 'غير محدد',
    term: term || 'عام',
    block: block || 'عام',
    subject: subject || (chain[chain.length - 1]?.name || 'عام'),
    section: section || (chain[chain.length - 1]?.name || 'عام'),
    fullPath: fullPath || 'موارد عامة',
  };
}

function toHashtag(text) {
  const clean = String(text || '')
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return clean && clean !== 'غير_محدد' && clean !== 'عام' ? `#${clean.slice(0, 28)}` : '';
}

function encodeArchiveMeta(obj) {
  try {
    const jsonStr = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(jsonStr);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return '';
  }
}

export function decodeArchiveMeta(text) {
  const match = String(text || '').match(/MEDBOT_META:([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = globalThis.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function fileTypeLabel(fileType) {
  const kind = String(fileType || 'doc').toLowerCase();
  if (kind === 'photo' || kind === 'image') return '🖼 صورة توضيحية (Photo)';
  if (kind === 'video') return '🎬 مقطع فيديو (Video)';
  if (kind === 'audio') return '🎧 ملف صوتي (Audio)';
  return '📕 مستند / ملف (Document)';
}

export function buildStructuredArchiveCaption({
  id,
  folderId,
  title,
  fileType,
  chain,
  sourceType,
  contributorName,
  contributorId,
  createdAt,
}) {
  const h = analyzeAcademicHierarchy(chain);
  const sourceLabel = sourceType === 'contribution'
    ? `🌟 مساهمة طالب: ${contributorName || 'طالب'}${contributorId ? ` (#${contributorId})` : ''}`
    : `🛡 رفع إداري: ${contributorName || 'إدارة المنصة'}${contributorId ? ` (#${contributorId})` : ''}`;
  const dateLabel = String(createdAt || new Date().toISOString()).slice(0, 16).replace('T', ' ');
  const tags = Array.from(new Set([
    toHashtag(h.level),
    toHashtag(h.term),
    toHashtag(h.block),
    toHashtag(h.subject),
    toHashtag(h.section),
  ].filter(Boolean))).join(' ');

  const metaToken = encodeArchiveMeta({
    c: chain.map((f) => [f.name, f.node_type || 'general']),
    t: String(title || '').slice(0, 120),
    y: String(fileType || 'doc'),
    s: String(sourceType || 'direct'),
    u: contributorId || null,
    n: contributorName ? String(contributorName).slice(0, 40) : null,
  });

  const lines = [
    '🗄 <b>أرشيف موارد منصة MEDBOT</b>',
    '━━━━━━━━━━━━━━━━━━',
    `📄 <b>اسم المورد:</b> ${esc(String(title || '').slice(0, 140))}`,
    `🗂 <b>نوع الداتا:</b> ${esc(fileTypeLabel(fileType))}`,
    '',
    `🎓 <b>المستوى الدراسي:</b> ${esc(h.level)}`,
    `📅 <b>الفصل الدراسي (الترم):</b> ${esc(h.term)}`,
    `🧩 <b>البلوك / الموديول:</b> ${esc(h.block)}`,
    `📚 <b>المادة الدراسية:</b> ${esc(h.subject)}`,
    `📂 <b>القسم:</b> ${esc(h.section)}`,
    `🧭 <b>المسار الكامل:</b> ${esc(h.fullPath)}`,
    '',
    `👤 <b>المشارك / المصدر:</b> ${esc(sourceLabel)}`,
    `🕒 <b>تاريخ الحفظ:</b> <code>${esc(dateLabel)}</code> | 🆔 <code>#${id || 0}</code> (قسم <code>#${folderId || 0}</code>)`,
  ];
  if (tags) lines.push(`🏷 ${esc(tags)}`);
  if (metaToken && lines.join('\n').length + metaToken.length < 960) {
    lines.push(`🔖 <code>MEDBOT_META:${metaToken}</code>`);
  }
  return lines.join('\n').slice(0, 1000);
}

async function publishSectionHeaderToArchive(db, bot, channel, folderId, chain) {
  if (!folderId || !chain?.length || !bot?.sendMessage) return;
  const fp = `folder:${folderId}`;
  const existing = await get(db, "SELECT status FROM archive_sync WHERE content_fingerprint=? AND status='published'", [fp]).catch(() => null);
  if (existing) return;

  const h = analyzeAcademicHierarchy(chain);
  const tags = Array.from(new Set([
    toHashtag(h.level),
    toHashtag(h.term),
    toHashtag(h.block),
    toHashtag(h.subject),
    toHashtag(h.section),
  ].filter(Boolean))).join(' ');

  const text = [
    '📁 <b>بطاقة فهرسة قسم دراسي — MEDBOT</b>',
    '━━━━━━━━━━━━━━━━━━',
    `🎓 <b>المستوى الدراسي:</b> ${esc(h.level)}`,
    `📅 <b>الفصل الدراسي (الترم):</b> ${esc(h.term)}`,
    `🧩 <b>البلوك / الموديول:</b> ${esc(h.block)}`,
    `📚 <b>المادة الدراسية:</b> ${esc(h.subject)}`,
    `📂 <b>القسم:</b> ${esc(h.section)}`,
    `🧭 <b>المسار:</b> ${esc(h.fullPath)}`,
    tags ? `\n🏷 ${esc(tags)}` : '',
  ].filter(Boolean).join('\n');

  const target = /^-\d+$/.test(channel) ? Number(channel) : channel;
  try {
    const sent = await bot.sendMessage(target, text, { parse_mode: 'HTML' });
    await run(
      db,
      `INSERT INTO archive_sync (object_type, content_fingerprint, folder_id, channel_id, channel_message_id, status, attempts, published_at)
       VALUES ('folder', ?, ?, ?, ?, 'published', 1, CURRENT_TIMESTAMP)
       ON CONFLICT(content_fingerprint) DO UPDATE SET status='published', channel_id=excluded.channel_id, channel_message_id=excluded.channel_message_id, error=NULL, updated_at=CURRENT_TIMESTAMP, published_at=CURRENT_TIMESTAMP`,
      [fp, Number(folderId), String(channel), sent?.message_id ?? null],
    ).catch(() => {});
  } catch {
    // Non-fatal
  }
}

export async function publishResourceToWorkerArchive(db, bot, env, contentId, { skipAutoBackup = false } = {}) {
  const channel = await resolveWorkerArchiveChannelAsync(db, env);
  if (!channel || !bot) return { ok: false, reason: 'not_configured' };
  const snap = await getResourceSnapshot(db, Number(contentId));
  if (!snap) return { ok: false, reason: 'not_found' };
  const [id, folderId, title, fileId, fileType] = snap;
  const fingerprint = `${fileType}:${fileId}:${title}`.slice(0, 240);

  const existing = await get(db, "SELECT status FROM archive_sync WHERE content_fingerprint=? AND status='published'", [fingerprint]).catch(() => null);
  if (existing) return { ok: true, skipped: true };

  const chain = await getFolderHierarchyChain(db, folderId);
  const detailsRow = await get(
    db,
    'SELECT c.source_type, c.source_contribution_id, c.created_by, c.created_at, u.full_name, u.username, ct.user_name, ct.user_id FROM content c LEFT JOIN users u ON u.user_id = c.created_by LEFT JOIN contributions ct ON ct.id = c.source_contribution_id WHERE c.id = ?',
    [Number(id)],
  ).catch(() => null);

  const sourceType = detailsRow?.[0] || 'direct';
  const contributorId = detailsRow?.[7] || detailsRow?.[2] || null;
  const contributorName = detailsRow?.[6] || detailsRow?.[4] || (detailsRow?.[5] ? `@${detailsRow[5]}` : null);
  const createdAt = detailsRow?.[3] || new Date().toISOString();

  await publishSectionHeaderToArchive(db, bot, channel, folderId, chain);

  const caption = buildStructuredArchiveCaption({
    id,
    folderId,
    title,
    fileType,
    chain,
    sourceType,
    contributorName,
    contributorId,
    createdAt,
  });

  const target = /^-\d+$/.test(channel) ? Number(channel) : channel;
  const kind = String(fileType || 'doc').toLowerCase();
  const primary = kind === 'photo' || kind === 'image'
    ? 'sendPhoto'
    : kind === 'video'
      ? 'sendVideo'
      : kind === 'audio'
        ? 'sendAudio'
        : 'sendDocument';
  const order = [primary, 'sendDocument', 'sendPhoto', 'sendVideo', 'sendAudio'].filter(
    (m, idx, arr) => arr.indexOf(m) === idx && typeof bot[m] === 'function',
  );

  try {
    let sent = null;
    let lastErr = null;
    for (const method of order) {
      try {
        sent = await bot[method](target, fileId, { caption, parse_mode: 'HTML' });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!sent && lastErr) throw lastErr;

    await run(
      db,
      `INSERT INTO archive_sync (object_type, content_fingerprint, folder_id, content_ids, channel_id, channel_message_id, status, attempts, published_at)
       VALUES ('content', ?, ?, ?, ?, ?, 'published', 1, CURRENT_TIMESTAMP)
       ON CONFLICT(content_fingerprint) DO UPDATE SET status='published', channel_id=excluded.channel_id, channel_message_id=excluded.channel_message_id, error=NULL, updated_at=CURRENT_TIMESTAMP, published_at=CURRENT_TIMESTAMP`,
      [fingerprint, folderId, String(id), String(channel), sent?.message_id ?? null],
    );

    if (!skipAutoBackup) {
      await publishWorkerCloudBackupToArchive(db, bot, env, { pin: true }).catch(() => {});
    }
    return { ok: true, message_id: sent?.message_id ?? null };
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

export async function exportWorkerCloudSnapshot(db) {
  const folders = await all(db, 'SELECT id, parent_id, name, node_type, accepts_contributions, description, keywords FROM folders ORDER BY COALESCE(parent_id, 0) ASC, id ASC').catch(() => []);
  const content = await all(db, 'SELECT id, folder_id, title, file_id, file_type, created_at, source_type, source_contribution_id, created_by, description, keywords FROM content ORDER BY id ASC').catch(() => []);
  const topics = await all(db, 'SELECT id, name, description, icon, display_order, active, created_at FROM topics ORDER BY id ASC').catch(() => []);
  const topic_folders = await all(db, 'SELECT topic_id, folder_id FROM topic_folders').catch(() => []);
  const admins = await all(db, 'SELECT telegram_id, username, added_at, role, permissions FROM admins').catch(() => []);
  const admin_scopes = await all(db, 'SELECT id, admin_id, scope_type, scope_id, created_at, created_by FROM admin_scopes').catch(() => []);
  const settings = await all(db, "SELECT key, value FROM settings WHERE key NOT LIKE 'worker_state:%'").catch(() => []);
  const about_us = await all(db, 'SELECT id, content, updated_at FROM about_us').catch(() => []);
  const news = await all(db, 'SELECT id, news_type, title, body, sender_id, subject_folder_id, section_folder_id, folder_id, status, created_at, published_at FROM news ORDER BY id ASC').catch(() => []);
  const contributions = await all(db, 'SELECT id, user_id, user_name, folder_id, title, file_id, file_type, status, created_at, reviewed_by, reviewed_at FROM contributions ORDER BY id ASC').catch(() => []);

  return {
    format: 'medbot-cloud-snapshot-v1',
    exported_at: new Date().toISOString(),
    counts: {
      folders: folders.length,
      content: content.length,
      topics: topics.length,
      admins: admins.length,
      news: news.length,
      contributions: contributions.length,
    },
    data: {
      folders,
      content,
      topics,
      topic_folders,
      admins,
      admin_scopes,
      settings,
      about_us,
      news,
      contributions,
    },
  };
}

export async function publishWorkerCloudBackupToArchive(db, bot, env = {}, { targetChatId = null, pin = true } = {}) {
  if (!bot?.sendBufferDocument) return { ok: false, reason: 'bot_missing_buffer_upload' };
  const channel = targetChatId || (await resolveWorkerArchiveChannelAsync(db, env));
  if (!channel) return { ok: false, reason: 'not_configured' };

  const snapshot = await exportWorkerCloudSnapshot(db);
  const jsonText = JSON.stringify(snapshot, null, 2);
  const dateTag = snapshot.exported_at.slice(0, 19).replace('T', ' ');
  const caption = [
    '📦 <b>نسخة الاسترداد السحابي الشاملة — MEDBOT Cloud Backup</b>',
    '━━━━━━━━━━━━━━━━━━',
    `📁 <b>المجلدات والأقسام الدراسية:</b> ${snapshot.counts.folders}`,
    `📄 <b>الموارد والملفات المسجلة:</b> ${snapshot.counts.content}`,
    `🧭 <b>مواضيع البحث:</b> ${snapshot.counts.topics}`,
    `👮 <b>المشرفون والإعدادات:</b> ${snapshot.counts.admins}`,
    `🕒 <b>تاريخ النسخة:</b> <code>${esc(dateTag)} UTC</code>`,
    '',
    '♻️ <i>تُستخدم هذه النسخة المثبتة لاسترداد كافة بيانات البوت وهيكلته وموارده تلقائياً بضغطة زر في حال فقدان البيانات السحابية.</i>',
    '#MEDBOT_BACKUP #نسخة_احتياطية',
  ].join('\n');

  const target = /^-\d+$/.test(String(channel)) ? Number(channel) : channel;
  const sent = await bot.sendBufferDocument(target, 'medbot-cloud-backup.json', jsonText, {
    caption,
    parse_mode: 'HTML',
  });

  if (pin && sent?.message_id && typeof bot.pinChatMessage === 'function') {
    await bot.pinChatMessage(target, sent.message_id, { disable_notification: true }).catch(() => {});
  }
  if (sent?.message_id && !targetChatId) {
    await run(
      db,
      "INSERT INTO settings(key,value) VALUES('last_archive_backup_msg_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [String(sent.message_id)],
    ).catch(() => {});
  }
  return { ok: true, message_id: sent?.message_id ?? null, counts: snapshot.counts };
}

async function ensureFolderChainInD1(db, chainSpecs = []) {
  let parentId = null;
  for (const spec of chainSpecs) {
    const rawName = String(Array.isArray(spec) ? spec[0] : (spec?.name ?? spec ?? '')).trim();
    const nodeType = String(Array.isArray(spec) ? (spec[1] || 'general') : (spec?.node_type || 'general')).trim();
    if (!rawName) continue;
    const existing = parentId === null
      ? await get(db, 'SELECT id FROM folders WHERE (parent_id IS NULL OR parent_id = 0) AND name = ? LIMIT 1', [rawName])
      : await get(db, 'SELECT id FROM folders WHERE parent_id = ? AND name = ? LIMIT 1', [parentId, rawName]);
    if (existing?.[0]) {
      parentId = Number(existing[0]);
    } else {
      const ins = await run(
        db,
        'INSERT INTO folders (parent_id, name, node_type, accepts_contributions) VALUES (?, ?, ?, ?)',
        [parentId, rawName, nodeType, nodeType === 'section' ? 1 : 0],
      );
      parentId = Number(ins.lastInsertRowid);
    }
  }
  return parentId;
}

export async function restoreWorkerBackupPayload(db, payload) {
  let foldersRestored = 0;
  let contentRestored = 0;
  let topicsRestored = 0;
  let settingsRestored = 0;

  const data = payload?.data || payload?.tables || payload;
  if (!data) return { ok: false, foldersRestored: 0, contentRestored: 0 };

  const rawFolders = Array.isArray(data.folders) ? data.folders : (Array.isArray(data.folders?.rows) ? data.folders.rows : []);
  const rawContent = Array.isArray(data.content) ? data.content : (Array.isArray(data.content?.rows) ? data.content.rows : []);
  const rawTopics = Array.isArray(data.topics) ? data.topics : (Array.isArray(data.topics?.rows) ? data.topics.rows : []);
  const rawTopicFolders = Array.isArray(data.topic_folders) ? data.topic_folders : (Array.isArray(data.topic_folders?.rows) ? data.topic_folders.rows : []);
  const rawSettings = Array.isArray(data.settings) ? data.settings : (Array.isArray(data.settings?.rows) ? data.settings.rows : []);
  const rawAdmins = Array.isArray(data.admins) ? data.admins : (Array.isArray(data.admins?.rows) ? data.admins.rows : []);
  const rawAbout = Array.isArray(data.about_us) ? data.about_us : (Array.isArray(data.about_us?.rows) ? data.about_us.rows : []);
  const rawNews = Array.isArray(data.news) ? data.news : (Array.isArray(data.news?.rows) ? data.news.rows : []);

  for (const r of rawFolders) {
    const id = Array.isArray(r) ? r[0] : r.id;
    const parentId = Array.isArray(r) ? r[1] : r.parent_id;
    const name = Array.isArray(r) ? r[2] : r.name;
    const nodeType = (Array.isArray(r) ? r[3] : r.node_type) || 'general';
    const accepts = Number((Array.isArray(r) ? r[4] : r.accepts_contributions) ?? 0);
    const desc = (Array.isArray(r) ? r[5] : r.description) ?? null;
    const kw = (Array.isArray(r) ? r[6] : r.keywords) ?? null;
    if (!name) continue;
    await run(
      db,
      `INSERT INTO folders (id, parent_id, name, node_type, accepts_contributions, description, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, name=excluded.name, node_type=excluded.node_type, accepts_contributions=excluded.accepts_contributions`,
      [Number(id), parentId ? Number(parentId) : null, String(name), String(nodeType), accepts, desc, kw],
    ).catch(() => {});
    foldersRestored++;
  }

  for (const r of rawContent) {
    const id = Array.isArray(r) ? r[0] : r.id;
    const folderId = Array.isArray(r) ? r[1] : r.folder_id;
    const title = Array.isArray(r) ? r[2] : r.title;
    const fileId = Array.isArray(r) ? r[3] : r.file_id;
    const fileType = (Array.isArray(r) ? r[4] : r.file_type) || 'doc';
    const createdAt = (Array.isArray(r) ? r[5] : r.created_at) || new Date().toISOString();
    const sourceType = (Array.isArray(r) ? r[6] : r.source_type) || 'direct';
    const sourceContribId = (Array.isArray(r) ? r[7] : r.source_contribution_id) ?? null;
    const createdBy = (Array.isArray(r) ? r[8] : r.created_by) ?? null;
    if (!folderId || !title || !fileId) continue;
    if (id) {
      await run(
        db,
        `INSERT INTO content (id, folder_id, title, file_id, file_type, created_at, source_type, source_contribution_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id, title=excluded.title, file_id=excluded.file_id, file_type=excluded.file_type`,
        [Number(id), Number(folderId), String(title), String(fileId), String(fileType), String(createdAt), String(sourceType), sourceContribId, createdBy],
      ).catch(() => {});
    } else {
      const dup = await get(db, 'SELECT id FROM content WHERE folder_id=? AND file_id=? LIMIT 1', [Number(folderId), String(fileId)]);
      if (!dup) {
        await addContent(db, Number(folderId), String(title), String(fileId), String(fileType), String(sourceType), sourceContribId, createdBy).catch(() => {});
      }
    }
    contentRestored++;
  }

  for (const r of rawTopics) {
    const id = Array.isArray(r) ? r[0] : r.id;
    const name = Array.isArray(r) ? r[1] : r.name;
    const desc = (Array.isArray(r) ? r[2] : r.description) ?? null;
    const icon = (Array.isArray(r) ? r[3] : r.icon) ?? null;
    const order = Number((Array.isArray(r) ? r[4] : r.display_order) ?? 0);
    const active = Number((Array.isArray(r) ? r[5] : r.active) ?? 1);
    if (!name) continue;
    await run(
      db,
      `INSERT INTO topics (id, name, description, icon, display_order, active)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, active=excluded.active`,
      [Number(id), String(name), desc, icon, order, active],
    ).catch(() => {});
    topicsRestored++;
  }

  for (const r of rawTopicFolders) {
    const tid = Array.isArray(r) ? r[0] : r.topic_id;
    const fid = Array.isArray(r) ? r[1] : r.folder_id;
    if (!tid || !fid) continue;
    await run(db, 'INSERT OR IGNORE INTO topic_folders (topic_id, folder_id) VALUES (?, ?)', [Number(tid), Number(fid)]).catch(() => {});
  }

  for (const r of rawSettings) {
    const k = Array.isArray(r) ? r[0] : r.key;
    const v = Array.isArray(r) ? r[1] : r.value;
    if (!k || String(k).startsWith('worker_state:')) continue;
    await run(db, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [String(k), String(v ?? '')]).catch(() => {});
    settingsRestored++;
  }

  for (const r of rawAdmins) {
    const tid = Array.isArray(r) ? r[0] : r.telegram_id;
    const uname = (Array.isArray(r) ? r[1] : r.username) ?? null;
    const role = (Array.isArray(r) ? r[3] : r.role) || 'admin';
    const perms = (Array.isArray(r) ? r[4] : r.permissions) || '';
    if (!tid) continue;
    await run(
      db,
      'INSERT INTO admins(telegram_id,username,role,permissions) VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET role=excluded.role, permissions=excluded.permissions',
      [Number(tid), uname, String(role), String(perms)],
    ).catch(() => {});
  }

  for (const r of rawAbout) {
    const contentText = Array.isArray(r) ? r[1] : r.content;
    if (!contentText) continue;
    await run(db, 'INSERT INTO about_us(id,content) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content', [String(contentText)]).catch(() => {});
  }

  for (const r of rawNews) {
    const id = Array.isArray(r) ? r[0] : r.id;
    const ntype = (Array.isArray(r) ? r[1] : r.news_type) || 'notify';
    const title = Array.isArray(r) ? r[2] : r.title;
    const body = (Array.isArray(r) ? r[3] : r.body) ?? '';
    const status = (Array.isArray(r) ? r[8] : r.status) || 'published';
    if (!title) continue;
    await run(
      db,
      'INSERT OR IGNORE INTO news (id, news_type, title, body, status) VALUES (?, ?, ?, ?, ?)',
      [Number(id), String(ntype), String(title), String(body), String(status)],
    ).catch(() => {});
  }

  return { ok: true, foldersRestored, contentRestored, topicsRestored, settingsRestored };
}

function parseCaptionHierarchyAndTitle(captionText, fallbackTitle) {
  const meta = decodeArchiveMeta(captionText);
  if (meta && Array.isArray(meta.c) && meta.c.length > 0) {
    return {
      chain: meta.c.map((item) => [String(item[0] || '').trim(), String(item[1] || 'general').trim()]),
      title: String(meta.t || fallbackTitle || 'مورد مسترد').trim(),
      sourceType: String(meta.s || 'direct'),
      createdBy: meta.u || null,
    };
  }

  const lines = String(captionText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let title = '';
  let fullPath = '';
  let level = '';
  let term = '';
  let block = '';
  let subject = '';
  let section = '';

  for (const line of lines) {
    const clean = line.replace(/^[🗄📄🗂🎓📅🧩📚📂🧭👤🕒🏷🔖📍🆔━\s]+/u, '').trim();
    if (/^اسم المورد\s*:/u.test(clean)) title = clean.replace(/^اسم المورد\s*:/u, '').trim();
    else if (!title && line.startsWith('📄')) title = clean;
    else if (/^المسار(?: الكامل)?\s*:/u.test(clean)) fullPath = clean.replace(/^المسار(?: الكامل)?\s*:/u, '').trim();
    else if (!fullPath && line.startsWith('📍')) fullPath = clean;
    else if (/^المستوى الدراسي\s*:/u.test(clean)) level = clean.replace(/^المستوى الدراسي\s*:/u, '').trim();
    else if (/^الفصل الدراسي(?:\s*\(الترم\))?\s*:|^الترم\s*:/u.test(clean)) term = clean.replace(/^الفصل الدراسي(?:\s*\(الترم\))?\s*:|^الترم\s*:/u, '').trim();
    else if (/^البلوك(?:\s*\/\s*الموديول)?\s*:/u.test(clean)) block = clean.replace(/^البلوك(?:\s*\/\s*الموديول)?\s*:/u, '').trim();
    else if (/^المادة(?: الدراسية)?\s*:/u.test(clean)) subject = clean.replace(/^المادة(?: الدراسية)?\s*:/u, '').trim();
    else if (/^القسم\s*:/u.test(clean)) section = clean.replace(/^القسم\s*:/u, '').trim();
  }

  const chain = [];
  if (fullPath) {
    const parts = fullPath.split(/\s*(?:\/|⬅️|->|>|\|)\s*/).map((p) => p.trim()).filter(Boolean);
    parts.forEach((p, idx) => {
      const ntype = idx === 0 ? 'year' : idx === parts.length - 1 ? 'section' : 'general';
      chain.push([p, ntype]);
    });
  } else {
    const addPart = (val, ntype) => {
      if (val && val !== 'غير محدد' && val !== 'عام' && !chain.some((c) => c[0] === val)) {
        chain.push([val, ntype]);
      }
    };
    addPart(level, 'year');
    addPart(term, 'term');
    addPart(block, 'block');
    addPart(subject, 'subject');
    addPart(section, 'section');
  }

  if (chain.length === 0) {
    const tags = Array.from(String(captionText || '').matchAll(/#([\p{L}\p{N}_]{2,40})/gu)).map((m) => m[1].replace(/_/g, ' '));
    const filteredTags = tags.filter((t) => !/MEDBOT|نسخة_احتياطية/i.test(t));
    if (filteredTags.length > 0) {
      filteredTags.slice(0, 5).forEach((t, idx, arr) => {
        chain.push([t, idx === 0 ? 'year' : idx === arr.length - 1 ? 'section' : 'general']);
      });
    } else {
      chain.push(['موارد مستردة من الأرشيف', 'section']);
    }
  }

  if (!title) {
    const firstNormal = lines.find((l) => !/MEDBOT|أرشيف|━━|المستوى|الفصل|البلوك|المادة|القسم|المسار|المشارك|تاريخ|#/.test(l));
    title = firstNormal || fallbackTitle || 'مورد تعليمي مسترد';
  }

  return {
    chain,
    title: String(title).slice(0, 160),
    sourceType: 'direct',
    createdBy: null,
  };
}

export async function importWorkerArchiveInput(db, user, message, bot = null) {
  if (!(await hasPermission(db, Number(user.id), 'can_archive'))) {
    return { ok: false, text: '🔒 غير مصرح.' };
  }

  // 1. Check if the message is a JSON or SQL backup document
  const docName = String(message?.document?.file_name || '').toLowerCase();
  const docMime = String(message?.document?.mime_type || '').toLowerCase();
  const isBackupFile = message?.document && (
    docName.endsWith('.json') ||
    docName.endsWith('.sql') ||
    docName.endsWith('.txt') ||
    docMime.includes('json') ||
    docMime.includes('sql') ||
    /MEDBOT_BACKUP|medbot-cloud-backup/i.test(String(message?.caption || '') + ' ' + docName)
  );

  if (isBackupFile && bot?.downloadFileText) {
    try {
      const rawText = await bot.downloadFileText(message.document.file_id);
      const trimmed = String(rawText || '').trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        const res = await restoreWorkerBackupPayload(db, parsed);
        return {
          ok: true,
          text:
            `✅ <b>تم استرداد النسخة السحابية بنجاح من الملف!</b>\n\n` +
            `📁 المجلدات والأقسام المستردة: ${res.foldersRestored}\n` +
            `📄 الموارد والملفات المستردة: ${res.contentRestored}\n` +
            `🧭 مواضيع البحث: ${res.topicsRestored}\n` +
            `⚙️ الإعدادات: ${res.settingsRestored}`,
          reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive'), btn('🏠 الرئيسية', 'home')]]),
        };
      }
      if (/INSERT\s+INTO/i.test(trimmed)) {
        const stmts = trimmed
          .split(/;\s*\r?\n/)
          .map((s) => s.trim())
          .filter((s) => /^INSERT\s+INTO/i.test(s));
        let executed = 0;
        for (const sql of stmts) {
          await run(db, sql).catch(() => {});
          executed++;
        }
        return {
          ok: true,
          text: `✅ <b>تم استيراد ملف قاعدة البيانات SQL بنجاح!</b>\n\n📊 السجلات المنفذة: ${executed}`,
          reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive'), btn('🏠 الرئيسية', 'home')]]),
        };
      }
    } catch (err) {
      return {
        ok: false,
        text: `⚠️ تعذر قراءة ملف النسخة الاحتياطية: ${esc(err?.message || String(err))}`,
        reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive')]]),
      };
    }
  }

  // 2. Check if plain text message is JSON or SQL
  const rawMsgText = String(message?.text || '').trim();
  if (!message?.document && !message?.photo && !message?.video && !message?.audio && rawMsgText) {
    if (rawMsgText.startsWith('{') || rawMsgText.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawMsgText);
        const res = await restoreWorkerBackupPayload(db, parsed);
        return {
          ok: true,
          text: `✅ <b>تم استرداد البيانات من نص JSON بنجاح!</b>\n📁 الأقسام: ${res.foldersRestored} | 📄 الموارد: ${res.contentRestored}`,
          reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive'), btn('🏠 الرئيسية', 'home')]]),
        };
      } catch {
        // Continue
      }
    }
    if (/INSERT\s+INTO/i.test(rawMsgText)) {
      const stmts = rawMsgText.split(/;\s*\r?\n/).map((s) => s.trim()).filter((s) => /^INSERT\s+INTO/i.test(s));
      let executed = 0;
      for (const sql of stmts) {
        await run(db, sql).catch(() => {});
        executed++;
      }
      return {
        ok: true,
        text: `✅ <b>تم تنفيذ أوامر الاسترداد SQL بنجاح!</b> (${executed} سجل)`,
        reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive'), btn('🏠 الرئيسية', 'home')]]),
      };
    }
    if (/بطاقة فهرسة قسم دراسي|المستوى الدراسي|المسار/u.test(rawMsgText)) {
      const parsedHeader = parseCaptionHierarchyAndTitle(rawMsgText, '');
      const fid = await ensureFolderChainInD1(db, parsedHeader.chain);
      const pathStr = parsedHeader.chain.map((c) => c[0]).join(' / ');
      return {
        ok: true,
        text: `✅ <b>تم استرداد وبناء هيكلة القسم الدراسي بنجاح!</b>\n🧭 المسار: <b>${esc(pathStr)}</b> (#${fid})\n\nأرسل أو وجّه باقي منشورات القناة للاستمرار، أو اضغط رجوع:`,
        reply_markup: kb([[btn('✅ إنهاء الاستيراد والعودة للأرشيف', 'admin_archive')]]),
      };
    }
  }

  // 3. Media post forwarded or sent from the Archive Channel (Document, Photo, Video, Audio)
  let fileId = null;
  let fileType = 'doc';
  let fallbackTitle = 'مورد تعليمي';
  if (message?.document) {
    fileId = message.document.file_id;
    fileType = 'doc';
    fallbackTitle = message.document.file_name || fallbackTitle;
  } else if (Array.isArray(message?.photo) && message.photo.length) {
    fileId = message.photo[message.photo.length - 1].file_id;
    fileType = 'photo';
    fallbackTitle = 'صورة تعليمية';
  } else if (message?.video) {
    fileId = message.video.file_id;
    fileType = 'video';
    fallbackTitle = message.video.file_name || 'فيديو تعليمي';
  } else if (message?.audio) {
    fileId = message.audio.file_id;
    fileType = 'audio';
    fallbackTitle = message.audio.file_name || 'ملف صوتي';
  }

  if (!fileId) {
    return {
      ok: false,
      text: '⚠️ يرجى توجيه (Forward) منشورات الموارد من قناة الأرشيف، أو إرسال ملف النسخة الاحتياطية (<code>.json</code> / <code>.sql</code>).',
      reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive')]]),
    };
  }

  const caption = String(message?.caption || message?.text || '');
  const parsed = parseCaptionHierarchyAndTitle(caption, fallbackTitle);
  const folderId = await ensureFolderChainInD1(db, parsed.chain);
  const pathStr = parsed.chain.map((c) => c[0]).join(' / ');

  const existing = await get(
    db,
    'SELECT id FROM content WHERE folder_id = ? AND (file_id = ? OR title = ?) LIMIT 1',
    [Number(folderId), String(fileId), String(parsed.title)],
  );
  let contentId = existing?.[0] ? Number(existing[0]) : null;
  if (!contentId) {
    contentId = await addContent(
      db,
      Number(folderId),
      parsed.title,
      fileId,
      fileType,
      parsed.sourceType || 'direct',
      null,
      parsed.createdBy || Number(user.id),
    );
  }

  return {
    ok: true,
    contentId,
    folderId,
    text:
      `✅ <b>تم قراءة واستيراد المورد من الأرشيف بنجاح!</b>\n\n` +
      `📄 <b>المورد:</b> ${esc(parsed.title)}\n` +
      `🧭 <b>المسار المسترد:</b> ${esc(pathStr)}\n\n` +
      `<i>يمكنك توجيه المزيد من رسائل القناة الآن، أو الضغط على إنهاء:</i>`,
    reply_markup: kb([[btn('✅ إنهاء الاستيراد والعودة للأرشيف', 'admin_archive')]]),
  };
}

export async function restoreWorkerFromArchiveChannelAuto(db, user, bot, env = {}) {
  if (!(await hasPermission(db, Number(user.id), 'can_archive'))) {
    return { ok: false, text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const channel = await resolveWorkerArchiveChannelAsync(db, env);
  if (!channel || !bot?.getChat) {
    return {
      ok: false,
      text: '⚠️ لم يتم ربط قناة الأرشيف بعد. اربط القناة أولاً من زر إعداد القناة.',
      reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive')]]),
    };
  }

  const target = /^-\d+$/.test(channel) ? Number(channel) : channel;
  try {
    const chat = await bot.getChat(target);
    const pinned = chat?.pinned_message;
    if (pinned?.document?.file_id && bot?.downloadFileText) {
      const rawText = await bot.downloadFileText(pinned.document.file_id);
      const parsed = JSON.parse(String(rawText || '').trim());
      const res = await restoreWorkerBackupPayload(db, parsed);
      return {
        ok: true,
        text:
          `🎉 <b>تم الاسترداد التلقائي الشامل من قناة الأرشيف بنجاح!</b>\n\n` +
          `📡 <b>القناة:</b> ${esc(chat?.title || channel)}\n` +
          `📁 <b>المستويات والأقسام المستردة:</b> ${res.foldersRestored}\n` +
          `📄 <b>الموارد والملفات المستردة:</b> ${res.contentRestored}\n` +
          `🧭 <b>مواضيع البحث المستردة:</b> ${res.topicsRestored}\n` +
          `⚙️ <b>الإعدادات المستردة:</b> ${res.settingsRestored}`,
        reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive'), btn('🏠 الرئيسية', 'home')]]),
      };
    }
    if (pinned && (pinned.document || pinned.photo || pinned.video || pinned.audio)) {
      const single = await importWorkerArchiveInput(db, user, pinned, bot);
      return single;
    }
    return {
      ok: false,
      text:
        `ℹ️ <b>لم يتم العثور على ملف نسخة استرداد مثبت في القناة (${esc(chat?.title || channel)}) بعد.</b>\n\n` +
        `• يمكنك الضغط على <b>"📦 حفظ وتثبيت نسخة استرداد شاملة في القناة"</b> لتثبيت أول نسخة تلقائية.\n` +
        `• أو الضغط على <b>"📥 استيراد من القناة (تحويل رسائل أو ملفات)"</b> وتوجيه أي رسائل أو ملفات من القناة مباشرةً إلى البوت ليقوم بقراءتها وبناء أقسامها فوراً.`,
      reply_markup: kb([
        [btn('📥 استيراد رسائل / ملفات من القناة', 'admin_archive_import')],
        [btn('⬅️ أرشيف القناة', 'admin_archive'), btn('🏠 الرئيسية', 'home')],
      ]),
    };
  } catch (err) {
    return {
      ok: false,
      text: `⚠️ تعذر الوصول إلى قناة الأرشيف (<code>${esc(channel)}</code>).\nتأكد من أن البوت مضاف كمشرف (Admin) داخل القناة.\n\nالخطأ: <code>${esc(err?.message || String(err))}</code>`,
      reply_markup: kb([[btn('⬅️ أرشيف القناة', 'admin_archive')]]),
    };
  }
}

export async function buildWorkerArchiveAdmin(db, user, env = {}, bot = null) {
  if (!(await hasPermission(db, Number(user.id), 'can_archive'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const channel = await resolveWorkerArchiveChannelAsync(db, env);
  const totalFolders = Number((await get(db, 'SELECT COUNT(*) FROM folders'))?.[0] ?? 0);
  const totalRes = Number((await get(db, 'SELECT COUNT(*) FROM content'))?.[0] ?? 0);
  const pubRes = Number((await get(db, "SELECT COUNT(*) FROM archive_sync WHERE object_type='content' AND status='published'"))?.[0] ?? 0);
  const failRes = Number((await get(db, "SELECT COUNT(*) FROM archive_sync WHERE object_type='content' AND status='failed'"))?.[0] ?? 0);

  let channelTitle = '';
  let hasPinnedBackup = false;
  if (channel && bot?.getChat) {
    try {
      const target = /^-\d+$/.test(channel) ? Number(channel) : channel;
      const chat = await bot.getChat(target);
      channelTitle = chat?.title ? ` — <b>${esc(chat.title)}</b>` : '';
      hasPinnedBackup = Boolean(chat?.pinned_message?.document);
    } catch {
      channelTitle = ' <i>(تحقق من صلاحية إشراف البوت في القناة)</i>';
    }
  }

  const lines = [
    '🗄 <b>أرشيف الطوارئ والاسترداد السحابي (Telegram Archive)</b>',
    '━━━━━━━━━━━━━━━━━━',
    `📡 <b>حالة القناة:</b> ${channel ? `✅ متصلة (<code>${esc(channel)}</code>)${channelTitle}` : '⚠️ غير مربوطة بعد'}`,
    `📦 <b>نسخة الاسترداد المثبتة:</b> ${hasPinnedBackup ? '✅ متوفرة ومثبتة في القناة' : 'ℹ️ غير مثبتة بعد'}`,
    `📁 <b>إجمالي المستويات والأقسام:</b> ${totalFolders}`,
    `📚 <b>إجمالي الموارد في البوت:</b> ${totalRes}`,
    `✅ <b>المؤرشف في القناة:</b> ${pubRes}`,
    `⚠️ <b>فشل أرشفته:</b> ${failRes}`,
    '',
    '💡 <i>يتم حفظ كل مورد في القناة بتنسيق هرمي كامل (المستوى، الترم، البلوك، المادة، القسم، نوع الداتا، والمشارك) مع تحديث نسخة الاسترداد السحابية تلقائياً.</i>',
  ];

  const rows = [];
  if (channel) {
    rows.push([btn('🔄 مزامنة ونشر كافة الموارد في القناة', 'admin_archive_sync')]);
    rows.push([btn('📦 حفظ وتثبيت نسخة استرداد شاملة في القناة', 'admin_archive_backup')]);
    rows.push([btn('♻️ استرداد تلقائي شامل من قناة الأرشيف', 'admin_archive_restore_auto')]);
  }
  rows.push([
    btn('📥 استيراد من القناة (بأي صيغة)', 'admin_archive_import'),
    btn('📤 تصدير نسخة للمحادثة', 'admin_archive_export_chat'),
  ]);
  rows.push([btn('⚙️ ربط / تغيير قناة الأرشيف', 'admin_archive_set_channel')]);
  rows.push([btn('⬅️ لوحة الإدارة', 'admin'), btn('🏠 الرئيسية', 'home')]);
  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

export async function syncWorkerArchiveAll(db, user, bot, env = {}) {
  if (!(await hasPermission(db, Number(user.id), 'can_archive'))) {
    return { text: '🔒 غير مصرح.', reply_markup: kb(home) };
  }
  const channel = await resolveWorkerArchiveChannelAsync(db, env);
  if (!channel) {
    return {
      text: '⚠️ لم يتم ربط قناة الأرشيف بعد. اضغط على <b>"⚙️ ربط / تغيير قناة الأرشيف"</b> لإعدادها.',
      reply_markup: kb([
        [btn('⚙️ ربط / تغيير قناة الأرشيف', 'admin_archive_set_channel')],
        [btn('⬅️ أرشيف القناة', 'admin_archive')],
      ]),
    };
  }
  const snapshots = await getAllResourceSnapshots(db);
  snapshots.sort((a, b) => String(a[5] || '').localeCompare(String(b[5] || ''), 'ar') || (Number(a[0]) - Number(b[0])));
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let lastError = '';
  for (const snap of snapshots.slice(0, 50)) {
    const res = await publishResourceToWorkerArchive(db, bot, env, snap[0], { skipAutoBackup: true });
    if (res.skipped) skipped++;
    else if (res.ok) sent++;
    else {
      failed++;
      if (!lastError && res.error) lastError = res.error;
    }
  }

  let backupDone = false;
  try {
    const bRes = await publishWorkerCloudBackupToArchive(db, bot, env, { pin: true });
    backupDone = Boolean(bRes?.ok);
  } catch {
    backupDone = false;
  }

  return {
    text:
      `✅ <b>اكتملت مزامنة الأرشيف والنسخ السحابي</b>\n\n` +
      `📤 تم نشر موارد جديدة بالتنسيق الهرمي: ${sent}\n` +
      `⏭ مؤرشف مسبقاً: ${skipped}\n` +
      `⚠️ فشل: ${failed}${lastError ? ` (<code>${esc(lastError.slice(0, 120))}</code>)` : ''}\n` +
      `📦 نسخة الاسترداد الشاملة المثبتة: ${backupDone ? '✅ تم تحديثها وتثبيتها في القناة' : 'ℹ️ لم يتم تحديثها'}`,
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
      const contentId = Array.isArray(result) ? result[5] : result?.contentId;
      if (contentId) {
        await publishResourceToWorkerArchive(db, bot, env, contentId).catch(() => {});
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
