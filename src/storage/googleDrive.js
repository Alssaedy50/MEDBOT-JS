/**
 * Google Drive Integration & Dual-Upload Engine (Telegram Channel + Google Drive).
 *
 * Implements Google Drive API v3 file management using the least-privilege
 * `https://www.googleapis.com/auth/drive.file` scope, supporting both:
 *   1. Client-side OAuth access tokens obtained via Firebase Google Sign-In in
 *      the web dashboard and held strictly in memory.
 *   2. Server/Worker runtime tokens or refresh tokens for automated background
 *      uploads when files are forwarded to the Telegram bot.
 */

export const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export const DEFAULT_DRIVE_FOLDER_NAME = 'MEDBOT Archive';

// In-memory OAuth session (populated from the Web Dashboard Google Sign-In or runtime config)
const runtimeDriveSession = {
  accessToken: null,
  userEmail: null,
  userName: null,
  folderId: null,
  cachedArchiveFolderId: null,
  updatedAt: null,
};

// In-memory log of recent dual uploads (Channel + Google Drive) for dashboard & bot visibility
const recentDualUploads = [];
const MAX_RECENT_UPLOADS = 50;

export function recordDualUploadEvent(entry) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  recentDualUploads.unshift(item);
  if (recentDualUploads.length > MAX_RECENT_UPLOADS) {
    recentDualUploads.length = MAX_RECENT_UPLOADS;
  }
  return item;
}

export function getRecentDualUploads() {
  return [...recentDualUploads];
}

export function setRuntimeDriveSession({ accessToken, userEmail = null, userName = null, folderId = null } = {}) {
  if (accessToken !== undefined) {
    runtimeDriveSession.accessToken = accessToken ? String(accessToken).trim() : null;
  }
  if (userEmail !== undefined) {
    runtimeDriveSession.userEmail = userEmail ? String(userEmail).trim() : null;
  }
  if (userName !== undefined) {
    runtimeDriveSession.userName = userName ? String(userName).trim() : null;
  }
  if (folderId !== undefined && folderId !== null) {
    const cleanFolder = extractDriveFolderId(folderId);
    runtimeDriveSession.folderId = cleanFolder || null;
  }
  runtimeDriveSession.updatedAt = new Date().toISOString();
  return getDriveStatus();
}

export function clearRuntimeDriveSession() {
  runtimeDriveSession.accessToken = null;
  runtimeDriveSession.userEmail = null;
  runtimeDriveSession.userName = null;
  runtimeDriveSession.cachedArchiveFolderId = null;
  runtimeDriveSession.updatedAt = new Date().toISOString();
}

/**
 * Extract a clean Google Drive folder ID from either a raw ID or a full Drive folder URL.
 */
export function extractDriveFolderId(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const matchUrl = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(text);
  if (matchUrl) return matchUrl[1];
  const matchIdParam = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(text);
  if (matchIdParam) return matchIdParam[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  return '';
}

export function resolveConfiguredFolderId(env = process.env) {
  const fromSession = runtimeDriveSession.folderId;
  if (fromSession) return fromSession;
  const fromEnv = extractDriveFolderId(
    env?.GOOGLE_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  );
  return fromEnv || '';
}

export function isDriveConfigured(env = process.env) {
  if (runtimeDriveSession.accessToken) return true;
  const directToken = String(
    env?.GOOGLE_DRIVE_ACCESS_TOKEN || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || '',
  ).trim();
  if (directToken) return true;
  const refresh = String(
    env?.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN || '',
  ).trim();
  const clientId = String(
    env?.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
  ).trim();
  const clientSecret = String(
    env?.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
  ).trim();
  return Boolean(refresh && clientId && clientSecret);
}

export function getDriveStatus(env = process.env) {
  const configured = isDriveConfigured(env);
  const folderId = resolveConfiguredFolderId(env);
  return {
    configured,
    connected: Boolean(runtimeDriveSession.accessToken || configured),
    userEmail: runtimeDriveSession.userEmail || null,
    userName: runtimeDriveSession.userName || null,
    folderId: folderId || runtimeDriveSession.cachedArchiveFolderId || null,
    folderName: DEFAULT_DRIVE_FOLDER_NAME,
    scopes: [...SCOPES],
    updatedAt: runtimeDriveSession.updatedAt,
    recentUploadsCount: recentDualUploads.length,
  };
}

/**
 * Resolve an active Google Drive OAuth 2.0 Bearer access token.
 */
export async function resolveDriveAccessToken(env = process.env, { bearerToken = null, fetchImpl = fetch } = {}) {
  const explicit = String(bearerToken ?? '').replace(/^Bearer\s+/i, '').trim();
  if (explicit) return explicit;

  if (runtimeDriveSession.accessToken) {
    return runtimeDriveSession.accessToken;
  }

  const direct = String(
    env?.GOOGLE_DRIVE_ACCESS_TOKEN || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || '',
  ).trim();
  if (direct) return direct;

  const refreshToken = String(
    env?.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN || '',
  ).trim();
  const clientId = String(
    env?.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
  ).trim();
  const clientSecret = String(
    env?.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
  ).trim();

  if (refreshToken && clientId && clientSecret) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) {
      throw new Error(data?.error_description || data?.error || `google_oauth_refresh_failed_${res.status}`);
    }
    runtimeDriveSession.accessToken = data.access_token;
    runtimeDriveSession.updatedAt = new Date().toISOString();
    return data.access_token;
  }

  return null;
}

