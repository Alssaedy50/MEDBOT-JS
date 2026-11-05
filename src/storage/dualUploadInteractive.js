/**
 * Interactive Dual-Upload Session Manager:
 *   1. Automatic file type detection (Video lecture, PDF reference, Presentation, Image, Audio, Archive).
 *   2. Smart Academic Folder Matcher + Hierarchical Drill-Down (Level -> Term -> Block -> Subject -> Section)
 *      to integrate any sent/forwarded file directly into the Bot's Database (`content`), Archive Channel, and Google Drive.
 *   3. Real-time visual progress bar (`▓▓▓▓░░░░░░ 42%`) with non-disruptive keyboard state preservation.
 *   4. Unified Cross-System Cancel & Delete (`du_cancel:<sessionId>`) that aborts active streams and deletes
 *      the file from the Bot Database, Archive Channel, and Google Drive simultaneously.
 */

import { all, get, run } from '../db/d1/core.js';
import { addContent, addFolder, deleteFile } from '../db/d1/registry.js';
import { createResourceNewsForContent, publishNews } from '../db/d1/news.js';
import {
  buildStructuredArchiveCaption,
  getFolderHierarchyChain,
} from '../telegram/workerAdmin.js';
import {
  deleteDriveFile,
  resolveDriveAccessToken,
  unmarkChannelPostPublished,
} from './googleDrive.js';

const memorySessions = new Map();

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Detect a detailed human-readable file type and database `file_type` (`doc`, `video`, `photo`, `audio`)
 * from Telegram message and inferred media metadata.
 */
