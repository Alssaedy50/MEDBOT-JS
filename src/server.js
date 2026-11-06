/**
 * Container healthcheck HTTP server & Dual-Upload Web Dashboard (Telegram Channel + Google Drive).
 *
 * Serves two roles:
 *   1. Container health probes (`GET /health` -> 200 JSON, `GET /` for non-HTML
 *      probes -> 200 `HEALTH_TEXT`) without ever exposing secrets.
 *   2. Interactive Web Dashboard (`GET /` with `Accept: text/html` or `GET /dashboard`)
 *      with Firebase Google Sign-In (`https://www.googleapis.com/auth/drive.file`)
 *      and API routes (`/api/drive/*`, `/api/channel/*`) to link the user's
 *      Google Drive account and Telegram channel for automatic dual-upload of
 *      any file forwarded to the bot.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { TelegramTransport } from './telegram/client.js';
import { normalizeChannelValue, resolveChannel, validateChannelValue } from './archive.js';
import {
  SCOPES,
  clearRuntimeDriveSession,
  deleteDriveFile,
  dualUploadMediaMessage,
  ensureDriveFolder,
  extractDriveFolderId,
  getDriveStatus,
  getRecentDualUploads,
  listDriveFiles,
   recordDualUploadEvent,
  resolveDriveAccessToken,
  setRuntimeDriveSession,
  uploadBytesToGoogleDrive,
} from './storage/googleDrive.js';
import { streamLargeTelegramFileToDrive } from './storage/mtprotoLargeFile.js';

export const DEFAULT_PORT = 3000;
export const HEALTH_TEXT = 'MEDBOT is active and running';
/** Health check path a host should be pointed at (see `render.yaml`). */
export const HEALTH_PATH = '/health';

/** Resolve the listen port: `PORT` when valid, else the container default. */
export function resolvePort(...args) {
  const value = args.length > 0 ? args[0] : process.env.PORT;
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

/**
 * The lightweight health payload. Never contains a secret, a token, a database
 * path or an environment value: only liveness and process uptime.
 */
export function healthPayload() {
  return { status: 'ok', uptime_seconds: Math.floor(process.uptime()) };
}

function loadFirebaseClientConfig() {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    // Fallback to empty object
  }
  return {};
}

