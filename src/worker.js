import { handleTelegramWebhook } from './telegram/webhook.js';
import { createD1TelegramIdempotencyStore, initTelegramWebhookStore } from './db/d1/telegramUpdates.js';
import { get, run } from './db/d1/core.js';
import { createR2Storage } from './storage/r2.js';
import { isForwardedMessage } from './storage/googleDrive.js';
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
  resolveWorkerArchiveChannelAsync,
  saveWorkerArchiveChannel,
  publishWorkerCloudBackupToArchive,
  restoreWorkerFromArchiveChannelAuto,
  importWorkerArchiveInput,
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
import {
  extractFirstUrlFromMessage,
  handleDualUploadCallback,
  handleDualUploadNewFolderText,
  hasActiveDualUploadTextPrompt,
  saveUploadSession,
  startInteractiveUploadWizard,
} from './storage/dualUploadInteractive.js';
import {
  COLLEGE_STATUS,
  buildCollegeRuntimeEnv,
  buildCollegeSetupMenu,
  buildPlatformOwnerHub,
  clearPlatformWizardState,
  ensureCollegeSchema,
  ensurePlatformSchema,
  getCollege,
  getPlatformChannelConfig,
  handleCollegeSetupCallback,
  handleCollegeSetupText,
  handlePlatformOwnerCallback,
  handlePlatformOwnerText,
  isAuthorizedCollegeManager,
  isPlatformOwner,
  listColleges,
  verifyUserPlatformMembership,
} from './platform/index.js';

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
    editMessageCaption: (chatId, messageId, caption, options = {}) =>
      call('editMessageCaption', { parse_mode: 'HTML', chat_id: chatId, message_id: messageId, caption, ...options }),
    deleteMessage: (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
    answerCallbackQuery: (id) => call('answerCallbackQuery', { callback_query_id: id }),
    sendDocument: (chatId, document, options = {}) => call('sendDocument', { chat_id: chatId, document, ...options }),
    sendPhoto: (chatId, photo, options = {}) => call('sendPhoto', { chat_id: chatId, photo, ...options }),
    sendVideo: (chatId, video, options = {}) => call('sendVideo', { chat_id: chatId, video, ...options }),
    sendAudio: (chatId, audio, options = {}) => call('sendAudio', { chat_id: chatId, audio, ...options }),
    getChat: (chatId) => call('getChat', { chat_id: chatId }),
    getMe: () => call('getMe', {}),
    getChatMember: (chatId, userId) => call('getChatMember', { chat_id: chatId, user_id: userId }),
    pinChatMessage: (chatId, messageId, options = {}) =>
      call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true, ...options }),
    getFile: (fileId) => call('getFile', { file_id: fileId }),
    downloadFileText: async (fileId) => {
      const f = await call('getFile', { file_id: fileId });
      if (!f?.file_path) throw new Error('telegram_file_path_missing');
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
      if (!res.ok) throw new Error(`telegram_file_download_failed_${res.status}`);
      return res.text();
    },
    downloadFileBytes: async (fileId) => {
      const f = await call('getFile', { file_id: fileId });
      if (!f?.file_path) throw new Error('telegram_file_path_missing');
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
      if (!res.ok) throw new Error(`telegram_file_download_failed_${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), filePath: f.file_path };
    },
    sendBufferDocument: async (chatId, filename, contentString, options = {}) => {
      const form = new globalThis.FormData();
      form.append('chat_id', String(chatId));
      if (options.caption) form.append('caption', String(options.caption));
      if (options.parse_mode) form.append('parse_mode', String(options.parse_mode));
      const blob = new globalThis.Blob([String(contentString ?? '')], { type: 'application/json; charset=utf-8' });
      form.append('document', blob, filename || 'medbot-cloud-backup.json');
      const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) {
        throw new Error(body?.description || 'telegram_sendBufferDocument_failed');
      }
      return body.result;
    },
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
  userData.admin_archive_set_channel = false;
  userData.admin_archive_import = false;
  userData.du_new_folder_session = null;
  userData.du_new_folder_parent = null;
  userData.du_wizard_session = null;
  userData.du_wizard_mode = null;
  userData.cs_waiting_secret_name = null;
  userData.cs_waiting_archive = false;
  clearPlatformWizardState(userData);
}

async function isWorkerAdminOrOwner(db, userId, env = {}) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return false;
  const configuredOwner = Number.parseInt(String(env?.ADMIN_ID ?? '').trim(), 10);
  if (Number.isSafeInteger(configuredOwner) && configuredOwner > 0 && uid === configuredOwner) {
    await ensureConfiguredAdmin(db, configuredOwner, null).catch(() => {});
    return true;
  }
  if (!db) return false;
  const row = await get(
    db,
    'SELECT 1 FROM admins WHERE telegram_id = ? AND role IN (?, ?, ?)',
    [uid, 'owner', 'admin', 'reviewer'],
  ).catch(() => null);
  return Boolean(row);
}

async function sendMediaByType(bot, chatId, fileType, fileId, options = {}) {
  const normalized = String(fileType ?? '').toLowerCase();
  if ((normalized === 'link' || normalized === 'text') && typeof bot.sendMessage === 'function') {
    const cap = options.caption ? `${options.caption}\n\n` : '';
    const body =
      normalized === 'link'
        ? `${cap}🔗 <b>الرابط المباشر:</b>\n${String(fileId)}`
        : `${cap}${String(fileId)}`;
    return bot.sendMessage(chatId, body, { parse_mode: 'HTML' });
  }
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

  // Support direct channel posts in the Archive Channel (e.g. /connect_archive or forwarded/sent files, data, or links)
  const channelPost = update?.channel_post || update?.edited_channel_post;
  if (channelPost && channelPost.chat?.id) {
    const postText = String(channelPost.text || channelPost.caption || '').trim();
    if (/^\/(connect_archive|link_archive)\b/i.test(postText)) {
      const chId = String(channelPost.chat.id);
      await run(
        env.DB,
        "INSERT INTO settings(key,value) VALUES('archive_channel_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [chId],
      ).catch(() => {});
      await bot.sendMessage(
        channelPost.chat.id,
        `✅ <b>تم ربط هذه القناة كقناة أرشيف واسترداد سحابي رسمية لبوت MEDBOT!</b>\n📡 معرّف القناة: <code>${chId}</code>`,
      ).catch(() => {});
      return null;
    }

    if (!update?.edited_channel_post) {
      // 1. Check if the channel is waiting for a text reply (e.g., editing name or new section/subject name)
      const isMediaPost = Boolean(
        channelPost.document || channelPost.video || channelPost.photo || channelPost.audio || channelPost.voice,
      );
      if (!isMediaPost && postText && (await hasActiveDualUploadTextPrompt(env.DB, channelPost.chat.id, null))) {
        const fakeCtx = {
          db: env.DB,
          chatId: channelPost.chat.id,
          from: channelPost.from || (env.ADMIN_ID ? { id: Number(env.ADMIN_ID) } : null),
          message: channelPost,
          userData: {},
          reply: (t, opts = {}) => bot.sendMessage(channelPost.chat.id, t, opts),
        };
        await handleDualUploadNewFolderText(fakeCtx, postText, bot, env).catch(() => {});
        return null;
      }

      // 2. Otherwise start the interactive Destination Picker Wizard for any file, forwarded post, or link posted in the channel
      const channelTarget =
        (await resolveWorkerArchiveChannelAsync(env.DB, env)) || String(channelPost.chat.id);
      const wiz = await startInteractiveUploadWizard({
        bot,
        message: channelPost,
        channelTarget,
        db: env.DB,
        env,
        isDirectChannelPost: true,
      });
      if (wiz.ok) {
        const sent = await bot
          .sendMessage(channelPost.chat.id, wiz.summaryText, {
            parse_mode: 'HTML',
            reply_markup: wiz.replyMarkup,
            reply_to_message_id: channelPost.message_id,
          })
          .catch(() => null);
        if (sent?.message_id && wiz.session) {
          wiz.session.statusMessageId = sent.message_id;
          await saveUploadSession(env.DB, wiz.session);
        }
      }
      return null;
    }
  }

  const platformDb = env.PLATFORM_DB || env.DB;

  async function enforceCollegeAccessAndMembership(ctx, isCallback = false) {
    const uid = ctx.from?.id;
    if (!uid) return null;

    // 1. Check if this college is suspended by the Platform Owner
    if (env.COLLEGE_STATUS === COLLEGE_STATUS.SUSPENDED && !isPlatformOwner(uid, env)) {
      const reason = env.COLLEGE_SUSPENSION_REASON || 'موقوف مؤقتاً من قِبل إدارة المنصة المركزية.';
      const msg = `⛔ <b>بوت هذه الكلية متوقف مؤقتاً</b>\n\nالسبب: ${reason}`;
      if (isCallback) {
        await ctx.answer();
        return ctx.editMessageText(msg, { parse_mode: 'HTML' });
      }
      return ctx.reply(msg, { parse_mode: 'HTML' });
    }

    // 2. If college is in `pending_setup`, only allow the College Manager or Platform Owner
    if (
      env.COLLEGE_STATUS === COLLEGE_STATUS.PENDING_SETUP &&
      !isPlatformOwner(uid, env) &&
      !(await isAuthorizedCollegeManager(ctx.db, uid, env))
    ) {
      const msg = '⏳ <b>بوت هذه الكلية قيد الإعداد والتجهيز حالياً</b>\n\nسيتم فتح البوت للطلاب فور استكمال الإعدادات من قِبل إدارة الكلية.';
      if (isCallback) {
        await ctx.answer();
        return ctx.editMessageText(msg, { parse_mode: 'HTML' });
      }
      return ctx.reply(msg, { parse_mode: 'HTML' });
    }

    // 3. Enforce mandatory membership in the developer's central platform channel
    const membership = await verifyUserPlatformMembership({
      platformDb,
      userId: uid,
      env,
      collegeBot: bot,
      forceRefresh: false,
    });
    if (!membership.allowed) {
      if (isCallback) {
        await ctx.answer();
        return ctx.editMessageText(membership.text, {
          reply_markup: membership.reply_markup,
          parse_mode: 'HTML',
        });
      }
      return ctx.reply(membership.text, {
        reply_markup: membership.reply_markup,
        parse_mode: 'HTML',
      });
    }
    return null;
  }

  const handlers = {
    command: async (ctx) => {
      clearPendingStates(ctx.userData);
      const gateResponse = await enforceCollegeAccessAndMembership(ctx, false);
      if (gateResponse) return gateResponse;

      const command = String(ctx.text).trim().split(/\s+/, 1)[0].split('@', 1)[0].slice(1);
      if (command === 'platform') {
        const hub = await buildPlatformOwnerHub(platformDb, ctx.from, env);
        return ctx.reply(hub.text, { reply_markup: hub.reply_markup, parse_mode: 'HTML' });
      }
      if (command === 'setup') {
        await ensureConfiguredAdmin(ctx.db, env.ADMIN_ID, ctx.from.id === Number(env.ADMIN_ID) ? ctx.from.username : null).catch(() => {});
        const setupMenu = await buildCollegeSetupMenu(ctx.db, platformDb, ctx.from, env);
        return ctx.reply(setupMenu.text, { reply_markup: setupMenu.reply_markup, parse_mode: 'HTML' });
      }
      if (command === 'start') {
        await ensureConfiguredAdmin(ctx.db, env.ADMIN_ID, ctx.from.id === Number(env.ADMIN_ID) ? ctx.from.username : null).catch(() => {});
        if (env.PLATFORM_OWNER_BOT_ONLY && isPlatformOwner(ctx.from?.id, env)) {
          const hub = await buildPlatformOwnerHub(platformDb, ctx.from, env);
          return ctx.reply(hub.text, { reply_markup: hub.reply_markup, parse_mode: 'HTML' });
        }
        const menu = await buildWorkerHome(ctx.db, ctx.from, env);
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
        await ensureConfiguredAdmin(ctx.db, env.ADMIN_ID, ctx.from.id === Number(env.ADMIN_ID) ? ctx.from.username : null).catch(() => {});
        const menu = await buildWorkerAdmin(ctx.db, ctx.from, env);
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
      const fallback = await buildWorkerHome(ctx.db, ctx.from, env);
      return ctx.reply(fallback.text, { reply_markup: fallback.reply_markup, parse_mode: 'HTML' });
    },

    callback: async (ctx) => {
      // Handle mandatory platform channel verification callback first
      if (ctx.data === 'verify_platform_sub') {
        const check = await verifyUserPlatformMembership({
          platformDb,
          userId: ctx.from?.id,
          env,
          collegeBot: bot,
          forceRefresh: true,
        });
        await ctx.answer();
        if (!check.allowed) {
          return ctx.editMessageText(
            `⚠️ <b>لم يتم العثور على اشتراكك في القناة المركزية بعد!</b>\nيرجى الانضمام للقناة أولاً ثم الضغط على زر التحقق مرة أخرى.\n\n${check.text}`,
            { reply_markup: check.reply_markup, parse_mode: 'HTML' },
          );
        }
        const homeMenu = await buildWorkerHome(ctx.db, ctx.from, env);
        return ctx.editMessageText(`✅ <b>تم التحقق من اشتراكك بنجاح! أهلاً بك في المنصة.</b>\n\n${homeMenu.text}`, {
          reply_markup: homeMenu.reply_markup,
          parse_mode: 'HTML',
        });
      }

      const isChannelAction = ctx.message?.chat?.type === 'channel';
      if (!isChannelAction) {
        const gateResponse = await enforceCollegeAccessAndMembership(ctx, true);
        if (gateResponse) return gateResponse;
      }

      // Clear transient input flags on navigation unless selecting folder type
      if (!ctx.data.startsWith('admin_ftype:')) {
        clearPendingStates(ctx.userData);
      }

      if (ctx.data.startsWith('pf_')) {
        return handlePlatformOwnerCallback(ctx, bot, env, env.REQUEST_URL || null);
      }

      if (ctx.data.startsWith('cs_')) {
        return handleCollegeSetupCallback(ctx, bot, env);
      }

      if (ctx.data.startsWith('du_')) {
        if (!isChannelAction && !(await isWorkerAdminOrOwner(ctx.db, ctx.from?.id, env))) {
          await ctx.answer();
          return ctx.editMessageText('🔒 هذه الأداة مخصصة للمالك والمشرفين المعتمدين فقط.', {
            reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
            parse_mode: 'HTML',
          });
        }
        return handleDualUploadCallback(ctx, ctx.data, bot, env);
      }

      if (ctx.data === 'language') {
        const menu = await buildWorkerLanguage(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data.startsWith('lang_set:')) {
        const ok = await applyWorkerLanguage(ctx.db, ctx.from.id, ctx.data.split(':')[1]);
        const menu = await buildWorkerHome(ctx.db, ctx.from, env);
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

      // --- Admin Dashboard & Tools (Strict Owner/Admin Separation) ---
      if (ctx.data === 'admin' || ctx.data.startsWith('admin_')) {
        await ensureConfiguredAdmin(ctx.db, env.ADMIN_ID, ctx.from.id === Number(env.ADMIN_ID) ? ctx.from.username : null).catch(() => {});
        if (!(await isWorkerAdminOrOwner(ctx.db, ctx.from?.id, env))) {
          await ctx.answer();
          return ctx.editMessageText('🔒 هذه المنطقة مخصصة للمشرفين المعتمدين فقط.', {
            reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
            parse_mode: 'HTML',
          });
        }
      }
      if (ctx.data === 'admin') {
        const menu = await buildWorkerAdmin(ctx.db, ctx.from, env);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_runtime') {
        const channel = await resolveWorkerArchiveChannelAsync(ctx.db, env);
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

      // Admin Archive & Cloud Disaster Recovery
      if (ctx.data === 'admin_archive') {
        const menu = await buildWorkerArchiveAdmin(ctx.db, ctx.from, env, bot);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_archive_sync') {
        await ctx.answer();
        const result = await syncWorkerArchiveAll(ctx.db, ctx.from, bot, env);
        return ctx.editMessageText(result.text, { reply_markup: result.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_archive_backup') {
        await ctx.answer();
        try {
          const res = await publishWorkerCloudBackupToArchive(ctx.db, bot, env, { pin: true });
          if (res.ok) {
            return ctx.editMessageText(
              `✅ <b>تم حفظ وتثبيت نسخة الاسترداد السحابية الشاملة في قناة الأرشيف بنجاح!</b>\n\n` +
              `📁 الأقسام والمستويات المحفوظة: ${res.counts?.folders ?? 0}\n` +
              `📄 الموارد والملفات المحفوظة: ${res.counts?.content ?? 0}\n` +
              `📌 تم تثبيت ملف النسخة في القناة لاسترداده تلقائياً في أي وقت بضغطة زر.`,
              {
                reply_markup: { inline_keyboard: [[{ text: '⬅️ أرشيف القناة', callback_data: 'admin_archive' }, { text: '🏠 الرئيسية', callback_data: 'home' }]] },
                parse_mode: 'HTML',
              },
            );
          }
          return ctx.editMessageText('⚠️ لم يتم ربط قناة الأرشيف بعد.', {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ أرشيف القناة', callback_data: 'admin_archive' }]] },
            parse_mode: 'HTML',
          });
        } catch (err) {
          return ctx.editMessageText(`⚠️ تعذر رفع النسخة للقناة: <code>${String(err?.message || err).slice(0, 180)}</code>`, {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ أرشيف القناة', callback_data: 'admin_archive' }]] },
            parse_mode: 'HTML',
          });
        }
      }
      if (ctx.data === 'admin_archive_restore_auto') {
        await ctx.answer();
        const result = await restoreWorkerFromArchiveChannelAuto(ctx.db, ctx.from, bot, env);
        return ctx.editMessageText(result.text, { reply_markup: result.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'admin_archive_export_chat') {
        await ctx.answer();
        try {
          await publishWorkerCloudBackupToArchive(ctx.db, bot, env, { targetChatId: ctx.from.id, pin: false });
          return ctx.reply('✅ تم تصدير وإرسال ملف النسخة الاحتياطية الشاملة (<code>medbot-cloud-backup.json</code>) إلى محادثتك.', {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ أرشيف القناة', callback_data: 'admin_archive' }]] },
            parse_mode: 'HTML',
          });
        } catch (err) {
          return ctx.reply(`⚠️ تعذر تصدير النسخة: ${String(err?.message || err).slice(0, 150)}`);
        }
      }
      if (ctx.data === 'admin_archive_import') {
        ctx.userData.admin_archive_import = true;
        await ctx.answer();
        return ctx.editMessageText(
          `📥 <b>الاستيراد الشامل من قناة الأرشيف (بأي صيغة)</b>\n\n` +
          `يمكنك الآن استرداد واستيراد كافة البيانات بأي طريقة من الطرق التالية:\n` +
          `1️⃣ <b>توجيه (Forward) الرسائل والملفات من قناة الأرشيف:</b> حدد رسالة أو عدة رسائل (ملفات PDF، صور، فيديوهات، صوتيات، أو بطاقات أقسام) من القناة ووجّهها إلى هنا مباشرةً، وسيقوم البوت بقراءة بياناتها (المستوى، الترم، البلوك، المادة، القسم) وإعادة بناء الأقسام والموارد تلقائياً.\n` +
          `2️⃣ <b>إرسال ملف نسخة احتياطية:</b> أرسل ملف <code>.json</code> أو <code>.sql</code> أو <code>.txt</code> لاستعادة قاعدة البيانات بالكامل فوراً.`,
          {
            reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء والعودة للأرشيف', callback_data: 'admin_archive' }]] },
            parse_mode: 'HTML',
          },
        );
      }
      if (ctx.data === 'admin_archive_set_channel') {
        ctx.userData.admin_archive_set_channel = true;
        await ctx.answer();
        return ctx.editMessageText(
          `⚙️ <b>ربط أو تغيير قناة الأرشيف والطوارئ</b>\n\n` +
          `تأكد أولاً من إضافة البوت كمشرف (<b>Admin</b>) داخل القناة، ثم اختر إحدى الطرق التالية:\n` +
          `• أرسل معرّف القناة العام مثل: <code>@my_archive_channel</code> أو رابطها <code>https://t.me/...</code>\n` +
          `• أو أرسل المعرّف الرقمي للقناة السرية مثل: <code>-1001234567890</code>\n` +
          `• أو قم بتوجيه (<b>Forward</b>) أي رسالة من القناة إلى هنا مباشرةً\n` +
          `• أو اكتب الأمر <code>/connect_archive</code> داخل القناة نفسها!`,
          {
            reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_archive' }]] },
            parse_mode: 'HTML',
          },
        );
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
        await ensureConfiguredAdmin(ctx.db, env.ADMIN_ID, ctx.from.id === Number(env.ADMIN_ID) ? ctx.from.username : null).catch(() => {});
        const menu = await buildWorkerHome(ctx.db, ctx.from, env);
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
    const gateResponse = await enforceCollegeAccessAndMembership(ctx, false);
    if (gateResponse) return gateResponse;

    if (await handlePlatformOwnerText(ctx, bot, env, env.REQUEST_URL || null)) {
      return;
    }
    if (await handleCollegeSetupText(ctx, bot, env)) {
      return;
    }

    const isAdminCaller = await isWorkerAdminOrOwner(ctx.db, ctx.from?.id, env);

    if (isAdminCaller && (await hasActiveDualUploadTextPrompt(ctx.db, ctx.chatId, ctx.userData))) {
      return handleDualUploadNewFolderText(ctx, ctx.text, bot, env);
    }
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

    if (isAdminCaller) {
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
      if (ctx.userData?.admin_archive_set_channel) {
        ctx.userData.admin_archive_set_channel = false;
        const res = await saveWorkerArchiveChannel(ctx.db, ctx.from, ctx.message || ctx.text, bot);
        const menu = await buildWorkerArchiveAdmin(ctx.db, ctx.from, env, bot);
        return ctx.reply(`${res.text}\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.userData?.admin_archive_import) {
        const res = await importWorkerArchiveInput(ctx.db, ctx.from, ctx.message, bot);
        return ctx.reply(res.text, { reply_markup: res.reply_markup, parse_mode: 'HTML' });
      }

      // Direct-forward or link upload to Bot + Archive Channel (Owner & Admins only)
      if (isForwardedMessage(ctx.message) || extractFirstUrlFromMessage(ctx.message)) {
        const channelTarget = await resolveWorkerArchiveChannelAsync(ctx.db, env);
        const wiz = await startInteractiveUploadWizard({
          bot,
          message: ctx.message,
          channelTarget,
          db: ctx.db,
          env,
        });
        if (wiz.ok) {
          const sent = await ctx.reply(wiz.summaryText, {
            parse_mode: 'HTML',
            reply_markup: wiz.replyMarkup,
          });
          if (sent?.message_id && wiz.session) {
            wiz.session.statusMessageId = sent.message_id;
            await saveUploadSession(ctx.db, wiz.session);
          }
          return sent;
        }
      }
    }

    return ctx.reply('ℹ️ استخدم أزرار MEDBOT للتنقل، أو /search للبحث داخل الموارد.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
    });
  };

  handlers.media = async (ctx) => {
    if (ctx.message?.is_automatic_forward) return null;
    if (ctx.message?.chat?.type && ctx.message.chat.type !== 'private') return null;

    const gateResponse = await enforceCollegeAccessAndMembership(ctx, false);
    if (gateResponse) return gateResponse;

    if (ctx.userData?.cs_waiting_archive) {
      if (await handleCollegeSetupText(ctx, bot, env)) return;
    }

    if (ctx.userData?.contribution_folder) {
      const result = await handleWorkerContributionMedia(ctx.db, ctx.from, ctx.message, ctx.userData.contribution_folder);
      ctx.userData.contribution_folder = null;
      return ctx.reply(result.text, { parse_mode: 'HTML' });
    }

    const isAdminCaller = await isWorkerAdminOrOwner(ctx.db, ctx.from?.id, env);
    if (isAdminCaller) {
      if (ctx.userData?.admin_archive_set_channel) {
        ctx.userData.admin_archive_set_channel = false;
        const res = await saveWorkerArchiveChannel(ctx.db, ctx.from, ctx.message, bot);
        const menu = await buildWorkerArchiveAdmin(ctx.db, ctx.from, env, bot);
        return ctx.reply(`${res.text}\n\n${menu.text}`, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.userData?.admin_archive_import) {
        const res = await importWorkerArchiveInput(ctx.db, ctx.from, ctx.message, bot);
        return ctx.reply(res.text, { reply_markup: res.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.userData?.admin_upload_folder) {
        const fid = Number(ctx.userData.admin_upload_folder);
        const result = await uploadWorkerAdminMedia(ctx.db, ctx.from, ctx.message, fid, bot, env);
        return ctx.reply(result.text, { reply_markup: result.reply_markup, parse_mode: 'HTML' });
      }

      const channelTarget = await resolveWorkerArchiveChannelAsync(ctx.db, env);
      const wiz = await startInteractiveUploadWizard({
        bot,
        message: ctx.message,
        channelTarget,
        db: ctx.db,
        env,
      });
      if (wiz.ok) {
        const sent = await ctx.reply(wiz.summaryText, {
          parse_mode: 'HTML',
          reply_markup: wiz.replyMarkup,
        });
        if (sent?.message_id && wiz.session) {
          wiz.session.statusMessageId = sent.message_id;
          await saveUploadSession(ctx.db, wiz.session);
        }
        return sent;
      }
    }

    return ctx.reply('ℹ️ لرفع مساهمة طلابية، اختر أولاً «📤 المساهمات» من القائمة الرئيسية وحدد القسم المسموح، ثم أرسل الملف.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
    });
  };

  const dispatch = createWorkerTelegramDispatcher({ bot, db: env.DB, handlers });
  try {
    return await dispatch(update);
  } catch (err) {
    lastWorkerError = String(err?.message || err);
    await run(
      env.DB,
      "INSERT INTO settings(key,value) VALUES('last_worker_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [lastWorkerError.slice(0, 500)],
    ).catch(() => {});
    // Acknowledge update so a transient handler error never blocks Telegram's webhook queue
    return null;
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
  const runtimeEnv = {
    ...env,
    PLATFORM_DB: env.PLATFORM_DB || env.DB,
    COLLEGE_ID: env.COLLEGE_ID || 'default',
    REQUEST_URL: request.url,
  };
  return handleTelegramWebhook(request, { env: runtimeEnv, idempotency, dispatch: dispatchTelegramUpdate });
}

async function collegeWebhookResponse(request, env, rawCollegeId) {
  const platformDb = env.PLATFORM_DB || env.DB;
  if (!platformDb) return json({ ok: false, error: 'd1_not_configured' }, 503);

  try {
    await ensureWorkerSchema(env.DB);
    await ensurePlatformSchema(platformDb);
  } catch (err) {
    lastWorkerError = `platform_schema_init_failed: ${err?.message || err}`;
    return json({ ok: false, error: 'd1_schema_init_failed' }, 503);
  }

  let college;
  try {
    college = await getCollege(platformDb, rawCollegeId, env, { includeDecryptedToken: true });
  } catch {
    return json({ ok: false, error: 'invalid_college_id' }, 400);
  }
  if (!college || college.status === COLLEGE_STATUS.DECOMMISSIONED) {
    return json({ ok: false, error: 'college_not_found' }, 404);
  }

  const collegeEnv = await buildCollegeRuntimeEnv(platformDb, env, college.college_id);
  collegeEnv.COLLEGE_STATUS = college.status;
  collegeEnv.COLLEGE_SUSPENSION_REASON = college.suspension_reason;
  collegeEnv.REQUEST_URL = request.url;
  collegeEnv.TELEGRAM_WEBHOOK_SECRET = college.webhook_secret || env.TELEGRAM_WEBHOOK_SECRET || '';

  if (!collegeEnv.DB) {
    return json({ ok: false, error: 'college_db_not_configured' }, 503);
  }

  await ensureCollegeSchema(collegeEnv.DB);
  const idempotency = createD1TelegramIdempotencyStore(collegeEnv.DB);
  return handleTelegramWebhook(request, {
    env: collegeEnv,
    idempotency,
    dispatch: dispatchTelegramUpdate,
  });
}

async function platformOwnerWebhookResponse(request, env) {
  const platformDb = env.PLATFORM_DB || env.DB;
  if (!platformDb) return json({ ok: false, error: 'd1_not_configured' }, 503);

  try {
    await ensureWorkerSchema(env.DB);
    await ensurePlatformSchema(platformDb);
  } catch (err) {
    lastWorkerError = `platform_schema_init_failed: ${err?.message || err}`;
    return json({ ok: false, error: 'd1_schema_init_failed' }, 503);
  }

  const platformBotEnv = {
    ...env,
    PLATFORM_DB: platformDb,
    TELEGRAM_BOT_TOKEN: env.PLATFORM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN,
    BOT_TOKEN: env.PLATFORM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: env.PLATFORM_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET,
    PLATFORM_OWNER_BOT_ONLY: true,
    REQUEST_URL: request.url,
  };

  const idempotency = createD1TelegramIdempotencyStore(platformDb);
  return handleTelegramWebhook(request, {
    env: platformBotEnv,
    idempotency,
    dispatch: dispatchTelegramUpdate,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return healthResponse(env);
    if (request.method === 'GET' && url.pathname === '/telegram/status') {
      let tables = 0;
      let d1Error = null;
      let storedError = lastWorkerError;
      if (env.DB) {
        try {
          await ensureWorkerSchema(env.DB);
          const row = await get(env.DB, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'");
          tables = Number(row?.[0] ?? 0);
          if (!storedError) {
            const errRow = await get(env.DB, "SELECT value FROM settings WHERE key = 'last_worker_error'").catch(() => null);
            if (errRow?.[0]) storedError = String(errRow[0]);
          }
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
        last_error: storedError,
      });
    }
    if (request.method === 'GET' && url.pathname === '/platform/status') {
      const platformDb = env.PLATFORM_DB || env.DB;
      if (!platformDb) return json({ ok: false, error: 'd1_not_configured' }, 503);
      await ensurePlatformSchema(platformDb);
      const colleges = await listColleges(platformDb, env);
      const chCfg = await getPlatformChannelConfig(platformDb, env);
      return json({
        ok: true,
        platform: 'MEDBOT Multi-College Platform',
        colleges_total: colleges.length,
        colleges_active: colleges.filter((c) => c.status === COLLEGE_STATUS.ACTIVE).length,
        colleges_pending: colleges.filter((c) => c.status === COLLEGE_STATUS.PENDING_SETUP).length,
        colleges_suspended: colleges.filter((c) => c.status === COLLEGE_STATUS.SUSPENDED).length,
        mandatory_channel_enabled: chCfg.enabled,
        mandatory_channel_id: chCfg.channelId,
      });
    }
    if (url.pathname === '/backup/latest') return backupEndpoint(request, env);
    if (url.pathname === '/telegram/webhook') return webhookResponse(request, env);
    if (url.pathname.startsWith('/telegram/webhook/')) {
      const collegeSlug = decodeURIComponent(url.pathname.slice('/telegram/webhook/'.length)).replace(/\/+$/, '');
      if (collegeSlug) return collegeWebhookResponse(request, env, collegeSlug);
    }
    if (url.pathname === '/platform/webhook') return platformOwnerWebhookResponse(request, env);
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