export function detectDetailedMediaKind(message, media) {
  const filename = String(media?.filename || '').toLowerCase();
  const mime = String(media?.mimeType || '').toLowerCase();
  const baseType = String(media?.fileType || 'document').toLowerCase();

  if (baseType === 'video' || mime.startsWith('video/') || /\.(mp4|mkv|mov|avi|webm)$/i.test(filename)) {
    return {
      dbType: 'video',
      icon: '🎬',
      label: 'مقطع فيديو / محاضرة مسجلة',
      shortLabel: 'فيديو',
      keywords: ['فيديو', 'محاضرات', 'تسجيل', 'شرح', 'عملي'],
    };
  }
  if (baseType === 'photo' || mime.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(filename)) {
    return {
      dbType: 'photo',
      icon: '🖼',
      label: 'صورة / مخطط توضيحي',
      shortLabel: 'صورة',
      keywords: ['صور', 'مخططات', 'عملي', 'أطلس', 'تحديد'],
    };
  }
  if (baseType === 'audio' || mime.startsWith('audio/') || /\.(mp3|ogg|m4a|wav|aac)$/i.test(filename)) {
    return {
      dbType: 'audio',
      icon: '🎧',
      label: 'تسجيل صوتي / ريكورد محاضرة',
      shortLabel: 'ريكورد صوتي',
      keywords: ['ريكورد', 'صوتيات', 'محاضرات', 'تسجيلات'],
    };
  }
  if (mime === 'application/pdf' || /\.pdf$/i.test(filename)) {
    return {
      dbType: 'doc',
      icon: '📕',
      label: 'مستند PDF / مقرر أو ملخص دراسي',
      shortLabel: 'ملف PDF',
      keywords: ['مقرر', 'ملخصات', 'محاضرات', 'كتب', 'نظري', 'عملي', 'تحديد'],
    };
  }
  if (/\.(pptx?|ppsx?)$/i.test(filename) || mime.includes('presentation')) {
    return {
      dbType: 'doc',
      icon: '📊',
      label: 'عرض تقديمي (PowerPoint)',
      shortLabel: 'عرض سلايدات',
      keywords: ['سلايدات', 'عروض', 'محاضرات', 'نظري'],
    };
  }
  if (/\.(docx?|rtf)$/i.test(filename) || mime.includes('word')) {
    return {
      dbType: 'doc',
      icon: '📝',
      label: 'مستند نصي (Word)',
      shortLabel: 'مستند Word',
      keywords: ['ملخصات', 'تفريغ', 'ملاحظات', 'أسئلة'],
    };
  }
  if (/\.(xlsx?|csv)$/i.test(filename) || mime.includes('spreadsheet')) {
    return {
      dbType: 'doc',
      icon: '📈',
      label: 'جدول بيانات (Excel)',
      shortLabel: 'جدول Excel',
      keywords: ['جداول', 'توزيع', 'درجات'],
    };
  }
  if (/\.(zip|rar|7z|tar|gz)$/i.test(filename)) {
    return {
      dbType: 'doc',
      icon: '📦',
      label: 'حزمة ملفات مضغوطة (Archive)',
      shortLabel: 'ملف مضغوط',
      keywords: ['تجميعات', 'ملفات', 'مراجع'],
    };
  }
  return {
    dbType: 'doc',
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
      const parentId = r[1] !== null && r[1] !== undefined ? Number(r[1]) : (r.parent_id ? Number(r.parent_id) : null);
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

      // Exact folder name appearance in file title/caption
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

      // Prefer leaf sections (folders without children or deeper in the hierarchy)
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
  if (t === 'level' || t === 'year') return '🎓';
  if (t === 'term' || t === 'semester') return '📅';
  if (t === 'block' || t === 'module') return '🧩';
  if (t === 'subject' || t === 'course') return '📚';
  return '📂';
}

/**
 * Build the unified message text and interactive inline keyboard for a Dual-Upload session.
 */
export async function renderDualUploadSessionMessage(db, session) {
  const sizeMb = session.fileSize
    ? `${(Number(session.fileSize) / (1024 * 1024)).toFixed(1)} MB`
    : 'غير محدد';

  // 1. Channel status line
  const channelLine = session.channelOk
    ? session.channelSkippedDuplicate
      ? `✅ موجود مسبقاً في قناة الأرشيف (تم منع التكرار في <code>${esc(session.channelId)}</code>)`
      : `✅ تم النشر والأرشفة في قناة البوت (<code>${esc(session.channelId)}</code>)`
    : session.channelId
      ? `⚠️ تعذر النشر في القناة: <code>${esc(String(session.channelError || '').slice(0, 100))}</code>`
      : '⚪️ القناة غير مربوطة بعد';

  // 2. Google Drive status & live progress bar
  let driveLine = '';
  if (session.driveStatus === 'uploading') {
    const pct = Number(session.progressPct || 0);
    const doneMb = ((Number(session.uploadedBytes || 0)) / (1024 * 1024)).toFixed(1);
    const totalMb = session.fileSize
      ? (Number(session.fileSize) / (1024 * 1024)).toFixed(1)
      : '?';
    const bar = renderProgressBar(pct);
    driveLine =
      `⏳ <b>جاري الرفع المباشر إلى Google Drive...</b>\n` +
      `📊 <b>التقدم:</b> <code>${bar}</code> (<code>${doneMb} / ${totalMb} MB</code>)`;
  } else if (session.driveStatus === 'done' && session.driveWebViewLink) {
    driveLine = `✅ تم الرفع الكامل إلى Google Drive (<a href="${esc(session.driveWebViewLink)}">فتح الملف في Drive</a>)`;
  } else if (session.driveStatus === 'failed') {
    driveLine = `⚠️ تعذر الرفع إلى Google Drive: <code>${esc(String(session.driveError || '').slice(0, 160))}</code>`;
  } else {
    driveLine = '⚪️ حساب Google Drive غير مربوط بعد';
  }

  // 3. Bot Database integration status (Level -> Block -> Subject -> Section)
  let botDataLine = '';
  if (session.selectedFolderId && session.selectedFolderPath) {
    botDataLine =
      `✅ <b>مدمج في داتا البوت:</b>\n` +
      `📍 <code>${esc(session.selectedFolderPath)}</code>` +
      (session.contentId ? ` (🆔 <code>#${session.contentId}</code>)` : '');
  } else {
    botDataLine =
      '⏳ <b>بانتظار تحديد القسم الأكاديمي:</b>\n' +
      'اختر <b>المستوى ⬅️ البلوك ⬅️ المادة ⬅️ القسم</b> من الأزرار أدناه لدفع الملف فوراً إلى داتا البوت وتحديث منشور القناة.';
  }

  // Current browse path breadcrumb if user is navigating folders
  let browseHeader = '';
  let currentFolder = null;
  let childFolders = [];
  const browseId = Number(session.browseFolderId || 0);

  if (db && typeof db.prepare === 'function' && (!session.selectedFolderId || session.pickingFolder)) {
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
      ? '☁️ <b>جاري الرفع المزدوج المباشر + تصنيف المورد في البوت</b>'
      : '☁️ <b>تقرير الرفع المزدوج والتصنيف الأكاديمي (البوت + القناة + Drive)</b>';

  const text = [
    headerTitle,
    '━━━━━━━━━━━━━━━━━━',
    `📄 <b>الملف:</b> ${esc(session.filename)}`,
    `${session.kindIcon || '📄'} <b>النوع المكتشف:</b> ${esc(session.kindLabel || 'مورد تعليمي')} · <code>${esc(sizeMb)}</code>`,
    '',
    `1️⃣ <b>قناة الأرشيف:</b>\n${channelLine}`,
    '',
    `2️⃣ <b>حساب Google Drive:</b>\n${driveLine}`,
    '',
    `3️⃣ <b>داتا البوت (مكتبة الطلاب):</b>\n${botDataLine}${browseHeader}`,
  ].join('\n');

  // Build Interactive Inline Keyboard
  const rows = [];

  // A. Google Drive link button if ready
  if (session.driveStatus === 'done' && session.driveWebViewLink) {
    rows.push([{ text: '📂 فتح الملف في Google Drive', url: session.driveWebViewLink }]);
  }

  // B. Academic Folder Integration Buttons
  if (!session.selectedFolderId || session.pickingFolder) {
    // 1. Smart 1-click suggestion if available and user is at root
    if (session.suggestedFolderId && session.suggestedFolderPath && browseId === 0) {
      const shortPath = String(session.suggestedFolderPath).slice(-38);
      rows.push([
        {
          text: `✨ دمج سريع: ${shortPath}`,
          callback_data: `du_save:${session.id}:${session.suggestedFolderId}`,
        },
      ]);
    }

    // 2. If inside a folder (`browseId > 0`), offer immediate save button into this folder
    if (browseId > 0 && currentFolder) {
      rows.push([
        {
          text: `✅ دمج وحفظ الملف في «${String(currentFolder.name).slice(0, 24)}»`,
          callback_data: `du_save:${session.id}:${browseId}`,
        },
      ]);
    }

    // 3. Child folders (Levels -> Blocks -> Subjects -> Sections) in 2-column grid
    for (let i = 0; i < childFolders.length; i += 2) {
      const pair = childFolders.slice(i, i + 2).map((cf) => ({
        text: `${nodeIcon(cf.nodeType)} ${String(cf.name).slice(0, 22)}`,
        callback_data: `du_nav:${session.id}:${cf.id}`,
      }));
      rows.push(pair);
    }

    // 4. Create new folder here / Back navigation
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
    // File is already saved into a bot section — allow changing section anytime
    rows.push([
      {
        text: `🗂 تغيير القسم (${String(session.selectedFolderName || 'القسم الحالي').slice(0, 22)})`,
        callback_data: `du_pick:${session.id}`,
      },
    ]);
  }

  // C. Live Progress Refresh & Unified Cancel / Delete Controls
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
 * Integrate the session's file into `folderId` in the Bot Database (`content`),
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

  // 1. Insert or update in `content` table
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
        Number(userId) || null,
      );
      if (contentId) {
        try {
          const newsId = await createResourceNewsForContent(db, contentId, Number(userId) || 0, 'published');
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

  // 2. Update Archive Channel post caption with full structured academic hierarchy + MEDBOT_META
  if (session.channelId && session.channelMessageId && bot) {
    const structuredCaption = buildStructuredArchiveCaption({
      id: contentId || 0,
      folderId: fid,
      title: session.title || session.filename,
      fileType: dbFileType,
      chain,
      sourceType: 'direct',
      contributorName: 'إدارة المنصة',
      contributorId: userId || null,
      createdAt: new Date().toISOString(),
    });
    const target = /^-\d+$/.test(String(session.channelId))
      ? Number(session.channelId)
      : session.channelId;
    if (typeof bot.editMessageCaption === 'function') {
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

  // 3. Update Google Drive file description with the selected academic path if already uploaded
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

  // 1. Remove from `pending_large_drive_jobs` queue in D1 if still queued
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

    // Delete from Bot `content` & `archive_sync`
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

  // Clear in-memory channel deduplication so user can re-upload later if desired
  unmarkChannelPostPublished(session.dedupeFp);
  unmarkChannelPostPublished(session.altFp);

  // 2. Delete message from Telegram Archive Channel
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

  // 3. Cancel / Delete from Google Drive
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
      `📄 <b>الملف:</b> ${esc(session.filename)}`,
      '',
      '✅ <b>تم إيقاف الرفع وإزالة الملف من الوجهات الثلاث:</b>',
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
 * Handle interactive callbacks (`du_nav:`, `du_save:`, `du_pick:`, `du_newf:`, `du_refresh:`, `du_cancel:`).
 */
export async function handleDualUploadCallback(ctx, data, bot, env) {
  const parts = String(data || '').split(':');
  const action = parts[0];
  const sessionId = parts[1];
  const targetId = parts[2] !== undefined ? Number(parts[2]) : null;

  const session = await getUploadSession(ctx.db, sessionId);
  if (!session) {
    await ctx.answer();
    return ctx.editMessageText('⚠️ انتهت صلاحية جلسة هذا الملف أو تم حذفه.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
      parse_mode: 'HTML',
    });
  }

  if (action === 'du_cancel') {
    const res = await cancelAndDeleteUploadSession(ctx.db, session, bot, env);
    await ctx.answer();
    return ctx.editMessageText(res.text, {
      reply_markup: res.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (action === 'du_nav') {
    session.browseFolderId = Number(targetId || 0);
    session.pickingFolder = true;
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (action === 'du_pick') {
    session.pickingFolder = true;
    session.browseFolderId = 0;
    await saveUploadSession(ctx.db, session);
    const view = await renderDualUploadSessionMessage(ctx.db, session);
    await ctx.answer();
    return ctx.editMessageText(view.text, {
      reply_markup: view.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (action === 'du_save') {
    await integrateSessionFileIntoFolder(
      ctx.db,
      session,
      Number(targetId),
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

  if (action === 'du_newf') {
    const parentId = Number(targetId || 0);
    if (ctx.userData) {
      ctx.userData.du_new_folder_session = session.id;
      ctx.userData.du_new_folder_parent = parentId;
    }
    await ctx.answer();
    return ctx.reply(
      parentId > 0
        ? '➕ <b>إنشاء قسم فرعي جديد ودمج الملف فيه</b>\n\nأرسل اسم القسم أو المادة الجديدة الآن في رسالة نصية:'
        : '➕ <b>إنشاء مستوى أو قسم رئيسي جديد ودمج الملف فيه</b>\n\nأرسل اسم المستوى أو القسم الجديد الآن:',
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ إلغاء', callback_data: `du_nav:${session.id}:${parentId}` }]],
        },
      },
    );
  }

  if (action === 'du_refresh') {
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
 * Handle text input when the user creates a new folder directly from the Dual-Upload card.
 */
export async function handleDualUploadNewFolderText(ctx, text, bot, env) {
  const sessionId = ctx.userData?.du_new_folder_session;
  const parentId = Number(ctx.userData?.du_new_folder_parent || 0);
  if (ctx.userData) {
    ctx.userData.du_new_folder_session = null;
    ctx.userData.du_new_folder_parent = null;
  }

  const cleanName = String(text || '').trim();
  if (!cleanName || !sessionId) {
    return ctx.reply('⚠️ يرجى إرسال اسم صالح للقسم.');
  }

  const session = await getUploadSession(ctx.db, sessionId);
  if (!session) {
    return ctx.reply('⚠️ انتهت صلاحية جلسة الرفع.');
  }

  const nodeType = parentId === 0 ? 'level' : 'section';
  const newFolderId = await addFolder(ctx.db, parentId || null, cleanName, nodeType, 0);
  if (newFolderId) {
    await integrateSessionFileIntoFolder(
      ctx.db,
      session,
      newFolderId,
      ctx.from?.id,
      bot,
      env,
    );
  }

  const view = await renderDualUploadSessionMessage(ctx.db, session);

  // Also update the original status card if possible
  if (session.userChatId && session.statusMessageId && bot?.editMessageText) {
    await bot
      .editMessageText(view.text, {
        chat_id: session.userChatId,
        message_id: session.statusMessageId,
        parse_mode: 'HTML',
        reply_markup: view.reply_markup,
      })
      .catch(() => {});
  }

  return ctx.reply(
    `✅ تم إنشاء القسم «<b>${esc(cleanName)}</b>» ودمج الملف فيه بنجاح!\n\n${view.text}`,
    {
      parse_mode: 'HTML',
      reply_markup: view.reply_markup,
    },
  );
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
    session.driveStatus = String(payload.driveStatus);
  }
  if (payload.driveFileId) {
    session.driveFileId = String(payload.driveFileId);
  }
  if (payload.driveWebViewLink) {
    session.driveWebViewLink = String(payload.driveWebViewLink);
  }
  if (payload.driveError) {
    session.driveError = String(payload.driveError);
  }

  await saveUploadSession(db, session);

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