function readJsonBody(request, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function extractBearerToken(request) {
  const authHeader = String(request.headers?.authorization ?? '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

async function handleApiRequest(request, response, pathname) {
  const method = String(request.method || 'GET').toUpperCase();
  const bearerToken = extractBearerToken(request);

  if (method === 'GET' && pathname === '/api/drive/status') {
    const channel = resolveChannel();
    const channelValid = validateChannelValue(channel);
    const drive = getDriveStatus();
    return sendJson(response, 200, {
      ok: true,
      channel: {
        configured: Boolean(channel),
        valid: channelValid.valid,
        value: channel || null,
        botTokenConfigured: Boolean(String(process.env.BOT_TOKEN ?? '').trim()),
      },
      drive,
      recentUploads: getRecentDualUploads(),
    });
  }

  if (method === 'POST' && pathname === '/api/drive/session') {
    try {
      const body = await readJsonBody(request);
      const token = bearerToken || String(body.accessToken ?? '').trim();
      if (!token) {
        return sendJson(response, 401, { ok: false, error: 'Missing Bearer access token' });
      }
      const status = setRuntimeDriveSession({
        accessToken: token,
        userEmail: body.userEmail ?? null,
        userName: body.userName ?? null,
        folderId: body.folderId ?? undefined,
      });
      // Proactively ensure the MEDBOT Archive folder exists in Drive
      const folderId = await ensureDriveFolder({ accessToken: token }).catch(() => null);
      return sendJson(response, 200, {
        ok: true,
        drive: { ...status, folderId: status.folderId || folderId },
      });
    } catch (err) {
      return sendJson(response, 400, { ok: false, error: err?.message || 'Bad request' });
    }
  }

  if (method === 'POST' && pathname === '/api/drive/logout') {
    clearRuntimeDriveSession();
    return sendJson(response, 200, { ok: true, drive: getDriveStatus() });
  }

  if (method === 'POST' && pathname === '/api/channel/config') {
    try {
      const body = await readJsonBody(request);
      if (body.channel !== undefined) {
        const normalized = normalizeChannelValue(body.channel);
        const check = validateChannelValue(normalized);
        if (normalized && !check.valid) {
          return sendJson(response, 400, {
            ok: false,
            error: 'معرّف القناة غير صالح. استخدم @channel_username أو معرّفاً رقمياً سالباً مثل -1001234567890.',
          });
        }
        process.env.MEDBOT_ARCHIVE_CHANNEL = normalized;
      }
      if (body.folderId !== undefined) {
        const cleanFolder = extractDriveFolderId(body.folderId);
        process.env.GOOGLE_DRIVE_FOLDER_ID = cleanFolder;
        setRuntimeDriveSession({ folderId: cleanFolder });
      }
      const channel = resolveChannel();
      return sendJson(response, 200, {
        ok: true,
        channel: {
          configured: Boolean(channel),
          valid: validateChannelValue(channel).valid,
          value: channel || null,
        },
        drive: getDriveStatus(),
      });
    } catch (err) {
      return sendJson(response, 400, { ok: false, error: err?.message || 'Bad request' });
    }
  }

  if (method === 'GET' && pathname === '/api/drive/files') {
    const token = await resolveDriveAccessToken(process.env, { bearerToken }).catch(() => null);
    if (!token) {
      return sendJson(response, 401, { ok: false, error: 'Unauthorized', files: [] });
    }
    const result = await listDriveFiles({ accessToken: token });
    return sendJson(response, result.ok ? 200 : 400, result);
  }

  if (method === 'DELETE' && pathname.startsWith('/api/drive/files/')) {
    const fileId = decodeURIComponent(pathname.slice('/api/drive/files/'.length));
    const token = await resolveDriveAccessToken(process.env, { bearerToken }).catch(() => null);
    if (!token) {
      return sendJson(response, 401, { ok: false, error: 'Unauthorized' });
    }
    const result = await deleteDriveFile({ accessToken: token, fileId });
    return sendJson(response, result.ok ? 200 : 400, result);
  }

  if (method === 'POST' && pathname === '/api/dual-upload') {
    try {
      const body = await readJsonBody(request);
      const filename = String(body.filename || 'document.pdf').trim();
      const mimeType = String(body.mimeType || 'application/octet-stream').trim();
      const title = String(body.title || filename).trim();
      const base64Data = String(body.base64Data || '').trim();
      if (!base64Data) {
        return sendJson(response, 400, { ok: false, error: 'يرجى اختيار ملف للرفع.' });
      }
      const bytes = new Uint8Array(Buffer.from(base64Data, 'base64'));

      // 1. Upload to Telegram Channel if BOT_TOKEN + Channel are configured
      const channel = resolveChannel();
      const botToken = String(process.env.BOT_TOKEN ?? '').trim();
      let channelOutcome = { ok: false, configured: Boolean(channel && botToken), error: null };
      if (channel && botToken) {
        try {
          const transport = new TelegramTransport(botToken);
          const target = /^-\d+$/.test(channel) ? Number(channel) : channel;
          const sent = await transport.sendDocumentBytes(target, bytes, {
            filename,
            caption: `🗄 <b>أرشيف ملفات منصة MEDBOT</b>\n━━━━━━━━━━━━━━━━━━\n📄 <b>الاسم:</b> ${title}`,
            parse_mode: 'HTML',
          });
          channelOutcome = { ok: true, configured: true, channel, messageId: sent?.message_id ?? null };
        } catch (err) {
          channelOutcome = { ok: false, configured: true, channel, error: err?.message ?? String(err) };
        }
      }

      // 2. Upload to Google Drive
      const token = await resolveDriveAccessToken(process.env, { bearerToken }).catch(() => null);
      if (token) {
        setRuntimeDriveSession({ accessToken: token });
      }
      const driveOutcome = await uploadBytesToGoogleDrive({
        accessToken: token,
        filename,
        mimeType,
        bytes,
        description: `MEDBOT Dual-Upload: ${title}`,
      });

      const event = recordDualUploadEvent({
        title,
        filename,
        fileType: mimeType,
        channelOk: channelOutcome.ok,
        channelTarget: channel || null,
        driveOk: driveOutcome.ok,
        driveFileId: driveOutcome.id || null,
        driveLink: driveOutcome.webViewLink || null,
      });

      return sendJson(response, 200, {
        ok: channelOutcome.ok || driveOutcome.ok,
        channelOutcome,
        driveOutcome,
        event,
      });
    } catch (err) {
      return sendJson(response, 400, { ok: false, error: err?.message || 'Upload failed' });
    }
  }

  if (method === 'POST' && pathname === '/api/drive/transfer-large-file') {
    try {
      const body = await readJsonBody(request);
      const botToken = String(body.botToken || process.env.BOT_TOKEN || '').trim();
      const sessionUri = String(body.sessionUri || '').trim();
      if (!botToken || !sessionUri) {
        return sendJson(response, 400, { ok: false, error: 'Missing botToken or sessionUri' });
      }

      const transferParams = {
        botToken,
        sessionId: body.sessionId ?? null,
        fileId: body.fileId ?? null,
        sessionUri,
        channelId: body.channelId ?? null,
        channelMessageId: body.channelMessageId ?? null,
        userChatId: body.userChatId ?? null,
        userMessageId: body.userMessageId ?? null,
        actorUserId: body.actorUserId ?? null,
        statusChatId: body.statusChatId ?? null,
        statusMessageId: body.statusMessageId ?? null,
        filename: String(body.filename || 'large-file.mp4'),
        mimeType: String(body.mimeType || 'application/octet-stream'),
        fileSize: body.fileSize ?? null,
      };

      // If statusChatId + statusMessageId are provided, run asynchronously in the background
      // and update the user's Telegram message with live progress and final completion link!
      if (transferParams.statusChatId && transferParams.statusMessageId) {
        streamLargeTelegramFileToDrive(transferParams).catch(async (err) => {
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: transferParams.statusChatId,
                message_id: transferParams.statusMessageId,
                parse_mode: 'HTML',
                text: [
                  '☁️ <b>تقرير الرفع المزدوج التلقائي (القناة + Google Drive)</b>',
                  '━━━━━━━━━━━━━━━━━━',
                  `📄 <b>الملف:</b> ${transferParams.filename}`,
                  '',
                  `1️⃣ <b>قناة البوت:</b>\n✅ تم الرفع والنشر في قناة البوت (<code>${transferParams.channelId || ''}</code>)`,
                  '',
                  `2️⃣ <b>حساب Google Drive:</b>\n⚠️ تعذر نقل الملف الكبير: <code>${String(err?.message || err).slice(0, 180)}</code>`,
                ].join('\n'),
                reply_markup: {
                  inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]],
                },
              }),
            });
          } catch {
            // Ignore Telegram edit error
          }
        });

        return sendJson(response, 200, {
          ok: true,
          asyncTransfer: true,
          status: 'transferring',
        });
      }

      const result = await streamLargeTelegramFileToDrive(transferParams);
      return sendJson(response, 200, result);
    } catch (err) {
      return sendJson(response, 400, { ok: false, error: err?.message || 'Large file transfer failed' });
    }
  }

  return sendJson(response, 404, { ok: false, error: 'not_found' });
}

