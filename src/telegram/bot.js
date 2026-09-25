/**
 * MEDBOT bot assembly: startup, handler registration and the polling loop.
 *
 * Registration order is deliberate and mirrors the Python `main()`: the
 * isolated subsystems register their callback namespaces first, the general
 * router last. A module's callbacks therefore always win over the fallback.
 */

import * as db from '../db/index.js';
import * as newsDelivery from '../newsDelivery.js';
import * as ai from '../ai/index.js';
import * as messages from '../ui/messages.js';
import * as contributions from '../ui/contributions.js';
import * as library from '../ui/library.js';
import * as assistant from '../ui/assistant.js';
import * as topics from '../ui/topics.js';
import * as news from '../ui/news.js';
import * as visibility from '../visibility.js';
import * as adminManagement from '../ui/adminManagement.js';
import * as adminSettings from '../ui/adminSettings.js';
import * as adminFolders from '../ui/adminFolders.js';
import * as homeUi from '../ui/home.js';
import * as workflowModule from '../workflow.js';
import { AI_DAILY_LIMIT } from '../constants.js';
import { btn, keyboard } from './ui.js';
import { TelegramTransport } from './client.js';
import {
  registerCommand,
  registerRoute,
  registerTextHandler,
  resetRouter,
  setCatchAll,
  setMediaHandler,
} from './router.js';
import { pollUpdates } from './adapter.js';

/**
 * Register every callback route, text handler and command.
 *
 * Idempotent via `resetRouter()`, so tests can re-register deterministically.
 */
export function registerHandlers() {
  resetRouter();

  // ---- Isolated subsystems (their callbacks must win) -------------
  for (const prefix of news.NEWS_CALLBACKS) {
    registerRoute({ name: `news:${prefix}`, prefixes: [prefix], handler: news.newsCallbackHandler });
  }
  registerRoute({
    name: 'adminManagement',
    prefixes: adminManagement.ADMIN_MGMT_PREFIXES,
    handler: adminManagement.adminManagementCallbackHandler,
  });
  registerRoute({
    name: 'adminSettings',
    prefixes: adminSettings.ADMIN_SETTINGS_PREFIXES,
    handler: adminSettings.adminSettingsCallbackHandler,
  });
  registerRoute({
    name: 'visibility',
    prefixes: visibility.VISIBILITY_PREFIXES,
    handler: visibility.visibilityCallbackHandler,
  });
  registerRoute({
    name: 'messages',
    prefixes: messages.MESSAGE_PREFIXES,
    handler: messages.messagesCallbackHandler,
  });
  registerRoute({
    name: 'contributions',
    prefixes: contributions.CONTRIBUTION_PREFIXES,
    handler: contributions.contributionsCallbackHandler,
  });
  registerRoute({
    name: 'topics',
    prefixes: topics.TOPIC_PREFIXES,
    handler: topics.topicsCallbackHandler,
  });
  registerRoute({
    name: 'assistant',
    prefixes: assistant.ASSISTANT_PREFIXES,
    handler: assistant.assistantCallbackHandler,
  });
  registerRoute({
    name: 'adminFolders',
    prefixes: adminFolders.ADMIN_FOLDER_PREFIXES,
    handler: adminFolders.adminFoldersCallbackHandler,
  });
  registerRoute({
    name: 'library',
    prefixes: library.LIBRARY_PREFIXES,
    handler: library.libraryCallbackHandler,
  });

  // ---- General router (always last) -------------------------------
  registerRoute({ name: 'admin', prefixes: ['admin'], handler: showAdminRoute });
  registerRoute({ name: 'home', prefixes: ['home'], handler: showHomeRoute });
  registerRoute({ name: 'language', prefixes: ['language', 'lang_set:'], handler: languageRoute });
  registerRoute({ name: 'account', prefixes: ['account'], handler: accountRoute });
  registerRoute({ name: 'about', prefixes: ['about'], handler: aboutRoute });
  registerRoute({ name: 'noop', prefixes: ['noop'], handler: noopRoute });

  setCatchAll(async (ctx) => {
    await ctx.answer();
    await ctx.editMessageText('⚠️ هذا الزر لم يعد صالحاً. استخدم 🏠 الرئيسية.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] },
    });
  });

  // ---- Text handlers (workflow state consumers) -------------------
  // Order matters: the most specific armed workflow first, so a typed title is
  // never consumed by a broader flow.
  registerTextHandler('news', news.handleNewsText);
  registerTextHandler('adminUpload', adminFolders.handleUploadText);
  registerTextHandler('adminFileRename', adminFolders.handleFileRenameText);
  registerTextHandler('adminFolderCreate', adminFolders.handleFolderCreateText);
  registerTextHandler('adminFolderRename', adminFolders.handleFolderRenameText);
  registerTextHandler('contributionTitle', contributions.handleContributionText);
  registerTextHandler('contributionResubmit', contributions.handleResubmitText);
  registerTextHandler('reviewNote', contributions.handleReviewNoteText);
  registerTextHandler('adminReply', messages.handleReplyText);
  registerTextHandler('contact', messages.handleMessageText);
  registerTextHandler('adminAdd', adminManagement.handleAddAdminText);
  registerTextHandler('settings', adminSettings.handleSettingText);
  registerTextHandler('topicsCreate', topics.handleTopicsText);
  registerTextHandler('notifications', adminSettings.handleNotificationText);
  registerTextHandler('assistant', assistant.handleAssistantText);
  registerTextHandler('librarySearch', handleLibrarySearch);

  // ---- Media handler (uploads) ------------------------------------
  setMediaHandler(async (ctx) => {
    if (await adminFolders.handleUploadMedia(ctx)) return;
    if (await contributions.handleContributionMedia(ctx)) return;
    if (await contributions.handleResubmitMedia(ctx)) return;
    await ctx.reply('ℹ️ لا توجد عملية رفع جارية. ابدأ من 📤 مساهمات الطلاب أو 🛠 إدارة المنصة.');
  });

  // ---- Commands ---------------------------------------------------
  registerCommand('start', startCommand);
  registerCommand('help', helpCommand);
  registerCommand('quota', quotaCommand);
  registerCommand('whoami', whoamiCommand);
  registerCommand('search', searchCommand);
  registerCommand('ask', askCommand);
  registerCommand('contact', messages.contactCommand);
  registerCommand('cancel', cancelCommand);
  registerCommand('text', unhandledText);
}

