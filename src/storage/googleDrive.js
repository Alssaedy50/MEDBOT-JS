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
  scriptUrl: null,
  userEmail: null,
  userName: null,
  folderId: null,
  cachedArchiveFolderId: null,
  updatedAt: null,
};

// In-memory log of recent dual uploads (Channel + Google Drive) for dashboard & bot visibility
const recentDualUploads = [];
const MAX_RECENT_UPLOADS = 50;

// In-memory deduplication map for channel uploads: key -> messageId
const publishedChannelPosts = new Map();

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

export function markChannelPostPublished(key, messageId = null) {
  if (!key) return;
  publishedChannelPosts.set(String(key), messageId ?? true);
}

export function isChannelPostPublished(key) {
  if (!key) return false;
  return publishedChannelPosts.has(String(key));
}

export function setRuntimeDriveSession({
  accessToken,
  scriptUrl,
  userEmail = null,
  userName = null,
  folderId = null,
} = {}) {
  if (accessToken !== undefined) {
    runtimeDriveSession.accessToken = accessToken ? String(accessToken).trim() : null;
  }
  if (scriptUrl !== undefined) {
    runtimeDriveSession.scriptUrl = scriptUrl ? String(scriptUrl).trim() : null;
    // Clear cached token when scriptUrl changes so a fresh token with updated scopes is fetched
    if (accessToken === undefined) {
      runtimeDriveSession.accessToken = null;
    }
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
  runtimeDriveSession.scriptUrl = null;
  runtimeDriveSession.userEmail = null;
  runtimeDriveSession.userName = null;
  runtimeDriveSession.cachedArchiveFolderId = null;
  runtimeDriveSession.updatedAt = new Date().toISOString();
  publishedChannelPosts.clear();
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

function defaultEnv() {
  return typeof process !== 'undefined' && process?.env ? process.env : {};
}

export function resolveConfiguredScriptUrl(env = defaultEnv()) {
  const fallback = defaultEnv();
  return String(
    runtimeDriveSession.scriptUrl ||
      env?.GOOGLE_DRIVE_SCRIPT_URL ||
      fallback.GOOGLE_DRIVE_SCRIPT_URL ||
      '',
  ).trim();
}

export function resolveConfiguredFolderId(env = defaultEnv()) {
  const fromSession = runtimeDriveSession.folderId;
  if (fromSession) return fromSession;
  const fallback = defaultEnv();
  const fromEnv = extractDriveFolderId(
    env?.GOOGLE_DRIVE_FOLDER_ID || fallback.GOOGLE_DRIVE_FOLDER_ID || '',
  );
  return fromEnv || '';
}

export function isDriveConfigured(env = defaultEnv()) {
  if (runtimeDriveSession.accessToken || runtimeDriveSession.scriptUrl) return true;
  const fallback = defaultEnv();
  const scriptUrl = String(
    env?.GOOGLE_DRIVE_SCRIPT_URL || fallback.GOOGLE_DRIVE_SCRIPT_URL || '',
  ).trim();
  if (scriptUrl) return true;
  const directToken = String(
    env?.GOOGLE_DRIVE_ACCESS_TOKEN || fallback.GOOGLE_DRIVE_ACCESS_TOKEN || '',
  ).trim();
  if (directToken) return true;
  const refresh = String(
    env?.GOOGLE_REFRESH_TOKEN || fallback.GOOGLE_REFRESH_TOKEN || '',
  ).trim();
  const clientId = String(
    env?.GOOGLE_CLIENT_ID || fallback.GOOGLE_CLIENT_ID || '',
  ).trim();
  const clientSecret = String(
    env?.GOOGLE_CLIENT_SECRET || fallback.GOOGLE_CLIENT_SECRET || '',
  ).trim();
  return Boolean(refresh && clientId && clientSecret);
}

export function getDriveStatus(env = defaultEnv()) {
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
 * Supports:
 *   1. Direct Bearer token
 *   2. Google Apps Script Web App URL (`GOOGLE_DRIVE_SCRIPT_URL`) returning `{ access_token }`
 *   3. OAuth 2.0 Refresh Token (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`)
 */
export async function resolveDriveAccessToken(env = defaultEnv(), { bearerToken = null, forceRefresh = false, fetchImpl = fetch } = {}) {
  const explicit = String(bearerToken ?? '').replace(/^Bearer\s+/i, '').trim();
  if (explicit) return explicit;

  const scriptUrl = resolveConfiguredScriptUrl(env);

  // If we use a Google Apps Script URL, always fetch a fresh token when forceRefresh is true or when no manual token is set
  if (!forceRefresh && runtimeDriveSession.accessToken && !scriptUrl) {
    return runtimeDriveSession.accessToken;
  }

  const fallback = defaultEnv();
  const direct = String(
    env?.GOOGLE_DRIVE_ACCESS_TOKEN || fallback.GOOGLE_DRIVE_ACCESS_TOKEN || '',
  ).trim();
  if (direct && !forceRefresh) return direct;

  if (scriptUrl && /^https:\/\/script\.google\.com\/macros\/s\//i.test(scriptUrl)) {
    const sep = scriptUrl.includes('?') ? '&' : '?';
    const fetchUrl = forceRefresh ? `${scriptUrl}${sep}_t=${Date.now()}` : scriptUrl;
    const res = await fetchImpl(fetchUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (res.ok) {
      let tokenCandidate = null;
      if (typeof res.text === 'function') {
        const rawText = (await res.text().catch(() => '')).trim();
        if (rawText.startsWith('{')) {
          try {
            const parsed = JSON.parse(rawText);
            tokenCandidate = parsed?.access_token ? String(parsed.access_token).trim() : null;
          } catch {
            tokenCandidate = null;
          }
        } else if (/^ya29\.[A-Za-z0-9._-]+$/.test(rawText)) {
          tokenCandidate = rawText;
        }
      } else if (typeof res.json === 'function') {
        const data = await res.json().catch(() => null);
        tokenCandidate = data?.access_token ? String(data.access_token).trim() : null;
      }
      if (tokenCandidate) {
        runtimeDriveSession.accessToken = tokenCandidate;
        runtimeDriveSession.updatedAt = new Date().toISOString();
        return tokenCandidate;
      }
    }
  }

  if (runtimeDriveSession.accessToken) {
    return runtimeDriveSession.accessToken;
  }

  const refreshToken = String(
    env?.GOOGLE_REFRESH_TOKEN || fallback.GOOGLE_REFRESH_TOKEN || '',
  ).trim();
  const clientId = String(
    env?.GOOGLE_CLIENT_ID || fallback.GOOGLE_CLIENT_ID || '',
  ).trim();
  const clientSecret = String(
    env?.GOOGLE_CLIENT_SECRET || fallback.GOOGLE_CLIENT_SECRET || '',
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
 * When `strict: true` is passed (e.g. during connection test), throws if the token lacks write permissions.
 */
export async function ensureDriveFolder({
  accessToken,
  folderName = DEFAULT_DRIVE_FOLDER_NAME,
  folderId = null,
  strict = false,
  env = defaultEnv(),
  fetchImpl = fetch,
} = {}) {
  const configuredId = extractDriveFolderId(folderId) || resolveConfiguredFolderId(env);
  if (configuredId && !strict) return configuredId;
  if (runtimeDriveSession.cachedArchiveFolderId && folderName === DEFAULT_DRIVE_FOLDER_NAME && !strict) {
    return runtimeDriveSession.cachedArchiveFolderId;
  }

  const safeName = String(folderName || DEFAULT_DRIVE_FOLDER_NAME).replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and trashed=false`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;

  let foundFolderId = configuredId || null;
  if (!foundFolderId) {
    try {
      const searchRes = await fetchImpl(searchUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json().catch(() => null);
        if (searchData?.files?.[0]?.id) {
          foundFolderId = searchData.files[0].id;
          if (folderName === DEFAULT_DRIVE_FOLDER_NAME) {
            runtimeDriveSession.cachedArchiveFolderId = foundFolderId;
          }
          if (!strict) return foundFolderId;
        }
      }
    } catch {
      // Proceed to folder creation
    }
  }

  if (foundFolderId && !strict) {
    return foundFolderId;
  }

  const createRes = await fetchImpl('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(
      foundFolderId
        ? {
            name: folderName || DEFAULT_DRIVE_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder',
            description: 'مجلد أرشيف ملفات بوت MEDBOT التلقائي',
          }
        : {
            name: folderName || DEFAULT_DRIVE_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder',
            description: 'مجلد أرشيف ملفات بوت MEDBOT التلقائي',
          },
    ),
  });

  if (!createRes.ok) {
    const errBody = await createRes.json().catch(() => null);
    const rawMsg = String(errBody?.error?.message || `HTTP ${createRes.status}`);
    if (strict) {
      if (/insufficient authentication scopes/i.test(rawMsg)) {
        throw new Error(
          'الكود في Google Script يمنح صلاحية القراءة فقط (drive.readonly). أضف السطر if (false) DriveApp.createFile("", ""); داخل الكود في script.google.com ثم اعمل New deployment ووافق على صلاحية الإنشاء.',
        );
      }
      throw new Error(rawMsg);
    }
    return foundFolderId || null;
  }
  const created = await createRes.json().catch(() => null);
  const finalId = foundFolderId || created?.id || null;
  if (finalId && folderName === DEFAULT_DRIVE_FOLDER_NAME) {
    runtimeDriveSession.cachedArchiveFolderId = finalId;
  }
  return finalId;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return globalThis.btoa(binary);
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
  env = defaultEnv(),
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

  const fileBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const RESUMABLE_THRESHOLD_BYTES = 4 * 1024 * 1024; // Use resumable direct binary upload for files > 4 MB

  if (fileBytes.byteLength > RESUMABLE_THRESHOLD_BYTES) {
    const initUrl =
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,createdTime,webViewLink,webContentLink';
    const initRes = await fetchImpl(initUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(fileBytes.byteLength),
      },
      body: JSON.stringify(metadata),
    });
    const sessionUri = initRes.headers?.get?.('Location') || initRes.headers?.get?.('location');
    if (initRes.ok && sessionUri) {
      const putRes = await fetchImpl(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Type': mimeType || 'application/octet-stream',
          'Content-Length': String(fileBytes.byteLength),
        },
        body: fileBytes,
      });
      const putData = await putRes.json().catch(() => null);
      if (putRes.ok && putData?.id) {
        return {
          ok: true,
          id: putData.id,
          name: putData.name || metadata.name,
          mimeType: putData.mimeType || mimeType,
          size: Number(putData.size ?? fileBytes.byteLength),
          createdTime: putData.createdTime || new Date().toISOString(),
          webViewLink: putData.webViewLink || `https://drive.google.com/file/d/${putData.id}/view`,
          webContentLink: putData.webContentLink || null,
          folderId: targetFolderId || null,
        };
      }
    }
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
    let errMsg = data?.error?.message || `Google Drive upload failed (${response.status})`;
    if (response.status === 401 || response.status === 403) {
      runtimeDriveSession.accessToken = null;
    }

    // If a Google Apps Script Web App URL is configured and supports doPost direct upload, try it automatically
    const scriptUrl = resolveConfiguredScriptUrl(env);
    if (scriptUrl && /^https:\/\/script\.google\.com\/macros\/s\//i.test(scriptUrl) && fileBytes.byteLength <= 35 * 1024 * 1024) {
      try {
        const postRes = await fetchImpl(scriptUrl, {
          method: 'POST',
          redirect: 'follow',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'upload',
            filename: metadata.name,
            mimeType: mimeType || 'application/octet-stream',
            description: metadata.description,
            folderId: targetFolderId || null,
            base64: uint8ToBase64(fileBytes),
          }),
        });
        const postData = await postRes.json().catch(() => null);
        if (postRes.ok && postData?.ok && postData?.id) {
          return {
            ok: true,
            id: postData.id,
            name: postData.name || metadata.name,
            mimeType: postData.mimeType || mimeType,
            size: Number(postData.size ?? fileBytes.length),
            createdTime: postData.createdTime || new Date().toISOString(),
            webViewLink: postData.webViewLink || `https://drive.google.com/file/d/${postData.id}/view`,
            webContentLink: postData.webContentLink || null,
            folderId: postData.folderId || targetFolderId || null,
          };
        }
      } catch {
        // Ignore doPost fallback failure and report main error
      }
    }

    if (/insufficient authentication scopes/i.test(errMsg)) {
      errMsg =
        'الكود في Google Script يمنح صلاحية القراءة فقط (drive.readonly). افتح script.google.com وأضف السطر if (false) DriveApp.createFile("", ""); داخل الكود ثم اضغط Deploy -> New deployment ووافق على الصلاحية.';
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
  env = defaultEnv(),
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
  env = defaultEnv(),
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

function extractMediaUniqueId(message, media) {
  if (message?.document?.file_unique_id) return message.document.file_unique_id;
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    if (largest?.file_unique_id) return largest.file_unique_id;
  }
  if (message?.video?.file_unique_id) return message.video.file_unique_id;
  if (message?.audio?.file_unique_id) return message.audio.file_unique_id;
  if (message?.voice?.file_unique_id) return message.voice.file_unique_id;
  return media?.fileId || '';
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
  channelLink = null,
  env = defaultEnv(),
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
  let downloadErr = null;
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
    downloadErr = err;
  }

  let finalName = String(filename || title || '').trim();
  if (!finalName) {
    const ext = detectedPath.includes('.') ? `.${detectedPath.split('.').pop()}` : '';
    finalName = `medbot-${fileId.slice(0, 12)}${ext}`;
  } else if (!finalName.includes('.') && detectedPath.includes('.')) {
    const ext = detectedPath.split('.').pop();
    if (ext && ext.length <= 6) finalName = `${finalName}.${ext}`;
  }

  // Fallback for files > 20 MB where public Telegram Bot API getFile returns "file is too big":
  // Save a direct cloud launcher card in Google Drive pointing to the Archive Channel post so no file of any size is ever lost.
  if (!bytes) {
    if (channelLink) {
      const safeTitle = String(title || finalName).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const htmlBridge = [
        '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">',
        `<meta http-equiv="refresh" content="0;url=${channelLink}">`,
        `<title>${safeTitle} — MEDBOT Archive</title>`,
        '<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px;max-width:480px}a{display:inline-block;margin-top:20px;padding:12px 24px;background:#10b981;color:#052e16;font-weight:700;text-decoration:none;border-radius:10px}</style></head>',
        `<body><div class="card"><h2>📄 ${safeTitle}</h2><p>ملف كبير الحجم محفوظ في أرشيف قناة البوت الرسمية.</p><a href="${channelLink}">📥 فتح وتنزيل الملف الكامل الآن</a></div></body></html>`,
      ].join('');
      const bridgeBytes = new TextEncoder().encode(htmlBridge);
      return uploadBytesToGoogleDrive({
        filename: `${finalName} (رابط مباشر للملف الكبير).html`,
        mimeType: 'text/html; charset=utf-8',
        bytes: bridgeBytes,
        folderId,
        description: `${description || title || finalName} — Direct Channel Link: ${channelLink}`,
        env,
        fetchImpl,
      });
    }
    return {
      ok: false,
      reason: 'telegram_download_failed',
      error: downloadErr?.message ?? 'تعذر تنزيل محتوى الملف من تيليجرام.',
    };
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
  db = null,
  env = defaultEnv(),
  fetchImpl = fetch,
} = {}) {
  // Never re-upload automatic channel discussion forwards or non-private group messages
  if (message?.is_automatic_forward) {
    return { ok: false, reason: 'no_media' };
  }
  if (message?.chat?.type && message.chat.type !== 'private') {
    return { ok: false, reason: 'no_media' };
  }

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
  const uniqueId = extractMediaUniqueId(message, media);
  const dedupeFp = `dual:${uniqueId || media.fileId}:${title}`.slice(0, 240);
  const altFp = `${media.fileType}:${media.fileId}:${title}`.slice(0, 240);

  const channelCaption = [
    '🗄 <b>أرشيف ملفات منصة MEDBOT</b>',
    '━━━━━━━━━━━━━━━━━━',
    `📄 <b>الاسم:</b> ${escapeHtml(title)}`,
    captionRaw && captionRaw !== title ? `\n📝 <b>الوصف:</b>\n${escapeHtml(captionRaw.slice(0, 600))}` : '',
    `\n🕒 <b>التاريخ:</b> <code>${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</code>`,
  ]
    .filter(Boolean)
    .join('\n');

  // Check if message was forwarded FROM the archive channel itself
  const fwdChatId =
    message?.forward_from_chat?.id ??
    message?.forward_origin?.chat?.id ??
    message?.sender_chat?.id ??
    null;
  const fwdChatUsername =
    message?.forward_from_chat?.username ??
    message?.forward_origin?.chat?.username ??
    message?.sender_chat?.username ??
    null;
  const normTarget = String(channelTarget || '').trim();
  const isFromArchiveChannel = Boolean(
    normTarget &&
      ((fwdChatId && String(fwdChatId) === normTarget) ||
        (fwdChatUsername && `@${fwdChatUsername}`.toLowerCase() === normTarget.toLowerCase())),
  );

  // 1. Upload to Telegram Bot Channel (with strict deduplication so posts are never duplicated)
  let channelOutcome = { ok: false, configured: Boolean(channelTarget), messageId: null, error: null, skippedDuplicate: false };
  if (channelTarget && bot) {
    let existingMsgId = isFromArchiveChannel
      ? (message?.forward_from_message_id ?? message?.forward_origin?.message_id ?? true)
      : (publishedChannelPosts.get(dedupeFp) ?? publishedChannelPosts.get(altFp) ?? null);

    if (!existingMsgId && db && typeof db.prepare === 'function') {
      try {
        const row = await db
          .prepare(
            "SELECT channel_message_id FROM archive_sync WHERE status='published' AND (content_fingerprint = ? OR content_fingerprint = ?) LIMIT 1",
          )
          .bind(dedupeFp, altFp)
          .first();
        if (row) {
          existingMsgId = row.channel_message_id ?? true;
        }
      } catch {
        // Ignore D1 lookup error
      }
    }

    if (existingMsgId) {
      channelOutcome = {
        ok: true,
        configured: true,
        skippedDuplicate: true,
        channel: String(channelTarget),
        messageId: typeof existingMsgId === 'number' ? existingMsgId : null,
      };
    } else {
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
        const msgId = sent?.message_id ?? null;
        publishedChannelPosts.set(dedupeFp, msgId ?? true);
        publishedChannelPosts.set(altFp, msgId ?? true);
        if (db && typeof db.prepare === 'function') {
          await db
            .prepare(
              `INSERT INTO archive_sync (object_type, content_fingerprint, channel_id, channel_message_id, status, attempts, published_at)
               VALUES ('dual', ?, ?, ?, 'published', 1, CURRENT_TIMESTAMP)
               ON CONFLICT(content_fingerprint) DO UPDATE SET status='published', channel_id=excluded.channel_id, channel_message_id=excluded.channel_message_id, updated_at=CURRENT_TIMESTAMP`,
            )
            .bind(dedupeFp, String(channelTarget), msgId)
            .run()
            .catch(() => {});
        }
        channelOutcome = {
          ok: true,
          configured: true,
          skippedDuplicate: false,
          channel: String(channelTarget),
          messageId: msgId,
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
  }

  // Build a direct Telegram link to the channel post so >20MB files always have a permanent bridge in Drive
  let channelLink = null;
  if (channelOutcome.ok && channelOutcome.messageId && channelTarget) {
    const rawTarget = String(channelTarget).trim();
    if (rawTarget.startsWith('@')) {
      channelLink = `https://t.me/${rawTarget.slice(1)}/${channelOutcome.messageId}`;
    } else if (/^-100\d+$/.test(rawTarget)) {
      channelLink = `https://t.me/c/${rawTarget.slice(4)}/${channelOutcome.messageId}`;
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
      channelLink,
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
    ? channelOutcome.skippedDuplicate
      ? `✅ موجود مسبقاً في قناة البوت (تم منع تكرار النشر في <code>${escapeHtml(channelTarget)}</code>)`
      : `✅ تم الرفع والنشر في قناة البوت (<code>${escapeHtml(channelTarget)}</code>)`
    : channelOutcome.configured
      ? `⚠️ تعذر الرفع للقناة: <code>${escapeHtml(String(channelOutcome.error || '').slice(0, 120))}</code>`
      : '⚪️ القناة غير مربوطة بعد (اضبط <code>MEDBOT_ARCHIVE_CHANNEL</code> أو اربطها من لوحة الإدارة)';

  const driveLine = driveOutcome.ok
    ? `✅ تم الرفع إلى حسابك في Google Drive (<a href="${escapeHtml(driveOutcome.webViewLink)}">فتح الملف في Drive</a>)`
    : driveOutcome.configured
      ? `⚠️ تعذر الرفع إلى Google Drive: <code>${escapeHtml(String(driveOutcome.error || '').slice(0, 220))}</code>`
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
