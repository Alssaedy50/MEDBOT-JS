import { handleTelegramWebhook } from './telegram/webhook.js';
import { createD1TelegramIdempotencyStore, initTelegramWebhookStore } from './db/d1/telegramUpdates.js';
import { get, run } from './db/d1/core.js';
import { createR2Storage } from './storage/r2.js';
import { createWorkerTelegramDispatcher } from './telegram/workerDispatcher.js';
import { buildWorkerHome, buildWorkerAccount } from './telegram/workerHome.js';
import { buildWorkerLibraryRoot, buildWorkerFolder, findWorkerResources, buildWorkerFile } from './telegram/workerResources.js';
import {
  buildWorkerLanguage,
  applyWorkerLanguage,
  buildWorkerAbout,
  buildWorkerContact,
  submitWorkerContactMessage,
  buildWorkerNews,
  buildWorkerNewsDetail,
  buildWorkerMyContributions,
  buildWorkerUnsupported,
} from './telegram/workerParity.js';
import { buildWorkerTopics, buildWorkerTopic } from './telegram/workerTopics.js';
import { buildWorkerContributionStart, prepareWorkerContribution, handleWorkerContributionMedia } from './telegram/workerContributions.js';
import { answerWorkerAi } from './telegram/workerAi.js';
import {
  buildWorkerAdmin,
  buildWorkerAdminFolders,
  buildWorkerFolderTypePicker,
  createWorkerFolder,
  renameWorkerFolder,
  toggleWorkerFolderContributions,
  deleteWorkerFolder,
  buildWorkerAdminFile,
  deleteWorkerAdminFile,
  uploadWorkerAdminMedia,
  buildWorkerArchiveAdmin,
  syncWorkerArchiveAll,
  resolveWorkerArchiveChannel,
  buildWorkerPending,
  buildWorkerContributionReview,
  reviewWorkerContribution,
  buildWorkerMessages,
  buildWorkerMessageDetail,
  replyWorkerMessage,
  buildWorkerNewsAdmin,
  createWorkerNewsItem,
  deleteWorkerNewsItem,
  buildWorkerNotificationsAdmin,
  sendWorkerBroadcastNotification,
  buildWorkerTopicsAdmin,
  buildWorkerTopicAdminDetail,
  buildWorkerTopicLinkPicker,
  createWorkerTopicItem,
  toggleWorkerTopicItem,
  linkWorkerTopicFolderItem,
  deleteWorkerTopicItem,
  buildWorkerSettingsAdmin,
  saveWorkerSetting,
  buildWorkerVisibilityAdmin,
  toggleWorkerFeatureVisibility,
  buildWorkerAiAdmin,
  buildWorkerAdmins,
  addWorkerNewAdmin,
  buildWorkerAdminUser,
  applyWorkerAdminRole,
  toggleWorkerAdminPermission,
} from './telegram/workerAdmin.js';
import { ensureConfiguredAdmin } from './db/d1/admins.js';
import { D1_SCHEMA_STATEMENTS } from './db/d1/migrations.js';

const initializedWebhookStores = new WeakSet();
let lastWorkerError = null;

