/**
 * MTProto Large-File Streamer (up to 2,000 MB / 2 GB) from Telegram -> Google Drive Resumable Upload.
 *
 * Bypasses the 20 MB HTTP limit of `api.telegram.org/bot.../getFile` by:
 *   1. Decoding the Telegram Bot API `file_id` binary structure (TDLib RLE + base64url)
 *      directly into `{ typeId, dcId, id, accessHash, fileReference }`.
 *   2. Connecting directly to Telegram's MTProto Data Center (`dcId`) using `BOT_TOKEN`.
 *   3. Downloading in 512 KB MTProto parts (`DirectDownloadIter`) and streaming 4 MB chunks
 *      (multiples of 256 KB) directly into a Google Drive Resumable Upload `sessionUri`.
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
 * Decode a Telegram Bot API `file_id` (TDLib v4/v3 RLE + base64url format) into
 * `{ typeId, dcId, id, accessHash, fileReference }` so we can call `Api.upload.GetFile`
 * directly on the target Data Center without needing chat/channel `access_hash` resolution.
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

    const hasSubVersion = buf.length >= 2 && buf[buf.length - 2] === 4;
    const data = hasSubVersion ? buf.subarray(0, buf.length - 2) : buf.subarray(0, buf.length - 1);

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
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
  } catch {
    // Non-fatal progress update error
  }
}

/**
 * Push a single chunk to a Google Drive Resumable Upload session URI.
 * Google Drive requires intermediate chunks to be multiples of 256 KB (262,144 bytes).
 */
async function putResumableChunk(sessionUri, chunkBytes, offset, totalBytes, mimeType) {
  const endByte = offset + chunkBytes.byteLength - 1;
  const totalLabel = totalBytes && totalBytes >= offset + chunkBytes.byteLength ? String(totalBytes) : '*';
  const contentRange = `bytes ${offset}-${endByte}/${totalLabel}`;

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
  throw new Error(errMsg);
}

/**
 * Locate the target media message via MTProto using either the Archive Channel message ID
 * or the user's private chat message ID.
 */
