/* global Request, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/worker.js';
import { getD1SchemaSql } from '../src/db/d1/migrations.js';
import { addFolder, getFolders, addContent, getFiles } from '../src/db/d1/registry.js';
import { get, run } from '../src/db/d1/core.js';
import {
  activateCollege,
  buildCollegeRuntimeEnv,
  buildCollegeSetupMenu,
  buildPlatformOwnerHub,
  createCollege,
  decryptSecretValue,
  encryptSecretValue,
  ensureCollegeSchema,
  ensureDefaultCollegeRegistered,
  ensurePlatformSchema,
  getCollege,
  getCollegeSecretsMap,
  handleCollegeSetupCallback,
  handleCollegeSetupText,
  handlePlatformOwnerCallback,
  handlePlatformOwnerText,
  listColleges,
  listPlatformAuditLogs,
  resolveCollegeDatabase,
  setCollegeArchiveChannel,
  setCollegeBotToken,
  setPlatformMandatoryChannel,
  suspendCollege,
  updateCollegeManager,
  validateCollegeConfiguration,
  verifyUserPlatformMembership,
} from '../src/platform/index.js';

/**
 * Create a real SQLite-backed Cloudflare D1 binding for integration testing.
 */
function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(getD1SchemaSql());

  function createPrepared(sql, boundParams = []) {
    return {
      bind(...params) {
        return createPrepared(sql, params.map((p) => (p === undefined ? null : p)));
      },
      async raw() {
        const stmt = sqlite.prepare(sql);
        stmt.setReturnArrays(true);
        return stmt.all(...boundParams);
      },
      async all() {
        const stmt = sqlite.prepare(sql);
        return { results: stmt.all(...boundParams) };
      },
      async first(colName) {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...boundParams);
        if (!row) return null;
        return colName ? row[colName] : row;
      },
      async run() {
        const stmt = sqlite.prepare(sql);
        const res = stmt.run(...boundParams);
        return {
          success: true,
          meta: {
            changes: Number(res.changes ?? 0),
            last_row_id: Number(res.lastInsertRowid ?? 0),
          },
          results: [],
        };
      },
    };
  }

  return {
    _sqlite: sqlite,
    prepare(sql) {
      return createPrepared(sql);
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { count: 1, duration: 1 };
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements) {
        out.push(await stmt.run());
      }
      return out;
    },
  };
}

/**
 * Intercept Telegram API calls during tests and return realistic responses.
 */
