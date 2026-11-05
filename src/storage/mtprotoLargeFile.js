/**
 * MTProto Large-File Streamer (up to 2,000 MB / 2 GB) from Telegram -> Google Drive Resumable Upload.
 *
 * Bypasses the 20 MB HTTP limit of `api.telegram.org/bot.../getFile` by connecting
 * directly to Telegram's MTProto Data Centers using the bot's own `BOT_TOKEN`,
 * downloading the file in 512 KB MTProto parts, and streaming 4 MB chunks
 * (multiples of 256 KB) directly into a Google Drive Resumable Upload `sessionUri`.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const DEFAULT_API_ID = Number(process.env.TELEGRAM_API_ID) || 6;
const DEFAULT_API_HASH =
  process.env.TELEGRAM_API_HASH || 'eb06d4abfb49dc3eeb1aeb98ae0f581e';

// Cache authenticated MTProto bot clients by botToken so subsequent large files start instantly
const clientCache = new Map();

async function getMtprotoBotClient(botToken) {
  const cleanToken = String(botToken || '').trim();
  if (!cleanToken) throw new Error('Missing Telegram BOT_TOKEN for MTProto transfer');

  const existing = clientCache.get(cleanToken);
  if (existing && existing.connected) {
    return existing;
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, DEFAULT_API_ID, DEFAULT_API_HASH, {
    connectionRetries: 3,
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

async function updateTelegramProgressMessage({
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
  // 1. Try Archive Channel message first (bot is admin in archive channel)
  if (channelId && channelMessageId) {
    try {
      const peer = /^-\d+$/.test(String(channelId)) ? Number(channelId) : String(channelId);
      const msgs = await client.getMessages(peer, { ids: [Number(channelMessageId)] });
      if (msgs?.[0]?.media) return msgs[0];
    } catch {
      // Fallback to userChatId
    }
  }

  // 2. Try the user's private chat message
  if (userChatId && userMessageId) {
    try {
      const msgs = await client.getMessages(Number(userChatId), { ids: [Number(userMessageId)] });
      if (msgs?.[0]?.media) return msgs[0];
    } catch {
      // Fallback to scanning recent bot messages
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
  const msg = await locateMtprotoMediaMessage(client, {
    channelId,
    channelMessageId,
    userChatId,
    userMessageId,
  });

  if (!msg || !msg.media) {
    throw new Error('تعذر العثور على رسالة الملف في بروتوكول MTProto لتحميل الحجم الكبير.');
  }

  const docSize = Number(
    msg.media?.document?.size ??
      msg.file?.size ??
      fileSize ??
      0,
  );
  const totalBytes = docSize > 0 ? docSize : null;

  // Google Drive Resumable Upload requires chunk sizes to be multiples of 256 KB (except final chunk).
  // 4 MB = 16 * 256 KB = 4,194,304 bytes.
  const CHUNK_SIZE = 4 * 1024 * 1024;
  let buffer = new Uint8Array(0);
  let offset = 0;
  let lastProgressUpdate = Date.now();
  let finalResult = null;

  const appendBytes = (existing, incoming) => {
    const next = new Uint8Array(existing.byteLength + incoming.byteLength);
    next.set(existing, 0);
    next.set(incoming, existing.byteLength);
    return next;
  };

  for await (const part of client.iterDownload({
    file: msg.media,
    requestSize: 512 * 1024,
  })) {
    const partArray = part instanceof Uint8Array ? part : new Uint8Array(part);
    buffer = appendBytes(buffer, partArray);

    while (buffer.byteLength >= CHUNK_SIZE) {
      // If totalBytes is known and this exact CHUNK_SIZE happens to be the very end of the file, send it as final
      const isExactEnd = totalBytes && offset + CHUNK_SIZE === totalBytes;
      if (!totalBytes && buffer.byteLength === CHUNK_SIZE) {
        // Keep at least 1 byte if totalBytes is unknown so we know when the iterator finishes
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
        isExactEnd ? totalBytes : totalBytes,
        mimeType,
      );
      offset += chunkCopy.byteLength;
      if (res.done) {
        finalResult = res;
      }

      if (statusChatId && statusMessageId && Date.now() - lastProgressUpdate > 6000) {
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

  // If a status message in Telegram was waiting for background completion, update it with the final Drive link!
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
