/**
 * Shared test harness.
 *
 * Each test file gets an isolated on-disk SQLite database (a temp file, because
 * `node:sqlite` opens a fresh `:memory:` database per connection) and a fake
 * bot transport that records every call. Handlers are exercised through the real
 * context objects the adapter builds, so the tests cover production code paths,
 * not mocks of the logic under test.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import * as db from '../../src/db/index.js';

let counter = 0;

/** A fresh isolated database path for one test file. */
export function tempDbPath(label = 'test') {
  counter += 1;
  const name = `medbot-${label}-${process.pid}-${counter}-${randomBytes(4).toString('hex')}.sqlite3`;
  return path.join(os.tmpdir(), name);
}

export function cleanupDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Point the database at a fresh temp file and run every migration.
 *
 * Callers must `cleanupDb(path)` in `after()`.
 */
export function freshDb(label = 'test') {
  const dbPath = tempDbPath(label);
  db.setDbPath(dbPath);
  db.initDb();
  return dbPath;
}

/**
 * A fake Telegram transport that records calls and can be told to fail.
 *
 * Implements the same surface the UI uses, so `getBot()` works unchanged.
 */
export class FakeBot {
  constructor() {
    this.calls = [];
    this.failFor = new Set();
    this.retryAfterFor = new Map();
    this._messageId = 1000;
    // Archive health probe state (set by tests).
    this.me = { id: 424242, username: 'medbot_test_bot' };
    this.chat = { id: -1001234567890, type: 'channel', title: 'Archive' };
    this.chatMember = { status: 'administrator', can_post_messages: true };
  }

  _record(method, args) {
    this.calls.push({ method, args });
    this._messageId += 1;
    return this._messageId;
  }

  _maybeFail(method, chatId) {
    const key = `${method}:${chatId}`;
    if (this.retryAfterFor.has(key)) {
      const error = new Error('429 Too Many Requests');
      error.retry_after = this.retryAfterFor.get(key);
      throw error;
    }
    if (this.failFor.has(key) || this.failFor.has(method)) {
      throw new Error(`${method} blocked for ${chatId}`);
    }
  }

  async sendMessage(chatId, text, options = {}) {
    this._maybeFail('sendMessage', chatId);
    return { message_id: this._record('sendMessage', { chatId, text, options }) };
  }

  async editMessageText(text, options = {}) {
    this._maybeFail('editMessageText', options.chat_id);
    return { message_id: this._record('editMessageText', { text, options }) };
  }

  async answerCallbackQuery() {
    return this._record('answerCallbackQuery', {});
  }

  async sendDocument(chatId, document, options = {}) {
    this._maybeFail('sendDocument', chatId);
    return { message_id: this._record('sendDocument', { chatId, document, options }) };
  }

  async sendPhoto(chatId, photo, options = {}) {
    this._maybeFail('sendPhoto', chatId);
    return { message_id: this._record('sendPhoto', { chatId, photo, options }) };
  }

  async sendAudio(chatId, audio, options = {}) {
    this._maybeFail('sendAudio', chatId);
    return { message_id: this._record('sendAudio', { chatId, audio, options }) };
  }

  async sendVideo(chatId, video, options = {}) {
    this._maybeFail('sendVideo', chatId);
    return { message_id: this._record('sendVideo', { chatId, video, options }) };
  }

  async setMyCommands() {
    this.calls.push({ method: 'setMyCommands', args: {} });
  }

  // ---- Archive health probe surface --------------------------------
  async getMe() {
    this._maybeFail('getMe', null);
    this._record('getMe', {});
    return this.me;
  }

  async getChat(chatId) {
    this._maybeFail('getChat', chatId);
    this._record('getChat', { chatId });
    return this.chat;
  }

  async getChatMember(chatId, userId) {
    this._maybeFail('getChatMember', chatId);
    this._record('getChatMember', { chatId, userId });
    return this.chatMember;
  }

  /** Messages sent to one chat (records only sendMessage). */
  messagesTo(chatId) {
    return this.calls
      .filter((call) => call.method === 'sendMessage' && call.args.chatId === chatId)
      .map((call) => call.args.text);
  }

