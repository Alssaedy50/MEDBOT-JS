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
import { addContent, addFolder, deleteFile, updateFolderName } from '../db/d1/registry.js';
import { createResourceNewsForContent, publishNews } from '../db/d1/news.js';
import {
  buildStructuredArchiveCaption,
  getFolderHierarchyChain,
} from '../telegram/workerAdmin.js';
import {
  deleteDriveFile,
  inferMediaFilenameAndMime,
  isDriveConfigured,
  markChannelPostPublished,
  recordDualUploadEvent,
  resolveDriveAccessToken,
  unmarkChannelPostPublished,
  uploadBytesToGoogleDrive,
  uploadTelegramFileToGoogleDrive,
} from './googleDrive.js';

const memorySessions = new Map();
const memoryTextWaiters = new Map();

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const CORE_BOT_DATA_TYPES = {
  books: { label: '📚 كتب', plain: 'كتب', dbFileType: 'doc' },
  video: { label: '🎥 فيديو', plain: 'فيديو', dbFileType: 'video' },
  audio: { label: '🎧 صوتيات', plain: 'صوتيات', dbFileType: 'audio' },
  summaries: { label: '📑 ملخصات', plain: 'ملخصات', dbFileType: 'doc' },
  mcq: { label: '📝 MCQ', plain: 'MCQ', dbFileType: 'doc' },
  general: { label: '📁 عام', plain: 'عام', dbFileType: 'doc' },
};

export const CORE_BOT_BRANCHES = {
  theory: { label: '📖 نظري', plain: 'نظري' },
  practical: { label: '🔬 عملي', plain: 'عملي' },
  general: { label: '📁 عام', plain: 'عام' },
};

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

export const NODE_TYPE_ADMIN_TITLES = {
  level: { label: '🎓 مستوى جديد', promptTitle: 'المستوى الدراسي', example: 'المستوى الأول أو الثاني' },
  block: { label: '🧩 بلوك جديد', promptTitle: 'البلوك الأكاديمي', example: 'بلوك القلب والأوعية الدموية CVS' },
  subject: { label: '📚 مادة جديدة', promptTitle: 'المادة الدراسية', example: 'مادة علم وظائف الأعضاء Physiology' },
  section: { label: '📑 قسم فرعي جديد', promptTitle: 'القسم الفرعي', example: 'محاضرات الدكتور أو قسم العملي' },
};

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
    return '🌟 الكل (البوت + قناة الأرشيف + Google Drive)';
  }
  const parts = [];
  if (session.destBot) parts.push('🤖 داتا البوت');
  if (session.destChannel) parts.push('🗄 قناة الأرشيف');
  if (session.destDrive) parts.push('☁️ Google Drive');
  return parts.length ? parts.join(' + ') : 'لم يتم التحديد بعد';
}