function createTelegramMock({
  botProfiles = {},
  channelMembers = new Map(),
} = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;

  function install() {
    globalThis.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      const match = urlStr.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/([A-Za-z0-9_]+)/);
      if (!match) {
        return originalFetch(url, options);
      }
      const [, token, method] = match;
      let payload = {};
      if (options.body) {
        try {
          payload = JSON.parse(String(options.body));
        } catch {
          payload = { raw: String(options.body) };
        }
      }
      calls.push({ token, method, payload });

      if (method === 'getMe') {
        const profile = botProfiles[token] || {
          id: 900100,
          is_bot: true,
          username: 'college_med_bot',
          first_name: 'College MedBot',
        };
        return new Response(JSON.stringify({ ok: true, result: profile }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'getChatMember') {
        const key = `${payload.chat_id}:${payload.user_id}`;
        const status = channelMembers.get(key) ?? 'left';
        return new Response(
          JSON.stringify({
            ok: true,
            result: { status, user: { id: payload.user_id } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'getChat') {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: payload.chat_id, title: 'Archive Channel', type: 'channel' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: calls.length + 100 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
  }

  function restore() {
    globalThis.fetch = originalFetch;
  }

  return { calls, install, restore, channelMembers };
}

test('1. Crypto Vault: encrypts and decrypts college bot tokens and AI keys at rest using AES-256-GCM', () => {
  const env = { PLATFORM_MASTER_KEY: 'unit-test-master-secret-key-2026' };
  const rawToken = '7123456789:AAH_test_college_bot_secret_token_xyz12';
  const encrypted = encryptSecretValue(rawToken, env);

  assert.ok(!encrypted.includes(rawToken));
  const parsed = JSON.parse(encrypted);
  assert.equal(parsed.v, 1);
  assert.ok(parsed.iv && parsed.tag && parsed.data);

  const decrypted = decryptSecretValue(encrypted, env);
  assert.equal(decrypted, rawToken);
});

test('2. Default College Bot Backward Compatibility: preserves existing default college data and functionality', async () => {
  const db = createSqliteD1();
  const env = {
    DB: db,
    ADMIN_ID: '1001',
    BOT_TOKEN: '111111111:AAH_default_bot_token_1234567890',
    MEDBOT_ARCHIVE_CHANNEL: '-100555000111',
  };

  // Pre-populate existing default college data before platform initialization
  const yearFolderId = await addFolder(db, null, 'السنة الأولى - الطب البشري', 'year');
  const fileId = await addContent(db, yearFolderId, 'محاضرة التشريح 1', 'tg_file_default_1', 'pdf');

  await ensurePlatformSchema(db);
  const defaultCollege = await ensureDefaultCollegeRegistered(db, env);

  assert.equal(defaultCollege.college_id, 'default');
  assert.equal(defaultCollege.status, 'active');

  // Verify existing folders and files in default college are completely untouched
  const rootFolders = await getFolders(db, null);
  assert.equal(rootFolders.length, 1);
  assert.equal(rootFolders[0][0], yearFolderId);
  assert.equal(rootFolders[0][1], 'السنة الأولى - الطب البشري');

  const files = await getFiles(db, yearFolderId);
  assert.equal(files.length, 1);
  assert.equal(files[0][0], fileId);
  assert.equal(files[0][1], 'محاضرة التشريح 1');
});

test('3. Strict Multi-College Data Isolation: College A, College B, and Default College never leak data', async () => {
  const db = createSqliteD1();
  const env = {
    DB: db,
    ADMIN_ID: '1001',
    BOT_TOKEN: '111111111:AAH_default_bot_token_1234567890',
    PLATFORM_MASTER_KEY: 'isolation-test-master-key',
  };

  await ensurePlatformSchema(db);
  await ensureDefaultCollegeRegistered(db, env);

  const collegeA = await createCollege(db, env, {
    slug: 'sanaa_med',
    nameAr: 'كلية الطب - جامعة صنعاء',
    managerTelegramId: 2001,
    actorId: 1001,
  });
  const collegeB = await createCollege(db, env, {
    slug: 'aden_pharm',
    nameAr: 'كلية الصيدلة - جامعة عدن',
    managerTelegramId: 2002,
    actorId: 1001,
  });

  const dbDefault = resolveCollegeDatabase(env, 'default');
  const dbA = resolveCollegeDatabase(env, collegeA);
  const dbB = resolveCollegeDatabase(env, collegeB);

  await ensureCollegeSchema(dbA);
  await ensureCollegeSchema(dbB);

  // Add distinct folders, files, admins, and settings in each college
  const folderDefault = await addFolder(dbDefault, null, 'مجلد الكلية الافتراضية', 'year');
  const folderA = await addFolder(dbA, null, 'مجلد طب صنعاء', 'year');
  const folderB = await addFolder(dbB, null, 'مجلد صيدلة عدن', 'year');

  await addContent(dbDefault, folderDefault, 'ملف افتراضي', 'file_def', 'pdf');
  await addContent(dbA, folderA, 'ملف طب صنعاء', 'file_a', 'pdf');
  await addContent(dbB, folderB, 'ملف صيدلة عدن', 'file_b', 'pdf');

  await run(dbA, 'INSERT INTO admins (telegram_id, username, role) VALUES (?, ?, ?)', [3001, 'sanaa_admin', 'admin']);
  await run(dbB, 'INSERT INTO admins (telegram_id, username, role) VALUES (?, ?, ?)', [3002, 'aden_admin', 'admin']);

  await run(dbA, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['welcome_msg', 'مرحباً بكم في طب صنعاء']);
  await run(dbB, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['welcome_msg', 'مرحباً بكم في صيدلة عدن']);

  // Verify strict isolation of folders
  const listDefault = await getFolders(dbDefault, null);
  const listA = await getFolders(dbA, null);
  const listB = await getFolders(dbB, null);

  assert.deepEqual(listDefault.map((r) => r[1]), ['مجلد الكلية الافتراضية']);
  assert.deepEqual(listA.map((r) => r[1]), ['مجلد طب صنعاء']);
  assert.deepEqual(listB.map((r) => r[1]), ['مجلد صيدلة عدن']);

  // Verify strict isolation of admins
  assert.equal(Boolean(await get(dbA, 'SELECT 1 FROM admins WHERE telegram_id = ?', [2001])), true); // Manager of College A
  assert.equal(Boolean(await get(dbA, 'SELECT 1 FROM admins WHERE telegram_id = ?', [3001])), true);
  assert.equal(Boolean(await get(dbA, 'SELECT 1 FROM admins WHERE telegram_id = ?', [2002])), false); // Manager of College B has 0 access in College A
  assert.equal(Boolean(await get(dbA, 'SELECT 1 FROM admins WHERE telegram_id = ?', [3002])), false);

  assert.equal(Boolean(await get(dbB, 'SELECT 1 FROM admins WHERE telegram_id = ?', [2002])), true); // Manager of College B
  assert.equal(Boolean(await get(dbB, 'SELECT 1 FROM admins WHERE telegram_id = ?', [3002])), true);
  assert.equal(Boolean(await get(dbB, 'SELECT 1 FROM admins WHERE telegram_id = ?', [2001])), false); // Manager of College A has 0 access in College B

  // Verify strict isolation of settings
  assert.equal((await get(dbA, 'SELECT value FROM settings WHERE key = ?', ['welcome_msg']))?.[0], 'مرحباً بكم في طب صنعاء');
  assert.equal((await get(dbB, 'SELECT value FROM settings WHERE key = ?', ['welcome_msg']))?.[0], 'مرحباً بكم في صيدلة عدن');
  assert.equal((await get(dbDefault, 'SELECT value FROM settings WHERE key = ?', ['welcome_msg'])) ?? null, null);
});

test('4. College Lifecycle, Managed Bot Provisioning, Self-Setup Wizard & Secret Management', async () => {
  const db = createSqliteD1();
  const collegeToken = '7999888777:AAH_managed_college_bot_token_abcdef123';
  const env = {
    DB: db,
    ADMIN_ID: '1001',
    PLATFORM_OWNER_ID: '1001',
    BOT_TOKEN: '111111111:AAH_default_bot_token_1234567890',
    PLATFORM_MASTER_KEY: 'lifecycle-master-key',
  };

  const tgMock = createTelegramMock({
    botProfiles: {
      [collegeToken]: {
        id: 7999888777,
        is_bot: true,
        username: 'taiz_med_bot',
        first_name: 'بوت كلية الطب تعز',
      },
    },
  });
  tgMock.install();

  try {
    await ensurePlatformSchema(db);
    const college = await createCollege(db, env, {
      slug: 'taiz_med',
      nameAr: 'كلية الطب - جامعة تعز',
      managerTelegramId: 5001,
      actorId: 1001,
    });

    assert.equal(college.status, 'pending_setup');

    // Attach Managed Bot Token and auto-configure webhook + bot profile commands
    const updatedWithToken = await setCollegeBotToken(
      db,
      env,
      college.college_id,
      collegeToken,
      1001,
      { webhookBaseUrl: 'https://medbot.example.workers.dev' },
    );
    assert.equal(updatedWithToken.bot_username, 'taiz_med_bot');
    assert.equal(
      updatedWithToken.webhook_url,
      'https://medbot.example.workers.dev/telegram/webhook/taiz_med',
    );

    // Verify setWebhook was called with college-specific webhook path and secret_token
    const webhookCall = tgMock.calls.find((c) => c.method === 'setWebhook');
    assert.ok(webhookCall);
    assert.equal(
      webhookCall.payload.url,
      'https://medbot.example.workers.dev/telegram/webhook/taiz_med',
    );
    assert.ok(webhookCall.payload.secret_token);

    const collegeDb = resolveCollegeDatabase(env, college.college_id);
    await ensureCollegeSchema(collegeDb);
    const collegeEnv = await buildCollegeRuntimeEnv(db, env, college.college_id);

    // College Manager (5001) opens Self-Setup Menu (/setup or cs_menu)
    const setupScreen = await buildCollegeSetupMenu(collegeDb, db, { id: 5001 }, collegeEnv);
    assert.match(setupScreen.text, /إعدادات الكلية والمفاتيح السرية/);
    assert.match(setupScreen.text, /taiz_med/);

    // Non-owner student (9999) is strictly denied access to College Setup
    const deniedScreen = await buildCollegeSetupMenu(collegeDb, db, { id: 9999 }, collegeEnv);
    assert.match(deniedScreen.text, /غير مصرح/);

    // College Manager sets GEMINI_API_KEY via Self-Setup Wizard (`cs_key_set:GEMINI_API_KEY`)
    const userData = {};
    let editedText = '';
    let repliedText = '';
    let deletedMsgId = null;

    const mockCtx = {
      db: collegeDb,
      from: { id: 5001 },
      chatId: 5001,
      data: 'cs_key_set:GEMINI_API_KEY',
      userData,
      answer: async () => {},
      editMessageText: async (text) => {
        editedText = text;
      },
      reply: async (text) => {
        repliedText = text;
      },
    };
    const mockBot = {
      deleteMessage: async (_chatId, msgId) => {
        deletedMsgId = msgId;
      },
    };

    await handleCollegeSetupCallback(mockCtx, mockBot, collegeEnv);
    assert.match(editedText, /GEMINI_API_KEY/);
    assert.equal(userData.cs_waiting_secret_name, 'GEMINI_API_KEY');

    mockCtx.text = 'AIzaSyTestCollegeGeminiSecretKey123456';
    mockCtx.message = { message_id: 777 };
    const handledKey = await handleCollegeSetupText(mockCtx, mockBot, collegeEnv);
    assert.equal(handledKey, true);
    assert.equal(deletedMsgId, 777); // Message containing API key must be auto-deleted!
    assert.match(repliedText, /تم تشفير وحفظ المفتاح/);

    // Configure archive channel
    await setCollegeArchiveChannel(db, collegeDb, env, college.college_id, '-100999888777', 5001);

    // Validate configuration and activate college
    const validation = await validateCollegeConfiguration(db, env, college.college_id);
    assert.equal(validation.ready, true);

    const actRes = await activateCollege(db, env, college.college_id, 5001);
    assert.equal(actRes.ok, true);
    assert.equal(actRes.college.status, 'active');

    // Verify runtime environment injects the decrypted college bot token, archive channel, and Gemini key
    const secretsMap = await getCollegeSecretsMap(collegeDb, env, college.college_id);
    assert.equal(secretsMap.GEMINI_API_KEY, 'AIzaSyTestCollegeGeminiSecretKey123456');

    const runtimeEnv = await buildCollegeRuntimeEnv(db, env, college.college_id);
    assert.equal(runtimeEnv.BOT_TOKEN, collegeToken);
    assert.equal(runtimeEnv.MEDBOT_ARCHIVE_CHANNEL, '-100999888777');
    assert.equal(runtimeEnv.COLLEGE_ID, 'taiz_med');
    assert.equal(runtimeEnv.GEMINI_API_KEY, 'AIzaSyTestCollegeGeminiSecretKey123456');

    // Suspend college and verify status
    const suspRes = await suspendCollege(db, env, college.college_id, 'صيانة دورية للكلية', 1001);
    assert.equal(suspRes.ok, true);
    assert.equal(suspRes.college.status, 'suspended');
  } finally {
    tgMock.restore();
  }
});

test('5. Mandatory Central Platform Channel Membership Gate: blocks non-members and unlocks after joining', async () => {
  const db = createSqliteD1();
  const defaultBotToken = '111111111:AAH_default_bot_token_1234567890';
  const defaultWebhookSecret = 'default-webhook-secret-token-2026';
  const env = {
    DB: db,
    ADMIN_ID: '1001',
    PLATFORM_OWNER_ID: '1001',
    BOT_TOKEN: defaultBotToken,
    TELEGRAM_WEBHOOK_SECRET: defaultWebhookSecret,
    PLATFORM_MASTER_KEY: 'membership-gate-key',
  };

  const tgMock = createTelegramMock({
    channelMembers: new Map([
      ['@medbot_central_channel:7777', 'left'],
    ]),
  });
  tgMock.install();

  try {
    await ensurePlatformSchema(db);
    await ensureDefaultCollegeRegistered(db, env);

    // Configure developer's central mandatory channel
    await setPlatformMandatoryChannel(db, {
      channelId: '@medbot_central_channel',
      channelUrl: 'https://t.me/medbot_central_channel',
      channelTitle: 'قناة منصة MEDBOT المركزية',
      enabled: true,
      actorId: 1001,
    });

    // 1. Student 7777 is NOT subscribed -> verifyUserPlatformMembership returns allowed: false
    const check1 = await verifyUserPlatformMembership({
      platformDb: db,
      userId: 7777,
      env,
    });
    assert.equal(check1.allowed, false);
    assert.equal(check1.config.channelId, '@medbot_central_channel');

    // 2. Student 7777 sends /start to the college bot webhook -> receives mandatory subscription gate
    tgMock.calls.length = 0;
    const reqBlocked = new Request('https://medbot.example.workers.dev/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': defaultWebhookSecret,
      },
      body: JSON.stringify({
        update_id: 501,
        message: {
          message_id: 10,
          from: { id: 7777, first_name: 'طالب' },
          chat: { id: 7777, type: 'private' },
          text: '/start',
        },
      }),
    });
    const resBlocked = await worker.fetch(reqBlocked, env, {});
    assert.equal(resBlocked.status, 200);

    const sentGateMsg = tgMock.calls.find((c) => c.method === 'sendMessage');
    assert.ok(sentGateMsg);
    assert.match(sentGateMsg.payload.text, /الاشتراك الإجباري في القناة المركزية/);

    // 3. Student 7777 joins the central channel and clicks "✅ اشتركت الآن — تحقّق من العضوية" (verify_platform_sub)
    tgMock.channelMembers.set('@medbot_central_channel:7777', 'member');
    tgMock.calls.length = 0;

    const reqVerify = new Request('https://medbot.example.workers.dev/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': defaultWebhookSecret,
      },
      body: JSON.stringify({
        update_id: 502,
        callback_query: {
          id: 'cbq_verify_1',
          from: { id: 7777, first_name: 'طالب' },
          message: { message_id: 11, chat: { id: 7777, type: 'private' } },
          data: 'verify_platform_sub',
        },
      }),
    });
    const resVerify = await worker.fetch(reqVerify, env, {});
    assert.equal(resVerify.status, 200);

    const editMsg = tgMock.calls.find((c) => c.method === 'editMessageText');
    assert.ok(editMsg);
    assert.match(editMsg.payload.text, /تم التحقق من اشتراكك بنجاح/);
  } finally {
    tgMock.restore();
  }
});

test('6. Central Platform Owner Bot & Multi-College Webhook Routing (/telegram/webhook/:collegeId)', async () => {
  const db = createSqliteD1();
  const collegeToken = '8111222333:AAH_college_webhook_token_xyz987654';
  const env = {
    DB: db,
    ADMIN_ID: '1001',
    PLATFORM_OWNER_ID: '1001',
    BOT_TOKEN: '111111111:AAH_default_bot_token_1234567890',
    PLATFORM_MASTER_KEY: 'webhook-routing-key',
  };

  const tgMock = createTelegramMock({
    botProfiles: {
      [collegeToken]: {
        id: 8111222333,
        is_bot: true,
        username: 'hadramout_med_bot',
        first_name: 'بوت طب حضرموت',
      },
    },
  });
  tgMock.install();

  try {
    await ensurePlatformSchema(db);
    await ensureDefaultCollegeRegistered(db, env);

    // Platform Owner (1001) opens Platform Owner Hub
    const hub = await buildPlatformOwnerHub(db, { id: 1001 }, env);
    assert.match(hub.text, /لوحة مالك المنصة المركزية/);

    // Platform Owner creates a new college via wizard (`pf_new`)
    const userData = {};
    let ownerReply = '';
    const ownerCtx = {
      db,
      from: { id: 1001 },
      chatId: 1001,
      data: 'pf_new',
      userData,
      answer: async () => {},
      editMessageText: async () => {},
      reply: async (text) => {
        ownerReply = text;
      },
    };
    const ownerBot = {
      deleteMessage: async () => {},
    };

    await handlePlatformOwnerCallback(
      ownerCtx,
      ownerBot,
      env,
      'https://medbot.example.workers.dev/platform/webhook',
    );
    assert.equal(userData.pf_new_college, true);

    ownerCtx.text = `hadramout_med | كلية الطب - جامعة حضرموت | 6001 | ${collegeToken}`;
    ownerCtx.message = { message_id: 888 };
    const createdHandled = await handlePlatformOwnerText(
      ownerCtx,
      ownerBot,
      env,
      'https://medbot.example.workers.dev/platform/webhook',
    );
    assert.equal(createdHandled, true);
    assert.match(ownerReply, /تم إنشاء الكلية وعزل قاعدة بياناتها بنجاح/);

    const collegeDb = resolveCollegeDatabase(env, 'hadramout_med');
    await setCollegeArchiveChannel(db, collegeDb, env, 'hadramout_med', '-100777666555', 6001);
    const actRes = await activateCollege(db, env, 'hadramout_med', 1001);
    assert.equal(actRes.ok, true);

    const college = await getCollege(db, 'hadramout_med', env);
    assert.equal(college.status, 'active');

    // Verify wrong webhook secret is rejected with 401 on /telegram/webhook/hadramout_med
    const badSecretReq = new Request(
      'https://medbot.example.workers.dev/telegram/webhook/hadramout_med',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
        },
        body: JSON.stringify({ update_id: 901 }),
      },
    );
    const badSecretRes = await worker.fetch(badSecretReq, env, {});
    assert.equal(badSecretRes.status, 401);

    // Verify valid webhook secret routes update to hadramout_med's isolated bot and database
    tgMock.calls.length = 0;
    const validReq = new Request(
      'https://medbot.example.workers.dev/telegram/webhook/hadramout_med',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': college.webhook_secret,
        },
        body: JSON.stringify({
          update_id: 902,
          message: {
            message_id: 55,
            from: { id: 6001, first_name: 'عميد حضرموت' },
            chat: { id: 6001, type: 'private' },
            text: '/start',
          },
        }),
      },
    );
    const validRes = await worker.fetch(validReq, env, {});
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.equal(validBody.ok, true);

    // Outgoing Telegram message must use hadramout_med's bot token, not the default bot token!
    const sentMsg = tgMock.calls.find((c) => c.method === 'sendMessage');
    assert.ok(sentMsg);
    assert.equal(sentMsg.token, collegeToken);

    // Verify Audit Logs captured all platform operations
    const logs = await listPlatformAuditLogs(db, { limit: 20 });
    assert.ok(logs.length >= 2);
    const actions = logs.map((l) => l.action);
    assert.ok(actions.includes('college.create'));
    assert.ok(actions.includes('college.activate'));

    // Verify updateCollegeManager works and logs audit
    const updatedCollege = await updateCollegeManager(db, env, 'hadramout_med', 6002, 'dean_new', 1001);
    assert.equal(updatedCollege.manager_telegram_id, 6002);

    const allColleges = await listColleges(db, env);
    assert.equal(allColleges.length, 2); // default + hadramout_med
  } finally {
    tgMock.restore();
  }
});