// ---------------------------------------------------------------------------
// General routes
// ---------------------------------------------------------------------------

async function showHomeRoute(ctx) {
  await ctx.answer();
  await homeUi.showHome(ctx);
}

async function showAdminRoute(ctx) {
  await ctx.answer();
  await adminFolders.showAdminPanel(ctx);
}

async function languageRoute(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';
  if (data.startsWith('lang_set:')) {
    await homeUi.setLanguage(ctx, data.split(':')[1]);
    return;
  }
  await homeUi.showLanguage(ctx);
}

async function accountRoute(ctx) {
  await ctx.answer();
  await homeUi.showAccount(ctx);
}

async function aboutRoute(ctx) {
  await ctx.answer();
  await homeUi.showAbout(ctx);
}

async function noopRoute(ctx) {
  await ctx.answer();
}

/** A bare search query typed outside the assistant flow. */
async function handleLibrarySearch(ctx) {
  if (ctx.kind !== 'message') return false;
  const text = String(ctx.text ?? '').trim();
  if (!text || text.startsWith('/')) return false;

  // Only treat it as a search when the user armed the library search explicitly.
  if (!ctx.userData?.library_search) return false;

  ctx.userData.library_search = false;
  await library.runSearch(ctx, text);
  return true;
}

/**
 * Arm the standalone platform-search workflow.
 *
 * Both `/search` and the library screen's "🔎 بحث في الموارد" button set this
 * marker, which is what `handleLibrarySearch` consumes. Python keeps the same
 * `search_mode` flag for both entry points.
 */
function workflowArmSearch(ctx) {
  ctx.userData.library_search = true;
}

/**
 * Notify a caller that a feature is hidden, unless they are an admin.
 *
 * Commands reply with a fresh message (there is no message to edit), unlike the
 * callback handlers which edit in place. Returns true when the notice was sent
 * and the caller should stop.
 */
