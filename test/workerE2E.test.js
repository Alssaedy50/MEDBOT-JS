/* global Request, Response */
/**
 * End-to-end Cloudflare Worker parity coverage.
 *
 * Unlike the unit tests that stub the D1 binding, this suite drives the real
 * Worker `fetch()` entry point against a real SQLite database wired through the
 * D1 prepared-statement contract, and a real HTTP `fetch` for the Telegram Bot
 * API boundary. Every assertion therefore exercises production code paths:
 * webhook parsing, D1 idempotency, the dispatcher, the handlers and the
 * rendered Telegram payloads that a student or admin would actually see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/worker.js';
import { getD1SchemaSql } from '../src/db/d1/migrations.js';
import { ensureConfiguredAdmin } from '../src/db/d1/admins.js';
import { get, run } from '../src/db/d1/core.js';

const WEBHOOK_SECRET = 'test-webhook-secret';
const BOT_TOKEN = '123456:TEST_BOT_TOKEN';

/**
 * A D1 binding backed by a real SQLite database.
 *
 * `raw()` returns positional arrays because that is the contract the MEDBOT
 * data layer relies on (`src/db/d1/core.js`).
 */
function createD1Binding() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(getD1SchemaSql());

  let updateId = 0;
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let params = [];
      return {
        bind(...next) {
          params = next;
          return this;
        },
        async raw() {
          statement.setReturnArrays(true);
          return statement.all(...params);
        },
        async first() {
          statement.setReturnArrays(false);
          return statement.get(...params) ?? null;
        },
        async all() {
          statement.setReturnArrays(false);
          return { results: statement.all(...params) };
        },
        async run() {
          const result = statement.run(...params);
          return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
        },
      };
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
    async batch(statements) {
      return statements.map((statement) => statement.run());
    },
    // Unused by the assertions, but part of the D1 surface.
    nextUpdateId() {
      updateId += 1;
      return updateId;
    },
  };
}

/**
 * Intercept the Telegram Bot API at the network boundary.
 *
 * The Worker builds its own bot transport with `globalThis.fetch`, so replacing
 * `fetch` captures the exact JSON payloads that would be sent to Telegram. This
 * is a real transport boundary, not a mock of the logic under test.
 */
function captureTelegramCalls() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    const payload = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, payload });
    if (method === 'sendMessage' || method === 'editMessageText') {
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    sentTexts: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text ?? ''),
    editedTexts: () => calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text ?? ''),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function env(db) {
  return { DB: db, TELEGRAM_BOT_TOKEN: BOT_TOKEN, MEDBOT_SECRETS_KEY: 'test-vault-key-stable', TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, ADMIN_ID: '500' };
}

async function post(db, update) {
  const request = new Request('https://staging.example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
  return worker.fetch(request, env(db));
}

let seq = 1000;
function nextUpdate(messageOrCallback) {
  seq += 1;
  return { update_id: seq, ...messageOrCallback };
}

function commandUpdate(userId, text) {
  return nextUpdate({ message: { message_id: seq, chat: { id: userId }, from: { id: userId, first_name: 'Ali', username: 'ali' }, text } });
}

function callbackUpdate(userId, data) {
  return nextUpdate({
    callback_query: {
      id: String(seq),
      from: { id: userId, first_name: 'Ali', username: 'ali' },
      message: { message_id: seq, chat: { id: userId } },
      data,
    },
  });
}

async function seedOwner(db, id = 500) {
  await ensureConfiguredAdmin(db, id, 'owner');
}

test('staging health endpoint reports the D1 binding', async () => {
  const db = createD1Binding();
  const response = await worker.fetch(new Request('https://staging.example.com/health'), env(db));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.database, 'd1-bound');
});

test('webhook rejects a request that omits the secret token header', async () => {
  const db = createD1Binding();
  const response = await worker.fetch(
    new Request('https://staging.example.com/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(commandUpdate(1, '/start')),
    }),
    env(db),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'invalid_webhook_secret');
});