/**
 * Render the interactive wizard message or execution status message for any `session.step`:
 *   - `choose_dest`: Step 1 — Select upload destination(s) (`Google Drive`, `قناة الأرشيف`, `البوت`, `الكل`).
 *   - `edit_name`: Step 2 — Confirm or edit the resource Name (`الاسم`).
 *   - `pick_folder`: Step 3 — Choose `المستوى ⬅️ البلوك ⬅️ المادة ⬅️ القسم` or create new section/subject.
 *   - `new_folder_name`: Step 4A — Waiting for new subject/section name text.
 *   - `choose_branch`: Step 4B — Choose `📖 نظري` or `🔬 عملي` (or `📁 عام`).
 *   - `choose_datatype`: Step 4C — Choose data type (`📚 كتب`, `🎥 فيديو`, `🎧 صوتيات`, `📑 ملخصات`, `📝 MCQ`, `📁 عام`).
 *   - `confirm_send`: Step 5 — Final review + `🚀 إرسال وتنفيذ الرفع الآن`.
 *   - `executing` (or default): Live progress bar (`▓▓▓▓░░░░░░ %`) + post-upload management.
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
      '🧭 <b>مركز الرفع الذكي — تحديد وجهات الرفع أولاً</b>',
      '━━━━━━━━━━━━━━━━━━',
      `📄 <b>الاسم المكتشف:</b> ${esc(session.title || session.filename)}`,
      metaLine,
      '',
      '1️⃣ <b>اختر وجهة الرفع المطلوبة لهذه الداتا:</b>',
      '• <b>☁️ Google Drive:</b> رفع مباشر لحسابك مع شريط تقدم حي.',
      '• <b>🗄 قناة الأرشيف:</b> نشر وأرشفة في قناة البوت مع منع التكرار.',
      '• <b>🤖 البوت:</b> تصنيف ودمج في مكتبة الطلاب (المستوى ⬅️ المادة ⬅️ القسم).',
      '• <b>🌟 الكل:</b> فتح تفاصيل الرفع بدءاً من الاسم ثم التصنيف الأكاديمي والرفع للوجهات الثلاث معاً.',
    ].join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌟 الكل (البوت + قناة الأرشيف + Google Drive)', callback_data: `du_dest:${session.id}:all` }],
          [
            { text: '☁️ جوجل درايف', callback_data: `du_dest:${session.id}:drive` },
            { text: '🗄 قناة الأرشيف', callback_data: `du_dest:${session.id}:channel` },
          ],
          [{ text: '🤖 البوت (مكتبة الطلاب)', callback_data: `du_dest:${session.id}:bot` }],
          [{ text: '🛑 إلغاء العملية', callback_data: `du_cancel:${session.id}` }],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 2: Upload Details Starting From Name (`edit_name`)
  // ---------------------------------------------------------------------------
  if (step === 'edit_name') {
    const suggestionLine =
      session.suggestedFolderPath
        ? `\n✨ <b>المسار المقترح تلقائياً:</b> <code>${esc(session.suggestedFolderPath)}</code>`
        : '';

    const text = [
      '📝 <b>تفاصيل الرفع — الخطوة 1: تحديد الاسم</b>',
      '━━━━━━━━━━━━━━━━━━',
      `🎯 <b>الوجهات المختارة:</b> ${esc(describeDestinations(session))}`,
      `🏷 <b>الاسم الحالي:</b> <code>${esc(session.title || session.filename)}</code>`,
      metaLine + suggestionLine,
      '',
      '💡 <b>لتغيير الاسم:</b> أرسل الاسم الجديد مباشرةً في رسالة نصية الآن، أو اضغط <b>«✅ اعتماد الاسم الحالي والمتابعة»</b> للانتقال إلى اختيار المستوى والمادة والقسم:',
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
  // STEP 3: Academic Destination Selection & Admin Folder Management (`pick_folder`)
  // ---------------------------------------------------------------------------
  if (step === 'pick_folder') {
    const browseId = Number(session.browseFolderId || 0);
    let currentFolder = null;
    let currentPathStr = 'المستويات والأقسام الرئيسية (الجذر)';
    let depth = 0;
    let childFolders = [];

    if (db && typeof db.prepare === 'function') {
      try {
        if (browseId > 0) {
          const chain = await getFolderHierarchyChain(db, browseId);
          if (chain.length > 0) {
            currentFolder = chain[chain.length - 1];
            currentPathStr = chain.map((c) => c.name).join(' ⬅️ ');
            depth = chain.length;
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
            nodeType: String(r[2] ?? r.node_type ?? 'level'),
          }));
        }
      } catch {
        childFolders = [];
      }
    }

    const currType = currentFolder ? String(currentFolder.node_type || '').toLowerCase() : '';
    const isLevel = currType === 'level' || depth === 1;
    const isBlock = currType === 'block' || depth === 2;

    const text = [
      '🛠 <b>نظام الإنشاء والتعديل الخاص بالإدارة — تحديد وجهة الداتا</b>',
      '━━━━━━━━━━━━━━━━━━',
      `🎯 <b>الوجهات:</b> ${esc(describeDestinations(session))}`,
      `🏷 <b>الاسم المعتمد:</b> <code>${esc(session.title || session.filename)}</code>`,
      metaLine,
      '',
      `🧭 <b>المسار الأكاديمي الحالي:</b>\n<code>${esc(currentPathStr)}</code>`,
      '',
      'اختر وجهة الداتا من التسلسل أدناه، أو أنشئ (مستوى / بلوك / مادة / قسم)، أو عدّل الاسم:',
    ].join('\n');

    const rows = [];

    // 1. Smart suggestion at root
    if (session.suggestedFolderId && session.suggestedFolderPath && browseId === 0) {
      const shortPath = String(session.suggestedFolderPath).slice(-38);
      rows.push([
        {
          text: `✨ اختيار المسار المقترح: ${shortPath}`,
          callback_data: `du_select_f:${session.id}:${session.suggestedFolderId}`,
        },
      ]);
    }

    // 2. If inside a folder (`browseId > 0`), allow selecting & approving ANY file type into it directly
    if (browseId > 0 && currentFolder) {
      rows.push([
        {
          text: `✅ اعتماد وحفظ الملف هنا في («${String(currentFolder.name).slice(0, 22)}»)`,
          callback_data: `du_select_f:${session.id}:${browseId}`,
        },
      ]);
      rows.push([
        {
          text: `✏️ تعديل اسم هذا القسم / المادة`,
          callback_data: `du_renf:${session.id}:${browseId}`,
        },
      ]);
    }

    // 3. Child folders in 2-column layout
    for (let i = 0; i < childFolders.length; i += 2) {
      const pair = childFolders.slice(i, i + 2).map((cf) => ({
        text: `${nodeIcon(cf.nodeType)} ${String(cf.name).slice(0, 22)}`,
        callback_data: `du_nav:${session.id}:${cf.id}`,
      }));
      rows.push(pair);
    }

    // 4. Admin Creation buttons based on current depth & hierarchy
    if (browseId === 0) {
      // Root level: create level or root subject
      rows.push([
        { text: '➕ إنشاء مستوى جديد', callback_data: `du_newnode:${session.id}:0:level` },
        { text: '➕ إنشاء مادة رئيسية', callback_data: `du_newnode:${session.id}:0:subject` },
      ]);
    } else if (isLevel) {
      // Inside Level: create Block or Subject or Section
      rows.push([
        { text: '➕ إنشاء بلوك جديد', callback_data: `du_newnode:${session.id}:${browseId}:block` },
        { text: '➕ إنشاء مادة جديدة', callback_data: `du_newnode:${session.id}:${browseId}:subject` },
      ]);
      rows.push([
        { text: '➕ إنشاء قسم فرعي', callback_data: `du_newnode:${session.id}:${browseId}:section` },
      ]);
    } else if (isBlock) {
      // Inside Block: create Subject or Section
      rows.push([
        { text: '➕ إنشاء مادة جديدة', callback_data: `du_newnode:${session.id}:${browseId}:subject` },
        { text: '➕ إنشاء قسم فرعي', callback_data: `du_newnode:${session.id}:${browseId}:section` },
      ]);
    } else {
      // Inside Subject or Section: create Section
      rows.push([
        { text: '➕ إنشاء قسم فرعي جديد', callback_data: `du_newnode:${session.id}:${browseId}:section` },
      ]);
    }

    // 5. Navigation Row
    const navRow = [];
    if (browseId > 0) {
      const parentId = currentFolder?.parent_id ? Number(currentFolder.parent_id) : 0;
      navRow.push({
        text: '⬅️ رجوع للمستوى الأعلى',
        callback_data: `du_nav:${session.id}:${parentId}`,
      });
    }
    navRow.push({ text: '✏️ تعديل اسم الملف', callback_data: `du_name_prompt:${session.id}` });
    rows.push(navRow);

    rows.push([
      { text: '🛑 إلغاء العملية', callback_data: `du_cancel:${session.id}` },
    ]);

    return {
      text,
      reply_markup: { inline_keyboard: rows },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 3B: Admin Folder Renaming (`rename_folder`)
  // ---------------------------------------------------------------------------
  if (step === 'rename_folder') {
    const fid = Number(session.pendingRenameFolderId || session.browseFolderId || 0);
    let currentFolderName = 'القسم الحالي';
    let fullPathStr = 'المسار الأكاديمي';
    if (fid > 0 && db && typeof db.prepare === 'function') {
      const chain = await getFolderHierarchyChain(db, fid).catch(() => []);
      if (chain.length > 0) {
        currentFolderName = chain[chain.length - 1].name;
        fullPathStr = chain.map((c) => c.name).join(' ⬅️ ');
      }
    }
    const text = [
      '✏️ <b>نظام إدارة الأقسام — تعديل اسم القسم / المادة</b>',
      '━━━━━━━━━━━━━━━━━━',
      `📂 <b>الاسم الحالي:</b> <code>${esc(currentFolderName)}</code>`,
      `📍 <b>المسار:</b> <code>${esc(fullPathStr)}</code>`,
      '',
      '✍️ <b>أرسل الآن الاسم الجديد في رسالة نصية لتحديثه فوراً في البوت:</b>',
    ].join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ إلغاء والرجوع للأقسام', callback_data: `du_nav:${session.id}:${fid}` }],
          [{ text: '🛑 إلغاء العملية', callback_data: `du_cancel:${session.id}` }],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 4A: Waiting for New Level/Block/Subject/Section Name (`new_folder_name`)
  // ---------------------------------------------------------------------------
  if (step === 'new_folder_name') {
    const parentId = Number(session.pendingFolderParentId || 0);
    const nodeType = String(session.pendingFolderNodeType || 'section');
    const nodeInfo = NODE_TYPE_ADMIN_TITLES[nodeType] || NODE_TYPE_ADMIN_TITLES.section;

    let parentPath = 'المستوى الرئيسي (الجذر)';
    if (parentId > 0 && db && typeof db.prepare === 'function') {
      const chain = await getFolderHierarchyChain(db, parentId).catch(() => []);
      if (chain.length > 0) {
        parentPath = chain.map((c) => c.name).join(' ⬅️ ');
      }
    }
    const text = [
      `➕ <b>نظام الإدارة — إنشاء ${esc(nodeInfo.promptTitle)} جديد</b>`,
      '━━━━━━━━━━━━━━━━━━',
      `📍 <b>الموقع الأب:</b> <code>${esc(parentPath)}</code>`,
      `🏷 <b>ملف الرفع:</b> <code>${esc(session.title || session.filename)}</code>`,
      metaLine,
      '',
      `✍️ <b>أرسل الآن اسم ${esc(nodeInfo.promptTitle)} في رسالة نصية:</b>`,
      `<i>(مثال: ${esc(nodeInfo.example)})</i>`,
    ].join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ رجوع لاختيار الأقسام', callback_data: `du_nav:${session.id}:${parentId}` }],
          [{ text: '🛑 إلغاء العملية', callback_data: `du_cancel:${session.id}` }],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 4B: Choose Practical vs Theoretical (`choose_branch`)
  // ---------------------------------------------------------------------------
  if (step === 'choose_branch') {
    const targetName = session.pendingNewFolderName || session.selectedFolderName || 'القسم المختار';
    const text = [
      '🔬 <b>تفاصيل القسم — أولاً: هل هو نظري أم عملي؟</b>',
      '━━━━━━━━━━━━━━━━━━',
      `📂 <b>المادة / القسم:</b> <code>${esc(targetName)}</code>`,
      `🏷 <b>الاسم:</b> <code>${esc(session.title || session.filename)}</code>`,
      '',
      '1️⃣ <b>اختر التصنيف الأكاديمي (نظري أو عملي):</b>',
    ].join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📖 نظري (Theory)', callback_data: `du_branch:${session.id}:theory` },
            { text: '🔬 عملي (Practical)', callback_data: `du_branch:${session.id}:practical` },
          ],
          [{ text: '📁 عام / شامل (بدون فرع)', callback_data: `du_branch:${session.id}:general` }],
          [{ text: '⚡️ اعتماد وحفظ في هذه المادة مباشرة (بدون فروع)', callback_data: `du_direct_save:${session.id}` }],
          [
            {
              text: '⬅️ رجوع للأقسام',
              callback_data: `du_nav:${session.id}:${Number(session.pendingFolderParentId || session.browseFolderId || 0)}`,
            },
            { text: '🛑 إلغاء', callback_data: `du_cancel:${session.id}` },
          ],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 4C: Choose Data Type matching Core Bot (`choose_datatype`)
  // ---------------------------------------------------------------------------
  if (step === 'choose_datatype') {
    const targetName = session.pendingNewFolderName || session.selectedFolderName || 'القسم المختار';
    const branchInfo = CORE_BOT_BRANCHES[session.selectedBranch || 'general'] || CORE_BOT_BRANCHES.general;

    const text = [
      '📚 <b>تفاصيل القسم — ثانياً: اختيار نوع الداتا</b>',
      '━━━━━━━━━━━━━━━━━━',
      `📂 <b>المادة / القسم:</b> <code>${esc(targetName)}</code>`,
      `🔬 <b>الفرع المختار:</b> ${esc(branchInfo.label)}`,
      `🏷 <b>الاسم:</b> <code>${esc(session.title || session.filename)}</code>`,
      '',
      '2️⃣ <b>اختر نوع الداتا (مطابق لنظام البوت الأساسي):</b>',
    ].join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📚 كتب', callback_data: `du_dtype:${session.id}:books` },
            { text: '🎥 فيديو', callback_data: `du_dtype:${session.id}:video` },
          ],
          [
            { text: '🎧 صوتيات', callback_data: `du_dtype:${session.id}:audio` },
            { text: '📑 ملخصات', callback_data: `du_dtype:${session.id}:summaries` },
          ],
          [
            { text: '📝 MCQ', callback_data: `du_dtype:${session.id}:mcq` },
            { text: '📁 عام', callback_data: `du_dtype:${session.id}:general` },
          ],
          [
            { text: '⬅️ رجوع لاختيار (نظري / عملي)', callback_data: `du_back_branch:${session.id}` },
            { text: '🛑 إلغاء', callback_data: `du_cancel:${session.id}` },
          ],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 5: Final Review & Send (`confirm_send`)
  // ---------------------------------------------------------------------------
  if (step === 'confirm_send') {
    const branchInfo = CORE_BOT_BRANCHES[session.selectedBranch || 'general'] || CORE_BOT_BRANCHES.general;
    const dtypeInfo =
      CORE_BOT_DATA_TYPES[session.selectedNodeType || session.defaultNodeType || 'general'] ||
      CORE_BOT_DATA_TYPES.general;

    const text = [
      '🚀 <b>تأكيد تفاصيل الرفع الشامل — جاهز للإرسال</b>',
      '━━━━━━━━━━━━━━━━━━',
      `🎯 <b>الوجهات المختارة:</b> ${esc(describeDestinations(session))}`,
      `🏷 <b>الاسم:</b> <code>${esc(session.title || session.filename)}</code>`,
      metaLine,
      `📍 <b>المسار الأكاديمي:</b> <code>${esc(session.selectedFolderPath || 'تم التحديد')}</code>`,
      `🔬 <b>التصنيف (نظري/عملي):</b> ${esc(branchInfo.label)}`,
      `📚 <b>نوع الداتا في البوت:</b> ${esc(dtypeInfo.label)}`,
      '',
      'اضغط <b>«🚀 إرسال وتنفيذ الرفع الآن»</b> لدفع المورد فوراً إلى الوجهات المختارة:',
    ].join('\n');

    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 إرسال وتنفيذ الرفع الآن', callback_data: `du_submit:${session.id}` }],
          [
            { text: '✏️ تعديل الاسم', callback_data: `du_name_prompt:${session.id}` },
            { text: '🗂 تغيير القسم', callback_data: `du_pick:${session.id}` },
          ],
          [
            { text: '🔬 تغيير (نظري/عملي ونوع الداتا)', callback_data: `du_edit_meta:${session.id}` },
            { text: '🛑 إلغاء', callback_data: `du_cancel:${session.id}` },
          ],
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 6 / DEFAULT: Executing & Post-Upload Live Status (`executing`)
  // ---------------------------------------------------------------------------
  const showChannel = session.destChannel !== false;
  const showDrive = session.destDrive !== false;
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

  // 2. Google Drive status & live progress bar
  let driveLine = '';
  if (!showDrive) {
    driveLine = '⚪️ لم يتم اختيار Google Drive في هذه العملية';
  } else if (session.driveStatus === 'uploading') {
    const pct = Number(session.progressPct || 0);
    const doneMb = (Number(session.uploadedBytes || 0) / (1024 * 1024)).toFixed(1);
    const totalMb = session.fileSize
      ? (Number(session.fileSize) / (1024 * 1024)).toFixed(1)
      : '?';
    const bar = renderProgressBar(pct);
    driveLine =
      `⏳ <b>جاري الرفع المباشر إلى Google Drive...</b>\n` +
      `📊 <b>التقدم:</b> <code>${bar}</code> (<code>${doneMb} / ${totalMb} MB</code>)`;
  } else if ((session.driveStatus === 'done' || session.driveStatus === 'completed') && session.driveWebViewLink) {
    driveLine = `✅ تم الرفع الكامل إلى Google Drive (<a href="${esc(session.driveWebViewLink)}">فتح الملف في Drive</a>)`;
  } else if (session.driveStatus === 'failed') {
    driveLine = `⚠️ تعذر الرفع إلى Google Drive: <code>${esc(String(session.driveError || '').slice(0, 160))}</code>`;
  } else {
    driveLine = '⚪️ حساب Google Drive غير مربوط بعد';
  }

  // 3. Bot Database integration status (Level -> Block -> Subject -> Section)
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
      'اختر <b>المستوى ⬅️ البلوك ⬅️ المادة ⬅️ القسم</b> من الأزرار أدناه لدفع الملف فوراً إلى داتا البوت وتحديث منشور القناة.';
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
          nodeType: String(r[2] ?? r.node_type ?? 'level'),
        }));
      }
    } catch {
      childFolders = [];
    }
  }

  const headerTitle =
    session.driveStatus === 'uploading'
      ? '☁️ <b>جاري الرفع المباشر + تصنيف المورد في البوت</b>'
      : '☁️ <b>تقرير الرفع المزدوج والتصنيف الأكاديمي (البوت + القناة + Drive)</b>';

  const text = [
    headerTitle,
    '━━━━━━━━━━━━━━━━━━',
    `📄 <b>الاسم:</b> ${esc(session.title || session.filename)}`,
    metaLine,
    '',
    `1️⃣ <b>قناة الأرشيف:</b>\n${channelLine}`,
    '',
    `2️⃣ <b>حساب Google Drive:</b>\n${driveLine}`,
    '',
    `3️⃣ <b>داتا البوت (مكتبة الطلاب):</b>\n${botDataLine}${browseHeader}`,
  ].join('\n');

  const rows = [];

  if ((session.driveStatus === 'done' || session.driveStatus === 'completed') && session.driveWebViewLink) {
    rows.push([{ text: '📂 فتح الملف في Google Drive', url: session.driveWebViewLink }]);
  }

  if (showInlineFolderBrowser) {
    if (session.suggestedFolderId && session.suggestedFolderPath && browseId === 0) {
      const shortPath = String(session.suggestedFolderPath).slice(-38);
      rows.push([
        {
          text: `✨ دمج سريع: ${shortPath}`,
          callback_data: `du_save:${session.id}:${session.suggestedFolderId}`,
        },
      ]);
    }
    if (browseId > 0 && currentFolder) {
      rows.push([
        {
          text: `✅ دمج وحفظ الملف في «${String(currentFolder.name).slice(0, 24)}»`,
          callback_data: `du_save:${session.id}:${browseId}`,
        },
      ]);
    }
    for (let i = 0; i < childFolders.length; i += 2) {
      const pair = childFolders.slice(i, i + 2).map((cf) => ({
        text: `${nodeIcon(cf.nodeType)} ${String(cf.name).slice(0, 22)}`,
        callback_data: `du_nav:${session.id}:${cf.id}`,
      }));
      rows.push(pair);
    }
    const navRow = [];
    if (browseId > 0) {
      const parentId = currentFolder?.parent_id ? Number(currentFolder.parent_id) : 0;
      navRow.push({
        text: '⬅️ رجوع للمستوى الأعلى',
        callback_data: `du_nav:${session.id}:${parentId}`,
      });
    }
    navRow.push({
      text: browseId > 0 ? '➕ إنشاء قسم فرعي هنا' : '➕ إنشاء مستوى / مادة جديدة',
      callback_data: `du_newf:${session.id}:${browseId}`,
    });
    rows.push(navRow);
  } else {
    rows.push([
      {
        text: session.selectedFolderId
          ? `🗂 تغيير القسم (${String(session.selectedFolderName || 'القسم الحالي').slice(0, 22)})`
          : '📚 دمج في داتا البوت أيضاً',
        callback_data: `du_pick:${session.id}`,
      },
    ]);
  }

  if (session.driveStatus === 'uploading') {
    rows.push([
      {
        text: `🔄 تحديث التقدم (${Math.round(Number(session.progressPct || 0))}%)`,
        callback_data: `du_refresh:${session.id}`,
      },
      {
        text: '🛑 إلغاء الرفع وحذف الملف',
        callback_data: `du_cancel:${session.id}`,
      },
    ]);
  } else {
    rows.push([
      {
        text: '🗑 حذف الملف (البوت + القناة + Drive)',
        callback_data: `du_cancel:${session.id}`,
      },
      {
        text: '🏠 الرئيسية',
        callback_data: 'home',
      },
    ]);
  }

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
    driveStatus: isDriveConfigured(env) ? 'pending' : 'unconfigured',
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
 * Create a new subject/section hierarchy in D1 `folders` based on:
 *   - `parentId`
 *   - `newFolderName` (subject or section name)
 *   - `branchKey` (`theory` -> `نظري`, `practical` -> `عملي`, `general` -> `عام`)
 *   - `dataTypeKey` (`books`, `video`, `audio`, `summaries`, `mcq`, `general`)
 */
