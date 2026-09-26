/**
 * Platform-setting edit end to end, through the real Telegram flow.
 *
 * The audit brief called out `settings_edit:contact_text` specifically: the
 * admin taps the setting, types a value, and must then SEE the new value. These
 * tests drive the whole sequence through the real router and adapter — not a
 * direct handler call — so the workflow marker, the text chain and the
 * re-rendered screen are all exercised together.
 *
 * It also pins the cross-workflow contract: a settings edit must not swallow a
 * message meant for the news wizard, and vice versa.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as workflow from '../src/workflow.js';
import { cleanupDb, FakeBot, freshDb } from './helpers/harness.js';

let dbPath;
let botModule;
let adapter;
let settingsUi;
let newsUi;

const ADMIN = 8800;

/** A bot that records every call and answers the archive health probe. */
function newBot() {
  return new FakeBot();
}

/** The rendered text of the most recent screen, whether edited or sent. */
function lastScreen(bot) {
  const last = bot.calls[bot.calls.length - 1];
  if (!last) return '';
  return last.args.text ?? '';
}

/** The buttons of the most recent keyboard, whether edited or sent. */
function lastKeyboard(bot) {
  const last = bot.calls[bot.calls.length - 1];
  if (!last) return [];
  return last.args.options?.reply_markup?.inline_keyboard ?? [];
}

/** The adapter's per-user scratch space, so a real dispatch sees the armed flow. */
function userDataFor(userId) {
  return adapter.userDataFor(userId);
}

/** Dispatch a raw callback tap through the real router. */
async function tap(bot, userId, data) {
  return adapter.dispatchUpdate(
    {
      update_id: 1,
      callback_query: {
        id: `cb-${data}`,
        from: { id: userId, first_name: 'Admin', username: 'admin' },
        message: { message_id: 500, chat: { id: userId } },
        data,
      },
    },
    bot,
    {},
  );
}

/** Dispatch a raw text message through the real router. */
async function type(bot, userId, text) {
  return adapter.dispatchUpdate(
    { update_id: 2, message: { from: { id: userId }, chat: { id: userId }, text } },
    bot,
    {},
  );
}

before(async () => {
  dbPath = freshDb('settings-e2e');
  botModule = await import('../src/telegram/bot.js');
  adapter = await import('../src/telegram/adapter.js');
  settingsUi = await import('../src/ui/adminSettings.js');
  newsUi = await import('../src/ui/news.js');

  botModule.registerHandlers();

  db.registerUser(ADMIN, 'settings_admin', 'Settings Admin');
  db.addSubAdmin(ADMIN, 'settings_admin');
  db.setAdminRole(ADMIN, 'owner');
  db.updateAdminPermissions(ADMIN, db.defaultPermissions());
});

after(() => {
  cleanupDb(dbPath);
});

beforeEach(() => {
  adapter.resetUserData();
});

describe('contact_text edit end to end', () => {
  it('shows the settings screen, arms the edit and persists the typed value', async () => {
    const bot = newBot();

    // 1. admin_settings -> the settings screen.
    await tap(bot, ADMIN, 'admin_settings');
    assert.match(lastScreen(bot), /إعدادات المنصة/);
    const hasContact = lastKeyboard(bot)
      .flat()
      .some((button) => button.callback_data === 'settings_edit:contact_text');
    assert.ok(hasContact, 'the contact_text setting is offered');

    // 2. tap settings_edit:contact_text -> the edit prompt.
    await tap(bot, ADMIN, 'settings_edit:contact_text');
    assert.equal(userDataFor(ADMIN).settings_edit_key, 'contact_text');
    assert.equal(userDataFor(ADMIN)[workflow.ACTIVE_KEY], settingsUi.SETTINGS_WORKFLOW);
    assert.match(lastScreen(bot), /القيمة الحالية/);

    // 3. send the new value.
    const handled = await type(bot, ADMIN, 'راسلنا على support@medbot.test');
    assert.equal(handled, true, 'the typed value was consumed');

    // 4. it persisted...
    assert.equal(db.getPlatformSetting('contact_text'), 'راسلنا على support@medbot.test');
    // ...and the admin sees it immediately, without navigating away and back.
    assert.match(lastScreen(bot), /تم حفظ الإعداد/);
    assert.match(lastScreen(bot), /راسلنا على support@medbot\.test/);

    // 5. the workflow is cleared, so the next message is not captured.
    assert.equal(userDataFor(ADMIN).settings_edit_key, undefined);
    assert.equal(userDataFor(ADMIN)[workflow.ACTIVE_KEY], undefined);
  });

  it('shows the new value when the settings screen is reopened', async () => {
    db.setPlatformSetting('contact_text', 'قيمة سابقة');
    const bot = newBot();

    await tap(bot, ADMIN, 'admin_settings');
    assert.match(lastScreen(bot), /قيمة سابقة/);
  });

  it('cancels cleanly on /cancel and changes nothing', async () => {
    db.setPlatformSetting('contact_text', 'يبقى كما هو');
    const bot = newBot();

    await tap(bot, ADMIN, 'settings_edit:contact_text');
    await type(bot, ADMIN, '/cancel');

    assert.equal(db.getPlatformSetting('contact_text'), 'يبقى كما هو');
    assert.equal(userDataFor(ADMIN).settings_edit_key, undefined);
    assert.match(lastScreen(bot), /إلغاء/);
  });

  it('tells the admin when they send an empty message instead of doing nothing', async () => {
    const bot = newBot();
    await tap(bot, ADMIN, 'settings_edit:contact_text');

    const handled = await type(bot, ADMIN, '   ');
    assert.equal(handled, true, 'an empty message is answered, not dropped');
    assert.match(lastScreen(bot), /لم ترسل أي نص/);
  });

  it('rejects an over-long value and keeps the previous one', async () => {
    db.setPlatformSetting('contact_text', 'محفوظ');
    const bot = newBot();

    await tap(bot, ADMIN, 'settings_edit:contact_text');
    await type(bot, ADMIN, 'x'.repeat(db.SETTINGS_MAX_LENGTH + 1));

    assert.equal(db.getPlatformSetting('contact_text'), 'محفوظ');
    assert.match(lastScreen(bot), /نص غير صالح/);
  });

  it('refuses the edit when the caller loses the capability mid-flow', async () => {
    // A non-owner admin, so revoking the capability actually takes effect (the
    // owner bypasses every capability check by design).
    const editor = 8810;
    db.registerUser(editor, 'settings_editor', 'Settings Editor');
    db.addSubAdmin(editor, 'settings_editor');
    db.setAdminRole(editor, 'admin');
    db.updateAdminPermissions(editor, db.defaultPermissions());

    const bot = newBot();
    db.setPlatformSetting('contact_text', 'قبل السحب');

    // Arm as an authorized admin...
    await tap(bot, editor, 'settings_edit:contact_text');
    assert.equal(userDataFor(editor).settings_edit_key, 'contact_text');

    // ...then revoke the capability before the value is typed.
    db.updateAdminPermissions(editor, { ...db.defaultPermissions(), can_settings: false });
    await type(bot, editor, 'لا يجب أن تُحفظ');
    db.updateAdminPermissions(editor, db.defaultPermissions());

    assert.equal(db.getPlatformSetting('contact_text'), 'قبل السحب', 'the write was refused');
    assert.match(lastScreen(bot), /غير مصرح/);
  });
});