test('webhook refuses to run when the server secret is not configured', async () => {
  const db = createD1Binding();
  const response = await worker.fetch(
    new Request('https://staging.example.com/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: JSON.stringify(commandUpdate(1, '/start')),
    }),
    { DB: db, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'missing_webhook_secret');
});

test('webhook rejects a wrong secret token', async () => {
  const db = createD1Binding();
  const response = await worker.fetch(
    new Request('https://staging.example.com/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
      body: JSON.stringify(commandUpdate(1, '/start')),
    }),
    env(db),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'invalid_webhook_secret');
});

test('/whoami reports the Telegram id and the real permission role', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    const response = await post(db, commandUpdate(500, '/whoami'));
    assert.equal(response.status, 200);
    const [text] = telegram.sentTexts();
    assert.ok(text.includes('500'), `expected the user id in ${text}`);
    assert.ok(text.includes('owner'), `expected the real role in ${text}`);
    assert.ok(!text.includes('\\n'), 'the reply must contain real newlines, not literal backslash-n');
  } finally {
    telegram.restore();
  }
});

test('/contact renders the student contact menu without a dead end', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    await post(db, commandUpdate(77, '/contact'));
    const [text] = telegram.sentTexts();
    assert.ok(text.length > 0);
    assert.ok(!text.includes('\\n'), 'contact text must use real newlines');
  } finally {
    telegram.restore();
  }
});

test('/cancel clears the in-flight state and returns a working home button', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    // Start the real contact workflow, then cancel it.
    await post(db, callbackUpdate(77, 'msg_cat:message'));
    const response = await post(db, commandUpdate(77, '/cancel'));
    assert.equal(response.status, 200);
    const texts = telegram.sentTexts();
    assert.ok(texts.some((t) => t.includes('إلغاء')), `expected a cancel confirmation, got ${JSON.stringify(texts)}`);

    // State must be cleared: a plain message no longer continues the workflow.
    telegram.calls.length = 0;
    await post(db, commandUpdate(77, 'نص عادي'));
    const after = telegram.sentTexts();
    assert.ok(!after.some((t) => t.includes('تم استلام رسالتك')), 'cancel must drop the contact workflow state');
  } finally {
    telegram.restore();
  }
});

test('/ask without a question opens the AI chat state instead of failing', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    const response = await post(db, commandUpdate(88, '/ask'));
    assert.equal(response.status, 200);
    const [text] = telegram.sentTexts();
    assert.ok(text.includes('المساعد الذكي'), `expected the assistant prompt, got ${text}`);
    assert.ok(!text.includes('\\n'), 'assistant prompt must use real newlines');
  } finally {
    telegram.restore();
  }
});

test('/ask with an inline question routes the text to the AI without the /ask prefix', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    const response = await post(db, commandUpdate(88, '/ask ما هو CBC؟'));
    assert.equal(response.status, 200);
    const [text] = telegram.sentTexts();
    // With no AI provider configured the answer is a graceful message, never a crash.
    assert.ok(typeof text === 'string' && text.length > 0);
    assert.ok(!text.includes('/ask'), 'the command prefix must be stripped before the AI sees it');
  } finally {
    telegram.restore();
  }
});

test('duplicate webhook deliveries are not dispatched twice', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    const update = commandUpdate(99, '/whoami');
    await post(db, update);
    const firstCount = telegram.calls.length;
    const replay = await post(db, update);
    assert.equal((await replay.json()).duplicate, true);
    assert.equal(telegram.calls.length, firstCount, 'a replayed update must not send more messages');
  } finally {
    telegram.restore();
  }
});