test('7. External Web Developer Control Plane (/dashboard & /api/platform/*) + In-Bot Settings Separation', async () => {
  const tgMock = createTelegramMock();
  tgMock.install();
  try {
    const db = createSqliteD1();
    await ensurePlatformSchema(db);
    const env = {
      DB: db,
      PLATFORM_DB: db,
      PLATFORM_OWNER_ID: '1001',
      ADMIN_ID: '1001',
      TELEGRAM_BOT_TOKEN: '111111111:AAH_DEFAULT_BOT_TOKEN_12345678901234',
      BOT_TOKEN: '111111111:AAH_DEFAULT_BOT_TOKEN_12345678901234',
      TELEGRAM_WEBHOOK_SECRET: 'default-secret-123',
      PLATFORM_MASTER_KEY: 'test-master-key-for-web-portal',
    };

    // 1. Verify GET /dashboard returns the external developer web portal HTML
    const dashReq = new Request('https://medbot.example.workers.dev/dashboard', {
      method: 'GET',
      headers: { Accept: 'text/html' },
    });
    const dashRes = await worker.fetch(dashReq, env);
    assert.equal(dashRes.status, 200);
    const dashHtml = await dashRes.text();
    assert.match(dashHtml, /MEDBOT Control Plane/);
    assert.match(dashHtml, /إنشاء وتجهيز بوت كلية جديد/);

    // 2. Provision a new college via POST /api/platform/colleges from the Web Portal
    const createReq = new Request('https://medbot.example.workers.dev/api/platform/colleges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'dentistry_ibb',
        name: 'كلية طب الأسنان - جامعة إب',
        managerId: 7701,
        managerUsername: 'dent_dean',
        botToken: '777777777:AAH_DENTISTRY_BOT_TOKEN_123456789012',
        autoActivate: true,
      }),
    });
    const createRes = await worker.fetch(createReq, env);
    assert.equal(createRes.status, 200);
    const createData = await createRes.json();
    assert.equal(createData.ok, true);
    assert.equal(createData.college.college_id, 'dentistry_ibb');
    assert.equal(createData.college.status, 'active');

    // 3. Verify GET /api/platform/overview lists default + dentistry_ibb
    const overviewReq = new Request('https://medbot.example.workers.dev/api/platform/overview');
    const overviewRes = await worker.fetch(overviewReq, env);
    assert.equal(overviewRes.status, 200);
    const overviewData = await overviewRes.json();
    assert.equal(overviewData.ok, true);
    assert.equal(overviewData.colleges.length, 2);

    // 4. Verify in-bot settings (`admin_settings`) has Channel & AI Keys setup while bot menus do NOT expose `pf_hub`
    const { buildWorkerAdmin, buildWorkerSettingsAdmin } = await import('../src/telegram/workerAdmin.js');
    const { buildWorkerHome } = await import('../src/telegram/workerHome.js');

    const dentDb = resolveCollegeDatabase(env, 'dentistry_ibb');
    const homeScreen = await buildWorkerHome(dentDb, { id: 7701, first_name: 'عميد الأسنان' });
    const homeCallbacks = homeScreen.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(!homeCallbacks.includes('pf_hub'), 'pf_hub must not appear in Telegram /start menu');

    const adminScreen = await buildWorkerAdmin(dentDb, { id: 7701 });
    const adminCallbacks = adminScreen.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(!adminCallbacks.includes('pf_hub'), 'pf_hub must not appear in Telegram admin menu');
    assert.ok(adminCallbacks.includes('admin_settings'), 'admin_settings must appear in Telegram admin menu');

    const settingsScreen = await buildWorkerSettingsAdmin(dentDb, { id: 7701 });
    const settingsCallbacks = settingsScreen.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(settingsCallbacks.includes('cs_archive'), 'Channel setup button must be inside bot settings');
    assert.ok(settingsCallbacks.includes('cs_menu'), 'AI keys menu button must be inside bot settings');
    assert.ok(settingsCallbacks.includes('cs_key_set:GEMINI_API_KEY'), 'Gemini key button must be inside bot settings');
    assert.ok(settingsCallbacks.includes('cs_key_set:GROQ_API_KEY'), 'Groq key button must be inside bot settings');
  } finally {
    tgMock.restore();
  }
});

