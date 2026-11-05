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
  assert.match(result.summaryText, /تم الرفع والنشر في قناة البوت/);
  assert.match(result.summaryText, /تم الرفع إلى حسابك في Google Drive/);

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
  assert.match(secondResult.summaryText, /منع تكرار النشر/);

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
            return name.toLowerCase() === 'content-length' ? String(fakeVideoBytes.byteLength) : null;
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