function renderDashboardHtml() {
  const firebaseConfig = loadFirebaseClientConfig();
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MEDBOT — الرفع المزدوج التلقائي (قناة البوت + Google Drive)</title>
  <meta name="description" content="تفعيل وربط ميزة الرفع المزدوج لأي ملف يتم توجيهه إلى بوت MEDBOT إلى قناة البوت وحساب Google Drive." />
  <meta property="og:title" content="MEDBOT — الرفع المزدوج (قناة البوت + Google Drive)" />
  <meta property="og:description" content="اربط حسابك في Google Drive وقناة تيليجرام لرفع أي ملف موجه للبوت إلى المكانين تلقائياً." />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap');
    body { font-family: 'Cairo', system-ui, -apple-system, sans-serif; }
    .gsi-material-button {
      -moz-user-select: none;
      -webkit-user-select: none;
      -ms-user-select: none;
      -webkit-appearance: none;
      background-color: #ffffff;
      background-image: none;
      border: 1px solid #747775;
      -webkit-border-radius: 8px;
      border-radius: 8px;
      -webkit-box-sizing: border-box;
      box-sizing: border-box;
      color: #1f1f1f;
      cursor: pointer;
      font-family: 'Cairo', 'Roboto', arial, sans-serif;
      font-size: 14px;
      height: 42px;
      letter-spacing: 0.25px;
      outline: none;
      overflow: hidden;
      padding: 0 16px;
      position: relative;
      text-align: center;
      -webkit-transition: background-color .218s, border-color .218s, box-shadow .218s;
      transition: background-color .218s, border-color .218s, box-shadow .218s;
      vertical-align: middle;
      white-space: nowrap;
      width: auto;
      direction: ltr;
    }
    .gsi-material-button:hover {
      box-shadow: 0 1px 3px 0 rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15);
      background-color: #f8fafd;
    }
    .gsi-material-button .gsi-material-button-content-wrapper {
      align-items: center;
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      height: 100%;
      justify-content: center;
      position: relative;
      width: 100%;
      gap: 10px;
    }
    .gsi-material-button .gsi-material-button-icon {
      height: 20px;
      width: 20px;
      min-width: 20px;
    }
    .gsi-material-button .gsi-material-button-contents {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <!-- Header -->
  <header class="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
    <div class="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-xl">
          ☁️
        </div>
        <div>
          <h1 class="text-lg md:text-xl font-extrabold text-white">MEDBOT — نظام الرفع المزدوج التلقائي</h1>
          <p class="text-xs md:text-sm text-slate-400">رفع أي ملف يتم توجيهه إلى البوت تلقائياً إلى: <span class="text-emerald-400 font-semibold">1* قناة البوت</span> + <span class="text-sky-400 font-semibold">2* حسابك في Google Drive</span></p>
        </div>
      </div>

      <div id="authHeaderArea" class="flex items-center gap-3">
        <button id="googleSignInBtn" class="gsi-material-button" type="button">
          <div class="gsi-material-button-state"></div>
          <div class="gsi-material-button-content-wrapper">
            <div class="gsi-material-button-icon">
              <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style="display: block;">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                <path fill="none" d="M0 0h48v48H0z"></path>
              </svg>
            </div>
            <span class="gsi-material-button-contents">Sign in with Google</span>
            <span style="display: none;">Sign in with Google</span>
          </div>
        </button>

        <div id="signedInBadge" class="hidden items-center gap-3 bg-slate-800/90 border border-slate-700 px-3.5 py-2 rounded-xl">
          <div class="text-right">
            <div id="userEmailLabel" class="text-xs font-bold text-emerald-400"></div>
            <div class="text-[11px] text-slate-400">Google Drive متصل للرفع التلقائي</div>
          </div>
          <button id="signOutBtn" type="button" class="text-xs px-2.5 py-1 rounded-lg bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 border border-rose-500/30 transition">
            تسجيل خروج
          </button>
        </div>
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 py-8 space-y-8">
    <!-- Status Banner -->
    <div id="statusNotice" class="hidden rounded-xl border px-4 py-3 text-sm font-medium"></div>

    <!-- Dual Destinations Grid -->
    <section class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- Destination 1: Bot Channel -->
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-lg">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold">1</span>
            <div>
              <h2 class="text-base font-bold text-white">المكان الأول: قناة البوت (Telegram Channel)</h2>
              <p class="text-xs text-slate-400">أرشفة ونشر فوري لأي ملف يتم توجيهه إلى البوت</p>
            </div>
          </div>
          <span id="channelStatusBadge" class="text-xs font-bold px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30">
            جارٍ التحقق...
          </span>
        </div>

        <div class="space-y-3 pt-2">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">معرّف قناة البوت (<code>@username</code> أو <code>-100...</code>)</label>
            <input id="channelInput" type="text" dir="ltr" placeholder="@my_medbot_channel or -1001234567890"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <p class="text-xs text-slate-400 leading-relaxed">
            💡 يمكنك أيضاً ربط القناة من داخل تيليجرام بإرسال الأمر <code>/connect_archive</code> داخل القناة أو عبر توجيه أي رسالة من القناة إلى البوت في قسم <b>🗄 أرشيف القناة</b>.
          </p>
        </div>
      </div>

      <!-- Destination 2: Google Drive -->
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-lg">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="w-9 h-9 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 font-bold">2</span>
            <div>
              <h2 class="text-base font-bold text-white">المكان الثاني: حسابك في Google Drive</h2>
              <p class="text-xs text-slate-400">رفع نسخة كاملة من الملف إلى مجلدك في Google Drive</p>
            </div>
          </div>
          <span id="driveStatusBadge" class="text-xs font-bold px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30">
            غير مربوط
          </span>
        </div>

        <div class="space-y-3 pt-2">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">معرّف أو رابط مجلد Google Drive (اختياري — يُنشئ <code>MEDBOT Archive</code> تلقائياً عند تركه فارغاً)</label>
            <input id="driveFolderInput" type="text" dir="ltr" placeholder="https://drive.google.com/drive/folders/... أو اتركه فارغاً"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
          </div>
          <div class="flex items-center justify-between gap-2 pt-1">
            <span id="driveFolderResolved" class="text-xs text-slate-400">المجلد الهدف: <code>MEDBOT Archive</code></span>
            <button id="saveConfigBtn" type="button"
              class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition shadow">
              💾 حفظ إعدادات القناة والمجلد
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- How Forwarding Works + Direct Dual Upload Tester -->
    <section class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <!-- Direct Dual Upload Card -->
      <div class="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 class="text-base font-bold text-white flex items-center gap-2">
          <span>🚀</span>
          <span>تجربة ورفع ملف فوري إلى المكانين معاً</span>
        </h3>
        <p class="text-xs text-slate-400 leading-relaxed">
          اختر أي ملف لرفعه فوراً إلى <b>قناة البوت</b> و<b>حسابك في Google Drive</b> في نفس اللحظة، تماماً كما يحدث عند توجيه (Forward) أي ملف إلى البوت في تيليجرام.
        </p>

        <form id="dualUploadForm" class="space-y-3">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">عنوان الملف (اختياري)</label>
            <input id="uploadTitleInput" type="text" placeholder="مثال: محاضرة التشريح العملي - المستوى الأول"
              class="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">اختر الملف</label>
            <input id="uploadFileInput" type="file" required
              class="w-full text-xs text-slate-300 file:mr-0 file:ml-3 file:py-2 file:px-3.5 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-slate-800 file:text-emerald-400 hover:file:bg-slate-700 cursor-pointer" />
          </div>
          <button id="uploadSubmitBtn" type="submit"
            class="w-full py-2.5 px-4 rounded-xl bg-gradient-to-l from-emerald-600 to-sky-600 hover:from-emerald-500 hover:to-sky-500 text-white font-bold text-sm transition shadow-md">
            ☁️ رفع الآن إلى قناة البوت + Google Drive
          </button>
        </form>

        <div class="border-t border-slate-800 pt-4 space-y-2 text-xs text-slate-400">
          <div class="font-bold text-slate-200">كيف يعمل التوجيه التلقائي في تيليجرام؟</div>
          <ol class="list-decimal list-inside space-y-1">
            <li>سجّل الدخول بحسابك في Google من الزر أعلى الصفحة لربط Google Drive.</li>
            <li>قم بتوجيه (<b>Forward</b>) أي ملف (PDF، صورة، فيديو، صوت) إلى البوت في تيليجرام.</li>
            <li>يقوم البوت تلقائياً بنشر الملف في <b>قناة البوت</b> ورفع نسخة منه إلى <b>Google Drive</b> وإرسال رابط الملف لك فوراً!</li>
          </ol>
        </div>
      </div>

      <!-- Google Drive Uploaded Files & Activity -->
      <div class="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-base font-bold text-white">📂 الملفات المرفوعة في Google Drive وسجل الرفع المزدوج</h3>
            <p class="text-xs text-slate-400">قائمة الملفات التي تم رفعها عبر البوت إلى حسابك في Google Drive</p>
          </div>
          <button id="refreshFilesBtn" type="button"
            class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition">
            🔄 تحديث القائمة
          </button>
        </div>

        <div id="driveFilesList" class="space-y-2.5 max-h-96 overflow-y-auto pr-1">
          <div class="text-xs text-slate-500 py-8 text-center">
            سجّل الدخول بحساب Google لعرض وإدارة الملفات المرفوعة في Google Drive.
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- Mandatory Confirmation Modal for Deleting a File from Google Drive -->
  <div id="deleteConfirmModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/70 backdrop-blur-sm p-4">
    <div class="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
      <h4 class="text-base font-bold text-white">⚠️ تأكيد حذف الملف من Google Drive</h4>
      <p id="deleteConfirmText" class="text-sm text-slate-300 leading-relaxed"></p>
      <div class="flex items-center justify-end gap-3 pt-2">
        <button id="cancelDeleteBtn" type="button"
          class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">
          إلغاء
        </button>
        <button id="confirmDeleteBtn" type="button"
          class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold">
          نعم، حذف من Google Drive
        </button>
      </div>
    </div>
  </div>

  <script type="module">
    import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js';
    import {
      getAuth,
      signInWithPopup,
      GoogleAuthProvider,
      onAuthStateChanged,
    } from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js';

    const firebaseConfig = ${JSON.stringify(firebaseConfig)};
    const SCOPES = ${JSON.stringify(SCOPES)};

    // In-memory access token cache (never stored in localStorage or sessionStorage)
    let isSigningIn = false;
    let cachedAccessToken = null;
    let pendingDeleteFile = null;

    const app = firebaseConfig?.apiKey ? initializeApp(firebaseConfig) : null;
    const auth = app ? getAuth(app) : null;
    const provider = new GoogleAuthProvider();
    for (const scope of SCOPES) {
      provider.addScope(scope);
    }

    const googleSignInBtn = document.getElementById('googleSignInBtn');
    const signedInBadge = document.getElementById('signedInBadge');
    const userEmailLabel = document.getElementById('userEmailLabel');
    const signOutBtn = document.getElementById('signOutBtn');
    const statusNotice = document.getElementById('statusNotice');
    const channelStatusBadge = document.getElementById('channelStatusBadge');
    const driveStatusBadge = document.getElementById('driveStatusBadge');
    const channelInput = document.getElementById('channelInput');
    const driveFolderInput = document.getElementById('driveFolderInput');
    const driveFolderResolved = document.getElementById('driveFolderResolved');
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    const dualUploadForm = document.getElementById('dualUploadForm');
    const uploadTitleInput = document.getElementById('uploadTitleInput');
    const uploadFileInput = document.getElementById('uploadFileInput');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    const driveFilesList = document.getElementById('driveFilesList');
    const refreshFilesBtn = document.getElementById('refreshFilesBtn');
    const deleteConfirmModal = document.getElementById('deleteConfirmModal');
    const deleteConfirmText = document.getElementById('deleteConfirmText');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

    function showNotice(message, kind = 'success') {
      statusNotice.className =
        'rounded-xl border px-4 py-3 text-sm font-medium ' +
        (kind === 'error'
          ? 'bg-rose-500/15 border-rose-500/30 text-rose-200'
          : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200');
      statusNotice.textContent = message;
      statusNotice.classList.remove('hidden');
    }

    function authHeaders(extra = {}) {
      const headers = { ...extra };
      if (cachedAccessToken) {
        headers['Authorization'] = 'Bearer ' + cachedAccessToken;
      }
      return headers;
    }

    async function syncTokenToBackend(user, token) {
      if (!token) return;
      await fetch('/api/drive/session', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          accessToken: token,
          userEmail: user?.email || null,
          userName: user?.displayName || null,
          folderId: driveFolderInput.value.trim() || undefined,
        }),
      });
    }

    async function refreshStatus() {
      try {
        const res = await fetch('/api/drive/status', { headers: authHeaders() });
        const data = await res.json();
        if (!data?.ok) return;

        if (data.channel?.configured && data.channel?.valid) {
          channelStatusBadge.textContent = '✅ متصلة (' + data.channel.value + ')';
          channelStatusBadge.className = 'text-xs font-bold px-2.5 py-1 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
          if (!channelInput.value) channelInput.value = data.channel.value;
        } else {
          channelStatusBadge.textContent = '⚪️ غير مضبوطة بعد';
          channelStatusBadge.className = 'text-xs font-bold px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30';
        }

        if (data.drive?.configured || cachedAccessToken) {
          driveStatusBadge.textContent = '✅ متصل وجاهز للرفع';
          driveStatusBadge.className = 'text-xs font-bold px-2.5 py-1 rounded-md bg-sky-500/15 text-sky-300 border border-sky-500/30';
          if (data.drive?.userEmail) {
            userEmailLabel.textContent = data.drive.userEmail;
            googleSignInBtn.classList.add('hidden');
            signedInBadge.classList.remove('hidden');
            signedInBadge.classList.add('flex');
          }
        } else {
          driveStatusBadge.textContent = '⚪️ بانتظار تسجيل الدخول';
          driveStatusBadge.className = 'text-xs font-bold px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30';
        }

        const folderLabel = data.drive?.folderId || data.drive?.folderName || 'MEDBOT Archive';
        driveFolderResolved.innerHTML = 'المجلد الهدف: <code>' + folderLabel + '</code>';
      } catch (err) {
        console.error('Status check error:', err);
      }
    }

    async function loadDriveFiles() {
      if (!cachedAccessToken) {
        const statusRes = await fetch('/api/drive/status').then((r) => r.json()).catch(() => null);
        if (!statusRes?.drive?.configured) return;
      }
      try {
        const res = await fetch('/api/drive/files', { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          return;
        }
        const files = data.files || [];
        if (!files.length) {
          driveFilesList.innerHTML = '<div class="text-xs text-slate-400 py-8 text-center">لا توجد ملفات مرفوعة بعد. قم بتوجيه أي ملف للبوت أو ارفعه من النموذج المجاور!</div>';
          return;
        }
        driveFilesList.innerHTML = files
          .map((f) => {
            const sizeKb = f.size ? Math.max(1, Math.round(Number(f.size) / 1024)) + ' KB' : '';
            const safeName = String(f.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeLink = String(f.webViewLink || 'https://drive.google.com');
            return \`
              <div class="flex items-center justify-between gap-3 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">
                <div class="min-w-0">
                  <div class="text-sm font-bold text-white truncate">📄 \${safeName}</div>
                  <div class="text-[11px] text-slate-400">\${sizeKb} · \${f.createdTime ? new Date(f.createdTime).toLocaleString('ar-EG') : ''}</div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <a href="\${safeLink}" target="_blank" rel="noopener noreferrer"
                    class="px-3 py-1.5 rounded-lg bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 border border-sky-500/30 text-xs font-bold">
                    فتح في Drive ↗
                  </a>
                  <button type="button" data-delete-id="\${f.id}" data-delete-name="\${safeName}"
                    class="delete-drive-btn px-2.5 py-1.5 rounded-lg bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 border border-rose-500/30 text-xs font-bold">
                    🗑 حذف
                  </button>
                </div>
              </div>
            \`;
          })
          .join('');

        document.querySelectorAll('.delete-drive-btn').forEach((btnEl) => {
          btnEl.addEventListener('click', () => {
            pendingDeleteFile = {
              id: btnEl.getAttribute('data-delete-id'),
              name: btnEl.getAttribute('data-delete-name'),
            };
            deleteConfirmText.textContent = \`هل أنت متأكد من رغبتك في حذف الملف "\${pendingDeleteFile.name}" من حسابك في Google Drive؟ لا يمكن التراجع عن هذا الإجراء.\`;
            deleteConfirmModal.classList.remove('hidden');
            deleteConfirmModal.classList.add('flex');
          });
        });
      } catch (err) {
        console.error('Failed to load Drive files:', err);
      }
    }

    if (auth) {
      onAuthStateChanged(auth, async (user) => {
        if (user) {
          if (cachedAccessToken) {
            userEmailLabel.textContent = user.email || user.displayName || 'متصل';
            googleSignInBtn.classList.add('hidden');
            signedInBadge.classList.remove('hidden');
            signedInBadge.classList.add('flex');
            await syncTokenToBackend(user, cachedAccessToken);
            await refreshStatus();
            await loadDriveFiles();
          } else if (!isSigningIn) {
            cachedAccessToken = null;
          }
        } else {
          cachedAccessToken = null;
          googleSignInBtn.classList.remove('hidden');
          signedInBadge.classList.add('hidden');
          signedInBadge.classList.remove('flex');
        }
      });
    }

    googleSignInBtn.addEventListener('click', async () => {
      if (!auth) {
        showNotice('إعدادات Firebase OAuth غير متوفرة.', 'error');
        return;
      }
      try {
        isSigningIn = true;
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (!credential?.accessToken) {
          throw new Error('لم يتم استلام رمز الوصول من Google Auth');
        }
        cachedAccessToken = credential.accessToken;
        userEmailLabel.textContent = result.user.email || result.user.displayName || 'متصل';
        googleSignInBtn.classList.add('hidden');
        signedInBadge.classList.remove('hidden');
        signedInBadge.classList.add('flex');

        await syncTokenToBackend(result.user, cachedAccessToken);
        showNotice('✅ تم ربط حسابك في Google Drive بنجاح! أي ملف يتم توجيهه للبوت سيُرفع تلقائياً إلى القناة وإلى حسابك في Google Drive.');
        await refreshStatus();
        await loadDriveFiles();
      } catch (err) {
        console.error('Sign in error:', err);
        showNotice('تعذّر تسجيل الدخول عبر Google: ' + (err?.message || err), 'error');
      } finally {
        isSigningIn = false;
      }
    });

    signOutBtn.addEventListener('click', async () => {
      if (auth) await auth.signOut();
      cachedAccessToken = null;
      await fetch('/api/drive/logout', { method: 'POST' });
      googleSignInBtn.classList.remove('hidden');
      signedInBadge.classList.add('hidden');
      signedInBadge.classList.remove('flex');
      showNotice('تم تسجيل الخروج وفصل جلسة Google Drive الحالية.');
      await refreshStatus();
    });

    saveConfigBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/channel/config', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            channel: channelInput.value.trim(),
            folderId: driveFolderInput.value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showNotice(data.error || 'تعذر حفظ الإعدادات', 'error');
          return;
        }
        showNotice('✅ تم حفظ إعدادات قناة البوت ومجلد Google Drive بنجاح!');
        await refreshStatus();
        await loadDriveFiles();
      } catch (err) {
        showNotice('حدث خطأ أثناء حفظ الإعدادات: ' + err.message, 'error');
      }
    });

    dualUploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = uploadFileInput.files?.[0];
      if (!file) return;
      uploadSubmitBtn.disabled = true;
      uploadSubmitBtn.textContent = '⏳ جارٍ الرفع إلى قناة البوت + Google Drive...';
      try {
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = String(reader.result || '');
            resolve(res.includes(',') ? res.split(',')[1] : res);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const res = await fetch('/api/dual-upload', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            title: uploadTitleInput.value.trim() || file.name,
            base64Data,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showNotice(data.error || data.driveOutcome?.error || 'تعذر الرفع — تأكد من تسجيل الدخول بحساب Google أو ضبط القناة.', 'error');
        } else {
          const parts = [];
          if (data.channelOutcome?.ok) parts.push('✅ نُشر في قناة البوت');
          if (data.driveOutcome?.ok) parts.push('✅ رُفع إلى Google Drive');
          showNotice('🎉 تم الرفع المزدوج بنجاح: ' + parts.join(' + '));
          uploadTitleInput.value = '';
          uploadFileInput.value = '';
          await loadDriveFiles();
        }
      } catch (err) {
        showNotice('خطأ أثناء رفع الملف: ' + err.message, 'error');
      } finally {
        uploadSubmitBtn.disabled = false;
        uploadSubmitBtn.textContent = '☁️ رفع الآن إلى قناة البوت + Google Drive';
      }
    });

    refreshFilesBtn.addEventListener('click', () => {
      refreshStatus();
      loadDriveFiles();
    });

    cancelDeleteBtn.addEventListener('click', () => {
      pendingDeleteFile = null;
      deleteConfirmModal.classList.add('hidden');
      deleteConfirmModal.classList.remove('flex');
    });

    confirmDeleteBtn.addEventListener('click', async () => {
      if (!pendingDeleteFile?.id) return;
      confirmDeleteBtn.disabled = true;
      try {
        const res = await fetch('/api/drive/files/' + encodeURIComponent(pendingDeleteFile.id), {
          method: 'DELETE',
          headers: authHeaders(),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          showNotice('✅ تم حذف الملف من Google Drive.');
          await loadDriveFiles();
        } else {
          showNotice(data.error || 'تعذر حذف الملف.', 'error');
        }
      } catch (err) {
        showNotice('خطأ أثناء الحذف: ' + err.message, 'error');
      } finally {
        confirmDeleteBtn.disabled = false;
        pendingDeleteFile = null;
        deleteConfirmModal.classList.add('hidden');
        deleteConfirmModal.classList.remove('flex');
      }
    });

    refreshStatus();
    loadDriveFiles();
  </script>
</body>
</html>`;
}

/**
 * Start the healthcheck and Dual-Upload Dashboard server.
 *
 * `GET /health` answers 200 with a small JSON liveness body;
 * `GET /` answers 200 HTML dashboard when `Accept: text/html` is sent by a
 * browser, or `HEALTH_TEXT` for plain probes (preserving backwards compatibility
 * with container health checks and existing tests).
 */
export function startHealthServer({
  port = resolvePort(),
  host = '0.0.0.0',
  onListening = null,
} = {}) {
  const server = http.createServer((request, response) => {
    const pathname = String(request.url ?? '/').split('?')[0];

    if (pathname === HEALTH_PATH) {
      const body = JSON.stringify(healthPayload());
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }

    if (pathname.startsWith('/api/')) {
      handleApiRequest(request, response, pathname).catch((err) => {
        sendJson(response, 500, { ok: false, error: err?.message || 'Internal server error' });
      });
      return;
    }

    const accept = String(request.headers?.accept ?? '');
    if (pathname === '/dashboard' || (pathname === '/' && accept.includes('text/html'))) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(renderDashboardHtml());
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(HEALTH_TEXT);
  });

  // A failed bind (port in use, permission denied) must surface as a log line,
  // not an unhandled 'error' event that takes the whole process down with it.
  server.on('error', (error) => {
    console.error('Healthcheck server error:', error.message ?? error);
  });

  server.listen(port, host, () => {
    const bound = server.address()?.port ?? port;
    console.log(`MEDBOT healthcheck listening on http://${host}:${bound}`);
    startLargeFileQueuePoller();
    if (typeof onListening === 'function') onListening(bound);
  });

  return server;
}

const DEFAULT_WORKER_PENDING_JOBS_URL =
  process.env.WORKER_PENDING_JOBS_URL ||
  'https://medbot-js.alssaedy500.workers.dev/api/drive/pending-jobs';

let queuePollerStarted = false;
const activeJobIds = new Set();

function startLargeFileQueuePoller() {
  if (queuePollerStarted) return;
  queuePollerStarted = true;

  const pollOnce = async () => {
    try {
      const res = await fetch(DEFAULT_WORKER_PENDING_JOBS_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      for (const job of jobs) {
        if (!job?.sessionUri || !job?.botToken) continue;
        const jid = job.jobId || `${job.fileId}:${job.sessionUri}`;
        if (activeJobIds.has(jid)) continue;
        activeJobIds.add(jid);

        streamLargeTelegramFileToDrive({
          botToken: job.botToken,
          sessionId: job.sessionId ?? null,
          fileId: job.fileId ?? null,
          sessionUri: job.sessionUri,
          channelId: job.channelId ?? null,
          channelMessageId: job.channelMessageId ?? null,
          userChatId: job.userChatId ?? null,
          userMessageId: job.userMessageId ?? null,
          actorUserId: job.actorUserId ?? null,
          statusChatId: job.statusChatId ?? null,
          statusMessageId: job.statusMessageId ?? null,
          filename: String(job.filename || 'large-file.mp4'),
          mimeType: String(job.mimeType || 'application/octet-stream'),
          fileSize: job.fileSize ?? null,
        })
          .catch(async (err) => {
            const errText = String(err?.message || err).slice(0, 180);
            if (job.sessionId) {
              try {
                await fetch(
                  process.env.WORKER_SESSION_PROGRESS_URL ||
                    'https://medbot-js.alssaedy500.workers.dev/api/drive/session-progress',
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      sessionId: job.sessionId,
                      driveStatus: 'failed',
                      error: errText,
                    }),
                  },
                );
                return;
              } catch {
                // Fallback below
              }
            }
            if (job.statusChatId && job.statusMessageId && job.botToken) {
              try {
                await fetch(`https://api.telegram.org/bot${job.botToken}/editMessageText`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: job.statusChatId,
                    message_id: job.statusMessageId,
                    parse_mode: 'HTML',
                    text: [
                      '☁️ <b>مركز الرفع المزدوج والدمج الذكي في البوت</b>',
                      '━━━━━━━━━━━━━━━━━━',
                      `📄 <b>الملف:</b> ${job.filename || 'ملف كبير'}`,
                      '',
                      `1️⃣ <b>قناة الأرشيف:</b> ✅ تم النشر في القناة (<code>${job.channelId || ''}</code>)`,
                      `2️⃣ <b>Google Drive:</b> ⚠️ تعذر نقل الملف الكبير: <code>${errText}</code>`,
                    ].join('\n'),
                    reply_markup: {
                      inline_keyboard: [
                        ...(job.sessionId
                          ? [[{ text: '🛑 إلغاء الرفع وحذف الملف', callback_data: `du_cancel:${job.sessionId}` }]]
                          : []),
                        [{ text: '🏠 الرئيسية', callback_data: 'home' }],
                      ],
                    },
                  }),
                });
              } catch {
                // Ignore
              }
            }
          })
          .finally(() => {
            activeJobIds.delete(jid);
          });
      }
    } catch {
      // Ignore transient poll errors
    }
  };

  setInterval(pollOnce, 2500).unref();
}

export { dualUploadMediaMessage };

