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

  clearRuntimeDriveSession();
});