async function ensureWorkerSchema(db) {
  if (!db || typeof db !== 'object' || initializedWebhookStores.has(db)) return;
  await initTelegramWebhookStore(db);
  if (typeof db.prepare === 'function' && typeof db.batch === 'function') {
    try {
      await db.batch(D1_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
    } catch {
      // Ignore if test mock does not support full DDL batch
    }
  }
  initializedWebhookStores.add(db);
}

function json(data, status = 200) {
  return new globalThis.Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function backupEndpoint(request, env) {
  if (!env.FILES || !env.BACKUP_SECRET) return json({ ok: false, error: 'backup_not_configured' }, 503);
  if (request.headers.get('Authorization') !== `Bearer ${env.BACKUP_SECRET}`) return json({ ok: false, error: 'unauthorized' }, 401);
  if (request.method === 'PUT') {
    await env.FILES.put('backups/latest.json', request.body, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    return json({ ok: true, stored: 'backups/latest.json' });
  }
  if (request.method === 'GET') {
    const object = await env.FILES.get('backups/latest.json');
    if (!object) return json({ ok: false, error: 'not_found' }, 404);
    return new globalThis.Response(object.body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

function healthResponse(env = {}) {
  return json({
    ok: true,
    service: 'MEDBOT',
    runtime: 'cloudflare-worker',
    phase: 11,
    telegram_webhook: 'adapter_enabled',
    telegram_domain_router: 'phase15-core-parity',
    database: env.DB ? 'd1-bound' : 'd1-missing',
    object_storage: env.FILES ? 'r2-bound' : 'r2-missing',
  });
}

function telegramBot(token) {
  if (!token) return null;
  async function call(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const desc = String(body?.description || '');
      if (method === 'editMessageText' && desc.includes('message is not modified')) return null;
      throw new Error(!response.ok ? `telegram_${method}_failed` : `telegram_${method}_rejected`);
    }
    return body.result;
  }
  return {
    sendMessage: (chatId, text, options = {}) => call('sendMessage', { parse_mode: 'HTML', chat_id: chatId, text, ...options }),
    editMessageText: (text, options = {}) => call('editMessageText', { parse_mode: 'HTML', text, ...options }),
    answerCallbackQuery: (id) => call('answerCallbackQuery', { callback_query_id: id }),
    sendDocument: (chatId, document, options = {}) => call('sendDocument', { chat_id: chatId, document, ...options }),
    sendPhoto: (chatId, photo, options = {}) => call('sendPhoto', { chat_id: chatId, photo, ...options }),
    sendVideo: (chatId, video, options = {}) => call('sendVideo', { chat_id: chatId, video, ...options }),
    sendAudio: (chatId, audio, options = {}) => call('sendAudio', { chat_id: chatId, audio, ...options }),
  };
}

function clearPendingStates(userData) {
  if (!userData) return;
  userData.ai_chat = false;
  userData.library_search = false;
  userData.contribution_folder = null;
  userData.contact_message = false;
  userData.admin_folder_new_parent = null;
  userData.admin_folder_new_name = null;
  userData.admin_folder_rename = null;
  userData.admin_upload_folder = null;
  userData.admin_msg_reply = null;
  userData.admin_news_new = false;
  userData.admin_notify_audience = null;
  userData.admin_topic_new = false;
  userData.admin_set_edit = null;
  userData.admin_add_new = false;
}

async function sendMediaByType(bot, chatId, fileType, fileId, options = {}) {
  const normalized = String(fileType ?? '').toLowerCase();
  const primary = normalized === 'photo' || normalized === 'image'
    ? 'sendPhoto'
    : normalized === 'video'
      ? 'sendVideo'
      : normalized === 'audio'
        ? 'sendAudio'
        : 'sendDocument';
  const order = [primary, 'sendDocument', 'sendPhoto', 'sendVideo', 'sendAudio'].filter(
    (m, idx, arr) => arr.indexOf(m) === idx && typeof bot[m] === 'function',
  );
  let lastError = null;
  for (const method of order) {
    try {
      return await bot[method](chatId, fileId, options);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('telegram_media_send_failed');
}

async function dispatchTelegramUpdate(update, { env }) {
  const bot = telegramBot(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN);
  if (!bot) throw new Error('telegram_bot_token_not_configured');
  const handlers = {
    command: async (ctx) => {
      clearPendingStates(ctx.userData);
      const command = String(ctx.text).trim().split(/\s+/, 1)[0].split('@', 1)[0].slice(1);
      if (command === 'start') {
        await ensureConfiguredAdmin(ctx.db, env.ADMIN_ID, ctx.from.id === Number(env.ADMIN_ID) ? ctx.from.username : null);
        const menu = await buildWorkerHome(ctx.db, ctx.from);
        return ctx.reply(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (command === 'help') {
        const menu = await buildWorkerAbout(ctx.db, ctx.from);
        return ctx.reply(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (command === 'quota') {
        const menu = await buildWorkerAccount(ctx.db, ctx.from);
        return ctx.reply(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (command === 'admin') {
        await ensureConfiguredAdmin(ctx.db, env.ADMIN_ID, ctx.from.id === Number(env.ADMIN_ID) ? ctx.from.username : null);
        const menu = await buildWorkerAdmin(ctx.db, ctx.from);
        return ctx.reply(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (command === 'ask') {
        ctx.userData.ai_chat = true;
        return ctx.reply('🤖 <b>المساعد الذكي</b>\n\nاكتب سؤالك الطبي الآن.', { parse_mode: 'HTML' });
      }
      if (command === 'contribute') {
        const menu = await buildWorkerContributionStart(ctx.db, ctx.from);
        return ctx.reply(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (command === 'search') {
        ctx.userData.library_search = true;
        return ctx.reply('🔎 <b>بحث في موارد المنصة</b>\n\nاكتب اسم مادة أو قسم أو مورد.', {
          reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
          parse_mode: 'HTML',
        });
      }
      if (command === 'cancel') {
        return ctx.reply('❌ تم إلغاء العملية الجارية.', {
          reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
          parse_mode: 'HTML',
        });
      }
      const fallback = await buildWorkerHome(ctx.db, ctx.from);
      return ctx.reply(fallback.text, { reply_markup: fallback.reply_markup, parse_mode: 'HTML' });
    },

    callback: async (ctx) => {
      // Clear transient input flags on navigation unless selecting folder type
      if (!ctx.data.startsWith('admin_ftype:')) {
        clearPendingStates(ctx.userData);
      }

      if (ctx.data === 'language') {
        const menu = await buildWorkerLanguage(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('lang_set:')) {
        const ok = await applyWorkerLanguage(ctx.db, ctx.from.id, ctx.data.split(':')[1]);
        const menu = await buildWorkerHome(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(ok ? menu.text : '⚠️ لغة غير مدعومة.', { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'about') {
        const menu = await buildWorkerAbout(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'contact') {
        const menu = await buildWorkerContact(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'contact_send') {
        ctx.userData.contact_message = true;
        await ctx.answer();
        return ctx.editMessageText('✉️ <b>مراسلة إدارة المنصة</b>\n\nاكتب رسالتك أو اقتراحك الآن في رسالة نصية:', {
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'home' }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data === 'news') {
        const menu = await buildWorkerNews(ctx.db, ctx.from, 0);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('news_page:')) {
        const menu = await buildWorkerNews(ctx.db, ctx.from, Number(ctx.data.split(':')[1]) || 0);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('news:')) {
        const menu = await buildWorkerNewsDetail(ctx.db, ctx.from, Number(ctx.data.split(':')[1]));
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'my_contributions') {
        const menu = await buildWorkerMyContributions(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'topics') {
        const menu = await buildWorkerTopics(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('topic:')) {
        const menu = await buildWorkerTopic(ctx.db, ctx.from, Number(ctx.data.split(':')[1]));
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'contributions' || ctx.data === 'contribute') {
        const menu = await buildWorkerContributionStart(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('contrib_folder:')) {
        const folderId = Number(ctx.data.split(':')[1]);
        const result = await prepareWorkerContribution(ctx.db, ctx.from, folderId);
        if (result.ok) ctx.userData.contribution_folder = folderId;
        await ctx.answer();
        return ctx.editMessageText(result.text, {
          reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data === 'assistant') {
        ctx.userData.ai_chat = true;
        await ctx.answer();
        return ctx.editMessageText('🤖 <b>المساعد الذكي</b>\n\nاكتب سؤالك الطبي الآن.', {
          reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
          parse_mode: 'HTML',
        });
      }

      // --- Admin Dashboard & Tools ---
      if (ctx.data === 'admin') {
        await ensureConfiguredAdmin(ctx.db, env.ADMIN_ID, ctx.from.id === Number(env.ADMIN_ID) ? ctx.from.username : null);
        const menu = await buildWorkerAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_runtime') {
        const channel = resolveWorkerArchiveChannel(env);
        await ctx.answer();
        return ctx.editMessageText(
          `📊 <b>حالة التشغيل (Cloudflare Worker)</b>\n\n` +
          `🗄 قاعدة البيانات: ${env.DB ? '✅ D1 متصلة' : '⚠️ غير متصلة'}\n` +
          `📦 التخزين السحابي: ${env.FILES ? '✅ R2 متصل' : '⚠️ غير متصل'}\n` +
          `📡 قناة الأرشيف: ${channel ? `✅ ${channel}` : '⚠️ غير مضبوطة'}`,
          {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ لوحة الإدارة', callback_data: 'admin' }, { text: '🏠 الرئيسية', callback_data: 'home' }]] },
            parse_mode: 'HTML',
          },
        );
      }

      // Admin Folders & Content
      if (ctx.data === 'admin_folders') {
        const menu = await buildWorkerAdminFolders(ctx.db, ctx.from, 0);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_folder:')) {
        const fid = Number(ctx.data.split(':')[1]) || 0;
        const menu = await buildWorkerAdminFolders(ctx.db, ctx.from, fid);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_fnew:')) {
        const pid = Number(ctx.data.split(':')[1]) || 0;
        ctx.userData.admin_folder_new_parent = pid;
        await ctx.answer();
        return ctx.editMessageText(
          pid ? '➕ <b>إنشاء قسم فرعي جديد</b>\n\nأرسل اسم القسم الفرعي الآن:' : '➕ <b>إنشاء مادة / قسم رئيسي جديد</b>\n\nأرسل اسم المادة أو القسم الآن:',
          {
            reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: pid ? `admin_folder:${pid}` : 'admin_folders' }]] },
            parse_mode: 'HTML',
          },
        );
      }
      if (ctx.data.startsWith('admin_ftype:')) {
        const parts = ctx.data.split(':');
        const pid = Number(parts[1]) || 0;
        const nodeType = parts[2] || 'general';
        const name = ctx.userData?.admin_folder_new_name || 'قسم جديد';
        clearPendingStates(ctx.userData);
        const created = await createWorkerFolder(ctx.db, ctx.from, pid, name, nodeType);
        const menu = await buildWorkerAdminFolders(ctx.db, ctx.from, created.ok ? created.folderId : pid);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_frename:')) {
        const fid = Number(ctx.data.split(':')[1]);
        ctx.userData.admin_folder_rename = fid;
        await ctx.answer();
        return ctx.editMessageText('✏️ <b>إعادة تسمية القسم</b>\n\nأرسل الاسم الجديد للقسم الآن:', {
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: `admin_folder:${fid}` }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data.startsWith('admin_fcontrib:')) {
        const fid = Number(ctx.data.split(':')[1]);
        await toggleWorkerFolderContributions(ctx.db, ctx.from, fid);
        const menu = await buildWorkerAdminFolders(ctx.db, ctx.from, fid);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_fdel:')) {
        const fid = Number(ctx.data.split(':')[1]);
        const del = await deleteWorkerFolder(ctx.db, ctx.from, fid);
        const menu = await buildWorkerAdminFolders(ctx.db, ctx.from, del.parentId || 0);
        await ctx.answer();
        return ctx.editMessageText(`${del.text}\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_fupload:')) {
        const fid = Number(ctx.data.split(':')[1]);
        ctx.userData.admin_upload_folder = fid;
        await ctx.answer();
        return ctx.editMessageText(
          '📤 <b>رفع داتا / ملفات للقسم</b>\n\nأرسل الآن الملف (PDF، مستند، صورة، فيديو، أو مقطع صوتي). يمكنك كتابة عنوان المورد في وصف المرفق (Caption):',
          {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ رجوع للقسم', callback_data: `admin_folder:${fid}` }]] },
            parse_mode: 'HTML',
          },
        );
      }
      if (ctx.data.startsWith('admin_ffile:')) {
        const cid = Number(ctx.data.split(':')[1]);
        const menu = await buildWorkerAdminFile(ctx.db, ctx.from, cid);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_fdel_file:')) {
        const parts = ctx.data.split(':');
        const cid = Number(parts[1]);
        const fid = Number(parts[2]) || 0;
        await deleteWorkerAdminFile(ctx.db, ctx.from, cid);
        const menu = await buildWorkerAdminFolders(ctx.db, ctx.from, fid);
        await ctx.answer();
        return ctx.editMessageText(`✅ تم حذف الملف.\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }

      // Admin Archive
      if (ctx.data === 'admin_archive') {
        const menu = await buildWorkerArchiveAdmin(ctx.db, ctx.from, env);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_archive_sync') {
        await ctx.answer();
        const result = await syncWorkerArchiveAll(ctx.db, ctx.from, bot, env);
        return ctx.editMessageText(result.text, { reply_markup: result.reply_markup, parse_mode: 'HTML' });
      }

      // Admin Pending Contributions
      if (ctx.data === 'admin_pending') {
        const menu = await buildWorkerPending(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_contrib:')) {
        const menu = await buildWorkerContributionReview(ctx.db, ctx.from, Number(ctx.data.split(':')[1]));
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_preview_contrib:')) {
        const cid = Number(ctx.data.split(':')[1]);
        const row = await get(ctx.db, 'SELECT title, file_id, file_type FROM contributions WHERE id=?', [cid]);
        if (row) {
          const caption = `👁 <b>معاينة مساهمة #${cid}</b>\n📄 ${String(row[0]).replace(/</g, '&lt;').replace(/>/g, '&gt;')}`;
          await sendMediaByType(bot, ctx.from.id, row[2], row[1], { caption, parse_mode: 'HTML' });
        }
        await ctx.answer();
        return;
      }
      if (ctx.data.startsWith('admin_approve:') || ctx.data.startsWith('admin_reject:')) {
        const action = ctx.data.startsWith('admin_approve:') ? 'approve' : 'reject';
        const id = Number(ctx.data.split(':')[1]);
        const result = await reviewWorkerContribution(ctx.db, ctx.from, id, action, bot, env);
        await ctx.answer();
        return ctx.editMessageText(result.text, {
          reply_markup: { inline_keyboard: [[{ text: '📥 المساهمات', callback_data: 'admin_pending' }, { text: '🏠 الرئيسية', callback_data: 'home' }]] },
          parse_mode: 'HTML',
        });
      }

      // Admin Student Messages
      if (ctx.data === 'admin_messages') {
        const menu = await buildWorkerMessages(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_msg:')) {
        const menu = await buildWorkerMessageDetail(ctx.db, ctx.from, Number(ctx.data.split(':')[1]));
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_msg_reply:')) {
        const mid = Number(ctx.data.split(':')[1]);
        ctx.userData.admin_msg_reply = mid;
        await ctx.answer();
        return ctx.editMessageText(`✍️ <b>الرد على رسالة الطالب #${mid}</b>\n\nاكتب نص الرد الآن ليتم إرساله للطالب مباشرة:`, {
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: `admin_msg:${mid}` }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data.startsWith('admin_msg_close:')) {
        const mid = Number(ctx.data.split(':')[1]);
        await run(ctx.db, "UPDATE messages SET status='CLOSED', updated_at=CURRENT_TIMESTAMP WHERE id=?", [mid]);
        const menu = await buildWorkerMessages(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }

      // Admin News & Broadcast Notifications
      if (ctx.data === 'admin_news') {
        const menu = await buildWorkerNewsAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_news_new') {
        ctx.userData.admin_news_new = true;
        await ctx.answer();
        return ctx.editMessageText('📰 <b>نشر خبر أو إعلان جديد للطلاب</b>\n\nاكتب عنوان الخبر في السطر الأول، وتفاصيل الخبر في الأسطر التالية:', {
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_news' }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data.startsWith('admin_news_del:')) {
        const nid = Number(ctx.data.split(':')[1]);
        await deleteWorkerNewsItem(ctx.db, ctx.from, nid);
        const menu = await buildWorkerNewsAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(`✅ تم حذف الخبر.\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_notifications') {
        const menu = await buildWorkerNotificationsAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_notify_all' || ctx.data === 'admin_notify_admins') {
        ctx.userData.admin_notify_audience = ctx.data === 'admin_notify_admins' ? 'admins' : 'all';
        await ctx.answer();
        return ctx.editMessageText('🔔 <b>إرسال إشعار جماعي</b>\n\nاكتب نص الإشعار الذي سيتم بثه الآن:', {
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_notifications' }]] },
          parse_mode: 'HTML',
        });
      }

      // Admin Topics
      if (ctx.data === 'admin_topics') {
        const menu = await buildWorkerTopicsAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_topic_new') {
        ctx.userData.admin_topic_new = true;
        await ctx.answer();
        return ctx.editMessageText('🧭 <b>إنشاء موضوع بحث جديد</b>\n\nاكتب اسم الموضوع في السطر الأول، ووصفه الاختياري في السطر الثاني:', {
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_topics' }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data.startsWith('admin_topic_item:')) {
        const tid = Number(ctx.data.split(':')[1]);
        const menu = await buildWorkerTopicAdminDetail(ctx.db, ctx.from, tid);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_topic_toggle:')) {
        const tid = Number(ctx.data.split(':')[1]);
        await toggleWorkerTopicItem(ctx.db, ctx.from, tid);
        const menu = await buildWorkerTopicAdminDetail(ctx.db, ctx.from, tid);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_topic_pick:')) {
        const tid = Number(ctx.data.split(':')[1]);
        const menu = await buildWorkerTopicLinkPicker(ctx.db, ctx.from, tid);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_topic_link:') || ctx.data.startsWith('admin_topic_unlink:')) {
        const unlink = ctx.data.startsWith('admin_topic_unlink:');
        const parts = ctx.data.split(':');
        const tid = Number(parts[1]);
        const fid = Number(parts[2]);
        await linkWorkerTopicFolderItem(ctx.db, ctx.from, tid, fid, unlink);
        const menu = await buildWorkerTopicAdminDetail(ctx.db, ctx.from, tid);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_topic_del:')) {
        const tid = Number(ctx.data.split(':')[1]);
        await deleteWorkerTopicItem(ctx.db, ctx.from, tid);
        const menu = await buildWorkerTopicsAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }

      // Admin Settings & Visibility
      if (ctx.data === 'admin_settings') {
        const menu = await buildWorkerSettingsAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_set_edit:')) {
        const key = ctx.data.split(':')[1];
        ctx.userData.admin_set_edit = key;
        await ctx.answer();
        return ctx.editMessageText('✏️ <b>تحديث الإعداد</b>\n\nأرسل النص الجديد الآن:', {
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_settings' }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data === 'admin_vis') {
        const menu = await buildWorkerVisibilityAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_vis_toggle:')) {
        const feat = ctx.data.split(':')[1];
        await toggleWorkerFeatureVisibility(ctx.db, ctx.from, feat);
        const menu = await buildWorkerVisibilityAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }

      // Admin AI & Admins Management
      if (ctx.data === 'admin_ai') {
        const menu = await buildWorkerAiAdmin(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_admins') {
        const menu = await buildWorkerAdmins(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_add_new') {
        ctx.userData.admin_add_new = true;
        await ctx.answer();
        return ctx.editMessageText('➕ <b>إضافة مشرف جديد</b>\n\nأرسل الرقم التعريفي (Telegram ID) للمشرف الجديد (أو @username إذا كان مسجلاً في البوت):', {
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_admins' }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data.startsWith('admin_user:')) {
        const menu = await buildWorkerAdminUser(ctx.db, ctx.from, Number(ctx.data.split(':')[1]));
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_role:')) {
        const parts = ctx.data.split(':');
        const targetId = Number(parts[1]);
        const result = await applyWorkerAdminRole(ctx.db, ctx.from, targetId, parts[2]);
        const menu = await buildWorkerAdminUser(ctx.db, ctx.from, targetId);
        await ctx.answer();
        return ctx.editMessageText(`${result.text}\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('admin_perm:')) {
        const parts = ctx.data.split(':');
        const targetId = Number(parts[1]);
        await toggleWorkerAdminPermission(ctx.db, ctx.from, targetId, parts[2]);
        const menu = await buildWorkerAdminUser(ctx.db, ctx.from, targetId);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }

      // --- Student Library Navigation ---
      if (ctx.data === 'resources') {
        const menu = await buildWorkerLibraryRoot(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'search') {
        ctx.userData.library_search = true;
        await ctx.answer();
        return ctx.editMessageText('🔎 <b>بحث في موارد المنصة</b>\n\nاكتب اسم مادة أو قسم أو مورد.', {
          reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
          parse_mode: 'HTML',
        });
      }
      if (ctx.data.startsWith('library:')) {
        const folderId = Number.parseInt(ctx.data.split(':')[1], 10) || 0;
        const menu = folderId ? await buildWorkerFolder(ctx.db, ctx.from, folderId) : await buildWorkerLibraryRoot(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('folder:')) {
        const folderId = Number.parseInt(ctx.data.split(':')[1], 10);
        const menu = await buildWorkerFolder(ctx.db, ctx.from, folderId);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('file:')) {
        const contentId = Number.parseInt(ctx.data.split(':')[1], 10);
        await ctx.answer();
        const file = await buildWorkerFile(ctx.db, contentId);
        if (!file) {
          return ctx.reply('⚠️ هذا المورد لم يعد موجوداً.', {
            reply_markup: { inline_keyboard: [[{ text: '📚 الموارد', callback_data: 'resources' }, { text: '🏠 الرئيسية', callback_data: 'home' }]] },
          });
        }
        const options = {
          caption: `📄 <b>${String(file.title).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</b>\n🗂 ${String(file.breadcrumb).replace(/</g, '&lt;').replace(/>/g, '&gt;')}`,
          parse_mode: 'HTML',
        };
        try {
          await sendMediaByType(bot, ctx.from.id, file.fileType, file.fileId, options);
        } catch {
          const isAdminUser = await get(ctx.db, 'SELECT 1 FROM admins WHERE telegram_id=? AND role IN (?,?,?)', [Number(ctx.from.id), 'owner', 'admin', 'reviewer']).catch(() => null);
          const errRows = [[{ text: '⬅️ رجوع للقسم', callback_data: `folder:${file.folderId}` }, { text: '🏠 الرئيسية', callback_data: 'home' }]];
          if (isAdminUser) {
            errRows.unshift([{ text: '🗑 حذف هذا المورد التالف من القسم', callback_data: `admin_fdel_file:${file.id}:${file.folderId}` }]);
          }
          await ctx.reply(
            `⚠️ <b>تعذّر إرسال هذا المورد من تيليجرام</b>\n\n📄 <b>${String(file.title).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</b>\n\nقد يكون هذا الملف مرفوعاً عبر توكن بوت قديم أو ببيانات تجريبية غير صالحة.`,
            { reply_markup: { inline_keyboard: errRows }, parse_mode: 'HTML' },
          );
        }
        return;
      }
      if (ctx.data === 'home') {
        const menu = await buildWorkerHome(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'account') {
        const account = await buildWorkerAccount(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(account.text, { reply_markup: account.reply_markup, parse_mode: 'HTML' });
      }
      const unsupported = await buildWorkerUnsupported(ctx.db, ctx.from, ctx.data);
      await ctx.answer();
      return ctx.editMessageText(unsupported.text, { reply_markup: unsupported.reply_markup, parse_mode: 'HTML' });
    },
  };

  handlers.message = async (ctx) => {
    if (ctx.userData?.ai_chat) {
      ctx.userData.ai_chat = false;
      const result = await answerWorkerAi(ctx.db, ctx.from, ctx.text, env);
      return ctx.reply(result.text, { parse_mode: 'HTML' });
    }
    if (ctx.userData?.library_search) {
      ctx.userData.library_search = false;
      const result = await findWorkerResources(ctx.db, ctx.from, ctx.text);
      return ctx.reply(result.text, { reply_markup: result.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.contact_message) {
      ctx.userData.contact_message = false;
      const result = await submitWorkerContactMessage(ctx.db, ctx.from, ctx.text);
      return ctx.reply(result.text, { reply_markup: result.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.admin_folder_new_parent !== undefined && ctx.userData?.admin_folder_new_parent !== null) {
      const pid = Number(ctx.userData.admin_folder_new_parent) || 0;
      const cleanName = String(ctx.text ?? '').trim();
      if (!cleanName) return ctx.reply('⚠️ يرجى إرسال اسم صالح للقسم.');
      ctx.userData.admin_folder_new_name = cleanName;
      const picker = buildWorkerFolderTypePicker(pid, cleanName);
      return ctx.reply(picker.text, { reply_markup: picker.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.admin_folder_rename) {
      const fid = Number(ctx.userData.admin_folder_rename);
      ctx.userData.admin_folder_rename = null;
      await renameWorkerFolder(ctx.db, ctx.from, fid, ctx.text);
      const menu = await buildWorkerAdminFolders(ctx.db, ctx.from, fid);
      return ctx.reply(`✅ تم تحديث اسم القسم.\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.admin_msg_reply) {
      const mid = Number(ctx.userData.admin_msg_reply);
      ctx.userData.admin_msg_reply = null;
      const res = await replyWorkerMessage(ctx.db, ctx.from, mid, ctx.text, bot);
      const menu = await buildWorkerMessages(ctx.db, ctx.from);
      return ctx.reply(`${res.text}\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.admin_news_new) {
      ctx.userData.admin_news_new = false;
      const res = await createWorkerNewsItem(ctx.db, ctx.from, ctx.text);
      const menu = await buildWorkerNewsAdmin(ctx.db, ctx.from);
      return ctx.reply(`${res.text}\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.admin_notify_audience) {
      const audience = ctx.userData.admin_notify_audience;
      ctx.userData.admin_notify_audience = null;
      const res = await sendWorkerBroadcastNotification(ctx.db, ctx.from, ctx.text, audience, bot);
      const menu = await buildWorkerNotificationsAdmin(ctx.db, ctx.from);
      return ctx.reply(`${res.text}\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.admin_topic_new) {
      ctx.userData.admin_topic_new = false;
      await createWorkerTopicItem(ctx.db, ctx.from, ctx.text);
      const menu = await buildWorkerTopicsAdmin(ctx.db, ctx.from);
      return ctx.reply(`✅ تم إنشاء الموضوع.\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.admin_set_edit) {
      const key = ctx.userData.admin_set_edit;
      ctx.userData.admin_set_edit = null;
      await saveWorkerSetting(ctx.db, ctx.from, key, ctx.text);
      const menu = await buildWorkerSettingsAdmin(ctx.db, ctx.from);
      return ctx.reply(`✅ تم حفظ الإعداد.\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.admin_add_new) {
      ctx.userData.admin_add_new = false;
      const res = await addWorkerNewAdmin(ctx.db, ctx.from, ctx.text);
      const menu = await buildWorkerAdmins(ctx.db, ctx.from);
      return ctx.reply(`${res.text}\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
    }
    return ctx.reply('ℹ️ استخدم أزرار MEDBOT للتنقل، أو /search للبحث داخل الموارد.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
    });
  };

  handlers.media = async (ctx) => {
    if (ctx.userData?.admin_upload_folder) {
      const fid = Number(ctx.userData.admin_upload_folder);
      const result = await uploadWorkerAdminMedia(ctx.db, ctx.from, ctx.message, fid, bot, env);
      return ctx.reply(result.text, { reply_markup: result.reply_markup, parse_mode: 'HTML' });
    }
    if (ctx.userData?.contribution_folder) {
      const result = await handleWorkerContributionMedia(ctx.db, ctx.from, ctx.message, ctx.userData.contribution_folder);
      ctx.userData.contribution_folder = null;
      return ctx.reply(result.text, { parse_mode: 'HTML' });
    }
    return ctx.reply('ℹ️ اختر أولاً القسم المناسب ثم أرسل المورد.');
  };

  const dispatch = createWorkerTelegramDispatcher({ bot, db: env.DB, handlers });
  try {
    return await dispatch(update);
  } catch (err) {
    lastWorkerError = String(err?.message || err);
    throw err;
  }
}

async function webhookResponse(request, env) {
  if (!env.DB) return json({ ok: false, error: 'd1_not_configured' }, 503);
  try {
    await ensureWorkerSchema(env.DB);
  } catch (err) {
    lastWorkerError = `schema_init_failed: ${err?.message || err}`;
    return json({ ok: false, error: 'd1_schema_init_failed' }, 503);
  }
  const idempotency = createD1TelegramIdempotencyStore(env.DB);
  return handleTelegramWebhook(request, { env, idempotency, dispatch: dispatchTelegramUpdate });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return healthResponse(env);
    if (request.method === 'GET' && url.pathname === '/telegram/status') {
      let tables = 0;
      let d1Error = null;
      if (env.DB) {
        try {
          await ensureWorkerSchema(env.DB);
          const row = await get(env.DB, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'");
          tables = Number(row?.[0] ?? 0);
        } catch (err) {
          d1Error = String(err?.message || err);
        }
      }
      return json({
        ok: Boolean(env.DB) && !d1Error,
        bot_token_configured: Boolean(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN),
        webhook_secret_configured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
        admin_id_configured: Boolean(env.ADMIN_ID),
        d1_tables: tables,
        d1_error: d1Error,
        last_error: lastWorkerError,
      });
    }
    if (url.pathname === '/backup/latest') return backupEndpoint(request, env);
    if (url.pathname === '/telegram/webhook') return webhookResponse(request, env);
    if (url.pathname === '/storage/status') {
      return json({
        ok: Boolean(env.FILES),
        storage: env.FILES ? 'r2' : 'unconfigured',
        adapter: env.FILES ? Boolean(createR2Storage(env.FILES)) : false,
      });
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
};
