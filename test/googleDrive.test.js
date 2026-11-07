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
  assert.doesNotMatch(result.summaryText, /Google Drive/);
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

  // 3. Sent message must include detected media type, omit Google Drive UI, and include cancel/delete button
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /مقطع فيديو \/ محاضرة مسجلة/);
  assert.doesNotMatch(sentMessages[0].text, /Google Drive/);
  const flatCallbacks = sentMessages[0].extra.reply_markup.inline_keyboard
    .flat()
    .map((b) => b.callback_data)
    .filter(Boolean);
  assert.ok(flatCallbacks.includes(`du_cancel:${outcome.sessionId}`));

  clearRuntimeDriveSession();
});

test('startInteractiveUploadWizard displays destination picker and transitions through name, hierarchy, branch, and data type', async () => {
  const {
    startInteractiveUploadWizard,
    handleDualUploadCallback,
    handleDualUploadNewFolderText,
    getUploadSession,
  } = await import('../src/storage/dualUploadInteractive.js');

  const foldersTable = [
    { id: 1, parent_id: null, name: 'مستوى أول', node_type: 'level', keywords: 'سنة أولى' },
    { id: 2, parent_id: 1, name: 'بلوك القلب والأوعية (CVS)', node_type: 'block', keywords: 'cvs قلب' },
    { id: 3, parent_id: 2, name: 'أناتومي', node_type: 'subject', keywords: 'تشريح anatomy' },
  ];
  let nextFolderId = 10;
  const contentTable = [];

  const mockDb = {
    prepare(sql) {
      const execBound = (boundArgs = []) => {
        const getResults = () => {
          if (sql.includes('FROM content WHERE folder_id = ?')) {
            const row = contentTable.find(
              (c) => c.folder_id === Number(boundArgs[0]) && c.file_id === String(boundArgs[1]),
            );
            return row ? [[row.id]] : [];
          }
          if (sql.includes('FROM folders WHERE id = ?')) {
            const f = foldersTable.find((x) => x.id === Number(boundArgs[0]));
            return f ? [[f.id, f.parent_id, f.name, f.node_type, f.keywords]] : [];
          }
          if (sql.includes('FROM folders WHERE parent_id = ?')) {
            const pid = Number(boundArgs[0]);
            return foldersTable
              .filter((x) => x.parent_id === pid)
              .map((x) => [x.id, x.name, x.node_type]);
          }
          if (sql.includes('SELECT id, parent_id, name, node_type FROM folders') || sql.includes('FROM folders ORDER BY id ASC')) {
            return foldersTable.map((x) => [x.id, x.parent_id, x.name, x.node_type, x.keywords]);
          }
          if (sql.includes('parent_id IS NULL OR parent_id = 0')) {
            return foldersTable
              .filter((x) => !x.parent_id)
              .map((x) => [x.id, x.name, x.node_type]);
          }
          return [];
        };

        return {
          raw: async () => getResults(),
          all: async () => ({ results: getResults() }),
          first: async () => {
            const r = getResults();
            return r.length ? r[0] : null;
          },
          run: async () => {
            if (sql.includes('INSERT INTO folders')) {
              const newId = nextFolderId++;
              foldersTable.push({
                id: newId,
                parent_id: boundArgs[0],
                name: boundArgs[1],
                node_type: boundArgs[2],
                keywords: '',
              });
              return { success: true, meta: { last_row_id: newId } };
            }
            if (sql.includes('UPDATE folders SET name = ?')) {
              const newName = boundArgs[0];
              const fid = boundArgs[1];
              const f = foldersTable.find((x) => x.id === fid);
              if (f) f.name = newName;
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes('INSERT INTO content')) {
              const newId = contentTable.length + 1;
              contentTable.push({
                id: newId,
                folder_id: boundArgs[0],
                title: boundArgs[1],
                file_id: boundArgs[2],
                file_type: boundArgs[3],
              });
              return { success: true, meta: { last_row_id: newId } };
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
      };

      return {
        bind(...args) {
          return execBound(args);
        },
        raw: async () => execBound([]).raw(),
        all: async () => execBound([]).all(),
        first: async () => execBound([]).first(),
        run: async () => execBound([]).run(),
      };
    },
  };

  const fakeBot = {
    async sendMessage(_chatId, _text, _opts) {
      return { message_id: 888 };
    },
    async editMessageText(_text, opts = {}) {
      return { message_id: opts.message_id || 888 };
    },
  };

  // 1. Initiate wizard with a message
  const wiz = await startInteractiveUploadWizard({
    bot: fakeBot,
    message: {
      message_id: 101,
      chat: { id: 7001, type: 'private' },
      from: { id: 7001 },
      document: {
        file_id: 'anatomy-doc-1',
        file_name: 'مقرر_التشريح_العملي.pdf',
        mime_type: 'application/pdf',
        file_size: 5000000,
      },
    },
    channelTarget: '-1004342544366',
    db: mockDb,
    env: {},
  });

  assert.equal(wiz.ok, true);
  assert.equal(wiz.session.step, 'choose_dest');
  assert.match(wiz.summaryText, /تحديد وجهات الرفع أولاً/);

  // Check buttons contain: All (Bot + Channel), Archive Channel, Bot — and NO Google Drive button
  const buttons1 = wiz.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons1.includes(`du_dest:${wiz.sessionId}:all`));
  assert.ok(!buttons1.includes(`du_dest:${wiz.sessionId}:drive`));
  assert.ok(buttons1.includes(`du_dest:${wiz.sessionId}:channel`));
  assert.ok(buttons1.includes(`du_dest:${wiz.sessionId}:bot`));

  // 2. Click 'all' -> transitions to step 2: 'edit_name'
  const mockCtx = {
    db: mockDb,
    chatId: 7001,
    messageId: 888,
    from: { id: 7001 },
    userData: {},
    async answer() {},
    async editMessageText(text, opts) {
      return { text, opts };
    },
    async reply(text, opts) {
      return { text, opts, message_id: 889 };
    },
  };

  const resDest = await handleDualUploadCallback(mockCtx, `du_dest:${wiz.sessionId}:all`, fakeBot, {});
  assert.match(resDest.text, /تحديد الاسم/);

  // 3. User sends updated name in chat
  const resName = await handleDualUploadNewFolderText(mockCtx, 'محاضرة التشريح العملي الأولى', fakeBot, {});
  assert.equal(resName.ok, true);
  const sAfterName = await getUploadSession(mockDb, wiz.sessionId);
  assert.equal(sAfterName.title, 'محاضرة التشريح العملي الأولى');
  assert.equal(sAfterName.step, 'pick_folder');

  // 4. Click 'du_fnew' to create a new section under subject 3 (أناتومي)
  const resNewF = await handleDualUploadCallback(mockCtx, `du_fnew:${wiz.sessionId}:3`, fakeBot, {});
  assert.match(resNewF.text, /إنشاء قسم فرعي جديد/);

  // 5. Send name of the new section
  const resSectionText = await handleDualUploadNewFolderText(mockCtx, 'تحديد عظام الأطراف', fakeBot, {});
  assert.match(resSectionText.text, /اختر نوع القسم الجديد:/);

  // 6. Select node type: 'summaries' (ملخصات)
  const resFtype = await handleDualUploadCallback(mockCtx, `du_ftype:${wiz.sessionId}:3:summaries`, fakeBot, {});
  assert.match(resFtype.text, /تحديد عظام الأطراف/);
  const sAfterFtype = await getUploadSession(mockDb, wiz.sessionId);
  assert.equal(sAfterFtype.step, 'pick_folder');
  assert.ok(sAfterFtype.browseFolderId > 0);

  // 7. Click 'du_select_f' to confirm placing file in this section
  const resSelect = await handleDualUploadCallback(mockCtx, `du_select_f:${wiz.sessionId}:${sAfterFtype.browseFolderId}`, fakeBot, {});
  assert.match(resSelect.text, /جاهز للإرسال/);
  const sAfterSelect = await getUploadSession(mockDb, wiz.sessionId);
  assert.equal(sAfterSelect.step, 'confirm_send');
  assert.equal(sAfterSelect.selectedFolderId, sAfterFtype.browseFolderId);

  // 8. Submit upload: execute across Bot + Archive Channel
  const resSubmit = await handleDualUploadCallback(mockCtx, `du_submit:${wiz.sessionId}`, fakeBot, {});
  assert.match(resSubmit.text, /تقرير رفع الداتا/);
  assert.doesNotMatch(resSubmit.text, /Google Drive/);
  const sFinal = await getUploadSession(mockDb, wiz.sessionId);
  assert.equal(sFinal.step, 'executing');
  assert.ok(sFinal.contentId > 0);
  assert.equal(contentTable.length, 1);
  assert.equal(contentTable[0].title, 'محاضرة التشريح العملي الأولى');
});

test('dualUploadInteractive supports Admin creation of Level, Block, Subject, and renaming folders', async () => {
  const {
    startInteractiveUploadWizard,
    handleDualUploadCallback,
    handleDualUploadNewFolderText,
    getUploadSession,
  } = await import('../src/storage/dualUploadInteractive.js');

  const foldersTable = [
    { id: 1, parent_id: null, name: 'المستوى الأول', node_type: 'level', keywords: '' },
  ];
  const contentTable = [];
  let nextFolderId = 20;

  const mockDb = {
    prepare(sql) {
      const execBound = (boundArgs = []) => {
        const getResults = () => {
          if (sql.includes('SELECT id, parent_id, name, node_type FROM folders WHERE id = ?')) {
            const f = foldersTable.find((x) => x.id === boundArgs[0]);
            return f ? [[f.id, f.parent_id, f.name, f.node_type]] : [];
          }
          if (sql.includes('SELECT id, parent_id, name, node_type FROM folders')) {
            return foldersTable.map((x) => [x.id, x.parent_id, x.name, x.node_type]);
          }
          if (sql.includes('WHERE parent_id = ?')) {
            return foldersTable
              .filter((x) => x.parent_id === boundArgs[0])
              .map((x) => [x.id, x.name, x.node_type]);
          }
          if (sql.includes('parent_id IS NULL OR parent_id = 0')) {
            return foldersTable
              .filter((x) => !x.parent_id)
              .map((x) => [x.id, x.name, x.node_type]);
          }
          return [];
        };

        return {
          raw: async () => getResults(),
          all: async () => ({ results: getResults() }),
          first: async () => {
            const r = getResults();
            return r.length ? r[0] : null;
          },
          run: async () => {
            if (sql.includes('INSERT INTO folders')) {
              const newId = nextFolderId++;
              foldersTable.push({
                id: newId,
                parent_id: boundArgs[0],
                name: boundArgs[1],
                node_type: boundArgs[2],
                keywords: '',
              });
              return { success: true, meta: { last_row_id: newId } };
            }
            if (sql.includes('UPDATE folders SET name = ?')) {
              const newName = boundArgs[0];
              const fid = boundArgs[1];
              const f = foldersTable.find((x) => x.id === fid);
              if (f) f.name = newName;
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes('INSERT INTO content')) {
              const newId = contentTable.length + 1;
              contentTable.push({
                id: newId,
                folder_id: boundArgs[0],
                title: boundArgs[1],
                file_id: boundArgs[2],
                file_type: boundArgs[3],
              });
              return { success: true, meta: { last_row_id: newId } };
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
      };

      return {
        bind(...args) {
          return execBound(args);
        },
        raw: async () => execBound([]).raw(),
        all: async () => execBound([]).all(),
        first: async () => execBound([]).first(),
        run: async () => execBound([]).run(),
      };
    },
  };

  const fakeBot = {
    async sendMessage(_chatId, _text, _opts) {
      return { message_id: 888 };
    },
    async editMessageText(_text, opts = {}) {
      return { message_id: opts.message_id || 888 };
    },
  };

  // Create wizard session
  const wiz = await startInteractiveUploadWizard({
    bot: fakeBot,
    message: {
      message_id: 202,
      chat: { id: 7002, type: 'private' },
      from: { id: 7002 },
      document: {
        file_id: 'video-cardio-1',
        file_name: 'شرح_تخطيط_القلب_ECG.mp4',
        mime_type: 'video/mp4',
        file_size: 25000000,
      },
    },
    channelTarget: '-1004342544366',
    db: mockDb,
    env: {},
  });

  const mockCtx = {
    db: mockDb,
    chatId: 7002,
    messageId: 999,
    from: { id: 7002 },
    userData: {},
    async answer() {},
    async editMessageText(text, opts) {
      return { text, opts };
    },
    async reply(text, opts) {
      return { text, opts, message_id: 1000 };
    },
  };

  // Choose destination: Bot
  await handleDualUploadCallback(mockCtx, `du_dest:${wiz.sessionId}:bot`, fakeBot, {});
  await handleDualUploadCallback(mockCtx, `du_name_ok:${wiz.sessionId}`, fakeBot, {});

  // 1. Create a Subfolder / Block inside Level 1: `du_fnew:sessionId:1`
  const resBlockPrompt = await handleDualUploadCallback(mockCtx, `du_fnew:${wiz.sessionId}:1`, fakeBot, {});
  assert.match(resBlockPrompt.text, /إنشاء قسم فرعي جديد/);

  const resBlockTypeName = await handleDualUploadNewFolderText(mockCtx, 'بلوك القلب والأوعية CVS', fakeBot, {});
  assert.match(resBlockTypeName.text, /اختر نوع القسم الجديد:/);

  await handleDualUploadCallback(mockCtx, `du_ftype:${wiz.sessionId}:1:general`, fakeBot, {});
  const blockFolder = foldersTable.find((f) => f.name === 'بلوك القلب والأوعية CVS');
  assert.ok(blockFolder);
  assert.equal(blockFolder.parent_id, 1);

  // 2. Rename folder: `du_frename:sessionId:1`
  const resRenamePrompt = await handleDualUploadCallback(mockCtx, `du_frename:${wiz.sessionId}:1`, fakeBot, {});
  assert.match(resRenamePrompt.text, /إعادة تسمية القسم/);

  const resRenameDone = await handleDualUploadNewFolderText(mockCtx, 'السنة الأولى (الطب البشري)', fakeBot, {});
  assert.equal(resRenameDone.ok, true);
  const levelFolder = foldersTable.find((f) => f.id === 1);
  assert.equal(levelFolder.name, 'السنة الأولى (الطب البشري)');

  // 3. Select folder to place the file
  const resSelect = await handleDualUploadCallback(mockCtx, `du_select_f:${wiz.sessionId}:${blockFolder.id}`, fakeBot, {});
  assert.match(resSelect.text, /جاهز للإرسال/);

  // 4. Submit upload
  await handleDualUploadCallback(mockCtx, `du_submit:${wiz.sessionId}`, fakeBot, {});
  const sFinal = await getUploadSession(mockDb, wiz.sessionId);
  assert.equal(sFinal.step, 'executing');
  assert.ok(sFinal.contentId > 0);
  assert.equal(contentTable.length, 1);
  assert.equal(contentTable[0].file_type, 'video');
});

test('Admin panel excludes Google Drive settings, keeps Archive Channel & Folders, and blocks regular users', async () => {
  const { buildWorkerAdmin } = await import('../src/telegram/workerAdmin.js');
  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async raw() {
              if (sql.includes('FROM admins')) {
                return Number(args[0]) === 1 ? [['owner', '']] : [];
              }
              return [[0]];
            },
            async first() {
              if (sql.includes('FROM admins')) {
                return Number(args[0]) === 1 ? { role: 'owner', permissions: '' } : null;
              }
              return { count: 0 };
            },
            async all() {
              return { results: [] };
            },
          };
        },
        async raw() {
          return [[0]];
        },
        async first() {
          return { count: 0 };
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };

  // 1. Authorized admin/owner sees Folders & Archive Channel, and NO Google Drive button
  const adminPanel = await buildWorkerAdmin(mockDb, { id: 1 });
  const callbacks = adminPanel.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  const labels = adminPanel.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(!callbacks.includes('drive_menu'));
  assert.ok(!labels.some((l) => l.includes('Google Drive')));
  assert.ok(callbacks.includes('admin_folders'));
  assert.ok(callbacks.includes('admin_archive'));

  // 2. Regular student user is strictly blocked from admin panel
  const studentAttempt = await buildWorkerAdmin(mockDb, { id: 99999 });
  assert.match(studentAttempt.text, /مخصصة للمشرفين المعتمدين فقط/);
  const studentCallbacks = studentAttempt.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(studentCallbacks, ['home']);
});







