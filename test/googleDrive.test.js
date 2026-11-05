import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearRuntimeDriveSession,
  dualUploadMediaMessage,
  inferMediaFilenameAndMime,
  isDriveConfigured,
  isForwardedMessage,
  setRuntimeDriveSession,
} from '../src/storage/googleDrive.js';

test('infers Telegram media metadata and detects forwarded messages', () => {
  const message = {
    forward_origin: { type: 'channel' },
    caption: 'ملخص أناتومي',
    document: {
      file_id: 'doc-123',
      file_name: 'anatomy-summary.pdf',
      mime_type: 'application/pdf',
      file_size: 4096,
    },
  };

  assert.equal(isForwardedMessage(message), true);
  const media = inferMediaFilenameAndMime(message);
  assert.deepEqual(media, {
    fileId: 'doc-123',
    fileType: 'document',
    filename: 'anatomy-summary.pdf',
    mimeType: 'application/pdf',
    fileSize: 4096,
  });
});

test('dualUploadMediaMessage uploads to both Telegram channel and Google Drive', async () => {
  clearRuntimeDriveSession();
  setRuntimeDriveSession({
    accessToken: 'test-drive-token',
    userEmail: 'doctor@example.com',
  });
  assert.equal(isDriveConfigured({}), true);

  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).includes('/upload/drive/v3/files')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'drive-file-999',
            name: 'lecture.pdf',
            webViewLink: 'https://drive.google.com/file/d/drive-file-999/view',
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          files: [{ id: 'folder-123', name: 'MEDBOT Archive' }],
        };
      },
    };
  };

  const channelCalls = [];
  const fakeBot = {
    async sendDocument(chatId, fileId, extra) {
      channelCalls.push({ chatId, fileId, extra });
      return { message_id: 77 };
    },
    async downloadFileBytes(fileId) {
      assert.equal(fileId, 'tg-file-55');
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        filePath: 'documents/lecture.pdf',
      };
    },
  };

  const result = await dualUploadMediaMessage({
    message: {
      forward_from_chat: { id: -100111 },
      caption: 'محاضرة الباطنة',
      document: {
        file_id: 'tg-file-55',
        file_name: 'lecture.pdf',
        mime_type: 'application/pdf',
      },
    },
    bot: fakeBot,
    channelTarget: '@medbot_channel',
    env: {},
    fetchImpl: mockFetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.channelOutcome.ok, true);
  assert.equal(result.channelOutcome.messageId, 77);
  assert.equal(result.driveOutcome.ok, true);
  assert.equal(result.driveOutcome.id, 'drive-file-999');
  assert.equal(channelCalls.length, 1);
  assert.equal(channelCalls[0].chatId, '@medbot_channel');
  assert.equal(fetchCalls.length, 2);
  assert.match(result.summaryText, /تم النشر والأرشفة في قناة البوت/);
  assert.match(result.summaryText, /تم الرفع الكامل إلى Google Drive/);
  assert.match(result.summaryText, /مستند PDF \/ مقرر أو ملخص دراسي/);

  // Sending the same file a second time must NOT duplicate the post in the channel
  const secondResult = await dualUploadMediaMessage({
    message: {
      forward_from_chat: { id: -100111 },
      caption: 'محاضرة الباطنة',
      document: {
        file_id: 'tg-file-55',
        file_name: 'lecture.pdf',
        mime_type: 'application/pdf',
      },
    },
    bot: fakeBot,
    channelTarget: '@medbot_channel',
    env: {},
    fetchImpl: mockFetch,
  });

  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.channelOutcome.ok, true);
  assert.equal(secondResult.channelOutcome.skippedDuplicate, true);
  assert.equal(channelCalls.length, 1);
  assert.match(secondResult.summaryText, /منع التكرار/);

  clearRuntimeDriveSession();
});

test('streams >20MB large files as real binary via Google Drive Resumable Upload instead of HTML', async () => {
  clearRuntimeDriveSession();
  setRuntimeDriveSession({
    accessToken: 'test-drive-token-large',
    folderId: 'folder-large-123',
  });

  const uploadedPayloads = [];
  const mockFetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('upload_id=session-90')) {
      uploadedPayloads.push({ url: u, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'drive-mp4-90',
            name: 'episode_90.mp4',
            size: '157286400',
            webViewLink: 'https://drive.google.com/file/d/drive-mp4-90/view',
          };
        },
      };
    }
    if (u.includes('uploadType=resumable')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name.toLowerCase() === 'location'
              ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-90'
              : null;
          },
        },
        async text() {
          return '';
        },
      };
    }
    if (u.includes('t.me/public_series/450')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return '<video src="https://cdn4.telesco.pe/file/episode90.mp4"></video>';
        },
      };
    }
    if (u.includes('cdn4.telesco.pe/file/episode90.mp4')) {
      const fakeVideoBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            const key = name.toLowerCase();
            if (key === 'content-length') return '157286400';
            if (key === 'content-type') return 'video/mp4';
            return null;
          },
        },
        body: fakeVideoBytes,
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { files: [{ id: 'folder-large-123', name: 'MEDBOT Archive' }] };
      },
    };
  };

  const fakeBot = {
    async sendVideo(chatId, fileId) {
      return { message_id: 901, chat: { id: chatId }, video: { file_id: fileId } };
    },
    async downloadFileBytes() {
      throw new Error('Telegram API error (getFile): Bad Request: file is too big');
    },
  };

  const outcome = await dualUploadMediaMessage({
    message: {
      chat: { id: 12345, type: 'private' },
      forward_from_chat: { id: -100999888, username: 'public_series', type: 'channel' },
      forward_from_message_id: 450,
      caption: 'مسلسل محمد الفاتح - الحلقة 90',
      video: {
        file_id: 'big-video-90',
        file_unique_id: 'uniq-video-90',
        file_name: 'episode_90.mp4',
        mime_type: 'video/mp4',
        file_size: 157286400, // 150 MB (> 20 MB limit)
      },
    },
    bot: fakeBot,
    channelTarget: '-1004342544366',
    env: {},
    fetchImpl: mockFetch,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.driveOutcome.ok, true);
  assert.equal(outcome.driveOutcome.id, 'drive-mp4-90');
  assert.equal(outcome.driveOutcome.name, 'episode_90.mp4');
  assert.equal(uploadedPayloads.length, 1);
  assert.equal(uploadedPayloads[0].options.headers['Content-Type'], 'video/mp4');

  clearRuntimeDriveSession();
});

