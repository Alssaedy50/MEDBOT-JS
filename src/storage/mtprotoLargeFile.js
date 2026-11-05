/**
 * MTProto Large-File Streamer (up to 2,000 MB / 2 GB) from Telegram -> Google Drive Resumable Upload.
 *
 * Bypasses the 20 MB HTTP limit of `api.telegram.org/bot.../getFile` by:
 *   1. Locating the live Telegram `Message` via MTProto (`Api.messages.GetMessages` by message ID
 *      for private chats, or channel lookup / silent temporary forward for channel posts) so we
 *      always obtain a fresh `fileReference` valid for the current MTProto `auth_key_id`.
 *   2. Falling back to decoding the Telegram Bot API `file_id` binary structure (TDLib v4 RLE + base64url).
 *   3. Downloading in 512 KB MTProto parts (`DirectDownloadIter`) and streaming 4 MB chunks
 *      (multiples of 256 KB) directly into a Google Drive Resumable Upload `sessionUri` with live progress.
 */

import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const DEFAULT_API_ID = Number(process.env.TELEGRAM_API_ID) || 6;
const DEFAULT_API_HASH =
  process.env.TELEGRAM_API_HASH || 'eb06d4abfb49dc3eeb1aeb98ae0f581e';

// Cache authenticated MTProto bot clients by botToken so subsequent large files start instantly
const clientCache = new Map();

/**
 * Decode a Telegram Bot API `file_id` (TDLib v4/v2 RLE + base64url format) into
 * `{ typeId, dcId, id, accessHash, fileReference }`.
 */
export function decodeTelegramFileId(fileId) {
  const clean = String(fileId || '').trim();
  if (!clean) return null;
  try {
    const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = Buffer.from(padded, 'base64');

    // Zero-byte run-length decoding (TDLib rle_decode)
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === 0) {
        i++;
        if (i < raw.length) {
          const count = raw[i];
          for (let k = 0; k < count; k++) out.push(0);
        }
      } else {
        out.push(raw[i]);
      }
    }

    const buf = Buffer.from(out);
    if (buf.length < 24) return null;

    // In TDLib FileId, the last byte is version (4 in modern Bot API, 2 in legacy).
    // When version === 4, buf[buf.length - 2] is sub_version (e.g. 30..40).
    const version = buf[buf.length - 1];
    const data = version === 4 ? buf.subarray(0, buf.length - 2) : buf.subarray(0, buf.length - 1);

    const typeIdWithFlags = data.readInt32LE(0);
    const dcId = data.readInt32LE(4);
    if (dcId < 1 || dcId > 10) return null;

    let offset = 8;
    const FILE_REFERENCE_FLAG = 1 << 25;
    const WEB_LOCATION_FLAG = 1 << 24;
    const typeId = typeIdWithFlags & ~(FILE_REFERENCE_FLAG | WEB_LOCATION_FLAG);

    let fileReference = Buffer.alloc(0);
    if ((typeIdWithFlags & FILE_REFERENCE_FLAG) !== 0) {
      let len = data[offset++];
      let prefix = 1;
      if (len === 254) {
        len = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
        offset += 3;
        prefix = 4;
      }
      fileReference = Buffer.from(data.subarray(offset, offset + len));
      offset += len;
      const pad = (4 - ((prefix + len) % 4)) % 4;
      offset += pad;
    }

    if (offset + 16 > data.length) return null;
    const id = data.readBigInt64LE(offset);
    const accessHash = data.readBigInt64LE(offset + 8);

    return {
      typeId,
      dcId,
      id,
      accessHash,
      fileReference,
    };
  } catch {
    return null;
  }
}

async function getMtprotoBotClient(botToken) {
  const cleanToken = String(botToken || '').trim();
  if (!cleanToken) throw new Error('Missing Telegram BOT_TOKEN for MTProto transfer');

  const existing = clientCache.get(cleanToken);
  if (existing && existing.connected) {
    return existing;
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, DEFAULT_API_ID, DEFAULT_API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });
  client.setLogLevel('none');
  await client.start({ botAuthToken: cleanToken });
  clientCache.set(cleanToken, client);
  return client;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildVisualProgressBar(pct, width = 10) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return `${'▓'.repeat(filled)}${'░'.repeat(empty)} ${clamped}%`;
}