  /** The last recorded call of a method. */
  last(method) {
    const calls = this.calls.filter((call) => call.method === method);
    return calls.length ? calls[calls.length - 1] : null;
  }

  reset() {
    this.calls = [];
    this.failFor.clear();
    this.retryAfterFor.clear();
  }
}

/** Build the context objects the adapter would build, for direct handler tests. */
export async function contexts(bot = new FakeBot()) {
  const { buildCallbackContext, buildMessageContext, buildMediaContext } = await import(
    '../../src/telegram/context.js'
  );
  return { buildCallbackContext, buildMessageContext, buildMediaContext, bot };
}

export function callbackCtx(bot, userId, data, userData = {}) {
  return {
    kind: 'callback',
    from: { id: userId, first_name: 'Test', username: `u${userId}` },
    data,
    userData,
    chatId: userId,
    bot,
    answer: async () => {},
    editMessageText: async (text, options = {}) => {
      bot.calls.push({ method: 'editMessageText', args: { text, options, chatId: userId } });
      return { message_id: 1 };
    },
    reply: async (text, options = {}) => {
      bot.calls.push({ method: 'sendMessage', args: { chatId: userId, text, options } });
      return { message_id: 2 };
    },
    getBot: () => bot,
  };
}

export function messageCtx(bot, userId, text, userData = {}) {
  return {
    kind: 'message',
    from: { id: userId, first_name: 'Test', username: `u${userId}` },
    text,
    userData,
    chatId: userId,
    bot,
    answer: async () => {},
    editMessageText: async () => ({}),
    reply: async (t, options = {}) => {
      bot.calls.push({ method: 'sendMessage', args: { chatId: userId, text: t, options } });
      return { message_id: 2 };
    },
    getBot: () => bot,
  };
}

export function mediaCtx(bot, userId, message, userData = {}) {
  const context = messageCtx(bot, userId, message.caption ?? '', userData);
  context.kind = 'media';
  context.message = message;
  return context;
}

/** The text of the last `editMessageText` recorded by a fake bot. */
export function lastEdit(bot) {
  const call = bot.last('editMessageText');
  return call ? call.args.text : '';
}

/** The reply markup of the last `editMessageText` recorded by a fake bot. */
export function lastMarkup(bot) {
  const call = bot.last('editMessageText');
  return call?.args?.options?.reply_markup ?? null;
}

/** All callback_data values in the last rendered keyboard. */
export function lastButtons(bot) {
  const rows = lastMarkup(bot)?.inline_keyboard ?? [];
  return rows.flat().map((button) => button.callback_data);
}

/**
 * Seed a small but realistic registry: two years, a subject, a section and a
 * resource. Returns the ids so tests can assert against real rows.
 */
export function seedRegistry() {
  const year1 = db.addFolder(0, 'السنة الأولى', 'general', 1);
  const year2 = db.addFolder(0, 'السنة الثانية', 'general', 0);
  const anatomy = db.addFolder(year1, 'علم التشريح', 'general', 1);
  const practical = db.addFolder(anatomy, 'عملي', 'general', 1);
  const physiology = db.addFolder(year2, 'الفسيولوجيا', 'general', 0);
  const lecture = db.addContent(practical, 'تشريح عملي - محاضرة 1', 'file-1', 'document');
  const lecture2 = db.addContent(physiology, 'فسيولوجيا القلب', 'file-2', 'video');
  const notes = db.addContent(practical, 'ملخصات التشريح', 'file-3', 'document');
  return { year1, year2, anatomy, practical, physiology, lecture, lecture2, notes };
}

/** Promote a user to owner (the single-owner bootstrap path). */
export function makeOwner(userId) {
  return db.ensureConfiguredAdmin(userId, `owner${userId}`);
}

/** Add an active admin holding every capability except `can_admins`. */
export function makeAdmin(userId) {
  db.addSubAdmin(userId, `admin${userId}`);
  db.applyRolePreset(userId, 'admin');
  return userId;
}

/** Add a reviewer (contributions + messages only). */
export function makeReviewer(userId) {
  db.addSubAdmin(userId, `reviewer${userId}`);
  db.applyRolePreset(userId, 'reviewer');
  return userId;
}