test('never uploads 12.4 KB JPEG thumbnail when Telegram embed says media is too big, queuing MTProto transfer instead', async () => {
  clearRuntimeDriveSession();
  setRuntimeDriveSession({
    accessToken: 'test-drive-token-mtproto',
    folderId: 'folder-large-123',
  });

  const sessionPuts = [];
  let savedJobsJson = null;
  const kvStore = new Map();
  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          if (sql.includes('pending_large_drive_jobs') && sql.includes('INSERT')) {
            savedJobsJson = args[0];
          }
          if (sql.includes('INSERT INTO bot_settings') && args.length >= 2) {
            kvStore.set(args[0], args[1]);
          }
          return {
            async first() {
              if (sql.includes('FROM bot_settings WHERE key = ?')) {
                const v = kvStore.get(args[0]);
                return v ? { value: v } : null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };

  const mockFetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('upload_id=session-mtproto-90')) {
      sessionPuts.push({ url: u, options });
      return { ok: true, status: 200, async json() { return {}; } };
    }
    if (u.includes('uploadType=resumable')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name.toLowerCase() === 'location'
              ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-mtproto-90'
              : null;
          },
        },
        async text() {
          return '';
        },
      };
    }
    if (u.includes('t.me/public_series/451')) {
      // Simulate Telegram web embed for >20MB video: has a 12.4 KB JPEG thumbnail and "This media is too big"
      return {
        ok: true,
        status: 200,
        async text() {
          return '<i class="tgme_widget_message_video_thumb" style="background-image:url(\'https://cdn4.telesco.pe/file/thumb12kb.jpg\')"></i><div class="message_media_not_supported_label">This media is too big</div>';
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { files: [] };
      },
    };
  };

  const sentMessages = [];
  const editedMessages = [];
  const deletedChannelMessages = [];
  const fakeBot = {
    async sendVideo(chatId, fileId) {
      return { message_id: 902, chat: { id: chatId }, video: { file_id: fileId } };
    },
    async sendMessage(chatId, text, extra) {
      sentMessages.push({ chatId, text, extra });
      return { message_id: 555 };
    },
    async editMessageText(chatId, messageId, text, extra) {
      editedMessages.push({ chatId, messageId, text, extra });
      return { message_id: messageId };
    },
    async deleteMessage(chatId, messageId) {
      deletedChannelMessages.push({ chatId, messageId });
      return true;
    },
  };

  const outcome = await dualUploadMediaMessage({
    message: {
      message_id: 400,
      from: { id: 777 },
      chat: { id: 12345, type: 'private' },
      forward_from_chat: { id: -100999888, username: 'public_series', type: 'channel' },
      forward_from_message_id: 451,
      caption: 'مسلسل محمد الفاتح - الحلقة 90 - الجودة 360p',
      video: {
        file_id: 'BAACAgIAAxkBAAIB',
        file_unique_id: 'uniq-video-90-mtproto',
        file_name: 'مسلسل_محمد_الفاتح_الحلقة_90_مترجمة_شوف_لايف.mp4',
        mime_type: 'video/mp4',
        file_size: 173015040,
      },
    },
    bot: fakeBot,
    channelTarget: '-1004342544366',
    db: mockDb,
    env: { BOT_TOKEN: '123456:ABC-DEF' },
    fetchImpl: mockFetch,
  });

  // 1. Must NOT have uploaded the 12.4 KB JPEG thumbnail to sessionUri
  assert.equal(sessionPuts.length, 0);
  // 2. Must have enqueued the MTProto job in D1 `pending_large_drive_jobs` with `sessionId`
  assert.equal(outcome.ok, true);
  assert.equal(outcome.alreadyReplied, true);
  assert.equal(outcome.driveOutcome.asyncTransfer, true);
  assert.ok(outcome.sessionId);
  assert.ok(savedJobsJson);
  const jobs = JSON.parse(savedJobsJson);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].fileId, 'BAACAgIAAxkBAAIB');
  assert.equal(jobs[0].statusMessageId, 555);
  assert.equal(jobs[0].sessionId, outcome.sessionId);

  // 3. Sent message must include detected media type, progress bar, and cancel/delete button
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /مقطع فيديو \/ محاضرة مسجلة/);
  assert.match(sentMessages[0].text, /░░░░░░░░░░ 0%/);
  const flatCallbacks = sentMessages[0].extra.reply_markup.inline_keyboard
    .flat()
    .map((b) => b.callback_data)
    .filter(Boolean);
  assert.ok(flatCallbacks.includes(`du_cancel:${outcome.sessionId}`));

  clearRuntimeDriveSession();
});




