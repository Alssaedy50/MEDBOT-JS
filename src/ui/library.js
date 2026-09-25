/**
 * Student library browsing: navigate the registered tree, open a resource,
 * and run the deterministic intent-aware search.
 *
 * Every screen is built from live registry rows; there is no cached copy of a
 * folder name anywhere, so an admin rename shows up immediately.
 */

import * as db from '../db/index.js';
import * as i18n from '../i18n.js';
import * as searchEngine from '../searchEngine.js';
import { btn, contentIcon, escHtml, keyboard, resourceIcon } from '../telegram/ui.js';

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

async function lang(userId) {
  try {
    return db.getUserLanguage(userId);
  } catch {
    return i18n.DEFAULT_LANGUAGE;
  }
}

/** True when the library is hidden for this caller (admins bypass). */
async function libraryHiddenFor(ctx) {
  try {
    if (db.isUserAdmin(ctx.from.id)) return false;
    if (!db.isFeatureHidden('resources')) return false;
  } catch {
    return false;
  }

  await ctx.editMessageText('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
    reply_markup: homeKeyboard(),
  });
  return true;
}

/**
 * The library browser: one screen per level of the real hierarchy.
 *
 * Folder entries drill down; resource entries are sent as a document/photo/
 * video/audio so the student gets the file itself, not a link that can rot.
 */
