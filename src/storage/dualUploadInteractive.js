/**
 * Interactive Multi-Destination Upload Wizard & Dual-Upload Session Manager:
 *   1. Destination Selection First (`تحديد وجهات الرفع أولاً`):
 *      - `☁️ Google Drive` (`drive`)
 *      - `🗄 قناة الأرشيف` (`channel`)
 *      - `🤖 البوت` (`bot`)
 *      - `🌟 الكل` (`all`)
 *   2. Full Core Bot Upload Sequence when `الكل` or `البوت` is chosen:
 *      - Step A: Upload Details starting from the Name (`الاسم`) — confirm or edit name.
 *      - Step B: Academic Hierarchy Navigation (`المستوى ⬅️ البلوك ⬅️ المادة ⬅️ القسم`) + Smart Matcher.
 *      - Step C: When creating a new section or subject (`إنشاء قسم أو مادة جديدة`):
 *        1. Enter subject/section name.
 *        2. Choose Practical vs Theoretical (`🔬 عملي` / `📖 نظري` / `📁 عام`).
 *        3. Choose Data Type matching core Bot `src/constants.js` (`📚 كتب`, `🎥 فيديو`, `🎧 صوتيات`, `📑 ملخصات`, `📝 MCQ`, `📁 عام`).
 *        4. Confirm & Send (`🚀 إرسال وتنفيذ الرفع الآن`).
 *   3. Real-time visual progress bar (`▓▓▓▓░░░░░░ 42%`) with non-disruptive keyboard state preservation.
 *   4. Unified Cross-System Cancel & Delete (`du_cancel:<sessionId>`) across Bot DB, Archive Channel, and Google Drive.
 */

import { all, get, run } from '../db/d1/core.js';
import {
  addContent,
  addFolder,
  deleteFile,
  getFolderView,
  getFolders,
  updateFolderAcceptsContributions,
  updateFolderName,
} from '../db/d1/registry.js';
import { FOLDER_NODE_TYPES, NODE_TYPE_LABELS } from '../constants.js';
import { createResourceNewsForContent, publishNews } from '../db/d1/news.js';
import {
  buildStructuredArchiveCaption,
  getFolderHierarchyChain,
} from '../telegram/workerAdmin.js';
import {
  inferMediaFilenameAndMime,
  markChannelPostPublished,
  recordDualUploadEvent,
  unmarkChannelPostPublished,
} from './googleDrive.js';

const memorySessions = new Map();
const memoryTextWaiters = new Map();

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}



/**
 * Extract the first URL (`https://...`, `http://...`, or `t.me/...`) from a message or caption.
 */