test('8. Vercel Serverless Entrypoints (/api/index.js & /src/index.js) support all Vercel runtime contracts without node:sqlite', async () => {
  const tgMock = createTelegramMock();
  tgMock.install();
  try {
    const { default: vercelHandler } = await import('../api/index.js');
    const { default: nodePresetHandler } = await import('../src/index.js');
    assert.equal(vercelHandler, nodePresetHandler);

    // Contract A: @vercel/node enhanced res (.status().send())
    function createVercelMockRes() {
      const headers = {};
      return {
        statusCode: 200,
        headers,
        body: '',
        setHeader(k, v) {
          headers[k.toLowerCase()] = v;
        },
        status(code) {
          this.statusCode = code;
          return this;
        },
        send(payload) {
          this.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
          return this;
        },
      };
    }

    const resRoot = createVercelMockRes();
    await vercelHandler(
      {
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html,application/xhtml+xml', host: 'medbot-js.vercel.app' },
      },
      resRoot,
    );
    assert.equal(resRoot.statusCode, 200);
    assert.match(resRoot.body, /MEDBOT Control Plane/);

    // Contract B: Raw Node http.ServerResponse (NO .status() or .send() methods!)
    function createRawNodeRes() {
      const headers = {};
      return {
        statusCode: 200,
        headersSent: false,
        headers,
        body: '',
        setHeader(k, v) {
          headers[k.toLowerCase()] = v;
        },
        writeHead(code, hdrs = {}) {
          this.statusCode = code;
          this.headersSent = true;
          for (const [k, v] of Object.entries(hdrs)) {
            headers[k.toLowerCase()] = v;
          }
        },
        end(payload = '') {
          this.body = String(payload);
        },
      };
    }

    const rawRes = createRawNodeRes();
    await nodePresetHandler(
      {
        method: 'GET',
        url: '/api/platform/overview',
        headers: { accept: 'application/json', host: 'medbot-js.vercel.app' },
      },
      rawRes,
    );
    assert.equal(rawRes.statusCode, 200);
    const overviewJson = JSON.parse(rawRes.body);
    assert.equal(overviewJson.ok, true);
    assert.ok(overviewJson.colleges.some((c) => c.college_id === 'default'));

    // Contract C: Web Standard Fetch Request (res is undefined, req.url is full https:// URL)
    const webRes = await nodePresetHandler(
      new Request('https://medbot-js.vercel.app/dashboard', {
        method: 'GET',
        headers: { Accept: 'text/html' },
      }),
    );
    assert.equal(webRes.status, 200);
    const webHtml = await webRes.text();
    assert.match(webHtml, /MEDBOT Control Plane/);
  } finally {
    tgMock.restore();
  }
});