async function createStructuredBotSection(db, parentId, newFolderName, branchKey, dataTypeKey) {
  const pid = Number(parentId || 0) || null;
  const cleanName = String(newFolderName || 'قسم جديد').trim();
  const branch = CORE_BOT_BRANCHES[branchKey] || CORE_BOT_BRANCHES.general;
  const dtype = CORE_BOT_DATA_TYPES[dataTypeKey] || CORE_BOT_DATA_TYPES.general;

  // Check if `cleanName` already includes نظري/عملي or if `branchKey === 'general'`
  const nameAlreadyHasBranch =
    branchKey === 'general' ||
    cleanName.includes('نظري') ||
    cleanName.includes('عملي');

  // Check parent depth so we know whether `cleanName` is a new Subject or a leaf Section
  let parentDepth = 0;
  if (pid && db && typeof db.prepare === 'function') {
    const chain = await getFolderHierarchyChain(db, pid).catch(() => []);
    parentDepth = chain.length;
  }

  if (nameAlreadyHasBranch) {
    const folderId = await addFolder(db, pid, cleanName, dataTypeKey || 'general', 1);
    return folderId;
  }

  // If creating inside a Level / Term / Block (depth <= 2), create Subject folder first, then Branch+DataType child folder!
  if (parentDepth <= 2) {
    const subjectFolderId = await addFolder(db, pid, cleanName, 'general', 1);
    const childName =
      dataTypeKey && dataTypeKey !== 'general'
        ? `${branch.plain} - ${dtype.plain}`
        : branch.plain;
    const sectionFolderId = await addFolder(
      db,
      subjectFolderId || pid,
      childName,
      dataTypeKey || 'general',
      1,
    );
    return sectionFolderId || subjectFolderId;
  }

  // Already inside a Subject (depth >= 3): create section with branch & data type
  const combinedName = `${cleanName} (${branch.plain})`;
  return addFolder(db, pid, combinedName, dataTypeKey || 'general', 1);
}