export async function updateTelegramProgressMessage({
  botToken,
  chatId,
  messageId,
  text,
  replyMarkup = null,
}) {
  if (!botToken || !chatId || !messageId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
  } catch {
    // Non-fatal progress update error
  }
}

const DEFAULT_WORKER_PROGRESS_URL =
  process.env.WORKER_SESSION_PROGRESS_URL ||
  'https://medbot-js.alssaedy500.workers.dev/api/drive/session-progress';

async function syncProgressWithWorkerOrTelegram({
  sessionId,
  workerProgressUrl = DEFAULT_WORKER_PROGRESS_URL,
  botToken,
  statusChatId,
  statusMessageId,
  channelId,
  filename,
  uploadedBytes,
  totalBytes,
  driveStatus = 'uploading',
  driveFileId = null,
  driveLink = null,
  error = null,
}) {
  const isDone = driveStatus === 'done' || driveStatus === 'completed';
  const normalizedStatus = isDone ? 'done' : driveStatus;
  const pct = totalBytes
    ? Math.min(isDone ? 100 : 99, Math.round((uploadedBytes / totalBytes) * 100))
    : isDone
      ? 100
      : 0;

  if (sessionId && workerProgressUrl) {
    try {
      const res = await fetch(workerProgressUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          uploadedBytes,
          totalBytes,
          progressPct: pct,
          driveStatus: normalizedStatus,
          driveFileId,
          driveWebViewLink: driveLink,
          driveLink,
          driveError: error,
          error,
        }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.ok) {
          return { cancelled: Boolean(data.cancelled), updatedViaWorker: true };
        }
      }
    } catch {
      // Fallback to direct Telegram edit below
    }
  }

  if (botToken && statusChatId && statusMessageId) {
    const mbDone = (uploadedBytes / (1024 * 1024)).toFixed(1);
    const mbTotal = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
    const bar = buildVisualProgressBar(pct);
    const cancelBtn = sessionId
      ? [{ text: '🛑 إلغاء الرفع وحذف الملف', callback_data: `du_cancel:${sessionId}` }]
      : [];

    if (isDone && driveLink) {
      await updateTelegramProgressMessage({
        botToken,
        chatId: statusChatId,
        messageId: statusMessageId,
        text: [
          '☁️ <b>مركز الرفع المزدوج والدمج الذكي في البوت</b>',
          '━━━━━━━━━━━━━━━━━━',
          `📄 <b>الملف:</b> ${escapeHtml(filename)} (<code>${mbDone} MB</code>)`,
          '',
          channelId ? `1️⃣ <b>قناة الأرشيف:</b> ✅ تم النشر في القناة (<code>${escapeHtml(channelId)}</code>)` : '',
          `2️⃣ <b>Google Drive:</b> ✅ تم الرفع الكامل بنجاح (<a href="${escapeHtml(driveLink)}">فتح الملف في Drive</a>)`,
          `   📊 <code>${bar}</code>`,
        ]
          .filter(Boolean)
          .join('\n'),
        replyMarkup: {
          inline_keyboard: [
            [{ text: '📂 فتح الملف في Google Drive', url: driveLink }],
            ...(cancelBtn.length ? [cancelBtn] : []),
            [{ text: '🏠 الرئيسية', callback_data: 'home' }],
          ],
        },
      });
    } else if (normalizedStatus === 'failed') {
      await updateTelegramProgressMessage({
        botToken,
        chatId: statusChatId,
        messageId: statusMessageId,
        text: [
          '☁️ <b>مركز الرفع المزدوج والدمج الذكي في البوت</b>',
          '━━━━━━━━━━━━━━━━━━',
          `📄 <b>الملف:</b> ${escapeHtml(filename)}`,
          '',
          channelId ? `1️⃣ <b>قناة الأرشيف:</b> ✅ تم النشر في القناة (<code>${escapeHtml(channelId)}</code>)` : '',
          `2️⃣ <b>Google Drive:</b> ⚠️ تعذر النقل: <code>${escapeHtml(String(error || '').slice(0, 180))}</code>`,
        ]
          .filter(Boolean)
          .join('\n'),
        replyMarkup: {
          inline_keyboard: [
            ...(cancelBtn.length ? [cancelBtn] : []),
            [{ text: '🏠 الرئيسية', callback_data: 'home' }],
          ],
        },
      });
    } else {
      await updateTelegramProgressMessage({
        botToken,
        chatId: statusChatId,
        messageId: statusMessageId,
        text: [
          '☁️ <b>مركز الرفع المزدوج والدمج الذكي في البوت</b>',
          '━━━━━━━━━━━━━━━━━━',
          `📄 <b>الملف:</b> ${escapeHtml(filename)}`,
          '',
          channelId ? `1️⃣ <b>قناة الأرشيف:</b> ✅ تم النشر في القناة (<code>${escapeHtml(channelId)}</code>)` : '',
          '2️⃣ <b>Google Drive:</b> ⏳ جاري الرفع المباشر إلى Google Drive...',
          `   📊 <code>${bar}</code> (<code>${mbDone} MB / ${mbTotal} MB</code>)`,
        ]
          .filter(Boolean)
          .join('\n'),
        replyMarkup: {
          inline_keyboard: [
            ...(sessionId ? [[{ text: '🔄 تحديث نسبة التقدم الآن', callback_data: `du_refresh:${sessionId}` }]] : []),
            ...(cancelBtn.length ? [cancelBtn] : []),
            [{ text: '🏠 الرئيسية', callback_data: 'home' }],
          ],
        },
      });
    }
  }

  return { cancelled: false, updatedViaWorker: false };
}