async function locateMtprotoMediaMessage(client, { channelId, channelMessageId, userChatId, userMessageId }) {
  if (channelId && channelMessageId) {
    try {
      const peer = /^-\d+$/.test(String(channelId)) ? Number(channelId) : String(channelId);
      const msgs = await client.getMessages(peer, { ids: [Number(channelMessageId)] });
      if (msgs?.[0]?.media) return msgs[0];
    } catch {
      // Fallback to userChatId
    }
  }

  if (userChatId && userMessageId) {
    try {
      const msgs = await client.getMessages(Number(userChatId), { ids: [Number(userMessageId)] });
      if (msgs?.[0]?.media) return msgs[0];
    } catch {
      // Ignore
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
  fileId = null,
  sessionUri,
  channelId = null,
  channelMessageId = null,
  userChatId = null,
  userMessageId = null,
  statusChatId = null,
  statusMessageId = null,
  filename = 'large-file.mp4',
  mimeType = 'application/octet-stream',
  fileSize = null,
} = {}) {
  if (!sessionUri) {
    throw new Error('Missing Google Drive resumable sessionUri');
  }

  const client = await getMtprotoBotClient(botToken);

  // 1. Prefer decoding the Bot API `file_id` directly into an InputDocumentFileLocation + dcId
  let downloadTarget = null;
  let targetDcId = undefined;
  let docSize = Number(fileSize || 0);

  const decoded = decodeTelegramFileId(fileId);
  if (decoded && decoded.id && decoded.accessHash) {
    downloadTarget = new Api.InputDocumentFileLocation({
      id: bigInt(decoded.id.toString()),
      accessHash: bigInt(decoded.accessHash.toString()),
      fileReference: decoded.fileReference,
      thumbSize: '',
    });
    targetDcId = decoded.dcId;
  } else {
    const msg = await locateMtprotoMediaMessage(client, {
      channelId,
      channelMessageId,
      userChatId,
      userMessageId,
    });
    if (msg?.media) {
      downloadTarget = msg.media;
      docSize = Number(msg.media?.document?.size ?? msg.file?.size ?? fileSize ?? 0);
    }
  }

  if (!downloadTarget) {
    throw new Error('تعذر فك معرّف الملف الكبير (file_id) أو العثور عليه في بروتوكول MTProto.');
  }

  const totalBytes = docSize > 0 ? docSize : null;

  // Google Drive Resumable Upload requires intermediate chunk sizes to be multiples of 256 KB.
  // 4 MB = 16 * 256 KB = 4,194,304 bytes.
  const CHUNK_SIZE = 4 * 1024 * 1024;
  let buffer = new Uint8Array(0);
  let offset = 0;
  let lastProgressUpdate = Date.now() - 4000;
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

    while (buffer.byteLength >= CHUNK_SIZE) {
      if (!totalBytes && buffer.byteLength === CHUNK_SIZE) {
        // Keep at least 1 byte when totalBytes is unknown so the final chunk closes the session
        break;
      }
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
      );
      offset += chunkCopy.byteLength;
      if (res.done) {
        finalResult = res;
      }

      if (statusChatId && statusMessageId && Date.now() - lastProgressUpdate > 5000) {
        lastProgressUpdate = Date.now();
        const mbDone = (offset / (1024 * 1024)).toFixed(1);
        const mbTotal = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
        const pct = totalBytes ? Math.min(99, Math.round((offset / totalBytes) * 100)) : '';
        await updateTelegramProgressMessage({
          botToken,
          chatId: statusChatId,
          messageId: statusMessageId,
          text: [
            '☁️ <b>جاري رفع الملف الكبير إلى حسابك في Google Drive...</b>',
            '━━━━━━━━━━━━━━━━━━',
            `📄 <b>الملف:</b> ${escapeHtml(filename)}`,
            `📊 <b>التقدم:</b> <code>${mbDone} MB / ${mbTotal} MB${pct ? ` (${pct}%)` : ''}</code>`,
            '',
            `1️⃣ <b>قناة البوت:</b> ✅ تم الرفع والنشر في قناة البوت (<code>${escapeHtml(channelId || '')}</code>)`,
            '2️⃣ <b>حساب Google Drive:</b> ⏳ جاري النقل المباشر للملف الكامل عبر MTProto...',
          ].join('\n'),
        });
      }
    }
  }

  // Flush the final remaining bytes
  if (!finalResult && buffer.byteLength > 0) {
    const finalTotal = offset + buffer.byteLength;
    const res = await putResumableChunk(
      sessionUri,
      buffer,
      offset,
      finalTotal,
      mimeType,
    );
    offset += buffer.byteLength;
    if (res.done) {
      finalResult = res;
    }
  }

  if (!finalResult?.ok) {
    throw new Error('لم يكتمل حفظ الملف الكبير في Google Drive.');
  }

  // Update the Telegram status message with the final Drive link and real file size!
  if (statusChatId && statusMessageId) {
    const sizeMb = (offset / (1024 * 1024)).toFixed(1);
    await updateTelegramProgressMessage({
      botToken,
      chatId: statusChatId,
      messageId: statusMessageId,
      text: [
        '☁️ <b>تقرير الرفع المزدوج التلقائي (القناة + Google Drive)</b>',
        '━━━━━━━━━━━━━━━━━━',
        `📄 <b>الملف:</b> ${escapeHtml(filename)} (<code>${sizeMb} MB</code>)`,
        '',
        `1️⃣ <b>قناة البوت:</b>\n✅ تم الرفع والنشر في قناة البوت (<code>${escapeHtml(channelId || '')}</code>)`,
        '',
        `2️⃣ <b>حساب Google Drive:</b>\n✅ تم رفع الملف الكامل بنجاح إلى Google Drive (<a href="${escapeHtml(finalResult.webViewLink)}">فتح الملف في Drive</a>)`,
      ].join('\n'),
      replyMarkup: {
        inline_keyboard: [
          [{ text: '📂 فتح الملف في Google Drive', url: finalResult.webViewLink }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }],
        ],
      },
    });
  }

  return finalResult;
}