/**
 * Execute the actual upload to the user's selected destinations (`destBot`, `destChannel`, `destDrive`).
 */
export async function executeWizardUpload(db, session, userId, bot, env, fetchImpl = fetch) {
  session.step = 'executing';
  session.pickingFolder = false;
  if (userId) session.actorUserId = Number(userId);

  if (session.destDrive) {
    session.driveStatus = isDriveConfigured(env) ? 'uploading' : 'unconfigured';
  }

  await saveUploadSession(db, session);

  // Immediately push an 'uploading' status update to the interactive message so the user sees 0% right away
  if (session.userChatId && session.statusMessageId && typeof bot?.editMessageText === 'function') {
    const progressView = await renderDualUploadSessionMessage(db, session);
    await bot
      .editMessageText(progressView.text, {
        chat_id: session.userChatId,
        message_id: session.statusMessageId,
        parse_mode: 'HTML',
        reply_markup: progressView.reply_markup,
      })
      .catch(() => {});
  }

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
      // The message is ALREADY inside the Archive Channel! Update its caption in-place instead of reposting
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
      // Check deduplication first
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

  // ---------------------------------------------------------------------------
  // 3. Google Drive (`destDrive`)
  // ---------------------------------------------------------------------------
  if (session.destDrive) {
    if (!isDriveConfigured(env)) {
      session.driveStatus = 'unconfigured';
    } else if (session.fileType === 'link' || session.fileType === 'text') {
      const contentStr =
        session.fileType === 'link'
          ? `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(session.fileId)}"><title>${esc(session.title)}</title></head><body style="font-family:sans-serif;direction:rtl;padding:2rem;"><h2>🔗 ${esc(session.title)}</h2><p><a href="${esc(session.fileId)}">اضغط هنا لفتح الرابط: ${esc(session.fileId)}</a></p></body></html>`
          : `${session.title}\n====================\n\n${session.captionRaw || session.fileId}`;
      const bytes = new TextEncoder().encode(contentStr);
      const driveRes = await uploadBytesToGoogleDrive({
        filename: session.filename,
        mimeType: session.mimeType,
        bytes,
        description: session.selectedFolderPath
          ? `MEDBOT [${session.selectedFolderPath}] — ${session.title}`
          : `MEDBOT — ${session.title}`,
        env,
        fetchImpl,
      });
      if (driveRes.ok) {
        session.driveStatus = 'done';
        session.driveFileId = driveRes.id || null;
        session.driveWebViewLink = driveRes.webViewLink || null;
        session.progressPct = 100;
        session.uploadedBytes = bytes.byteLength;
      } else {
        session.driveStatus = 'failed';
        session.driveError = driveRes.error || null;
      }
    } else {
      const uploaded = await uploadTelegramFileToGoogleDrive({
        bot,
        fileId: session.fileId,
        filename: session.filename,
        mimeType: session.mimeType,
        fileSize: session.fileSize,
        title: session.title,
        description: session.selectedFolderPath
          ? `MEDBOT [${session.selectedFolderPath}] — ${session.title}`
          : session.captionRaw || session.title,
        message: session.sourceMessage || {
          message_id: session.sourceMessageId,
          chat: { id: session.sourceChatId },
          from: { id: session.actorUserId },
        },
        actorUserId: session.actorUserId,
        channelTarget: session.channelId,
        channelMessageId: session.channelMessageId,
        statusChatId: session.userChatId,
        statusMessageId: session.statusMessageId,
        sessionId: session.id,
        db,
        env,
        fetchImpl,
      });

      if (uploaded.sessionUri) {
        session.driveSessionUri = uploaded.sessionUri;
      }
      if (uploaded.jobPayload) {
        session.jobPayload = uploaded.jobPayload;
      }
      if (uploaded.asyncTransfer) {
        session.driveStatus = 'uploading';
      } else if (uploaded.ok) {
        session.driveStatus = 'done';
        session.driveFileId = uploaded.id || null;
        session.driveWebViewLink = uploaded.webViewLink || null;
        session.progressPct = 100;
        session.uploadedBytes = Number(session.fileSize || uploaded.size || 0);
      } else {
        session.driveStatus = 'failed';
        session.driveError = uploaded.error || null;
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
    driveOk: session.driveStatus === 'done',
    driveFileId: session.driveFileId || null,
    driveLink: session.driveWebViewLink || null,
  });

  return session;
}

/**
 * Integrate the session's file/link/text into `folderId` in the Bot Database (`content`),
 * update the Archive Channel post caption with the full academic hierarchy,
 * and update Google Drive file metadata.
 */
export async function integrateSessionFileIntoFolder(db, session, folderId, userId, bot, env) {
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

  if (session.driveFileId) {
    try {
      const token = await resolveDriveAccessToken(env);
      if (token) {
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(session.driveFileId)}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json; charset=UTF-8',
            },
            body: JSON.stringify({
              description: `MEDBOT [${fullPath}] — ${session.title || session.filename}`.slice(0, 1000),
            }),
          },
        ).catch(() => {});
      }
    } catch {
      // Non-fatal Drive metadata update
    }
  }

  await saveUploadSession(db, session);
  return session;
}