describe('settings and news workflows stay isolated', () => {
  it('does not let the news wizard swallow a settings value', async () => {
    const bot = newBot();
    db.setPlatformSetting('contact_text', 'قيمة الإعداد');

    // Arm the settings edit.
    await tap(bot, ADMIN, 'settings_edit:contact_text');

    // A message sent now belongs to settings, never to news.
    await type(bot, ADMIN, 'نص الإعداد الجديد');
    assert.equal(db.getPlatformSetting('contact_text'), 'نص الإعداد الجديد');
    assert.equal(userDataFor(ADMIN).news_new_step, undefined, 'no news step was armed');
  });

  it('does not let a settings edit swallow a news wizard step', async () => {
    const bot = newBot();

    // Start the news wizard and advance to the title step.
    await tap(bot, ADMIN, 'news_new:notify');
    assert.equal(userDataFor(ADMIN)[workflow.ACTIVE_KEY], newsUi.NEWS_WORKFLOW);
    assert.equal(userDataFor(ADMIN).news_new_step, 'title');

    // The title typed now must land in the news draft, not in a setting.
    const before = db.getPlatformSetting('contact_text');
    await type(bot, ADMIN, 'عنوان خبر الاختبار');
    assert.equal(userDataFor(ADMIN).news_new_title, 'عنوان خبر الاختبار');
    assert.equal(db.getPlatformSetting('contact_text'), before, 'no setting was written');
  });

  it('releases the workflow claim when the news wizard is cancelled', async () => {
    const bot = newBot();

    await tap(bot, ADMIN, 'news_new:notify');
    await type(bot, ADMIN, '/cancel');

    assert.equal(userDataFor(ADMIN)[workflow.ACTIVE_KEY], undefined, 'no stale claim survives /cancel');
    assert.equal(userDataFor(ADMIN).news_new_step, undefined, 'the wizard keys are gone');
  });

  it('releases the workflow claim once a draft is created', async () => {
    const bot = newBot();

    await tap(bot, ADMIN, 'news_new:notify');
    await type(bot, ADMIN, 'عنوان المسودة');
    await type(bot, ADMIN, '/skip'); // body
    await type(bot, ADMIN, '/skip'); // doctor
    await type(bot, ADMIN, '/skip'); // event -> draft created

    assert.equal(userDataFor(ADMIN)[workflow.ACTIVE_KEY], undefined, 'the finished wizard does not hold the marker');
    // A setting edit still works immediately afterwards: nothing is stuck.
    await tap(bot, ADMIN, 'settings_edit:contact_text');
    await type(bot, ADMIN, 'قيمة بعد المسودة');
    assert.equal(db.getPlatformSetting('contact_text'), 'قيمة بعد المسودة');
  });
});

describe('the settings screen is a compact grid', () => {
  it('packs the setting buttons two per row', async () => {
    const bot = newBot();
    await tap(bot, ADMIN, 'admin_settings');
    const rows = lastKeyboard(bot);
    const settingRows = rows.filter((row) =>
      row.some((button) => String(button.callback_data).startsWith('settings_edit:')),
    );
    assert.ok(settingRows.length >= 1);
    assert.equal(settingRows[0].length, 2, 'two settings share the first row');
    // Home and the back button keep their own full-width rows.
    assert.ok(rows.some((row) => row.length === 1 && row[0].callback_data === 'home'));
  });
});