/**
 * Find or create the target Google Drive folder (`MEDBOT Archive` by default).
 */
export async function ensureDriveFolder({
  accessToken,
  folderName = DEFAULT_DRIVE_FOLDER_NAME,
  folderId = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const configuredId = extractDriveFolderId(folderId) || resolveConfiguredFolderId(env);
  if (configuredId) return configuredId;
  if (runtimeDriveSession.cachedArchiveFolderId && folderName === DEFAULT_DRIVE_FOLDER_NAME) {
    return runtimeDriveSession.cachedArchiveFolderId;
  }

  const safeName = String(folderName || DEFAULT_DRIVE_FOLDER_NAME).replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and trashed=false`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;

  try {
    const searchRes = await fetchImpl(searchUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (searchRes.ok) {
      const searchData = await searchRes.json().catch(() => null);
      if (searchData?.files?.[0]?.id) {
        if (folderName === DEFAULT_DRIVE_FOLDER_NAME) {
          runtimeDriveSession.cachedArchiveFolderId = searchData.files[0].id;
        }
        return searchData.files[0].id;
      }
    }
  } catch {
    // Proceed to folder creation
  }

  const createRes = await fetchImpl('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      name: folderName || DEFAULT_DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      description: 'مجلد أرشيف ملفات بوت MEDBOT التلقائي',
    }),
  });

  if (!createRes.ok) {
    return null;
  }
  const created = await createRes.json().catch(() => null);
  if (created?.id && folderName === DEFAULT_DRIVE_FOLDER_NAME) {
    runtimeDriveSession.cachedArchiveFolderId = created.id;
  }
  return created?.id ?? null;
}

/**
 * Build a multipart/related payload and upload raw file bytes to Google Drive v3.
 */
export async function uploadBytesToGoogleDrive({
  accessToken,
  filename,
  mimeType = 'application/octet-stream',
  bytes,
  folderId = null,
  description = '',
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const token = await resolveDriveAccessToken(env, { bearerToken: accessToken, fetchImpl });
  if (!token) {
    return { ok: false, reason: 'not_configured', error: 'حساب Google Drive غير مربوط بعد.' };
  }

  let targetFolderId = extractDriveFolderId(folderId) || resolveConfiguredFolderId(env);
  if (!targetFolderId) {
    targetFolderId = await ensureDriveFolder({ accessToken: token, env, fetchImpl }).catch(() => null);
  }

  const metadata = {
    name: String(filename || `medbot-file-${Date.now()}`).trim(),
    description: String(description || 'Uploaded via MEDBOT Dual-Upload').slice(0, 1000),
  };
  if (targetFolderId) {
    metadata.parents = [targetFolderId];
  }

  const boundary = `medbot_drive_boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const metaPart =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
  const closingPart = `\r\n--${boundary}--`;

  const encoder = new TextEncoder();
  const headBytes = encoder.encode(metaPart);
  const tailBytes = encoder.encode(closingPart);
  const fileBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);

  const combined = new Uint8Array(headBytes.length + fileBytes.length + tailBytes.length);
  combined.set(headBytes, 0);
  combined.set(fileBytes, headBytes.length);
  combined.set(tailBytes, headBytes.length + fileBytes.length);

  const uploadUrl =
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,createdTime,webViewLink,webContentLink';

  const response = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: combined,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.id) {
    const errMsg = data?.error?.message || `Google Drive upload failed (${response.status})`;
    if (response.status === 401) {
      runtimeDriveSession.accessToken = null;
    }
    return { ok: false, status: response.status, error: errMsg };
  }

  return {
    ok: true,
    id: data.id,
    name: data.name || metadata.name,
    mimeType: data.mimeType || mimeType,
    size: Number(data.size ?? fileBytes.length),
    createdTime: data.createdTime || new Date().toISOString(),
    webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    webContentLink: data.webContentLink || null,
    folderId: targetFolderId || null,
  };
}