/**
 * Cancel an active upload or delete an already uploaded file across ALL 3 systems:
 *   1. Bot Database (`content`, `news`, `archive_sync`, `pending_large_drive_jobs`)
 *   2. Bot Archive Channel (`deleteMessage`)
 *   3. Google Drive (`deleteDriveFile` + abort resumable `sessionUri`)
 */
export async function cancelAndDeleteUploadSession(db, session, bot, env) {
  session.cancelled = true;
  session.driveStatus = 'cancelled';
  await saveUploadSession(db, session);
  await setChatTextWaiter(db, session.userChatId, null);

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
          const filtered = jobs.filter(
            (j) => j && j.sessionId !== session.id && j.sessionUri !== session.driveSessionUri,
          );
          await run(
            db,
            "INSERT INTO settings(key,value) VALUES('pending_large_drive_jobs',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [JSON.stringify(filtered)],
          ).catch(() => {});
        }
      }
    } catch {
      // Ignore queue cleanup error
    }

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

  let driveDeleted = false;
  try {
    if (session.driveSessionUri) {
      await fetch(session.driveSessionUri, { method: 'DELETE' }).catch(() => {});
      driveDeleted = true;
    }
    if (session.driveFileId) {
      const delRes = await deleteDriveFile({ fileId: session.driveFileId, env });
      if (delRes?.ok) driveDeleted = true;
    }
  } catch {
    // Non-fatal
  }

  return {
    ok: true,
    channelDeleted,
    driveDeleted,
    text: [
      '🗑 <b>تم إلغاء العملية وحذف الملف نهائياً</b>',
      '━━━━━━━━━━━━━━━━━━',
      `📄 <b>الملف:</b> ${esc(session.title || session.filename)}`,
      '',
      '✅ <b>تم إيقاف الرفع وإزالة الملف من الوجهات:</b>',
      `• <b>داتا البوت:</b> ${session.contentId ? `تم حذف المورد (#${session.contentId})` : 'تم إلغاء الدمج'}`,
      `• <b>قناة الأرشيف:</b> ${channelDeleted ? 'تم حذف المنشور من القناة' : 'تم إلغاء الأرشفة'}`,
      `• <b>حساب Google Drive:</b> ${driveDeleted ? 'تم إيقاف الجلسة وحذف الملف من Drive' : 'تم الإلغاء'}`,
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

  // Step 1 -> Destination chosen (`all`, `drive`, `channel`, `bot`)
  if (action === 'du_dest') {
    const choice = String(arg || 'all');
    session.destChoice = choice;
    session.destBot = choice === 'all' || choice === 'bot';
    session.destChannel = choice === 'all' || choice === 'channel';
    session.destDrive = choice === 'all' || choice === 'drive';

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

    // `drive` only or `channel` only -> execute immediately!
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
    if (session.step !== 'pick_folder') {
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
    if (session.step === 'confirm_send' || session.step === 'edit_name') {
      session.step = 'pick_folder';
    } else {
      session.pickingFolder = true;
      session.destBot = true;
    }
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

  // Admin Folder Renaming Prompt (`du_renf`)
  if (action === 'du_renf') {
    const fid = Number(arg || session.browseFolderId || 0);
    session.pendingRenameFolderId = fid;
    session.step = 'rename_folder';
    await saveUploadSession(ctx.db, session);
    await setChatTextWaiter(ctx.db, session.userChatId, {
      sessionId: session.id,
      mode: 'rename_folder',
      folderId: fid,
    });
    if (ctx.userData) {
      ctx.userData.du_wizard_session = session.id;
      ctx.userData.du_wizard_mode = 'rename_folder';
      ctx.userData.du_rename_folder_id = fid;
    }
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Admin Hierarchical Node Creation (`du_newnode:<sessionId>:<parentId>:<nodeType>`)
  if (action === 'du_newnode') {
    const parentId = Number(arg || 0);
    const nodeType = parts[3] || 'section';
    session.pendingFolderParentId = parentId;
    session.pendingFolderNodeType = nodeType;
    session.step = 'new_folder_name';
    await saveUploadSession(ctx.db, session);
    await setChatTextWaiter(ctx.db, session.userChatId, {
      sessionId: session.id,
      mode: 'new_folder_name',
      parentId,
      nodeType,
    });
    if (ctx.userData) {
      ctx.userData.du_new_folder_session = session.id;
      ctx.userData.du_new_folder_parent = parentId;
      ctx.userData.du_new_folder_node_type = nodeType;
      ctx.userData.du_wizard_session = session.id;
      ctx.userData.du_wizard_mode = 'new_folder_name';
    }
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 4A -> Legacy / Generic Create New Section or Subject (`du_newf`)
  if (action === 'du_newf') {
    const parentId = Number(arg || 0);
    session.pendingFolderParentId = parentId;
    session.pendingFolderNodeType = parentId === 0 ? 'level' : 'section';
    session.step = 'new_folder_name';
    await saveUploadSession(ctx.db, session);
    await setChatTextWaiter(ctx.db, session.userChatId, {
      sessionId: session.id,
      mode: 'new_folder_name',
      parentId,
      nodeType: session.pendingFolderNodeType,
    });
    if (ctx.userData) {
      ctx.userData.du_new_folder_session = session.id;
      ctx.userData.du_new_folder_parent = parentId;
      ctx.userData.du_new_folder_node_type = session.pendingFolderNodeType;
      ctx.userData.du_wizard_session = session.id;
      ctx.userData.du_wizard_mode = 'new_folder_name';
    }
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Direct Save into newly named Subject/Folder without branch subdivision (`du_direct_save`)
  if (action === 'du_direct_save') {
    if (session.pendingNewFolderName && ctx.db && typeof ctx.db.prepare === 'function') {
      const cleanName = session.pendingNewFolderName.trim();
      const parentId = Number(session.pendingFolderParentId || 0) || null;
      const createdFolderId = await addFolder(ctx.db, parentId, cleanName, 'general', 1);
      if (createdFolderId) {
        session.selectedFolderId = createdFolderId;
        const chain = await getFolderHierarchyChain(ctx.db, createdFolderId).catch(() => []);
        if (chain.length > 0) {
          session.selectedFolderName = chain[chain.length - 1].name;
          session.selectedFolderPath = chain.map((c) => c.name).join(' / ');
        } else {
          session.selectedFolderName = cleanName;
          session.selectedFolderPath = cleanName;
        }
      }
      session.pendingNewFolderName = null;
    }
    session.step = 'confirm_send';
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 4B -> Choose Practical vs Theoretical (`du_branch`)
  if (action === 'du_branch') {
    const branchKey = String(arg || 'general');
    session.selectedBranch = CORE_BOT_BRANCHES[branchKey] ? branchKey : 'general';
    session.step = 'choose_datatype';
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (action === 'du_back_branch' || action === 'du_edit_meta') {
    session.step = 'choose_branch';
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  // Step 4C -> Choose Data Type (`du_dtype`) matching core Bot system
  if (action === 'du_dtype') {
    const dtypeKey = String(arg || 'general');
    session.selectedNodeType = CORE_BOT_DATA_TYPES[dtypeKey] ? dtypeKey : 'general';

    if (session.pendingNewFolderName && ctx.db && typeof ctx.db.prepare === 'function') {
      const createdFolderId = await createStructuredBotSection(
        ctx.db,
        session.pendingFolderParentId,
        session.pendingNewFolderName,
        session.selectedBranch,
        session.selectedNodeType,
      );
      if (createdFolderId) {
        session.selectedFolderId = createdFolderId;
        const chain = await getFolderHierarchyChain(ctx.db, createdFolderId).catch(() => []);
        if (chain.length > 0) {
          session.selectedFolderName = chain[chain.length - 1].name;
          session.selectedFolderPath = chain.map((c) => c.name).join(' / ');
        } else {
          session.selectedFolderName = session.pendingNewFolderName;
          session.selectedFolderPath = session.pendingNewFolderName;
        }
      }
      session.pendingNewFolderName = null;
    }

    // If the upload was already executed earlier (e.g. user clicked `➕ إنشاء قسم` from `executing` screen), integrate immediately
    if (session.driveStatus === 'uploading' || session.driveStatus === 'done' || session.channelMessageId && !session.destChoice) {
      if (session.selectedFolderId) {
        await integrateSessionFileIntoFolder(
          ctx.db,
          session,
          session.selectedFolderId,
          ctx.from?.id,
          bot,
          env,
        );
      }
      session.step = 'executing';
    } else {
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
  const waiterNodeType = String(
    ctx.userData?.du_new_folder_node_type ?? waiter?.nodeType ?? '',
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

  // 1. Rename Folder / Section (`mode === 'rename_folder'`)
  if (mode === 'rename_folder' || session.step === 'rename_folder') {
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

  // 3. New Folder / Level / Block / Subject / Section
  const nodeType = String(
    waiterNodeType || session.pendingFolderNodeType || 'section',
  ).toLowerCase();

  session.pendingFolderParentId = parentId || session.pendingFolderParentId || 0;
  session.pendingFolderNodeType = nodeType;

  // Level or Block: create folder directly in D1, then navigate inside it!
  if (nodeType === 'level' || nodeType === 'block') {
    let createdFolderId = null;
    if (ctx.db && typeof ctx.db.prepare === 'function') {
      const pid = nodeType === 'level' ? null : (session.pendingFolderParentId || null);
      createdFolderId = await addFolder(ctx.db, pid, cleanText, nodeType, 0);
    }
    session.browseFolderId = createdFolderId || session.pendingFolderParentId || 0;
    session.step = 'pick_folder';
    session.pendingNewFolderName = null;
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

  // Subject or Section: transition to Step 4B (`choose_branch`: عملي أو نظري)
  session.pendingNewFolderName = cleanText;
  session.step = 'choose_branch';
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