export function extractFirstUrlFromMessage(message) {
  const raw = String(message?.text || message?.caption || '').trim();
  if (!raw) return null;
  const match = /(https?:\/\/[^\s<>"]+|(?:https?:\/\/)?t\.me\/[A-Za-z0-9_/+=-]+)/i.exec(raw);
  if (!match?.[1]) return null;
  const url = match[1].trim();
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Detect a detailed human-readable file/data/link type and database `file_type`
 * (`doc`, `video`, `photo`, `audio`, `link`, `text`) from a Telegram message.
 */
export function detectDetailedMediaKind(message, media) {
  const filename = String(media?.filename || '').toLowerCase();
  const mime = String(media?.mimeType || '').toLowerCase();
  const baseType = String(media?.fileType || 'document').toLowerCase();

  if (baseType === 'link') {
    return {
      dbType: 'link',
      defaultNodeType: 'general',
      icon: '🔗',
      label: 'رابط خارجي / مورد سحابي',
      shortLabel: 'رابط',
      keywords: ['روابط', 'مراجع', 'فيديو', 'محاضرات', 'قنوات'],
    };
  }
  if (baseType === 'text') {
    return {
      dbType: 'text',
      defaultNodeType: 'summaries',
      icon: '📝',
      label: 'منشور نصي / ملخص أو ملاحظة علمية',
      shortLabel: 'منشور نصي',
      keywords: ['ملخصات', 'ملاحظات', 'أسئلة', 'تحديد', 'نظري'],
    };
  }
  if (baseType === 'video' || mime.startsWith('video/') || /\.(mp4|mkv|mov|avi|webm)$/i.test(filename)) {
    return {
      dbType: 'video',
      defaultNodeType: 'video',
      icon: '🎬',
      label: 'مقطع فيديو / محاضرة مسجلة',
      shortLabel: 'فيديو',
      keywords: ['فيديو', 'محاضرات', 'تسجيل', 'شرح', 'عملي'],
    };
  }
  if (baseType === 'photo' || mime.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(filename)) {
    return {
      dbType: 'photo',
      defaultNodeType: 'summaries',
      icon: '🖼',
      label: 'صورة / مخطط توضيحي',
      shortLabel: 'صورة',
      keywords: ['صور', 'مخططات', 'عملي', 'أطلس', 'تحديد'],
    };
  }
  if (baseType === 'audio' || mime.startsWith('audio/') || /\.(mp3|ogg|m4a|wav|aac)$/i.test(filename)) {
    return {
      dbType: 'audio',
      defaultNodeType: 'audio',
      icon: '🎧',
      label: 'تسجيل صوتي / ريكورد محاضرة',
      shortLabel: 'ريكورد صوتي',
      keywords: ['ريكورد', 'صوتيات', 'محاضرات', 'تسجيلات'],
    };
  }
  if (mime === 'application/pdf' || /\.pdf$/i.test(filename)) {
    return {
      dbType: 'doc',
      defaultNodeType: 'books',
      icon: '📕',
      label: 'مستند PDF / مقرر أو ملخص دراسي',
      shortLabel: 'ملف PDF',
      keywords: ['مقرر', 'ملخصات', 'محاضرات', 'كتب', 'نظري', 'عملي', 'تحديد'],
    };
  }
  if (/\.(pptx?|ppsx?)$/i.test(filename) || mime.includes('presentation')) {
    return {
      dbType: 'doc',
      defaultNodeType: 'summaries',
      icon: '📊',
      label: 'عرض تقديمي (PowerPoint)',
      shortLabel: 'عرض سلايدات',
      keywords: ['سلايدات', 'عروض', 'محاضرات', 'نظري'],
    };
  }
  if (/\.(docx?|rtf)$/i.test(filename) || mime.includes('word')) {
    return {
      dbType: 'doc',
      defaultNodeType: 'summaries',
      icon: '📝',
      label: 'مستند نصي (Word)',
      shortLabel: 'مستند Word',
      keywords: ['ملخصات', 'تفريغ', 'ملاحظات', 'أسئلة'],
    };
  }
  if (/\.(xlsx?|csv)$/i.test(filename) || mime.includes('spreadsheet')) {
    return {
      dbType: 'doc',
      defaultNodeType: 'general',
      icon: '📈',
      label: 'جدول بيانات (Excel)',
      shortLabel: 'جدول Excel',
      keywords: ['جداول', 'توزيع', 'درجات'],
    };
  }
  if (/\.(zip|rar|7z|tar|gz)$/i.test(filename)) {
    return {
      dbType: 'doc',
      defaultNodeType: 'books',
      icon: '📦',
      label: 'حزمة ملفات مضغوطة (Archive)',
      shortLabel: 'ملف مضغوط',
      keywords: ['تجميعات', 'ملفات', 'مراجع'],
    };
  }
  return {
    dbType: 'doc',
    defaultNodeType: 'general',
    icon: '📄',
    label: 'مورد تعليمي / مستند',
    shortLabel: 'مستند',
    keywords: ['محاضرات', 'ملخصات', 'موارد'],
  };
}

/**
 * Render a 10-block visual progress bar (`▓▓▓▓░░░░░░ 42%`).
 */
export function renderProgressBar(pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const filled = Math.round(clamped / 10);
  const empty = Math.max(0, 10 - filled);
  return `${'▓'.repeat(filled)}${'░'.repeat(empty)} ${clamped}%`;
}

/**
 * Generate a compact session ID (`u` + 8 base36 chars) that fits cleanly inside Telegram's 64-byte `callback_data`.
 */
export function createUploadSessionId() {
  const ts = Date.now().toString(36).slice(-5);
  const rnd = Math.random().toString(36).slice(2, 5);
  return `u${ts}${rnd}`;
}

export async function saveUploadSession(db, session) {
  if (!session?.id) return session;
  session.updatedAt = Date.now();
  memorySessions.set(session.id, session);
  if (db && typeof db.prepare === 'function') {
    const key = `upload_session:${session.id}`;
    await run(
      db,
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, JSON.stringify(session)],
    ).catch(() => {});
  }
  return session;
}

export async function getUploadSession(db, sessionId) {
  const cleanId = String(sessionId || '').trim();
  if (!cleanId) return null;
  if (memorySessions.has(cleanId)) {
    const mem = memorySessions.get(cleanId);
    if (!db || typeof db.prepare !== 'function') return mem;
  }
  if (db && typeof db.prepare === 'function') {
    try {
      const row = await get(db, 'SELECT value FROM settings WHERE key = ? LIMIT 1', [
        `upload_session:${cleanId}`,
      ]);
      const raw = row?.[0] ?? row?.value ?? null;
      if (raw) {
        const parsed = JSON.parse(String(raw));
        memorySessions.set(cleanId, parsed);
        return parsed;
      }
    } catch {
      // Fallback to memory session
    }
  }
  return memorySessions.get(cleanId) || null;
}

export async function setChatTextWaiter(db, chatId, waiter) {
  if (!chatId) return;
  const key = `du_wait_text:${chatId}`;
  if (!waiter) {
    memoryTextWaiters.delete(String(chatId));
    if (db && typeof db.prepare === 'function') {
      await run(db, 'DELETE FROM settings WHERE key = ?', [key]).catch(() => {});
    }
    return;
  }
  memoryTextWaiters.set(String(chatId), waiter);
  if (db && typeof db.prepare === 'function') {
    await run(
      db,
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, JSON.stringify(waiter)],
    ).catch(() => {});
  }
}

export async function getChatTextWaiter(db, chatId) {
  if (!chatId) return null;
  if (memoryTextWaiters.has(String(chatId))) {
    return memoryTextWaiters.get(String(chatId));
  }
  if (db && typeof db.prepare === 'function') {
    try {
      const row = await get(db, 'SELECT value FROM settings WHERE key = ? LIMIT 1', [
        `du_wait_text:${chatId}`,
      ]);
      const raw = row?.[0] ?? row?.value ?? null;
      if (raw) {
        const parsed = JSON.parse(String(raw));
        memoryTextWaiters.set(String(chatId), parsed);
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Find the best-matching existing folder in the bot's hierarchy based on filename, caption, and file type.
 */
export async function findSmartFolderSuggestion(db, title, caption, detailedKind) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const rows = await all(
      db,
      'SELECT id, parent_id, name, node_type, keywords FROM folders ORDER BY id ASC',
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const byId = new Map();
    const hasChildren = new Set();
    for (const r of rows) {
      const id = Number(r[0] ?? r.id);
      const parentId =
        r[1] !== null && r[1] !== undefined
          ? Number(r[1])
          : r.parent_id
            ? Number(r.parent_id)
            : null;
      const name = String(r[2] ?? r.name ?? '').trim();
      const nodeType = String(r[3] ?? r.node_type ?? 'general').trim();
      const keywords = String(r[4] ?? r.keywords ?? '').trim();
      byId.set(id, { id, parentId, name, nodeType, keywords });
      if (parentId) hasChildren.add(parentId);
    }

    const buildChainNames = (folderId) => {
      const names = [];
      let curr = byId.get(folderId);
      let guard = 0;
      while (curr && guard < 12) {
        names.unshift(curr.name);
        curr = curr.parentId ? byId.get(curr.parentId) : null;
        guard++;
      }
      return names;
    };

    const searchCorpus = `${title || ''} ${caption || ''}`.toLowerCase();
    const words = searchCorpus
      .split(/[^\p{L}\p{N}]+/u)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3);

    let best = null;
    let bestScore = 0;

    for (const folder of byId.values()) {
      const chainNames = buildChainNames(folder.id);
      const fullPath = chainNames.join(' / ');
      const folderCorpus = `${fullPath} ${folder.keywords || ''}`.toLowerCase();
      let score = 0;

      const cleanFolderName = folder.name.toLowerCase();
      if (cleanFolderName.length >= 3 && searchCorpus.includes(cleanFolderName)) {
        score += 15;
      }

      for (const w of words) {
        if (folderCorpus.includes(w)) {
          score += 4;
        }
      }

      if (detailedKind?.keywords) {
        for (const kw of detailedKind.keywords) {
          if (cleanFolderName.includes(kw.toLowerCase()) && score > 0) {
            score += 5;
          }
        }
      }

      if (score > 0 && !hasChildren.has(folder.id)) {
        score += 3;
      }
      if (score > 0) {
        score += Math.min(4, chainNames.length);
      }

      if (score > bestScore) {
        bestScore = score;
        best = {
          folderId: folder.id,
          folderName: folder.name,
          fullPath,
        };
      }
    }

    return best;
  } catch {
    return null;
  }
}

function nodeIcon(nodeType) {
  const t = String(nodeType || '').toLowerCase();
  if (t === 'books' || t === 'book') return '📚';
  if (t === 'video') return '🎥';
  if (t === 'audio') return '🎧';
  if (t === 'summaries' || t === 'summary') return '📑';
  if (t === 'mcq') return '📝';
  if (t === 'level' || t === 'year') return '🎓';
  if (t === 'term' || t === 'semester') return '📅';
  if (t === 'block' || t === 'module') return '🧩';
  if (t === 'subject' || t === 'course') return '📚';
  if (t === 'section') return '📑';
  return '📁';
}

function describeDestinations(session) {
  if (session.destChoice === 'all') {
    return '🌟 الكل (البوت + قناة الأرشيف)';
  }
  const parts = [];
  if (session.destBot) parts.push('🤖 داتا البوت');
  if (session.destChannel) parts.push('🗄 قناة الأرشيف');
  return parts.length ? parts.join(' + ') : 'لم يتم التحديد بعد';
}

/**
 * Render the interactive wizard message or execution status message for any `session.step`:
 *   - `choose_dest`: Step 1 — Select upload destination(s) (`قناة الأرشيف`, `البوت`, `الكل`).
 *   - `edit_name`: Step 2 — Confirm or edit the resource Name (`الاسم`).
 *   - `pick_folder`: Step 3 — Admin `الأقسام والمحتوى` navigation & management.
 *   - `admin_fnew` / `admin_ftype` / `admin_frename`: Standard Admin folder creation & renaming.
 *   - `confirm_send`: Step 5 — Final review + `🚀 إرسال وتنفيذ الرفع الآن`.
 *   - `executing` (or default): Status report + post-upload management & unified delete.
 */
export async function renderDualUploadSessionMessage(db, session) {
  const step = String(session.step || 'executing');
  const sizeMb = session.fileSize
    ? `${(Number(session.fileSize) / (1024 * 1024)).toFixed(1)} MB`
    : null;
  const metaLine = `${session.kindIcon || '📄'} <b>النوع المكتشف:</b> ${esc(session.kindLabel || 'مورد تعليمي')}${sizeMb ? ` · <code>${esc(sizeMb)}</code>` : ''}`;

  // ---------------------------------------------------------------------------
  // STEP 1: Choose Upload Destination (`choose_dest`)
  // ---------------------------------------------------------------------------
  if (step === 'choose_dest') {
    const text = [
      '🧭 <b>توجيه ورفع الداتا — تحديد وجهات الرفع أولاً</b>',
      '━━━━━━━━━━━━━━━━━━',
      `📄 <b>الاسم المكتشف:</b> ${esc(session.title || session.filename)}`,
      metaLine,
      '',
      '1️⃣ <b>اختر وجهة الرفع المطلوبة لهذه الداتا:</b>',
      '• <b>🤖 البوت (الأقسام والمحتوى):</b> تصنيف ودمج في مكتبة الطلاب حسب هيكل الأقسام والمحتوى.',
      '• <b>🗄 قناة الأرشيف:</b> نشر وأرشفة في قناة البوت مع منع التكرار.',
      '• <b>🌟 الكل:</b> تحديد الاسم والقسم من «الأقسام والمحتوى» والرفع إلى البوت وقناة الأرشيف معاً.',
    ].join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌟 الكل (البوت + قناة الأرشيف)', callback_data: `du_dest:${session.id}:all` }],
          [
            { text: '🤖 البوت (الأقسام والمحتوى)', callback_data: `du_dest:${session.id}:bot` },
            { text: '🗄 قناة الأرشيف', callback_data: `du_dest:${session.id}:channel` },
          ],
          [{ text: '🛑 إلغاء العملية', callback_data: `du_cancel:${session.id}` }],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 2: Upload Details Starting From Name (`edit_name`)
  // ---------------------------------------------------------------------------
  if (step === 'edit_name') {
    const text = [
      '📝 <b>تفاصيل الرفع — الخطوة 1: تحديد الاسم</b>',
      '━━━━━━━━━━━━━━━━━━',
      `🎯 <b>الوجهات المختارة:</b> ${esc(describeDestinations(session))}`,
      `🏷 <b>الاسم الحالي:</b> <code>${esc(session.title || session.filename)}</code>`,
      metaLine,
      '',
      '💡 <b>لتغيير الاسم:</b> أرسل الاسم الجديد مباشرةً في رسالة نصية الآن، أو اضغط <b>«✅ اعتماد الاسم الحالي والمتابعة»</b> للانتقال إلى شاشة الأقسام والمحتوى:',
    ].join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ اعتماد الاسم الحالي والمتابعة ⬅️', callback_data: `du_name_ok:${session.id}` }],
          [{ text: '✏️ كتابة اسم جديد للملف', callback_data: `du_name_prompt:${session.id}` }],
          [
            { text: '⬅️ تغيير وجهة الرفع', callback_data: `du_back_dest:${session.id}` },
            { text: '🛑 إلغاء', callback_data: `du_cancel:${session.id}` },
          ],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 3: Admin Folders & Content Navigation (`pick_folder`)
  // ---------------------------------------------------------------------------
  if (step === 'pick_folder') {
    const browseId = Number(session.browseFolderId || 0);

    if (browseId === 0) {
      let roots = [];
      if (db && typeof db.prepare === 'function') {
        try {
          roots = await getFolders(db, 0);
        } catch {
          roots = [];
        }
      }

      const text = [
        `📄 <b>الملف:</b> <code>${esc(session.title || session.filename)}</code>`,
        `🎯 <b>الوجهة:</b> ${esc(describeDestinations(session))}`,
        '━━━━━━━━━━━━━━━━━━',
        '🗂 <b>إدارة المواد والأقسام الرئيسية</b>',
        '',
        `عدد المواد الحالية: ${roots.length}`,
        'اختر مادة لإدارة فروعها وتحديد مكان الملف أو أنشئ مادة جديدة:',
      ].join('\n');

      const rows = (roots || []).map((r) => {
        const id = Number(r[0] ?? r.id);
        const name = String(r[1] ?? r.name ?? '');
        const type = String(r[2] ?? r.node_type ?? 'general');
        const contrib = Boolean(r[3] ?? r.accepts_contributions);
        return [
          {
            text: `${nodeIcon(type)} ${String(name).slice(0, 32)}${contrib ? ' 📤' : ''}`,
            callback_data: `du_nav:${session.id}:${id}`,
          },
        ];
      });

      rows.push([
        { text: '➕ إنشاء مادة / قسم رئيسي', callback_data: `du_fnew:${session.id}:0` },
      ]);
      rows.push([
        { text: '✏️ تعديل اسم الملف', callback_data: `du_name_prompt:${session.id}` },
        { text: '⬅️ تغيير الوجهة', callback_data: `du_back_dest:${session.id}` },
      ]);
      rows.push([
        { text: '🛑 إلغاء الرفع', callback_data: `du_cancel:${session.id}` },
      ]);

      return {
        text,
        reply_markup: { inline_keyboard: rows },
      };
    }

    // Inside a folder (`browseId > 0`)
    let view = null;
    if (db && typeof db.prepare === 'function') {
      try {
        view = await getFolderView(db, browseId);
      } catch {
        view = null;
      }
    }

    if (!view?.folder) {
      return {
        text: '⚠️ القسم غير موجود.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ الأقسام الرئيسية', callback_data: `du_nav:${session.id}:0` }]],
        },
      };
    }

    const folder = view.folder;
    const fid = Number(folder[0] ?? folder.id);
    const parentId =
      folder[1] !== null && folder[1] !== undefined
        ? Number(folder[1])
        : folder.parent_id
          ? Number(folder.parent_id)
          : 0;
    const name = String(folder[2] ?? folder.name ?? '');
    const nodeType = String(folder[3] ?? folder.node_type ?? 'general');
    const acceptsContrib = Boolean(folder[4] ?? folder.accepts_contributions);

    const children = Array.isArray(view.children) ? view.children : [];
    const files = Array.isArray(view.files) ? view.files : [];
    const breadcrumb = String(view.breadcrumb || name);

    const lines = [
      `📄 <b>الملف:</b> <code>${esc(session.title || session.filename)}</code>`,
      `🎯 <b>الوجهة:</b> ${esc(describeDestinations(session))}`,
      '━━━━━━━━━━━━━━━━━━',
      `${nodeIcon(nodeType)} <b>${esc(name)}</b>`,
      `📍 المسار: ${esc(breadcrumb)}`,
      `🏷 النوع: ${esc(NODE_TYPE_LABELS[nodeType] ?? nodeType)}`,
      `📤 استقبال مساهمات الطلاب: ${acceptsContrib ? '✅ مفعل' : '❌ متوقف'}`,
      `📁 الأقسام الفرعية: ${children.length} · 📄 الملفات: ${files.length}`,
    ];

    const rows = [];

    // Prominent action button to place and approve this file in the current folder:
    rows.push([
      {
        text: `📥 حفظ واعتماد الملف في هذا القسم («${name.slice(0, 22)}»)`,
        callback_data: `du_select_f:${session.id}:${fid}`,
      },
    ]);

    // Subfolders list (matches Admin!)
    for (const child of children) {
      const cid = Number(child[0] ?? child.id);
      const cname = String(child[1] ?? child.name ?? '');
      const ctype = String(child[2] ?? child.node_type ?? 'general');
      const ccontrib = Boolean(child[3] ?? child.accepts_contributions);
      rows.push([
        {
          text: `${nodeIcon(ctype)} ${String(cname).slice(0, 32)}${ccontrib ? ' 📤' : ''}`,
          callback_data: `du_nav:${session.id}:${cid}`,
        },
      ]);
    }

    // Existing files preview in this folder (first 4)
    for (const file of files.slice(0, 4)) {
      const title = String(file[1] ?? file.title ?? '');
      const ftype = String(file[3] ?? file.file_type ?? 'doc');
      rows.push([
        {
          text: `${nodeIcon(ftype)} ${title.slice(0, 28)}`,
          callback_data: `du_noop:${session.id}`,
        },
      ]);
    }

    // Standard Admin management actions (identical to buildWorkerAdminFolders):
    rows.push([
      { text: '➕ قسم فرعي', callback_data: `du_fnew:${session.id}:${fid}` },
      { text: '✏️ إعادة تسمية', callback_data: `du_frename:${session.id}:${fid}` },
    ]);
    rows.push([
      {
        text: acceptsContrib ? '🔕 إيقاف المساهمات' : '🔔 تفعيل المساهمات',
        callback_data: `du_fcontrib:${session.id}:${fid}`,
      },
      { text: '🗑 حذف هذا القسم', callback_data: `du_fdel:${session.id}:${fid}` },
    ]);
    rows.push([
      { text: '⬅️ رجوع', callback_data: `du_nav:${session.id}:${parentId}` },
      { text: '🛑 إلغاء الرفع', callback_data: `du_cancel:${session.id}` },
    ]);

    return {
      text: lines.join('\n'),
      reply_markup: { inline_keyboard: rows },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 4A: Standard Admin New Folder Prompt (`admin_fnew`)
  // ---------------------------------------------------------------------------
  if (step === 'admin_fnew') {
    const pid = Number(session.pendingFolderParentId || 0);
    const text =
      pid > 0
        ? '➕ <b>إنشاء قسم فرعي جديد</b>\n\nأرسل اسم القسم الفرعي الآن في رسالة نصية:'
        : '➕ <b>إنشاء مادة / قسم رئيسي جديد</b>\n\nأرسل اسم المادة أو القسم الآن في رسالة نصية:';
    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ إلغاء', callback_data: `du_nav:${session.id}:${pid}` }],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 4B: Standard Admin Folder Type Picker (`admin_ftype`)
  // ---------------------------------------------------------------------------
  if (step === 'admin_ftype') {
    const pid = Number(session.pendingFolderParentId || 0);
    const folderName = session.pendingFolderNewName || 'قسم جديد';
    const rows = FOLDER_NODE_TYPES.map((type) => [
      {
        text: NODE_TYPE_LABELS[type] ?? type,
        callback_data: `du_ftype:${session.id}:${pid}:${type}`,
      },
    ]);
    rows.push([{ text: '❌ إلغاء', callback_data: `du_nav:${session.id}:${pid}` }]);
    return {
      text: `🏷 <b>اختر نوع القسم الجديد:</b>\n\nالاسم: <b>${esc(folderName)}</b>`,
      reply_markup: { inline_keyboard: rows },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 4C: Standard Admin Rename Folder Prompt (`admin_frename`)
  // ---------------------------------------------------------------------------
  if (step === 'admin_frename') {
    const fid = Number(session.pendingRenameFolderId || session.browseFolderId || 0);
    return {
      text: '✏️ <b>إعادة تسمية القسم</b>\n\nأرسل الاسم الجديد للقسم الآن في رسالة نصية:',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ إلغاء', callback_data: `du_nav:${session.id}:${fid}` }],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 5: Final Review & Send (`confirm_send`)
  // ---------------------------------------------------------------------------
  if (step === 'confirm_send') {
    const text = [
      '🚀 <b>تأكيد تفاصيل الرفع — جاهز للإرسال</b>',
      '━━━━━━━━━━━━━━━━━━',
      `🎯 <b>الوجهات المختارة:</b> ${esc(describeDestinations(session))}`,
      `📄 <b>اسم الملف:</b> <code>${esc(session.title || session.filename)}</code>`,
      metaLine,
      `📍 <b>القسم المختار:</b> <code>${esc(session.selectedFolderPath || 'تم التحديد')}</code>`,
      session.selectedNodeType
        ? `🏷 <b>نوع القسم:</b> ${esc(NODE_TYPE_LABELS[session.selectedNodeType] ?? session.selectedNodeType)}`
        : '',
      '',
      'اضغط <b>«🚀 إرسال وتنفيذ الرفع الآن»</b> لدفع المورد فوراً إلى الوجهات المحددة:',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 إرسال وتنفيذ الرفع الآن', callback_data: `du_submit:${session.id}` }],
          [
            { text: '✏️ تعديل اسم الملف', callback_data: `du_name_prompt:${session.id}` },
            { text: '🗂 تغيير القسم', callback_data: `du_pick:${session.id}` },
          ],
          [{ text: '🛑 إلغاء الرفع', callback_data: `du_cancel:${session.id}` }],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 6 / DEFAULT: Executing & Post-Upload Status (`executing`)
  // ---------------------------------------------------------------------------
  const showChannel = session.destChannel !== false;
  const showBot = session.destBot !== false;

  // 1. Channel status line
  let channelLine = '';
  if (!showChannel) {
    channelLine = '⚪️ لم يتم اختيار قناة الأرشيف في هذه العملية';
  } else if (session.channelOk) {
    channelLine = session.channelSkippedDuplicate
      ? `✅ موجود مسبقاً في قناة الأرشيف (تم منع التكرار في <code>${esc(session.channelId)}</code>)`
      : `✅ تم النشر والأرشفة في قناة البوت (<code>${esc(session.channelId)}</code>)`;
  } else if (session.channelId) {
    channelLine = `⚠️ تعذر النشر في القناة: <code>${esc(String(session.channelError || '').slice(0, 100))}</code>`;
  } else {
    channelLine = '⚪️ القناة غير مربوطة بعد';
  }

  // 2. Bot Database integration status (الأقسام والمحتوى)
  let botDataLine = '';
  if (session.selectedFolderId && session.selectedFolderPath && session.contentId) {
    botDataLine =
      `✅ <b>مدمج في داتا البوت:</b>\n` +
      `📍 <code>${esc(session.selectedFolderPath)}</code> (🆔 <code>#${session.contentId}</code>)`;
  } else if (!showBot && !session.pickingFolder) {
    botDataLine = '⚪️ لم يتم اختيار دمج البوت (يمكنك دمجه من الزر أدناه في أي وقت)';
  } else {
    botDataLine =
      '⏳ <b>بانتظار تحديد القسم الأكاديمي:</b>\n' +
      'اختر القسم المناسب من الأزرار أدناه لدفع الملف فوراً إلى داتا البوت وتحديث منشور القناة.';
  }

  let browseHeader = '';
  let currentFolder = null;
  let childFolders = [];
  const browseId = Number(session.browseFolderId || 0);
  const showInlineFolderBrowser = Boolean(
    db &&
      typeof db.prepare === 'function' &&
      ((showBot && !session.selectedFolderId) || session.pickingFolder),
  );

  if (showInlineFolderBrowser) {
    try {
      if (browseId > 0) {
        const chain = await getFolderHierarchyChain(db, browseId);
        if (chain.length > 0) {
          currentFolder = chain[chain.length - 1];
          const pathStr = chain.map((c) => c.name).join(' ⬅️ ');
          browseHeader = `\n🧭 <b>المسار المختار حالياً:</b> <code>${esc(pathStr)}</code>`;
        }
        const rows = await all(
          db,
          'SELECT id, name, node_type FROM folders WHERE parent_id = ? ORDER BY id ASC LIMIT 24',
          [browseId],
        );
        childFolders = (rows || []).map((r) => ({
          id: Number(r[0] ?? r.id),
          name: String(r[1] ?? r.name ?? ''),
          nodeType: String(r[2] ?? r.node_type ?? 'general'),
        }));
      } else {
        const rows = await all(
          db,
          'SELECT id, name, node_type FROM folders WHERE parent_id IS NULL OR parent_id = 0 ORDER BY id ASC LIMIT 24',
        );
        childFolders = (rows || []).map((r) => ({
          id: Number(r[0] ?? r.id),
          name: String(r[1] ?? r.name ?? ''),
          nodeType: String(r[2] ?? r.node_type ?? 'general'),
        }));
      }
    } catch {
      childFolders = [];
    }
  }

  const headerTitle = '✅ <b>تقرير رفع الداتا والتصنيف الأكاديمي (البوت + قناة الأرشيف)</b>';

  const text = [
    headerTitle,
    '━━━━━━━━━━━━━━━━━━',
    `📄 <b>الاسم:</b> ${esc(session.title || session.filename)}`,
    metaLine,
    '',
    `1️⃣ <b>قناة الأرشيف:</b>\n${channelLine}`,
    '',
    `2️⃣ <b>داتا البوت (مكتبة الطلاب):</b>\n${botDataLine}${browseHeader}`,
  ].join('\n');

  const rows = [];

  if (showInlineFolderBrowser) {
    if (browseId > 0 && currentFolder) {
      rows.push([
        {
          text: `📥 حفظ واعتماد الملف في هذا القسم («${String(currentFolder.name).slice(0, 22)}»)`,
          callback_data: `du_save:${session.id}:${browseId}`,
        },
      ]);
    }
    for (const cf of childFolders) {
      rows.push([
        {
          text: `${nodeIcon(cf.nodeType)} ${String(cf.name).slice(0, 32)}`,
          callback_data: `du_nav:${session.id}:${cf.id}`,
        },
      ]);
    }
    const navRow = [];
    if (browseId > 0) {
      const parentId = currentFolder?.parent_id ? Number(currentFolder.parent_id) : 0;
      navRow.push({
        text: '⬅️ رجوع',
        callback_data: `du_nav:${session.id}:${parentId}`,
      });
    }
    navRow.push({
      text: browseId > 0 ? '➕ قسم فرعي' : '➕ إنشاء مادة / قسم رئيسي',
      callback_data: `du_fnew:${session.id}:${browseId}`,
    });
    rows.push(navRow);
  } else {
    rows.push([
      {
        text: session.selectedFolderId
          ? `🗂 تغيير القسم (${String(session.selectedFolderName || 'القسم الحالي').slice(0, 22)})`
          : '🗂 اختيار القسم من الأقسام والمحتوى',
        callback_data: `du_pick:${session.id}`,
      },
    ]);
  }

  rows.push([
    {
      text: '🗑 حذف الملف (البوت + القناة)',
      callback_data: `du_cancel:${session.id}`,
    },
    {
      text: '🏠 الرئيسية',
      callback_data: 'home',
    },
  ]);

  return {
    text,
    reply_markup: { inline_keyboard: rows },
  };
}

/**
 * Start the interactive Multi-Destination Upload Wizard when ANY message, media/data, or link
 * is sent or forwarded to the Bot or to the Archive Channel.
 */
export async function startInteractiveUploadWizard({
  _bot = null,
  message,
  channelTarget = null,
  db = null,
  env = {},
  isDirectChannelPost = false,
} = {}) {
  if (!message || message.is_automatic_forward) {
    return { ok: false, reason: 'ignored' };
  }

  const rawText = String(message.caption || message.text || '').trim();

  // Never trigger wizard on the bot's own archive/report posts in the channel
  if (
    rawText.includes('MEDBOT_META:') ||
    rawText.includes('أرشيف ملفات منصة MEDBOT') ||
    rawText.includes('مركز الرفع الذكي') ||
    rawText.includes('تقرير الرفع المزدوج')
  ) {
    return { ok: false, reason: 'bot_own_post' };
  }

  const firstLine = rawText.split(/\r?\n/)[0]?.trim() || '';
  const fallbackBase =
    message?.document?.file_name ||
    message?.video?.file_name ||
    message?.audio?.file_name ||
    message?.audio?.title ||
    firstLine.slice(0, 80) ||
    `مورد-${new Date().toISOString().slice(0, 10)}`;

  let media = inferMediaFilenameAndMime(message, fallbackBase);
  const detectedUrl = !media ? extractFirstUrlFromMessage(message) : null;

  if (!media && detectedUrl) {
    const cleanTitle =
      firstLine.replace(/https?:\/\/\S+/gi, '').trim() ||
      detectedUrl.replace(/^https?:\/\//i, '').slice(0, 60) ||
      'رابط تعليمي';
    media = {
      fileId: detectedUrl,
      fileType: 'link',
      filename: `${cleanTitle.replace(/[\\/:*?"<>|]+/g, '_')}.html`,
      mimeType: 'text/html; charset=utf-8',
      fileSize: new TextEncoder().encode(rawText || detectedUrl).byteLength,
    };
  } else if (!media && rawText) {
    const cleanTitle = firstLine.slice(0, 65) || 'منشور نصي';
    media = {
      fileId: rawText.slice(0, 3800),
      fileType: 'text',
      filename: `${cleanTitle.replace(/[\\/:*?"<>|]+/g, '_')}.txt`,
      mimeType: 'text/plain; charset=utf-8',
      fileSize: new TextEncoder().encode(rawText).byteLength,
    };
  }

  if (!media) {
    return { ok: false, reason: 'no_media' };
  }

  const detailedKind = detectDetailedMediaKind(message, media);
  const defaultTitle =
    (media.fileType === 'link'
      ? firstLine.replace(/https?:\/\/\S+/gi, '').trim() || media.fileId
      : firstLine || media.filename) || 'مورد تعليمي';

  const suggestion = await findSmartFolderSuggestion(db, defaultTitle, rawText, detailedKind);
  const sessionId = createUploadSessionId();
  const chatId = message?.chat?.id ?? message?.from?.id ?? null;
  const actorUserId = message?.from?.id ?? (env?.ADMIN_ID ? Number(env.ADMIN_ID) : null);

  const uniquePart =
    message?.document?.file_unique_id ||
    message?.video?.file_unique_id ||
    message?.audio?.file_unique_id ||
    message?.voice?.file_unique_id ||
    (Array.isArray(message?.photo) && message.photo.length
      ? message.photo[message.photo.length - 1]?.file_unique_id
      : null) ||
    media.fileId;

  const dedupeFp = `dual:${uniquePart}:${defaultTitle}`.slice(0, 240);
  const altFp = `${media.fileType}:${media.fileId}:${defaultTitle}`.slice(0, 240);

  const session = {
    id: sessionId,
    step: 'choose_dest',
    destChoice: null,
    destBot: false,
    destChannel: false,
    destDrive: false,
    title: defaultTitle,
    captionRaw: rawText,
    filename: media.filename,
    fileId: media.fileId,
    fileType: media.fileType,
    dbType: detailedKind.dbType,
    defaultNodeType: detailedKind.defaultNodeType || 'general',
    selectedBranch: 'general',
    selectedNodeType: detailedKind.defaultNodeType || 'general',
    kindIcon: detailedKind.icon,
    kindLabel: detailedKind.label,
    mimeType: media.mimeType,
    fileSize: media.fileSize ?? null,
    dedupeFp,
    altFp,
    userChatId: chatId,
    actorUserId,
    sourceChatId: chatId,
    sourceMessageId: message?.message_id ?? null,
    isDirectChannelPost: Boolean(isDirectChannelPost),
    sourceMessage: {
      message_id: message?.message_id ?? null,
      chat: message?.chat ? { id: message.chat.id, type: message.chat.type, username: message.chat.username } : null,
      from: message?.from ? { id: message.from.id, username: message.from.username } : null,
      forward_from_chat: message?.forward_from_chat ?? null,
      forward_from_message_id: message?.forward_from_message_id ?? null,
      forward_origin: message?.forward_origin ?? null,
      caption: message?.caption ?? null,
      text: message?.text ?? null,
    },
    statusMessageId: null,
    channelId: channelTarget ? String(channelTarget) : (isDirectChannelPost && chatId ? String(chatId) : null),
    channelMessageId: isDirectChannelPost ? (message?.message_id ?? null) : null,
    channelOk: Boolean(isDirectChannelPost),
    channelSkippedDuplicate: false,
    channelError: null,
    executed: false,
    driveStatus: 'disabled',
    driveFileId: null,
    driveWebViewLink: null,
    driveSessionUri: null,
    driveError: null,
    progressPct: 0,
    uploadedBytes: 0,
    contentId: null,
    selectedFolderId: null,
    selectedFolderName: null,
    selectedFolderPath: null,
    browseFolderId: 0,
    pendingFolderParentId: 0,
    pendingNewFolderName: null,
    pickingFolder: false,
    suggestedFolderId: suggestion?.folderId ?? null,
    suggestedFolderPath: suggestion?.fullPath ?? null,
    cancelled: false,
    createdAt: Date.now(),
  };

  await saveUploadSession(db, session);
  const view = await renderDualUploadSessionMessage(db, session);

  return {
    ok: true,
    sessionId: session.id,
    session,
    summaryText: view.text,
    replyMarkup: view.reply_markup,
  };
}



/**
 * Execute the actual upload to the user's selected destinations (`destBot`, `destChannel`).
 */
export async function executeWizardUpload(db, session, userId, bot, env) {
  session.step = 'executing';
  session.executed = true;
  session.pickingFolder = false;
  if (userId) session.actorUserId = Number(userId);

  await saveUploadSession(db, session);

  // ---------------------------------------------------------------------------
  // 1. Bot Database (`content` + `news`) if `destBot` is selected
  // ---------------------------------------------------------------------------
  let chain = [];
  if (session.selectedFolderId && db && typeof db.prepare === 'function') {
    chain = await getFolderHierarchyChain(db, Number(session.selectedFolderId)).catch(() => []);
    if (chain.length > 0) {
      session.selectedFolderPath = chain.map((c) => c.name).join(' / ');
      session.selectedFolderName = chain[chain.length - 1]?.name || session.selectedFolderName;
    }
  }

  if (session.destBot && session.selectedFolderId && db && typeof db.prepare === 'function') {
    await integrateSessionFileIntoFolder(
      db,
      session,
      Number(session.selectedFolderId),
      userId || session.actorUserId,
      bot,
      env,
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Archive Channel (`destChannel`)
  // ---------------------------------------------------------------------------
  if (session.destChannel && session.channelId && bot) {
    const target = /^-\d+$/.test(String(session.channelId))
      ? Number(session.channelId)
      : session.channelId;

    const structuredCaption =
      chain.length > 0
        ? buildStructuredArchiveCaption({
            id: session.contentId || 0,
            folderId: session.selectedFolderId || 0,
            title: session.title || session.filename,
            fileType: session.dbType || 'doc',
            chain,
            sourceType: 'direct',
            contributorName: 'إدارة المنصة',
            contributorId: userId || session.actorUserId || null,
            createdAt: new Date().toISOString(),
          })
        : [
            '🗄 <b>أرشيف ملفات منصة MEDBOT</b>',
            '━━━━━━━━━━━━━━━━━━',
            `📄 <b>الاسم:</b> ${esc(session.title || session.filename)}`,
            session.captionRaw && session.captionRaw !== session.title
              ? `\n📝 <b>الوصف:</b>\n${esc(session.captionRaw.slice(0, 600))}`
              : '',
            `\n🕒 <b>التاريخ:</b> <code>${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</code>`,
          ]
            .filter(Boolean)
            .join('\n');

    if (session.isDirectChannelPost && session.sourceMessageId) {
      session.channelMessageId = session.sourceMessageId;
      session.channelOk = true;
      session.channelSkippedDuplicate = false;
      if (session.fileType !== 'link' && session.fileType !== 'text' && typeof bot.editMessageCaption === 'function') {
        await bot
          .editMessageCaption(target, Number(session.sourceMessageId), structuredCaption, {
            parse_mode: 'HTML',
          })
          .catch(() => {});
      }
    } else if (!session.channelMessageId) {
      let existingMsgId = null;
      if (db && typeof db.prepare === 'function') {
        try {
          const row = await db
            .prepare(
              "SELECT channel_message_id FROM archive_sync WHERE status='published' AND (content_fingerprint = ? OR content_fingerprint = ?) LIMIT 1",
            )
            .bind(session.dedupeFp, session.altFp)
            .first();
          if (row) {
            existingMsgId = row.channel_message_id ?? true;
          }
        } catch {
          // Ignore
        }
      }

      if (existingMsgId) {
        session.channelOk = true;
        session.channelSkippedDuplicate = true;
        session.channelMessageId = typeof existingMsgId === 'number' ? existingMsgId : null;
      } else {
        try {
          let sent = null;
          if (session.fileType === 'link' || session.fileType === 'text') {
            const bodyText =
              session.fileType === 'link'
                ? `${structuredCaption}\n\n🔗 <b>الرابط المباشر:</b>\n${esc(session.fileId)}`
                : `${structuredCaption}\n\n📝 <b>المحتوى النصي:</b>\n${esc(session.fileId.slice(0, 2500))}`;
            sent = await bot.sendMessage(target, bodyText, { parse_mode: 'HTML' });
          } else if (session.fileType === 'photo' && typeof bot.sendPhoto === 'function') {
            sent = await bot.sendPhoto(target, session.fileId, {
              caption: structuredCaption,
              parse_mode: 'HTML',
            });
          } else if (session.fileType === 'video' && typeof bot.sendVideo === 'function') {
            sent = await bot.sendVideo(target, session.fileId, {
              caption: structuredCaption,
              parse_mode: 'HTML',
            });
          } else if (session.fileType === 'audio' && typeof bot.sendAudio === 'function') {
            sent = await bot.sendAudio(target, session.fileId, {
              caption: structuredCaption,
              parse_mode: 'HTML',
            });
          } else if (typeof bot.sendDocument === 'function') {
            sent = await bot.sendDocument(target, session.fileId, {
              caption: structuredCaption,
              parse_mode: 'HTML',
            });
          }
          const msgId = sent?.message_id ?? null;
          session.channelOk = true;
          session.channelSkippedDuplicate = false;
          session.channelMessageId = msgId;
          markChannelPostPublished(session.dedupeFp, msgId ?? true);
          markChannelPostPublished(session.altFp, msgId ?? true);
          if (db && typeof db.prepare === 'function') {
            await db
              .prepare(
                `INSERT INTO archive_sync (object_type, folder_id, content_ids, content_fingerprint, channel_id, channel_message_id, status, attempts, published_at)
                 VALUES ('dual', ?, ?, ?, ?, ?, 'published', 1, CURRENT_TIMESTAMP)
                 ON CONFLICT(content_fingerprint) DO UPDATE SET status='published', folder_id=excluded.folder_id, content_ids=excluded.content_ids, channel_id=excluded.channel_id, channel_message_id=excluded.channel_message_id, updated_at=CURRENT_TIMESTAMP`,
              )
              .bind(
                session.selectedFolderId || null,
                session.contentId ? String(session.contentId) : null,
                session.dedupeFp,
                String(session.channelId),
                msgId,
              )
              .run()
              .catch(() => {});
          }
        } catch (err) {
          session.channelOk = false;
          session.channelError = err?.message ?? String(err);
        }
      }
    }
  }

  await saveUploadSession(db, session);

  recordDualUploadEvent({
    title: session.title,
    filename: session.filename,
    fileType: session.fileType,
    channelOk: session.channelOk,
    channelTarget: session.channelId || null,
    driveOk: false,
    driveFileId: null,
    driveLink: null,
  });

  return session;
}

/**
 * Integrate the session's file/link/text into `folderId` in the Bot Database (`content`),
 * and update the Archive Channel post caption with the full academic hierarchy.
 */
export async function integrateSessionFileIntoFolder(db, session, folderId, userId, bot, _env) {
  const fid = Number(folderId);
  if (!fid || !db) return session;

  const chain = await getFolderHierarchyChain(db, fid);
  if (!chain.length) return session;

  const fullPath = chain.map((c) => c.name).join(' / ');
  const folderName = chain[chain.length - 1]?.name || 'قسم تعليمي';
  const dbFileType = session.dbType || 'doc';

  let contentId = session.contentId ? Number(session.contentId) : null;
  if (contentId) {
    await run(db, 'UPDATE content SET folder_id = ?, title = ? WHERE id = ?', [
      fid,
      session.title || session.filename,
      contentId,
    ]).catch(() => {});
  } else {
    const existing = await get(
      db,
      'SELECT id FROM content WHERE folder_id = ? AND file_id = ? LIMIT 1',
      [fid, String(session.fileId)],
    ).catch(() => null);
    if (existing?.[0]) {
      contentId = Number(existing[0]);
    } else {
      contentId = await addContent(
        db,
        fid,
        session.title || session.filename,
        String(session.fileId),
        dbFileType,
        'direct',
        null,
        Number(userId || session.actorUserId) || null,
      );
      if (contentId) {
        try {
          const newsId = await createResourceNewsForContent(
            db,
            contentId,
            Number(userId || session.actorUserId) || 0,
            'published',
          );
          if (newsId) await publishNews(db, newsId);
        } catch {
          // Non-fatal
        }
      }
    }
  }

  session.contentId = contentId;
  session.selectedFolderId = fid;
  session.selectedFolderName = folderName;
  session.selectedFolderPath = fullPath;
  session.pickingFolder = false;

  if (session.channelId && session.channelMessageId && bot) {
    const structuredCaption = buildStructuredArchiveCaption({
      id: contentId || 0,
      folderId: fid,
      title: session.title || session.filename,
      fileType: dbFileType,
      chain,
      sourceType: 'direct',
      contributorName: 'إدارة المنصة',
      contributorId: userId || session.actorUserId || null,
      createdAt: new Date().toISOString(),
    });
    const target = /^-\d+$/.test(String(session.channelId))
      ? Number(session.channelId)
      : session.channelId;
    if (session.fileType !== 'link' && session.fileType !== 'text' && typeof bot.editMessageCaption === 'function') {
      await bot
        .editMessageCaption(target, Number(session.channelMessageId), structuredCaption, {
          parse_mode: 'HTML',
        })
        .catch(() => {});
    }
    await run(
      db,
      'UPDATE archive_sync SET folder_id = ?, content_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE channel_message_id = ?',
      [fid, String(contentId || ''), Number(session.channelMessageId)],
    ).catch(() => {});
  }

  await saveUploadSession(db, session);
  return session;
}

/**
 * Cancel an active upload or delete an already uploaded file across Bot DB and Archive Channel:
 *   1. Bot Database (`content`, `news`, `archive_sync`)
 *   2. Bot Archive Channel (`deleteMessage`)
 */
export async function cancelAndDeleteUploadSession(db, session, bot, _env) {
  session.cancelled = true;
  await saveUploadSession(db, session);
  await setChatTextWaiter(db, session.userChatId, null);

  if (db && typeof db.prepare === 'function') {
    if (session.contentId) {
      await deleteFile(db, Number(session.contentId)).catch(() => {});
      await run(db, 'DELETE FROM news WHERE content_id = ?', [Number(session.contentId)]).catch(
        () => {},
      );
    }
    if (session.channelMessageId) {
      await run(db, 'DELETE FROM archive_sync WHERE channel_message_id = ?', [
        Number(session.channelMessageId),
      ]).catch(() => {});
    }
    if (session.dedupeFp) {
      await run(db, 'DELETE FROM archive_sync WHERE content_fingerprint = ?', [
        String(session.dedupeFp),
      ]).catch(() => {});
    }
  }

  unmarkChannelPostPublished(session.dedupeFp);
  unmarkChannelPostPublished(session.altFp);

  let channelDeleted = false;
  if (session.channelId && session.channelMessageId && bot) {
    const target = /^-\d+$/.test(String(session.channelId))
      ? Number(session.channelId)
      : session.channelId;
    if (typeof bot.deleteMessage === 'function') {
      try {
        await bot.deleteMessage(target, Number(session.channelMessageId));
        channelDeleted = true;
      } catch {
        channelDeleted = false;
      }
    }
  }

  return {
    ok: true,
    channelDeleted,
    text: [
      '🗑 <b>تم إلغاء العملية وحذف الملف نهائياً</b>',
      '━━━━━━━━━━━━━━━━━━',
      `📄 <b>الملف:</b> ${esc(session.title || session.filename)}`,
      '',
      '✅ <b>تم إيقاف الرفع وإزالة الملف من الوجهات:</b>',
      `• <b>داتا البوت:</b> ${session.contentId ? `تم حذف المورد (#${session.contentId})` : 'تم إلغاء الدمج'}`,
      `• <b>قناة الأرشيف:</b> ${channelDeleted ? 'تم حذف المنشور من القناة' : 'تم إلغاء الأرشفة'}`,
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]],
    },
  };
}

/**
 * Re-enqueue a stalled large-file MTProto job when the user clicks `🔄 تحديث التقدم` and it's still at 0%.
 */
async function ensureLargeJobQueuedInD1(db, session) {
  if (!db || typeof db.prepare !== 'function' || !session?.jobPayload) return;
  try {
    const row = await get(
      db,
      "SELECT value FROM settings WHERE key = 'pending_large_drive_jobs' LIMIT 1",
    ).catch(() => null);
    let jobs = [];
    const raw = row?.[0] ?? row?.value ?? null;
    if (raw) {
      try {
        const parsed = JSON.parse(String(raw));
        if (Array.isArray(parsed)) jobs = parsed;
      } catch {
        jobs = [];
      }
    }
    const existingIdx = jobs.findIndex((j) => j && j.sessionId === session.id);
    const updatedJob = {
      ...session.jobPayload,
      statusChatId: session.userChatId || session.jobPayload.statusChatId,
      statusMessageId: session.statusMessageId || session.jobPayload.statusMessageId,
      dispatchedAt: 0,
    };
    if (existingIdx >= 0) {
      jobs[existingIdx] = updatedJob;
    } else {
      jobs.push(updatedJob);
    }
    await run(
      db,
      "INSERT INTO settings(key,value) VALUES('pending_large_drive_jobs',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(jobs)],
    ).catch(() => {});
  } catch {
    // Ignore
  }
}

/**
 * Handle all interactive callbacks (`du_*`).
 */
export async function handleDualUploadCallback(ctx, data, bot, env) {
  const parts = String(data || '').split(':');
  const action = parts[0];
  const sessionId = parts[1];
  const arg = parts[2];

  const session = await getUploadSession(ctx.db, sessionId);
  if (!session) {
    await ctx.answer();
    return ctx.editMessageText('⚠️ انتهت صلاحية جلسة هذا الملف أو تم حذفه.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
      parse_mode: 'HTML',
    });
  }

  // Record the status message ID and actor user ID whenever a button is clicked
  if (ctx.messageId && !session.statusMessageId) {
    session.statusMessageId = ctx.messageId;
  }
  if (ctx.chatId && !session.userChatId) {
    session.userChatId = ctx.chatId;
  }
  if (ctx.from?.id) {
    session.actorUserId = ctx.from.id;
  }

  // Clear any text waiter unless we're entering a text input step
  await setChatTextWaiter(ctx.db, session.userChatId, null);

  if (action === 'du_cancel') {
    const res = await cancelAndDeleteUploadSession(ctx.db, session, bot, env);
    await ctx.answer();
    return ctx.editMessageText(res.text, {
      reply_markup: res.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 1 -> Back to destination selection
  if (action === 'du_back_dest') {
    session.step = 'choose_dest';
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 1 -> Destination chosen (`all`, `channel`, `bot`)
  if (action === 'du_dest') {
    const choice = String(arg || 'all');
    session.destChoice = choice;
    session.destBot = choice === 'all' || choice === 'bot';
    session.destChannel = choice === 'all' || choice === 'channel';
    session.destDrive = false;

    if (session.destBot) {
      // Enter full Core Bot sequence starting from the Name (`edit_name`)
      session.step = 'edit_name';
      await saveUploadSession(ctx.db, session);
      await setChatTextWaiter(ctx.db, session.userChatId, {
        sessionId: session.id,
        mode: 'edit_name',
      });
      if (ctx.userData) {
        ctx.userData.du_wizard_session = session.id;
        ctx.userData.du_wizard_mode = 'edit_name';
      }
      const view = await renderDualUploadSessionMessage(ctx.db, session);
      await ctx.answer();
      return ctx.editMessageText(view.text, {
        reply_markup: view.reply_markup,
        parse_mode: 'HTML',
      });
    }

    // `channel` only -> execute immediately!
    await ctx.answer();
    await executeWizardUpload(ctx.db, session, ctx.from?.id, bot, env);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 2 -> Confirm current name and move to folder picker
  if (action === 'du_name_ok') {
    session.step = 'pick_folder';
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 2 -> Prompt for a new name
  if (action === 'du_name_prompt') {
    session.step = 'edit_name';
    await saveUploadSession(ctx.db, session);
    await setChatTextWaiter(ctx.db, session.userChatId, {
      sessionId: session.id,
      mode: 'edit_name',
    });
    if (ctx.userData) {
      ctx.userData.du_wizard_session = session.id;
      ctx.userData.du_wizard_mode = 'edit_name';
    }
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 3 -> Navigate folder hierarchy
  if (action === 'du_nav') {
    session.browseFolderId = Number(arg || 0);
    if (
      session.step === 'admin_fnew' ||
      session.step === 'admin_ftype' ||
      session.step === 'admin_frename'
    ) {
      session.step = 'pick_folder';
    } else if (session.step !== 'pick_folder') {
      session.pickingFolder = true;
    }
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Open folder picker to change section
  if (action === 'du_pick') {
    session.browseFolderId = 0;
    session.step = 'pick_folder';
    session.destBot = true;
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 3 -> Select an existing folder in the wizard (`du_select_f`)
  if (action === 'du_select_f') {
    const fid = Number(arg || 0);
    const alreadyExecuted = Boolean(
      session.executed ||
        session.contentId ||
        (session.channelOk && !session.destChoice),
    );

    if (alreadyExecuted && fid > 0) {
      session.destBot = true;
      await integrateSessionFileIntoFolder(
        ctx.db,
        session,
        fid,
        ctx.from?.id,
        bot,
        env,
      );
      session.step = 'executing';
    } else {
      if (fid > 0 && ctx.db) {
        const chain = await getFolderHierarchyChain(ctx.db, fid).catch(() => []);
        if (chain.length > 0) {
          const last = chain[chain.length - 1];
          session.selectedFolderId = fid;
          session.selectedFolderName = last.name;
          session.selectedFolderPath = chain.map((c) => c.name).join(' / ');
          session.selectedNodeType = last.node_type || session.defaultNodeType || 'general';
        }
      }
      session.pendingNewFolderName = null;
      session.step = 'confirm_send';
    }
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Admin Folder Contributions Toggle (`du_fcontrib`)
  if (action === 'du_fcontrib') {
    const fid = Number(arg || session.browseFolderId || 0);
    if (fid > 0 && ctx.db && typeof ctx.db.prepare === 'function') {
      const fView = await getFolderView(ctx.db, fid).catch(() => null);
      if (fView?.folder) {
        const nextVal = Number(fView.folder.accepts_contributions || 0) ? 0 : 1;
        await updateFolderAcceptsContributions(ctx.db, fid, nextVal).catch(() => null);
      }
    }
    session.browseFolderId = fid;
    session.step = 'pick_folder';
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Admin Folder Delete (`du_fdel`)
  if (action === 'du_fdel') {
    const fid = Number(arg || session.browseFolderId || 0);
    if (fid > 0 && ctx.db && typeof ctx.db.prepare === 'function') {
      const fView = await getFolderView(ctx.db, fid).catch(() => null);
      if (fView?.folder) {
        if ((fView.children?.length || 0) === 0 && (fView.files?.length || 0) === 0) {
          const parentId = fView.folder.parent_id ? Number(fView.folder.parent_id) : 0;
          await run(ctx.db, 'DELETE FROM folders WHERE id = ?1', [fid]).catch(() => null);
          session.browseFolderId = parentId;
        }
      }
    }
    session.step = 'pick_folder';
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Post-execution immediate save into folder (`du_save`)
  if (action === 'du_save') {
    session.destBot = true;
    await integrateSessionFileIntoFolder(
      ctx.db,
      session,
      Number(arg),
      ctx.from?.id,
      bot,
      env,
    );
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Admin Folder Renaming Prompt (`du_frename` / `du_renf`)
  if (action === 'du_frename' || action === 'du_renf') {
    const fid = Number(arg || session.browseFolderId || 0);
    session.pendingRenameFolderId = fid;
    session.step = 'admin_frename';
    await saveUploadSession(ctx.db, session);
    await setChatTextWaiter(ctx.db, session.userChatId, {
      sessionId: session.id,
      mode: 'admin_frename',
      folderId: fid,
    });
    if (ctx.userData) {
      ctx.userData.du_wizard_session = session.id;
      ctx.userData.du_wizard_mode = 'admin_frename';
      ctx.userData.du_rename_folder_id = fid;
    }
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Admin Folder Creation Prompt (`du_fnew` / `du_newf` / `du_newnode`)
  if (action === 'du_fnew' || action === 'du_newf' || action === 'du_newnode') {
    const parentId = Number(arg || 0);
    session.pendingFolderParentId = parentId;
    session.step = 'admin_fnew';
    await saveUploadSession(ctx.db, session);
    await setChatTextWaiter(ctx.db, session.userChatId, {
      sessionId: session.id,
      mode: 'admin_fnew',
      parentId,
    });
    if (ctx.userData) {
      ctx.userData.du_wizard_session = session.id;
      ctx.userData.du_wizard_mode = 'admin_fnew';
      ctx.userData.du_new_folder_parent = parentId;
    }
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Admin Folder Node Type Selection (`du_ftype:${sessionId}:${parentId}:${nodeType}`)
  if (action === 'du_ftype') {
    const pid = Number(arg || 0);
    const nodeType = parts[3] || 'general';
    const folderName = session.pendingFolderNewName || 'قسم جديد';
    let createdId = null;
    if (ctx.db && typeof ctx.db.prepare === 'function') {
      const accepts = pid > 0 && nodeType !== 'general' ? 1 : 0;
      createdId = await addFolder(ctx.db, pid || null, folderName, nodeType, accepts);
    }
    session.browseFolderId = createdId || pid || 0;
    session.step = 'pick_folder';
    session.pendingFolderNewName = null;
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Legacy direct save support
  if (action === 'du_direct_save' || action === 'du_branch' || action === 'du_dtype') {
    session.step = 'confirm_send';
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 5 -> Final Send & Execute (`du_submit`)
  if (action === 'du_submit') {
    await ctx.answer();
    await executeWizardUpload(ctx.db, session, ctx.from?.id, bot, env);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Live Progress Refresh (`du_refresh`)
  if (action === 'du_refresh') {
    if (session.driveStatus === 'uploading' && Number(session.uploadedBytes || 0) === 0) {
      await ensureLargeJobQueuedInD1(ctx.db, session);
    }
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  await ctx.answer();
  return null;
}

/**
 * Check if a chat or user currently has an active Dual-Upload Wizard text prompt (`edit_name` or `new_folder_name`).
 */
export async function hasActiveDualUploadTextPrompt(db, chatId, userData) {
  if (userData?.du_wizard_session || userData?.du_new_folder_session) return true;
  const waiter = await getChatTextWaiter(db, chatId);
  return Boolean(waiter?.sessionId);
}

/**
 * Handle text input for both:
 *   1. Editing the resource/file Name (`mode === 'edit_name'`)
 *   2. Entering a new Subject/Section name (`mode === 'new_folder_name'`), which then transitions to
 *      choosing `عملي أو نظري` (`choose_branch`) -> `نوع الداتا` (`choose_datatype`) -> `الإرسال` (`confirm_send`).
 */
export async function handleDualUploadNewFolderText(ctx, text, bot, _env) {
  const waiter = await getChatTextWaiter(ctx.db, ctx.chatId);
  const sessionId =
    ctx.userData?.du_wizard_session ||
    ctx.userData?.du_new_folder_session ||
    waiter?.sessionId ||
    null;
  const mode =
    ctx.userData?.du_wizard_mode ||
    waiter?.mode ||
    (ctx.userData?.du_new_folder_session ? 'new_folder_name' : 'edit_name');
  const parentId = Number(
    ctx.userData?.du_new_folder_parent ?? waiter?.parentId ?? 0,
  );
  const targetFolderId = Number(
    ctx.userData?.du_rename_folder_id ?? waiter?.folderId ?? 0,
  );


  if (ctx.userData) {
    ctx.userData.du_new_folder_session = null;
    ctx.userData.du_new_folder_parent = null;
    ctx.userData.du_new_folder_node_type = null;
    ctx.userData.du_rename_folder_id = null;
    ctx.userData.du_wizard_session = null;
    ctx.userData.du_wizard_mode = null;
  }
  await setChatTextWaiter(ctx.db, ctx.chatId, null);

  const cleanText = String(text || '').trim();
  if (!cleanText || !sessionId) {
    return ctx.reply('⚠️ يرجى إرسال اسم صالح.');
  }

  const session = await getUploadSession(ctx.db, sessionId);
  if (!session) {
    return ctx.reply('⚠️ انتهت صلاحية جلسة الرفع.');
  }

  // If user typed in a channel, delete their temporary text reply to keep the channel clean
  if (session.isDirectChannelPost && ctx.message?.message_id && bot?.deleteMessage) {
    await bot.deleteMessage(ctx.chatId, ctx.message.message_id).catch(() => {});
  }

  // 1. Rename Folder / Section (`mode === 'admin_frename'` or `mode === 'rename_folder'`)
  if (
    mode === 'admin_frename' ||
    mode === 'rename_folder' ||
    session.step === 'admin_frename' ||
    session.step === 'rename_folder'
  ) {
    const fid = targetFolderId || Number(session.pendingRenameFolderId || session.browseFolderId || 0);
    if (fid > 0 && ctx.db && typeof ctx.db.prepare === 'function') {
      await updateFolderName(ctx.db, fid, cleanText);
      if (session.selectedFolderId === fid) {
        session.selectedFolderName = cleanText;
      }
    }
    session.pendingRenameFolderId = null;
    session.browseFolderId = fid;
    session.step = 'pick_folder';
    await saveUploadSession(ctx.db, session);

    const view = await renderDualUploadSessionMessage(ctx.db, session);
    let edited = null;
    if (session.userChatId && session.statusMessageId && bot?.editMessageText) {
      edited = await bot
        .editMessageText(view.text, {
          chat_id: session.userChatId,
          message_id: session.statusMessageId,
          parse_mode: 'HTML',
          reply_markup: view.reply_markup,
        })
        .catch(() => null);
    }
    const sent = await ctx.reply(view.text, {
      parse_mode: 'HTML',
      reply_markup: view.reply_markup,
    });
    if (sent?.message_id) {
      session.statusMessageId = sent.message_id;
      await saveUploadSession(ctx.db, session);
    }
    return { ok: true, text: view.text, reply_markup: view.reply_markup, ...view, sent, edited };
  }

  // 2. Edit Resource Name (`mode === 'edit_name'`)
  if (mode === 'edit_name' || session.step === 'edit_name') {
    session.title = cleanText;
    // Preserve extension on filename if applicable
    const extMatch = /(\.[A-Za-z0-9]{1,6})$/.exec(String(session.filename || ''));
    const ext = extMatch ? extMatch[1] : '';
    session.filename = ext && !cleanText.endsWith(ext) ? `${cleanText}${ext}` : cleanText;
    session.step = 'pick_folder';
    await saveUploadSession(ctx.db, session);

    const view = await renderDualUploadSessionMessage(ctx.db, session);
    let edited = null;
    if (session.userChatId && session.statusMessageId && bot?.editMessageText) {
      edited = await bot
        .editMessageText(view.text, {
          chat_id: session.userChatId,
          message_id: session.statusMessageId,
          parse_mode: 'HTML',
          reply_markup: view.reply_markup,
        })
        .catch(() => null);
    }
    const sent = await ctx.reply(view.text, {
      parse_mode: 'HTML',
      reply_markup: view.reply_markup,
    });
    if (sent?.message_id) {
      session.statusMessageId = sent.message_id;
      await saveUploadSession(ctx.db, session);
    }
    return { ok: true, text: view.text, reply_markup: view.reply_markup, ...view, sent, edited };
  }

  // 3. Admin Folder Creation: user entered the name for the new folder/section
  session.pendingFolderNewName = cleanText;
  session.pendingFolderParentId = parentId || session.pendingFolderParentId || 0;
  session.step = 'admin_ftype';
  await saveUploadSession(ctx.db, session);

  const view = await renderDualUploadSessionMessage(ctx.db, session);
  let edited = null;
  if (session.userChatId && session.statusMessageId && bot?.editMessageText) {
    edited = await bot
      .editMessageText(view.text, {
        chat_id: session.userChatId,
        message_id: session.statusMessageId,
        parse_mode: 'HTML',
        reply_markup: view.reply_markup,
      })
      .catch(() => null);
  }

  const sent = await ctx.reply(view.text, {
    parse_mode: 'HTML',
    reply_markup: view.reply_markup,
  });
  if (sent?.message_id) {
    session.statusMessageId = sent.message_id;
    await saveUploadSession(ctx.db, session);
  }
  return { ok: true, text: view.text, reply_markup: view.reply_markup, ...view, sent, edited };
}

/**
 * Apply a live progress or completion update from the MTProto streamer to D1 and update
 * the user's Telegram message while keeping their active classification buttons intact!
 */
export async function applySessionProgressUpdate(db, bot, env, payload = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  if (!sessionId) return { ok: false, error: 'missing_session_id' };

  const session = await getUploadSession(db, sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  if (session.cancelled || session.driveStatus === 'cancelled') {
    return { ok: true, cancelled: true };
  }

  if (payload.uploadedBytes !== undefined) {
    session.uploadedBytes = Number(payload.uploadedBytes);
  }
  if (payload.totalBytes !== undefined && Number(payload.totalBytes) > 0) {
    session.fileSize = Number(payload.totalBytes);
  }
  if (payload.progressPct !== undefined) {
    session.progressPct = Number(payload.progressPct);
  }
  if (payload.driveStatus) {
    const normStatus = String(payload.driveStatus);
    session.driveStatus = normStatus === 'completed' ? 'done' : normStatus;
  }
  if (payload.driveFileId) {
    session.driveFileId = String(payload.driveFileId);
  }
  if (payload.driveWebViewLink || payload.driveLink) {
    session.driveWebViewLink = String(payload.driveWebViewLink || payload.driveLink);
  }
  if (payload.driveError || payload.error) {
    session.driveError = String(payload.driveError || payload.error);
  }

  await saveUploadSession(db, session);

  // Clean up completed or failed job from `pending_large_drive_jobs`, or refresh `dispatchedAt` while actively streaming
  if (db && typeof db.prepare === 'function') {
    try {
      const row = await get(
        db,
        "SELECT value FROM settings WHERE key = 'pending_large_drive_jobs' LIMIT 1",
      ).catch(() => null);
      const raw = row?.[0] ?? row?.value ?? null;
      if (raw) {
        const jobs = JSON.parse(String(raw));
        if (Array.isArray(jobs)) {
          let nextJobs;
          if (session.driveStatus === 'done' || session.driveStatus === 'failed' || session.driveStatus === 'cancelled') {
            nextJobs = jobs.filter((j) => j && j.sessionId !== session.id);
          } else {
            nextJobs = jobs.map((j) =>
              j && j.sessionId === session.id ? { ...j, dispatchedAt: Date.now() } : j,
            );
          }
          await run(
            db,
            "INSERT INTO settings(key,value) VALUES('pending_large_drive_jobs',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [JSON.stringify(nextJobs)],
          ).catch(() => {});
        }
      }
    } catch {
      // Ignore queue update error
    }
  }

  if (session.userChatId && session.statusMessageId && bot?.editMessageText) {
    const view = await renderDualUploadSessionMessage(db, session);
    await bot
      .editMessageText(view.text, {
        chat_id: session.userChatId,
        message_id: session.statusMessageId,
        parse_mode: 'HTML',
        reply_markup: view.reply_markup,
      })
      .catch(() => {});
  }

  return { ok: true, cancelled: false, session };
}