test('admin runtime, resources, upload, messages, topics, settings, news and visibility routes all respond', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);

  // Seed a folder tree and one resource so the admin screens have real data.
  const { addFolder, addContent } = await import('../src/db/d1/registry.js');
  await addFolder(db, null, 'Second Year', 'year', 0);
  await addFolder(db, 1, 'MSK Block', 'block', 1);
  await addContent(db, 2, 'Muscle Physiology', 'file-1', 'document', 'direct', null, 500);

  // Seed a student message so the messages screen lists something.
  const { run } = await import('../src/db/d1/core.js');
  await run(db, 'INSERT INTO messages(user_id,user_name,category,body,status) VALUES(?,?,?,?,?)', [77, 'Ali', 'message', 'سؤال', 'NEW']);
  // Seed a topic and a draft news item.
  await run(db, 'INSERT INTO topics(name,description,icon,display_order,active) VALUES(?,?,?,?,?)', ['Anatomy', 'تشريح', '🧭', 1, 1]);
  await run(db, "INSERT INTO news(news_type,title,body,status,visibility,source) VALUES(?,?,?,?,?,?)", ['announcement', 'مسودة', 'نص', 'draft', 'public', 'manual']);

  const telegram = captureTelegramCalls();
  try {
    const routes = [
      ['admin'],
      ['admin_runtime'],
      ['admin_folders'],
      ['admin_content'],
      ['admin_upload:2'],
      ['admin_messages'],
      ['admin_topics'],
      ['admin_settings'],
      ['admin_news'],
      ['admin_visibility'],
      ['admin_secrets'],
    ];
    for (const [data] of routes) {
      telegram.calls.length = 0;
      const response = await post(db, callbackUpdate(500, data));
      assert.equal(response.status, 200, `route ${data} must be acknowledged`);
      const texts = [...telegram.editedTexts(), ...telegram.sentTexts()];
      const rendered = texts.join('\n');
      assert.ok(rendered.length > 0, `route ${data} must render something`);
      assert.ok(!rendered.includes('\\n'), `route ${data} must use real newlines`);
      assert.ok(!rendered.includes('غير مصرح'), `owner must be authorised for ${data}`);
    }
  } finally {
    telegram.restore();
  }
});

test('every home-menu button opens a real screen instead of the stale-button notice', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    await post(db, commandUpdate(500, '/start'));
    const homePayload = telegram.calls.find((c) => c.method === 'sendMessage');
    const homeButtons = (homePayload?.payload?.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data);
    assert.ok(
      homeButtons.includes('contribute'),
      `the home menu must emit the contributions button: ${JSON.stringify(homeButtons)}`,
    );

    for (const data of homeButtons) {
      telegram.calls.length = 0;
      const response = await post(db, callbackUpdate(500, data));
      assert.equal(response.status, 200, `home button ${data} must be acknowledged`);
      const rendered = [...telegram.editedTexts(), ...telegram.sentTexts()].join('\n');
      assert.ok(
        !rendered.includes('انتهت صلاحية هذا الزر'),
        `home button ${data} must not fall through to the stale-button notice`,
      );
    }
  } finally {
    telegram.restore();
  }
});

test('the topics screen renders a well-formed keyboard even with no active topics', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    const response = await post(db, callbackUpdate(500, 'topics'));
    assert.equal(response.status, 200, 'the topics screen must not fail the webhook delivery');
    const payload = telegram.calls.find((c) => c.method === 'editMessageText');
    const rows = payload?.payload?.reply_markup?.inline_keyboard ?? [];
    assert.ok(Array.isArray(rows) && rows.length > 0, 'topics must render at least the home button');
    for (const row of rows) {
      assert.ok(Array.isArray(row), `each keyboard row must be an array, got ${JSON.stringify(row)}`);
    }
  } finally {
    telegram.restore();
  }
});

test('admin screens render real newlines instead of literal backslash-n', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    for (const data of ['admin_add', `admin_perm:600:can_admins`]) {
      telegram.calls.length = 0;
      const response = await post(db, callbackUpdate(500, data));
      assert.equal(response.status, 200, `${data} must be acknowledged`);
      const rendered = [...telegram.editedTexts(), ...telegram.sentTexts()].join('\n');
      assert.ok(rendered.length > 0, `${data} must render something`);
      assert.ok(!rendered.includes('\\n'), `${data} must use real newlines, not literal backslash-n`);
    }
  } finally {
    telegram.restore();
  }
});