/**
 * Push a single chunk to a Google Drive Resumable Upload session URI.
 * Google Drive requires intermediate chunks to be multiples of 256 KB (262,144 bytes).
 */
async function putResumableChunk(sessionUri, chunkBytes, offset, totalBytes, mimeType, isFinal = false) {
  const endByte = offset + chunkBytes.byteLength - 1;
  const totalLabel = isFinal ? String(offset + chunkBytes.byteLength) : '*';
  const contentRange = `bytes ${offset}-${endByte}/${totalLabel}`;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Type': mimeType || 'application/octet-stream',
          'Content-Length': String(chunkBytes.byteLength),
          'Content-Range': contentRange,
        },
        body: chunkBytes,
      });

      // 308 Resume Incomplete means Google Drive accepted the intermediate chunk
      if (res.status === 308) {
        return { done: false, status: 308 };
      }

      const data = await res.json().catch(() => null);
      if ((res.status === 200 || res.status === 201) && data?.id) {
        return {
          done: true,
          ok: true,
          id: data.id,
          name: data.name,
          mimeType: data.mimeType || mimeType,
          size: Number(data.size ?? (offset + chunkBytes.byteLength)),
          webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
          webContentLink: data.webContentLink || null,
        };
      }

      const errMsg = data?.error?.message || `Google Drive chunk upload failed (HTTP ${res.status})`;
      lastErr = new Error(errMsg);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        break;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }

  throw lastErr || new Error('Google Drive chunk upload failed');
}

/**
 * Locate the target media message via MTProto so we get a fresh `fileReference` valid
 * for the current MTProto `TelegramClient` session (`auth_key_id`).
 */