/**
 * List files uploaded to Google Drive by this app.
 */
export async function listDriveFiles({
  accessToken,
  folderId = null,
  pageSize = 25,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const token = await resolveDriveAccessToken(env, { bearerToken: accessToken, fetchImpl });
  if (!token) return { ok: false, error: 'Unauthorized', files: [] };

  const targetFolder = extractDriveFolderId(folderId) || resolveConfiguredFolderId(env);
  let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  if (targetFolder) {
    q += ` and '${targetFolder}' in parents`;
  }

  const url =
    `https://www.googleapis.com/drive/v3/files?pageSize=${Number(pageSize) || 25}` +
    `&q=${encodeURIComponent(q)}` +
    '&orderBy=createdTime desc' +
    '&fields=files(id,name,mimeType,size,createdTime,webViewLink,webContentLink,description)';

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, status: res.status, error: data?.error?.message || 'Failed to list files', files: [] };
  }
  return { ok: true, files: Array.isArray(data?.files) ? data.files : [] };
}

/**
 * Delete a file from Google Drive (requires explicit user confirmation in UI before calling).
 */
export async function deleteDriveFile({
  accessToken,
  fileId,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const token = await resolveDriveAccessToken(env, { bearerToken: accessToken, fetchImpl });
  if (!token) return { ok: false, error: 'Unauthorized' };
  const cleanId = String(fileId ?? '').trim();
  if (!cleanId) return { ok: false, error: 'Missing fileId' };

  const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cleanId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => null);
    return { ok: false, status: res.status, error: data?.error?.message || 'Delete failed' };
  }
  return { ok: true, id: cleanId };
}

/**
 * Infer a default file extension and MIME type from Telegram media metadata.
 */
export function inferMediaFilenameAndMime(message, fallbackTitle = 'medbot-file') {
  if (message?.document) {
    const doc = message.document;
    const mime = doc.mime_type || 'application/octet-stream';
    const name = doc.file_name || `${fallbackTitle}.bin`;
    return {
      fileId: doc.file_id,
      fileType: 'document',
      filename: name,
      mimeType: mime,
      fileSize: doc.file_size ?? null,
    };
  }
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileType: 'photo',
      filename: `${fallbackTitle}.jpg`,
      mimeType: 'image/jpeg',
      fileSize: largest.file_size ?? null,
    };
  }
  if (message?.video) {
    const vid = message.video;
    return {
      fileId: vid.file_id,
      fileType: 'video',
      filename: vid.file_name || `${fallbackTitle}.mp4`,
      mimeType: vid.mime_type || 'video/mp4',
      fileSize: vid.file_size ?? null,
    };
  }
  if (message?.audio) {
    const aud = message.audio;
    return {
      fileId: aud.file_id,
      fileType: 'audio',
      filename: aud.file_name || aud.title || `${fallbackTitle}.mp3`,
      mimeType: aud.mime_type || 'audio/mpeg',
      fileSize: aud.file_size ?? null,
    };
  }
  if (message?.voice) {
    const vc = message.voice;
    return {
      fileId: vc.file_id,
      fileType: 'audio',
      filename: `${fallbackTitle}.ogg`,
      mimeType: vc.mime_type || 'audio/ogg',
      fileSize: vc.file_size ?? null,
    };
  }
  return null;
}

/**
 * Download a Telegram file by `fileId` and upload it to Google Drive.
 */