test('a non-admin is denied scoped admin routes', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    const response = await post(db, callbackUpdate(999, 'admin_messages'));
    assert.equal(response.status, 200);
    const rendered = [...telegram.editedTexts(), ...telegram.sentTexts()].join('\n');
    assert.ok(rendered.includes('غير مصرح') || rendered.length === 0, `a stranger must not see the messages panel: ${rendered}`);
  } finally {
    telegram.restore();
  }
});

test('Owner Secrets round-trip stores an encrypted value and never echoes it', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    // Enter the secret workflow.
    await post(db, callbackUpdate(500, 'secret_set'));
    assert.ok(telegram.editedTexts().some((t) => t.includes('NAME=VALUE')));

    telegram.calls.length = 0;
    const secretUpdate = commandUpdate(500, 'GEMINI_API_KEY=super-secret-value');
    const response = await post(db, secretUpdate);
    assert.equal(response.status, 200);
    const texts = telegram.sentTexts();
    assert.ok(texts.some((t) => t.includes('تم حفظ')), `expected a save confirmation, got ${JSON.stringify(texts)}`);
    assert.ok(!texts.join('\n').includes('super-secret-value'), 'the secret value must never be echoed back');

    // The confirmation must be followed by a real deleteMessage call, which is
    // what removes the plaintext from the chat.
    const deleted = telegram.calls.filter((c) => c.method === 'deleteMessage');
    assert.equal(deleted.length, 1, 'the plaintext message must be deleted');
    assert.equal(deleted[0].payload.chat_id, 500);
    assert.equal(deleted[0].payload.message_id, secretUpdate.message.message_id);
  } finally {
    telegram.restore();
  }
});

test('non-owner cannot open the Worker secret management surface', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    const response = await post(db, callbackUpdate(600, 'admin_secrets'));
    assert.equal(response.status, 200);
    assert.equal(telegram.editedTexts().length, 0, 'a non-owner must not receive the secret-management screen');
  } finally {
    telegram.restore();
  }
});

test('the settings workflow stores a new value and rejects unknown keys', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    await post(db, callbackUpdate(500, 'admin_setting:platform_name'));
    const prompt = telegram.editedTexts().join('\n');
    assert.ok(prompt.includes('اسم المنصة'), `the prompt must name the setting: ${prompt}`);

    telegram.calls.length = 0;
    await post(db, commandUpdate(500, 'MEDBOT STAGING'));
    const texts = telegram.sentTexts();
    assert.ok(texts.some((t) => t.includes('تم تحديث')), `expected an update confirmation, got ${JSON.stringify(texts)}`);

    const { get } = await import('../src/db/d1/core.js');
    assert.equal((await get(db, 'SELECT value FROM settings WHERE key=?', ['platform_name']))[0], 'MEDBOT STAGING');
  } finally {
    telegram.restore();
  }
});

test('visibility toggles persist and hide a student section from the home menu', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    await post(db, callbackUpdate(500, 'admin_visibility_toggle:topics'));

    telegram.calls.length = 0;
    await post(db, commandUpdate(77, '/start'));
    const menu = telegram.sentTexts().join('\n');
    const home = telegram.calls.find((c) => c.method === 'sendMessage');
    const callbacks = JSON.stringify(home?.payload?.reply_markup ?? {});
    assert.ok(!callbacks.includes('"topics"'), `a hidden section must not be offered: ${callbacks}`);
    assert.ok(!menu.includes('\\n'), 'the home menu must use real newlines');
  } finally {
    telegram.restore();
  }
});