async function locateMtprotoMediaMessage(
  client,
  {
    botToken,
    channelId,
    channelMessageId,
    userChatId,
    userMessageId,
    actorUserId,
  },
) {
  // 1. If the message is in a private chat (userChatId > 0), `Api.messages.GetMessages`
  //    (called by passing `undefined` as the entity to `client.getMessages`) looks up the message
  //    directly in the Bot's message inbox with ZERO entity cache or `access_hash` needed!
  if (userMessageId && (!userChatId || Number(userChatId) > 0)) {
    try {
      const msgs = await client.getMessages(undefined, { ids: [Number(userMessageId)] });
      if (msgs?.[0]?.media) return msgs[0];
    } catch {
      // Continue to next strategy
    }
  }

  // 2. Try direct channel lookup if channelId + channelMessageId are available
  const srcChannelId = channelId || (Number(userChatId) < 0 ? userChatId : null);
  const srcChannelMsgId = channelMessageId || (Number(userChatId) < 0 ? userMessageId : null);

  if (srcChannelId && srcChannelMsgId) {
    try {
      const peer = /^-\d+$/.test(String(srcChannelId)) ? Number(srcChannelId) : String(srcChannelId);
      const msgs = await client.getMessages(peer, { ids: [Number(srcChannelMsgId)] });
      if (msgs?.[0]?.media) return msgs[0];
    } catch {
      // If StringSession does not have the channel's access_hash yet, use a silent temporary
      // forward to a private chat (actorUserId / userChatId > 0) to pull the message into
      // the Bot's sequential inbox, fetch its fresh MTProto media, and immediately delete the temp message!
      const targetPrivateChatId =
        (Number(actorUserId) > 0 ? Number(actorUserId) : null) ||
        (Number(userChatId) > 0 ? Number(userChatId) : null) ||
        (Number(process.env.ADMIN_ID) > 0 ? Number(process.env.ADMIN_ID) : null);

      if (botToken && targetPrivateChatId) {
        try {
          const fwdRes = await fetch(`https://api.telegram.org/bot${botToken}/forwardMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: targetPrivateChatId,
              from_chat_id: srcChannelId,
              message_id: Number(srcChannelMsgId),
              disable_notification: true,
            }),
          });
          const fwdData = await fwdRes.json().catch(() => null);
          const tempMsgId = fwdData?.result?.message_id;
          if (tempMsgId) {
            try {
              const msgs = await client.getMessages(undefined, { ids: [Number(tempMsgId)] });
              if (msgs?.[0]?.media) {
                return msgs[0];
              }
            } finally {
              await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: targetPrivateChatId,
                  message_id: Number(tempMsgId),
                }),
              }).catch(() => {});
            }
          }
        } catch {
          // Ignore fallback forward error
        }
      }
    }
  }

  return null;
}

/**
 * Stream a large Telegram file (> 20 MB up to 2 GB) via MTProto directly into a
 * Google Drive Resumable Upload `sessionUri` in 4 MB chunks.
 */
export async function streamLargeTelegramFileToDrive({
  botToken,
  sessionId = null,
  fileId = null,
  sessionUri,
  channelId = null,
  channelMessageId = null,
  userChatId = null,
  userMessageId = null,
  actorUserId = null,
  statusChatId = null,
  statusMessageId = null,
  filename = 'large-file.mp4',
  mimeType = 'application/octet-stream',
  fileSize = null,
  workerProgressUrl = DEFAULT_WORKER_PROGRESS_URL,
} = {}) {
  if (!sessionUri) {
    throw new Error('Missing Google Drive resumable sessionUri');
  }

  const client = await getMtprotoBotClient(botToken);

  // 1. ALWAYS prefer locating the live Message via MTProto first so we get a fresh `fileReference`
  //    bound to this exact `TelegramClient` session (`auth_key_id`).
  let downloadTarget = null;
  let targetDcId = undefined;
  let docSize = Number(fileSize || 0);

  const msg = await locateMtprotoMediaMessage(client, {
    botToken,
    channelId,
    channelMessageId,
    userChatId,
    userMessageId,
    actorUserId,
  });

  if (msg?.media) {
    downloadTarget = msg.media;
    docSize = Number(msg.media?.document?.size ?? msg.file?.size ?? fileSize ?? 0);
  } else {
    const decoded = decodeTelegramFileId(fileId);
    if (decoded && decoded.id && decoded.accessHash) {
      downloadTarget = new Api.InputDocumentFileLocation({
        id: bigInt(decoded.id.toString()),
        accessHash: bigInt(decoded.accessHash.toString()),
        fileReference: decoded.fileReference,
        thumbSize: '',
      });
      targetDcId = decoded.dcId;
    }
  }

  if (!downloadTarget) {
    throw new Error('تعذر فك معرّف الملف الكبير (file_id) أو العثور عليه في بروتوكول MTProto.');
  }

  const totalBytes = docSize > 0 ? docSize : null;

  // Initial progress ping so the user immediately sees active streaming
  const initCheck = await syncProgressWithWorkerOrTelegram({
    sessionId,
    workerProgressUrl,
    botToken,
    statusChatId,
    statusMessageId,
    channelId,
    filename,
    uploadedBytes: 0,
    totalBytes,
    driveStatus: 'uploading',
  });
  if (initCheck.cancelled) {
    return { ok: false, cancelled: true };
  }

  // Google Drive Resumable Upload requires intermediate chunk sizes to be multiples of 256 KB.
  // 4 MB = 16 * 256 KB = 4,194,304 bytes.
  const CHUNK_SIZE = 4 * 1024 * 1024;
  let buffer = new Uint8Array(0);
  let offset = 0;
  let lastProgressUpdate = Date.now() - 2500;
  let finalResult = null;

  const appendBytes = (existing, incoming) => {
    const next = new Uint8Array(existing.byteLength + incoming.byteLength);
    next.set(existing, 0);
    next.set(incoming, existing.byteLength);
    return next;
  };

  for await (const part of client.iterDownload({
    file: downloadTarget,
    dcId: targetDcId,
    requestSize: 512 * 1024,
  })) {
    const partArray = part instanceof Uint8Array ? part : new Uint8Array(part);
    buffer = appendBytes(buffer, partArray);

    // Keep at least 1 byte in `buffer` (`buffer.byteLength > CHUNK_SIZE`) so intermediate
    // chunks always use `*` in Content-Range and the final chunk after the loop closes the session cleanly.
    while (buffer.byteLength > CHUNK_SIZE) {
      const slice = buffer.subarray(0, CHUNK_SIZE);
      const remaining = buffer.subarray(CHUNK_SIZE);
      const chunkCopy = new Uint8Array(slice);
      buffer = new Uint8Array(remaining);

      const res = await putResumableChunk(
        sessionUri,
        chunkCopy,
        offset,
        totalBytes,
        mimeType,
        false,
      );
      offset += chunkCopy.byteLength;
      if (res.done) {
        finalResult = res;
      }

      if (Date.now() - lastProgressUpdate > 3000) {
        lastProgressUpdate = Date.now();
        const prog = await syncProgressWithWorkerOrTelegram({
          sessionId,
          workerProgressUrl,
          botToken,
          statusChatId,
          statusMessageId,
          channelId,
          filename,
          uploadedBytes: offset,
          totalBytes: totalBytes ? Math.max(totalBytes, offset + buffer.byteLength) : null,
          driveStatus: 'uploading',
        });
        if (prog.cancelled) {
          await fetch(sessionUri, { method: 'DELETE' }).catch(() => null);
          return { ok: false, cancelled: true };
        }
      }
    }
  }

  // Flush the final remaining bytes and close the Google Drive Resumable Session
  if (!finalResult && buffer.byteLength > 0) {
    const finalTotal = offset + buffer.byteLength;
    const res = await putResumableChunk(
      sessionUri,
      buffer,
      offset,
      finalTotal,
      mimeType,
      true,
    );
    offset += buffer.byteLength;
    if (res.done) {
      finalResult = res;
    }
  }

  if (!finalResult?.ok) {
    throw new Error('لم يكتمل حفظ الملف الكبير في Google Drive.');
  }

  // Update the Worker session & Telegram status message with the final Drive link and 100% progress!
  await syncProgressWithWorkerOrTelegram({
    sessionId,
    workerProgressUrl,
    botToken,
    statusChatId,
    statusMessageId,
    channelId,
    filename,
    uploadedBytes: offset,
    totalBytes: offset,
    driveStatus: 'done',
    driveFileId: finalResult.id,
    driveLink: finalResult.webViewLink,
  });

  return finalResult;
}