async function featureHiddenNotice(ctx, feature) {
  try {
    if (db.isUserAdmin(ctx.from.id)) return false;
    if (!db.isFeatureHidden(feature)) return false;
  } catch {
    return false;
  }

  await ctx.reply('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
    reply_markup: homeUi.homeKeyboard(),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * The configured owner/admin Telegram id, or 0 when unset.
 *
 * Identity must come from explicit configuration: a missing/blank/zero
 * ADMIN_ID returns 0 and never promotes anyone, least of all the first user
 * who happens to send /start.
 */
function configuredAdminId() {
  const parsed = Number.parseInt(String(process.env.ADMIN_ID ?? '').trim(), 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 0 : parsed;
}

/**
 * Honest note about when the daily allowance refills.
 *
 * The counter rolls over at midnight, so the wait is until the next local day
 * begins. No number about the limit itself is ever shown.
 */
function quotaResetText() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);

  const totalMinutes = Math.max(1, Math.floor((tomorrow - now) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  let wait;
  if (hours && minutes) wait = `خلال ${hours} ساعة و${minutes} دقيقة`;
  else if (hours) wait = `خلال ${hours} ساعة`;
  else wait = `خلال ${minutes} دقيقة`;

  return (
    '⏳ <b>توقف مؤقت لا خطأ عندك.</b>\n' +
    'وصلت إلى الحد اليومي لاستخدام المساعد. ' +
    `سيتجدد العداد تلقائياً ${wait} (منتصف الليل بتوقيت الخادم)، ` +
    'ثم يمكنك المتابعة كالمعتاد.'
  );
}

async function startCommand(ctx) {
  db.registerUser(ctx.from.id, ctx.from.username, ctx.from.full_name ?? ctx.from.first_name);

  // Register the configured owner idempotently (a no-op without ADMIN_ID).
  const adminId = process.env.ADMIN_ID;
  if (adminId) {
    try {
      db.ensureConfiguredAdmin(Number.parseInt(adminId, 10), null);
    } catch {
      // Owner bootstrap is best-effort.
    }
  }

  // Register the configured admin ids (ADMIN_IDS="1,2,3").
  const adminIds = process.env.ADMIN_IDS;
  if (adminIds) {
    for (const part of adminIds.split(',')) {
      const parsed = Number.parseInt(part.trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0 && !db.isOwner(parsed)) {
        try {
          db.addSubAdmin(parsed, null);
        } catch {
          // Best-effort.
        }
      }
    }
  }

  await homeUi.showHome(ctx);
}

async function helpCommand(ctx) {
  const settings = homeUi.platformSettings();
  await ctx.reply(String(settings.help_text ?? '').trim() || 'استخدم الأزرار للتنقل.', {
    reply_markup: homeUi.buildMenu(ctx.from.id),
  });
}

/**
 * Report whether the caller can use the assistant right now.
 *
 * The figure shown is the shared AI_DAILY_LIMIT, and the same limiter runs
 * before generation, so the two can never disagree.
 */
async function quotaCommand(ctx) {
  db.registerUser(ctx.from.id, ctx.from.username, ctx.from.full_name ?? ctx.from.first_name);

  let remaining = 0;
  try {
    remaining = db.getRemainingQuota(ctx.from.id, AI_DAILY_LIMIT);
  } catch {
    remaining = 0;
  }

  const message = remaining > 0 ? '✅ يمكنك استخدام المساعد الآن.' : quotaResetText();
  await ctx.reply(message, { reply_markup: homeUi.buildMenu(ctx.from.id) });
}

/** The caller's Telegram id and current MEDBOT authorization status. */
async function whoamiCommand(ctx) {
  db.registerUser(ctx.from.id, ctx.from.username, ctx.from.full_name ?? ctx.from.first_name);

  let isAdmin = false;
  try {
    isAdmin = db.isUserAdmin(ctx.from.id);
  } catch {
    isAdmin = false;
  }

  const configured = configuredAdminId();
  let status;
  if (configured === 0) {
    status = 'ADMIN_ID غير مُهيّأ في البيئة.\nلن يُرقّى أي مستخدم تلقائياً، حتى أول مستخدم.';
  } else if (configured === ctx.from.id) {
    status = `أنت المالك المُهيّأ (ADMIN_ID=${configured}).`;
  } else {
    status = `ADMIN_ID مُهيّأ لمُعرّف آخر (${configured}).`;
  }

  await ctx.reply(
    `🆔 <b>مُعرّف Telegram الخاص بك:</b> <code>${ctx.from.id}</code>\n\n` +
      `🔐 صلاحية مشرف في MEDBOT: ${isAdmin ? 'نعم' : 'لا'}\n\n${status}`,
    { reply_markup: homeUi.buildMenu(ctx.from.id) },
  );
}

/**
 * Arm the standalone platform-search workflow (the `/search` command).
 *
 * Sets the library-search marker that the text chain consumes; without it the
 * prompt would be shown but the next message would go unanswered.
 */
async function searchCommand(ctx) {
  if (await featureHiddenNotice(ctx, 'assistant')) return;

  workflowArmSearch(ctx);
  await ctx.reply(
    '🔎 <b>MEDBOT Search</b>\n\n' +
      'اكتب اسم الكتاب أو المحاضرة أو الملف الذي تريد البحث عنه.\n\n' +
      'سيتم البحث فقط داخل الموارد المسجلة في MEDBOT.',
    { reply_markup: keyboard([[btn('❌ إلغاء البحث', 'home')]]) },
  );
}

/**
 * `/ask <question>` — explicit AI-chat entry point.
 *
 * With a question attached it is answered immediately in chat mode; without
 * one it opens the assistant menu, exactly like Python's handler. The typed
 * message is dispatched through the same text chain a manual message uses, so
 * `/ask` cannot diverge from the normal assistant path.
 */
async function askCommand(ctx) {
  db.registerUser(ctx.from.id, ctx.from.username, ctx.from.full_name ?? ctx.from.first_name);

  const query = String(ctx.text ?? '').replace(/^\/ask\b/i, '').trim();

  if (!query) {
    await ctx.reply(
      '🤖 <b>المساعد الذكي</b>\n\nاكتب سؤالك بعد الأمر مباشرة، مثل:\n<code>/ask ما هو CBC؟</code>',
      { reply_markup: keyboard([[btn('🤖 افتح المساعد', 'assistant')], [btn('🏠 الرئيسية', 'home')]]) },
    );
    return;
  }

  ctx.text = query;
  workflowModule.begin(ctx, assistant.ASSISTANT_WORKFLOW);
  ctx.userData.ai_mode = 'chat';
  await assistant.handleAssistantText(ctx);
}

async function cancelCommand(ctx) {
  // Clear every armed workflow so no stale state consumes the next message.
  workflowModule.clearAll(ctx);
  await ctx.reply('❌ تم إلغاء العملية الجارية.', { reply_markup: homeUi.homeKeyboard() });
}

/** A message nothing consumed: never dead-end the student. */
async function unhandledText(ctx) {
  if (ctx.kind !== 'message') return;
  const text = String(ctx.text ?? '').trim();
  if (!text || text.startsWith('/')) return;

  await ctx.reply(
    '🤔 لم أفهم طلبك من هذه الرسالة.\n\n' +
      'استخدم الأزرار للتنقل، أو ابدأ من 🤖 المساعد لسؤال علمي أو للبحث في موارد المنصة.',
    { reply_markup: homeUi.buildMenu(ctx.from.id) },
  );
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Initialise the database, run migrations, register handlers and warm caches.
 *
 * Returns `{bot, ready}`; the caller decides whether to start polling (the tests
 * assemble everything without a token and never poll).
 */
export async function createBot({ token = null, transport = null } = {}) {
  db.setDbPath();
  db.initDb();

  registerHandlers();

  const bot = transport ?? (token ? new TelegramTransport(token) : null);

  // Warm the AI pool once so the first student reply is not slowed by discovery.
  // Best-effort: a failure never blocks startup.
  ai.warmAiPool().catch(() => {});

  // Recover deliveries interrupted by a restart (non-blocking, one worker).
  if (bot) {
    newsDelivery.startRecovery(bot);
  }

  // Register the Telegram command list (best-effort).
  if (bot?.setMyCommands) {
    bot
      .setMyCommands([
        { command: 'start', description: 'بدء استخدام المنصة' },
        { command: 'quota', description: 'حالة استخدام المساعد اليومي' },
        { command: 'whoami', description: 'مُعرّفك وحالة صلاحيتك' },
        { command: 'search', description: 'البحث في موارد المنصة' },
        { command: 'ask', description: 'اسأل المساعد الذكي' },
        { command: 'contact', description: 'تواصل مع المنصة' },
        { command: 'cancel', description: 'إلغاء العملية الجارية' },
      ])
      .catch(() => {});
  }

  return { bot, ready: true };
}

/** Run the bot: migrate, register and long-poll until stopped. */
export async function runBot({ token = process.env.BOT_TOKEN } = {}) {
  const { bot } = await createBot({ token });
  if (!bot) throw new Error('BOT_TOKEN is required to run MEDBOT.');

  const me = await bot.getMe().catch(() => null);
  if (me?.username) {
    console.log(`MEDBOT running as @${me.username}`);
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await pollUpdates(bot, {
    shouldStop: () => stopping,
    onError: (error) => console.error('Polling error:', error.message ?? error),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBot().catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
  });
}