test('student contact submission is stored and fanned out to admins', async () => {
  const db = createD1Binding();
  await seedOwner(db, 500);
  const telegram = captureTelegramCalls();
  try {
    await post(db, callbackUpdate(77, 'msg_cat:message'));
    telegram.calls.length = 0;
    const response = await post(db, commandUpdate(77, 'أريد مساعدة في الموارد'));
    assert.equal(response.status, 200);

    const texts = telegram.sentTexts();
    const receipt = texts.find((t) => t.includes('تم استلام رسالتك'));
    assert.ok(receipt, `expected a receipt, got ${JSON.stringify(texts)}`);
    assert.ok(!receipt.includes('\\n'), 'the receipt must use real newlines');

    const { get } = await import('../src/db/d1/core.js');
    const row = await get(db, 'SELECT status,body FROM messages ORDER BY id DESC LIMIT 1');
    assert.equal(row[0], 'NEW');
    assert.equal(row[1], 'أريد مساعدة في الموارد');

    // The owner has can_messages, so they must receive the admin notification.
    assert.ok(texts.some((t) => t.includes('رسالة جديدة')), 'the admin fan-out must reach an authorised admin');
  } finally {
    telegram.restore();
  }
});

test('stale callback queries are acknowledged and recover to the home screen', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    const response = await post(db, callbackUpdate(77, 'callback_that_no_longer_exists'));
    assert.equal(response.status, 200);
    assert.ok(telegram.calls.some((c) => c.method === 'answerCallbackQuery'), 'stale callbacks must be acknowledged');
    const edited = telegram.editedTexts().join('\n');
    assert.ok(edited.includes('انتهت صلاحية'), `expected stale-button message, got ${edited}`);
    assert.ok(edited.includes('الرئيسية'), `expected a home recovery button, got ${edited}`);
  } finally {
    telegram.restore();
  }
});

test('an unknown command is answered instead of failing the delivery', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    const response = await post(db, commandUpdate(77, '/definitely_not_a_command'));
    // A throw here would become a 503, which makes Telegram redeliver forever.
    assert.equal(response.status, 200);
    const menu = telegram.sentTexts().join('\n');
    assert.ok(menu.includes('أمر غير معروف'), `expected a graceful unknown-command reply, got ${menu}`);
    const home = telegram.calls.find((c) => c.method === 'sendMessage');
    assert.ok(JSON.stringify(home?.payload?.reply_markup ?? {}).includes('"home"'), 'the reply must offer a way back home');
  } finally {
    telegram.restore();
  }
});


test('owner can add an admin and manage its role and permissions', async () => {
  const db = createD1Binding();
  await ensureConfiguredAdmin(db, 500, 'owner');
  const telegram = captureTelegramCalls();
  try {
    await post(db, callbackUpdate(500, 'admin_admins'));
    assert.ok(telegram.editedTexts().join('\n').includes('إدارة المشرفين'));

    telegram.calls.length = 0;
    await post(db, callbackUpdate(500, 'admin_add'));
    assert.ok(telegram.editedTexts().join('\n').includes('إضافة مشرف'));

    telegram.calls.length = 0;
    await post(db, commandUpdate(500, '600 | scoped | admin'));
    assert.ok(telegram.sentTexts().join('\n').includes('تم إضافة المشرف'));
    assert.equal((await get(db, 'SELECT role FROM admins WHERE telegram_id=?', [600]))[0], 'admin');

    telegram.calls.length = 0;
    await post(db, callbackUpdate(500, 'admin_perms:600'));
    const permissionsCall = telegram.calls.find((call) => call.method === 'editMessageText');
    const permissionsMarkup = JSON.stringify(permissionsCall?.payload?.reply_markup ?? {});
    assert.ok(permissionsMarkup.includes('إدارة المجلدات'));

    telegram.calls.length = 0;
    await post(db, callbackUpdate(500, 'admin_perm:600:can_folders'));
    assert.ok(telegram.editedTexts().join('\n').includes('صلاحيات'));
    assert.equal((await get(db, 'SELECT permissions FROM admins WHERE telegram_id=?', [600]))[0].includes('can_folders'), false);

    telegram.calls.length = 0;
    await post(db, callbackUpdate(500, 'admin_role:600:reviewer'));
    assert.equal((await get(db, 'SELECT role FROM admins WHERE telegram_id=?', [600]))[0], 'reviewer');
  } finally {
    telegram.restore();
  }
});