export async function showFolder(ctx, folderId) {
  const language = await lang(ctx.from.id);

  let view;
  try {
    view = db.getFolderView(folderId);
  } catch {
    view = null;
  }

  if (!view || !view.folder) {
    await ctx.editMessageText(i18n.t('not_found', language), {
      reply_markup: keyboard([
        [btn(i18n.t('library_title', language), 'library:0')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  const { folder, children, files, parentId, breadcrumb } = view;
  const folderName = folder[2];
  const nodeType = folder[3];

  const lines = [
    `${resourceIcon(nodeType)} <b>${esc(folderName)}</b>`,
    `📍 ${esc(breadcrumb)}`,
  ];

  if (!children.length && !files.length) {
    lines.push('', i18n.t('library_area_empty', language));
  } else {
    if (children.length) lines.push('', `📂 الأقسام: ${children.length}`);
    if (files.length) lines.push(`📄 الموارد: ${files.length}`);
  }

  const rows = [];

  for (const [childId, name, childType] of children) {
    rows.push([
      btn(`${resourceIcon(childType)} ${String(name).slice(0, 36)}`, `folder:${childId}`),
    ]);
  }

  for (const [contentId, title, , fileType] of files) {
    rows.push([btn(`${contentIcon(fileType)} ${String(title).slice(0, 36)}`, `file:${contentId}`)]);
  }

  rows.push([btn('⬅️ رجوع', `library:${parentId || 0}`)]);
  rows.push([btn('🔎 بحث في الموارد', 'search')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/**
 * Send one resource to the caller, falling back to its containing folder.
 *
 * The file type decides the Telegram method (document/photo/video/audio), so a
 * photo opens in the gallery rather than as a generic file.
 */
export async function sendResource(ctx, contentId) {
  const language = await lang(ctx.from.id);

  let record;
  try {
    record = db.getFileRecord(contentId);
  } catch {
    record = null;
  }

  if (!record) {
    await ctx.editMessageText(i18n.t('not_found', language), { reply_markup: homeKeyboard() });
    return;
  }

  const [, folderId, title, fileId, fileType] = record;
  const folder = (() => {
    try {
      return db.getFolder(folderId);
    } catch {
      return null;
    }
  })();
  const folderName = folder ? folder[2] : '';

  const bot = ctx.getBot();
  const caption = `📄 <b>${esc(title)}</b>\n🗂 ${esc(folderName)}`;

  try {
    if (fileType === 'photo') {
      await bot.sendPhoto(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
    } else if (fileType === 'video') {
      await bot.sendVideo(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
    } else if (fileType === 'audio') {
      await bot.sendAudio(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
    } else {
      await bot.sendDocument(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
    }
  } catch {
    await ctx.reply(`⚠️ تعذّر إرسال الملف من Telegram حالياً.\n\n📄 <b>${esc(title)}</b>`, {
      reply_markup: keyboard([
        [btn('🗂 فتح القسم', `folder:${folderId}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  await ctx.reply('✅ تم إرسال المورد.', {
    reply_markup: keyboard([
      [btn('🗂 فتح القسم', `folder:${folderId}`)],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
}

/** Prompt for a search query. */
export async function showSearchPrompt(ctx) {
  const language = await lang(ctx.from.id);
  await ctx.editMessageText(
    '🔎 <b>بحث في موارد المنصة</b>\n\n' +
      'اكتب اسم مادة أو قسم أو مورد، وسيبحث MEDBOT في الموارد المسجّلة فقط.\n\n' +
      'مثال: CBC · فسيولوجيا · منهج السنة الثانية',
    { reply_markup: keyboard([[btn('⬅️ رجوع', 'home')], [btn('🏠 الرئيسية', 'home')]]) },
  );
  return language;
}

/**
 * Run a search and render the results as navigable buttons.
 *
 * The results are deterministic registry rows; a result that is an empty folder
 * is shown as such rather than pretending to hold resources.
 */
export async function runSearch(ctx, query) {
  const language = await lang(ctx.from.id);

  let results = [];
  try {
    results = searchEngine.searchLibrary(query, 15);
  } catch {
    results = [];
  }

  if (!results.length) {
    await ctx.reply(
      `🔎 <b>${esc(query)}</b>\n\n${i18n.t('search_empty', language)}`,
      { reply_markup: keyboard([[btn('🏠 الرئيسية', 'home')]]) },
    );
    return;
  }

  const lines = [`🔎 <b>نتائج البحث عن: ${esc(query)}</b>`, `📊 ${results.length} نتيجة`, ''];

  const rows = [];
  for (const item of results.slice(0, 10)) {
    const isFolder = item.result_type === 'FOLDER' || item.result_type === 'EMPTY_FOLDER';
    const icon = isFolder ? '📂' : contentIcon(item.file_type);
    lines.push(
      `${icon} <b>${esc(item.title)}</b>` +
        (item.path ? `\n   📍 ${esc(item.path)}` : '') +
        (isFolder
          ? item.result_type === 'EMPTY_FOLDER'
            ? '\n   ℹ️ قسم بدون موارد مسجّلة'
            : `\n   📄 ${item.content_count} مورد`
          : ''),
    );
    rows.push([
      btn(
        `${icon} ${String(item.title).slice(0, 34)}`,
        isFolder ? `folder:${item.id}` : `file:${item.id}`,
      ),
    ]);
  }

  rows.push([btn('🔎 بحث آخر', 'search')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** The library root: the top level of the real hierarchy, or an empty notice. */
export async function showLibraryRoot(ctx) {
  if (await libraryHiddenFor(ctx)) return;
  const language = await lang(ctx.from.id);

  let roots = [];
  try {
    roots = db.getFolders(0);
  } catch {
    roots = [];
  }

  if (!roots.length) {
    await ctx.editMessageText(
      `${i18n.t('library_title', language)}\n\n${i18n.t('library_empty', language)}`,
      { reply_markup: keyboard([[btn('🏠 الرئيسية', 'home')]]) },
    );
    return;
  }

  const lines = [`${i18n.t('library_title', language)}`, '', i18n.t('library_pick_year', language), ''];
  const rows = [];
  for (const [folderId, name, nodeType] of roots) {
    lines.push(`${resourceIcon(nodeType)} ${esc(name)}`);
    rows.push([btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 36)}`, `folder:${folderId}`)]);
  }
  rows.push([btn('🔎 بحث في الموارد', 'search')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Callback handler for the library namespace. */
export async function libraryCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  if (data === 'resources') {
    await showLibraryRoot(ctx);
    return;
  }

  // The Python reference routes both `library:` and `library_parent:` to
  // show_library(parent_id); its folder keyboard emits `library:<target>` for
  // the back button, and the topics menu emits `library:0`. Without these the
  // back button and "open resources" taps would fall through to the catch-all.
  if (data.startsWith('library:') || data.startsWith('library_parent:')) {
    const target = Number.parseInt(data.split(':')[1], 10);
    if (Number.isNaN(target) || target === 0) {
      await showLibraryRoot(ctx);
      return;
    }
    await showFolder(ctx, target);
    return;
  }

  if (data === 'search') {
    if (await libraryHiddenFor(ctx)) return;
    // Arm the pending-query marker, as Python does with `search_mode = True`,
    // so the prompt is followed by an actual search.
    ctx.userData.library_search = true;
    await showSearchPrompt(ctx);
    return;
  }

  if (data.startsWith('folder:')) {
    const folderId = Number.parseInt(data.split(':')[1], 10);
    if (Number.isNaN(folderId)) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await showFolder(ctx, folderId);
    return;
  }

  if (data.startsWith('file:')) {
    const contentId = Number.parseInt(data.split(':')[1], 10);
    if (Number.isNaN(contentId)) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await sendResource(ctx, contentId);
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const LIBRARY_PREFIXES = [
  'resources',
  'search',
  'library:',
  'library_parent:',
  'folder:',
  'file:',
];