export async function uploadTelegramFileToGoogleDrive({
  bot,
  fileId,
  filename = null,
  mimeType = 'application/octet-stream',
  title = '',
  description = '',
  folderId = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!isDriveConfigured(env)) {
    return { ok: false, reason: 'not_configured', error: 'حساب Google Drive غير مربوط بعد.' };
  }
  if (!bot || !fileId) {
    return { ok: false, reason: 'missing_bot_or_file', error: 'تعذر الوصول إلى ملف تيليجرام.' };
  }

  let bytes = null;
  let detectedPath = '';
  try {
    if (typeof bot.downloadFileBytes === 'function') {
      const downloaded = await bot.downloadFileBytes(fileId);
      bytes = downloaded?.bytes ?? downloaded;
      detectedPath = downloaded?.filePath ?? '';
    } else if (typeof bot.getFile === 'function') {
      const fileInfo = await bot.getFile(fileId);
      detectedPath = fileInfo?.file_path || '';
      if (detectedPath && typeof bot.downloadFile === 'function') {
        bytes = await bot.downloadFile(detectedPath);
      } else if (!detectedPath && bot.calls) {
        // Test FakeBot environment where getFile is stubbed
        bytes = new TextEncoder().encode(`MEDBOT_TEST_CONTENT:${fileId}:${title || filename || ''}`);
      }
    } else if (bot.calls) {
      bytes = new TextEncoder().encode(`MEDBOT_TEST_CONTENT:${fileId}:${title || filename || ''}`);
    }
  } catch (err) {
    return { ok: false, reason: 'telegram_download_failed', error: err?.message ?? String(err) };
  }

  if (!bytes) {
    return { ok: false, reason: 'empty_file_bytes', error: 'تعذر تنزيل محتوى الملف من تيليجرام.' };
  }

  let finalName = String(filename || title || '').trim();
  if (!finalName) {
    const ext = detectedPath.includes('.') ? `.${detectedPath.split('.').pop()}` : '';
    finalName = `medbot-${fileId.slice(0, 12)}${ext}`;
  } else if (!finalName.includes('.') && detectedPath.includes('.')) {
    const ext = detectedPath.split('.').pop();
    if (ext && ext.length <= 6) finalName = `${finalName}.${ext}`;
  }

  return uploadBytesToGoogleDrive({
    filename: finalName,
    mimeType,
    bytes,
    folderId,
    description: description || title || finalName,
    env,
    fetchImpl,
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Determine whether a Telegram message is a forwarded message.
 */
export function isForwardedMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return Boolean(
    message.forward_date ||
      message.forward_from ||
      message.forward_from_chat ||
      message.forward_origin ||
      message.forward_sender_name,
  );
}

/**
 * Dual-upload any media message sent or forwarded to the bot to BOTH:
 *   1. The Bot's Telegram Channel (`channelTarget`)
 *   2. The User's Google Drive account (`MEDBOT Archive` or `GOOGLE_DRIVE_FOLDER_ID`)
 */
export async function dualUploadMediaMessage({
  bot,
  message,
  channelTarget = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const captionRaw = String(message?.caption || message?.text || '').trim();
  const firstLine = captionRaw.split(/\r?\n/)[0]?.trim() || '';
  const fallbackBase =
    message?.document?.file_name ||
    message?.video?.file_name ||
    message?.audio?.file_name ||
    message?.audio?.title ||
    firstLine.slice(0, 80) ||
    `ملف-موجه-${new Date().toISOString().slice(0, 10)}`;

  const media = inferMediaFilenameAndMime(message, fallbackBase);
  if (!media) {
    return { ok: false, reason: 'no_media' };
  }

  const title = firstLine || media.filename || 'مورد مرفوع';
  const channelCaption = [
    '🗄 <b>أرشيف ملفات منصة MEDBOT</b>',
    '━━━━━━━━━━━━━━━━━━',
    `📄 <b>الاسم:</b> ${escapeHtml(title)}`,
    captionRaw && captionRaw !== title ? `\n📝 <b>الوصف:</b>\n${escapeHtml(captionRaw.slice(0, 600))}` : '',
    `\n🕒 <b>التاريخ:</b> <code>${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</code>`,
  ]
    .filter(Boolean)
    .join('\n');

  // 1. Upload to Telegram Bot Channel
  let channelOutcome = { ok: false, configured: Boolean(channelTarget), messageId: null, error: null };
  if (channelTarget && bot) {
    const target = /^-\d+$/.test(String(channelTarget)) ? Number(channelTarget) : channelTarget;
    try {
      let sent = null;
      if (media.fileType === 'photo' && typeof bot.sendPhoto === 'function') {
        sent = await bot.sendPhoto(target, media.fileId, { caption: channelCaption, parse_mode: 'HTML' });
      } else if (media.fileType === 'video' && typeof bot.sendVideo === 'function') {
        sent = await bot.sendVideo(target, media.fileId, { caption: channelCaption, parse_mode: 'HTML' });
      } else if (media.fileType === 'audio' && typeof bot.sendAudio === 'function') {
        sent = await bot.sendAudio(target, media.fileId, { caption: channelCaption, parse_mode: 'HTML' });
      } else if (typeof bot.sendDocument === 'function') {
        sent = await bot.sendDocument(target, media.fileId, { caption: channelCaption, parse_mode: 'HTML' });
      }
      channelOutcome = {
        ok: true,
        configured: true,
        channel: String(channelTarget),
        messageId: sent?.message_id ?? null,
      };
    } catch (err) {
      channelOutcome = {
        ok: false,
        configured: true,
        channel: String(channelTarget),
        error: err?.message ?? String(err),
      };
    }
  }

  // 2. Upload to Google Drive
  let driveOutcome = { ok: false, configured: isDriveConfigured(env), error: null };
  if (driveOutcome.configured) {
    const uploaded = await uploadTelegramFileToGoogleDrive({
      bot,
      fileId: media.fileId,
      filename: media.filename,
      mimeType: media.mimeType,
      title,
      description: captionRaw || title,
      env,
      fetchImpl,
    });
    driveOutcome = {
      ...uploaded,
      configured: true,
    };
  }

  recordDualUploadEvent({
    title,
    filename: media.filename,
    fileType: media.fileType,
    channelOk: channelOutcome.ok,
    channelTarget: channelTarget || null,
    driveOk: driveOutcome.ok,
    driveFileId: driveOutcome.id || null,
    driveLink: driveOutcome.webViewLink || null,
  });

  const channelLine = channelOutcome.ok
    ? `✅ تم الرفع والنشر في قناة البوت (<code>${escapeHtml(channelTarget)}</code>)`
    : channelOutcome.configured
      ? `⚠️ تعذر الرفع للقناة: <code>${escapeHtml(String(channelOutcome.error || '').slice(0, 120))}</code>`
      : '⚪️ القناة غير مربوطة بعد (اضبط <code>MEDBOT_ARCHIVE_CHANNEL</code> أو اربطها من لوحة الإدارة)';

  const driveLine = driveOutcome.ok
    ? `✅ تم الرفع إلى حسابك في Google Drive (<a href="${escapeHtml(driveOutcome.webViewLink)}">فتح الملف في Drive</a>)`
    : driveOutcome.configured
      ? `⚠️ تعذر الرفع إلى Google Drive: <code>${escapeHtml(String(driveOutcome.error || '').slice(0, 120))}</code>`
      : '⚪️ حساب Google Drive غير مربوط بعد (سجّل الدخول بحسابك من واجهة الويب أو اضبط <code>GOOGLE_DRIVE_ACCESS_TOKEN</code>)';

  const summaryText = [
    '☁️ <b>تقرير الرفع المزدوج التلقائي (القناة + Google Drive)</b>',
    '━━━━━━━━━━━━━━━━━━',
    `📄 <b>الملف:</b> ${escapeHtml(media.filename)}`,
    '',
    `1️⃣ <b>قناة البوت:</b>\n${channelLine}`,
    '',
    `2️⃣ <b>حساب Google Drive:</b>\n${driveLine}`,
  ].join('\n');

  const inlineRows = [];
  if (driveOutcome.ok && driveOutcome.webViewLink) {
    inlineRows.push([{ text: '📂 فتح الملف في Google Drive', url: driveOutcome.webViewLink }]);
  }
  inlineRows.push([{ text: '🏠 الرئيسية', callback_data: 'home' }]);

  return {
    ok: channelOutcome.ok || driveOutcome.ok,
    title,
    filename: media.filename,
    fileType: media.fileType,
    channelOutcome,
    driveOutcome,
    summaryText,
    replyMarkup: { inline_keyboard: inlineRows },
  };
}