test('owner can broadcast a notification and verify its audit trail', async () => {
  const db = createD1Binding();
  await ensureConfiguredAdmin(db, 500, 'owner');
  await run(db, 'INSERT INTO users(user_id,username,language) VALUES(?,?,?)', [701, 'student1', 'ar']);
  await run(db, 'INSERT INTO users(user_id,username,language) VALUES(?,?,?)', [702, 'student2', 'ar']);
  const telegram = captureTelegramCalls();
  try {
    await post(db, callbackUpdate(500, 'admin_notifications'));
    const panel = telegram.editedTexts().join('\n');
    assert.ok(panel.includes('الإشعارات والبث'), 'expected notification panel, got '+panel);
    telegram.calls.length = 0;
    await post(db, callbackUpdate(500, 'admin_notify_send'));
    assert.ok(telegram.editedTexts().join('\n').includes('العنوان | نص الإشعار'));
    telegram.calls.length = 0;
    const response = await post(db, commandUpdate(500, 'تنبيه مهم | سيتم تحديث موارد المنصة اليوم'));
    assert.equal(response.status, 200);
    const sent = telegram.sentTexts();
    assert.ok(sent.some((text) => text.includes('تنبيه مهم')), 'expected broadcast delivery, got '+JSON.stringify(sent));
    assert.ok(sent.some((text) => text.includes('تم إرسال الإشعار')), 'expected admin confirmation, got '+JSON.stringify(sent));
    const notification = await get(db, 'SELECT title,body,audience,recipients,delivered FROM notifications ORDER BY id DESC LIMIT 1');
    assert.equal(notification[0], 'تنبيه مهم');
    assert.equal(notification[1], 'سيتم تحديث موارد المنصة اليوم');
    assert.equal(notification[2], 'all');
    assert.equal(notification[3], 2);
    assert.equal(notification[4], 2);
    telegram.calls.length = 0;
    await post(db, callbackUpdate(500, 'admin_audit'));
    const audit = telegram.editedTexts().join('\n');
    assert.ok(audit.includes('notification_broadcast'), 'expected broadcast audit entry, got '+audit);
    assert.ok(audit.includes('500'), 'expected owner actor in audit, got '+audit);
  } finally {
    telegram.restore();
  }
});

test('admin notification permission is enforced for a reviewer without can_notifications', async () => {
  const db = createD1Binding();
  await ensureConfiguredAdmin(db, 500, 'owner');
  await run(db, "INSERT INTO admins(telegram_id,username,role,permissions) VALUES(?,?,?,?)", [600, 'reviewer', 'reviewer', 'can_messages']);
  const telegram = captureTelegramCalls();
  try {
    await post(db, callbackUpdate(600, 'admin_notifications'));
    const panel = telegram.editedTexts().join('\n');
    assert.ok(panel.includes('غير مصرح'), 'reviewer without notification permission must be denied: '+panel);
    telegram.calls.length = 0;
    await post(db, callbackUpdate(600, 'admin_notify_send'));
    assert.equal(telegram.calls.filter((call) => call.method === 'sendMessage').length, 0);
  } finally {
    telegram.restore();
  }
});

