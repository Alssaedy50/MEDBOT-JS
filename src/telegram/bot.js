/**
 * MEDBOT bot assembly: startup, handler registration and the polling loop.
 *
 * Registration order is deliberate and mirrors the Python `main()`: the
 * isolated subsystems register their callback namespaces first, the general
 * router last. A module's callbacks therefore always win over the fallback.
 */

import * as db from '../db/index.js';
import * as archive from '../archive.js';
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
  registerTextHandler('topicsCreate', topics.handleTopicCreateText);
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

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

async function cancelCommand(ctx) {
  // Clear every armed workflow so no stale state consumes the next message.
  const workflowModule = await import('../workflow.js');
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
        { command: 'help', description: 'المساعدة' },
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

  // Fire-and-forget archive sync when enabled (never blocks polling).
  if (archive.archiveEnabled()) {
    archive.syncAllResources(bot).catch(() => {});
  }

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