test('scoped news admin cannot view or mutate news outside its folder scope', async () => {
  const db = createD1Binding();
  const telegram = captureTelegramCalls();
  try {
    const { addFolder } = await import('../src/db/d1/registry.js');
    const allowedFolder = await addFolder(db, null, 'Allowed', 'general', 0);
    const outsideFolder = await addFolder(db, null, 'Outside', 'general', 0);
    const allowedId = Number(allowedFolder?.lastInsertRowid ?? allowedFolder?.id ?? 1);
    const outsideId = Number(outsideFolder?.lastInsertRowid ?? outsideFolder?.id ?? 2);
    await run(db, "INSERT INTO admins(telegram_id,username,role,permissions) VALUES(?,?,?,?)", [600, 'scoped', 'admin', 'can_news']);
    await run(db, "INSERT INTO admin_scopes(admin_id,scope_type,scope_id,created_by) VALUES(?,?,?,?)", [600, 'folder', allowedId, 500]);
    await run(db, "INSERT INTO news(news_type,title,body,section_folder_id,folder_id,status,visibility,source) VALUES(?,?,?,?,?,?,?,?)", ['section', 'Allowed news', 'ok', allowedId, allowedId, 'draft', 'public', 'manual']);
    await run(db, "INSERT INTO news(news_type,title,body,section_folder_id,folder_id,status,visibility,source) VALUES(?,?,?,?,?,?,?,?)", ['section', 'Outside news', 'blocked', outsideId, outsideId, 'draft', 'public', 'manual']);
    const outsideNewsRow = await get(db, 'SELECT id FROM news WHERE title=?', ['Outside news']);
    const outsideNewsId = Number(outsideNewsRow[0]);

    await post(db, callbackUpdate(600, 'admin_news'));
    const renderedAdminNews = telegram.calls
      .filter((call) => call.method === 'editMessageText')
      .map((call) => ({
        text: call.payload.text ?? '',
        markup: JSON.stringify(call.payload.reply_markup ?? {}),
      }));
    const listText = renderedAdminNews.map((item) => item.text).join('\n');
    const listMarkup = renderedAdminNews.map((item) => item.markup).join('\n');
    assert.ok(listText.includes('مسودات: 1'), `expected one visible draft, got ${listText}`);
    assert.ok(listMarkup.includes('Allowed news'), `scoped news must expose the allowed item button: ${listMarkup}`);
    assert.ok(!listMarkup.includes('Outside news'), `scoped news must hide the outside item button: ${listMarkup}`);

    telegram.calls.length = 0;
    await post(db, callbackUpdate(600, `admin_news_publish:${outsideNewsId}`));
    const denial = telegram.editedTexts().join('\n');
    assert.ok(denial.includes('خارج نطاق مسؤوليتك'));
    const outside = await get(db, 'SELECT status FROM news WHERE id=?', [outsideNewsId]);
    assert.equal(outside[0], 'draft');
  } finally {
    telegram.restore();
  }
});

test('scoped admin authorization blocks folder, resource and topic mutations outside scope', async () => {
  const db = createD1Binding();
  await ensureConfiguredAdmin(db, 500, 'owner');
  const { addFolder, addContent } = await import('../src/db/d1/registry.js');
  const allowedFolder = await addFolder(db, null, 'Allowed', 'general', 0);
  const outsideFolder = await addFolder(db, null, 'Outside', 'general', 0);
  const allowedId = Number(allowedFolder?.lastInsertRowid ?? allowedFolder?.id ?? 1);
  const outsideId = Number(outsideFolder?.lastInsertRowid ?? outsideFolder?.id ?? 2);
  await addFolder(db, allowedId, 'Child', 'general', 0);
  await addContent(db, allowedId, 'Allowed resource', 'file-allowed', 'document', 'direct', null, 500);
  await addContent(db, outsideId, 'Outside resource', 'file-outside', 'document', 'direct', null, 500);

  await run(db, "INSERT INTO topics(name,description,icon,display_order,active) VALUES(?,?,?,?,?)", ['Allowed topic', 'ok', '🧭', 1, 1]);
  await run(db, "INSERT INTO topics(name,description,icon,display_order,active) VALUES(?,?,?,?,?)", ['Outside topic', 'blocked', '🧭', 2, 1]);
  const allowedTopic = await get(db, 'SELECT id FROM topics WHERE name=?', ['Allowed topic']);
  const outsideTopic = await get(db, 'SELECT id FROM topics WHERE name=?', ['Outside topic']);
  const allowedTopicId = Number(allowedTopic[0]);
  const outsideTopicId = Number(outsideTopic[0]);

  await run(db, "INSERT INTO admins(telegram_id,username,role,permissions) VALUES(?,?,?,?)", [600, 'scoped', 'admin', 'can_folders,can_content,can_topics']);
  await run(db, "INSERT INTO admin_scopes(admin_id,scope_type,scope_id,created_by) VALUES(?,?,?,?)", [600, 'folder', allowedId, 500]);
  await run(db, "INSERT INTO admin_scopes(admin_id,scope_type,scope_id,created_by) VALUES(?,?,?,?)", [600, 'topic', allowedTopicId, 500]);

  const telegram = captureTelegramCalls();
  try {
    await post(db, callbackUpdate(600, 'admin_folder:'+outsideId));
    assert.ok(telegram.editedTexts().join('\n').includes(' خارج نطاق مسؤوليتك'));

    telegram.calls.length = 0;
    await post(db, callbackUpdate(600, 'admin_folder_delete:'+outsideId));
    assert.ok(telegram.editedTexts().join('\n').includes(' خارج نطاق مسؤوليتك'));
    assert.ok((await get(db, 'SELECT COUNT(*) FROM folders WHERE id=?', [outsideId]))[0] === 1);

    const outsideResource = await get(db, 'SELECT id FROM content WHERE title=?', ['Outside resource']);
    const outsideResourceId = Number(outsideResource[0]);
    telegram.calls.length = 0;
    await post(db, callbackUpdate(600, 'admin_file:'+outsideResourceId));
    assert.ok(telegram.editedTexts().join('\n').includes(' خارج نطاق مسؤوليتك'));

    telegram.calls.length = 0;
    await post(db, callbackUpdate(600, 'admin_file_delete:'+outsideResourceId));
    assert.ok(telegram.editedTexts().join('\n').includes(' خارج نطاق مسؤوليتك'));
    assert.ok((await get(db, 'SELECT COUNT(*) FROM content WHERE id=?', [outsideResourceId]))[0] === 1);

    telegram.calls.length = 0;
    await post(db, callbackUpdate(600, 'admin_topic:'+outsideTopicId));
    assert.ok(telegram.editedTexts().join('\n').includes(' خارج نطاق مسؤوليتك'));

    telegram.calls.length = 0;
    await post(db, callbackUpdate(600, 'admin_topic_toggle:'+outsideTopicId));
    assert.ok(telegram.editedTexts().join('\n').includes(' خارج نطاق مسؤوليتك'));
    assert.equal((await get(db, 'SELECT active FROM topics WHERE id=?', [outsideTopicId]))[0], 1);

    telegram.calls.length = 0;
    await post(db, callbackUpdate(600, 'admin_topic:'+allowedTopicId));
    assert.ok(telegram.editedTexts().join('\n').includes('Allowed topic'));
  } finally {
    telegram.restore();
  }
});

test('owner secret vault stores ciphertext and recovers the original value with the stable vault key', async () => {
  const db = createD1Binding();
  await ensureConfiguredAdmin(db, 500, 'owner');
  const { setWorkerSecret, getWorkerSecret, deleteWorkerSecret } = await import('../src/telegram/workerSecrets.js');
  const vaultKey = 'test-vault-key-stable';
  await setWorkerSecret(db, vaultKey, 'GEMINI_API_KEY', 'super-secret-value');
  const stored = await get(db, 'SELECT value FROM settings WHERE key=?', ['secret.v2.GEMINI_API_KEY']);
  assert.ok(stored?.[0], 'ciphertext must be persisted');
  assert.ok(!String(stored[0]).includes('super-secret-value'), 'plaintext secret must never be persisted');
  const parsed = JSON.parse(stored[0]);
  assert.equal(parsed.v, 2);
  assert.ok(parsed.iv && parsed.data);
  assert.equal(await getWorkerSecret(db, vaultKey, 'GEMINI_API_KEY'), 'super-secret-value');
  assert.equal(await getWorkerSecret(db, 'wrong-vault-key', 'GEMINI_API_KEY'), null);
  assert.equal(await deleteWorkerSecret(db, 'GEMINI_API_KEY'), true);
  assert.equal(await get(db, 'SELECT value FROM settings WHERE key=?', ['secret.v2.GEMINI_API_KEY']), undefined);
});
