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
import * as workflowModule from '../workflow.js';
import * as backup from './adminBackup.js';
import * as secrets from './adminSecrets.js';
import { buildFullBotBundle } from '../backup/fullBundle.js';
import { loadRuntimeSecrets, setRuntimeSecret } from '../security/secretVault.js';
import { restoreRemoteSnapshotIfEmpty } from '../db/backup.js';
import { AI_DAILY_LIMIT } from '../constants.js';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
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
import {
  dualUploadMediaMessage,
  ensureDriveFolder,
  extractDriveFolderId,
  getDriveStatus,
  isDriveConfigured,
  isForwardedMessage,
  resolveDriveAccessToken,
  setRuntimeDriveSession,
} from '../storage/googleDrive.js';

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
  registerRoute({ name: 'backup', prefixes: ['backup_menu', 'backup_chat', 'backup_channel'], handler: backupRoute });
  registerRoute({
    name: 'drive',
    prefixes: [
      'drive_menu',
      'drive_toggle_dual',
      'drive_set_script',
      'drive_set_token',
      'drive_set_refresh',
      'drive_set_folder',
      'drive_test',
    ],
    handler: driveRoute,
  });
  registerRoute({ name: 'secrets', prefixes: secrets.ADMIN_SECRET_PREFIXES, handler: secrets.handleSecretCallback });
  registerRoute({ name: 'bundle', prefixes: ['bundle_confirm'], handler: bundleRoute });
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
  registerTextHandler('adminUploadCustomTitle', adminFolders.handleUploadCustomTitleText);
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
  registerTextHandler('secrets', secrets.handleSecretText);
  registerTextHandler('driveSetup', handleDriveSetupText);
  registerTextHandler('topicsCreate', topics.handleTopicsText);
  registerTextHandler('notifications', adminSettings.handleNotificationText);
  registerTextHandler('assistant', assistant.handleAssistantText);
  registerTextHandler('librarySearch', handleLibrarySearch);

  // ---- Media handler (uploads) ------------------------------------
  setMediaHandler(async (ctx) => {
    if (ctx.userData?.restore_waiting && ctx.message?.document?.file_id) {
      await backup.restoreFromUploadedFile(ctx, ctx.message.document.file_id);
      delete ctx.userData.restore_waiting;
      return;
    }
    if (await adminFolders.handleUploadMedia(ctx)) return;
    if (await contributions.handleContributionMedia(ctx)) return;
    if (await contributions.handleResubmitMedia(ctx)) return;

    // Dual-upload any file forwarded to the bot (or sent when dual-upload/channel/Drive is configured)
    const shouldDualUpload =
      isForwardedMessage(ctx.message) ||
      Boolean(ctx.userData?.dual_upload_mode) ||
      archive.isConfigured() ||
      isDriveConfigured();

    if (shouldDualUpload) {
      const outcome = await dualUploadMediaMessage({
        bot: ctx.bot,
        message: ctx.message,
        channelTarget: archive.channelForSend(),
      });
      if (outcome.reason !== 'no_media') {
        await ctx.reply(outcome.summaryText, {
          parse_mode: 'HTML',
          reply_markup: outcome.replyMarkup,
        });
        return;
      }
    }

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
  registerCommand('backup', backupCommand);
  registerCommand('restore', restoreCommand);
  registerCommand('secrets', secretsCommand);
  registerCommand('bundle', bundleCommand);
  registerCommand('drive', driveCommand);
  registerCommand('dual', driveCommand);
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

async function backupRoute(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';
  if (data === 'backup_menu') return backup.showBackupMenu(ctx);
  if (data === 'backup_chat') return backup.sendDatabaseBackup(ctx, { toChannel: false });
  if (data === 'backup_channel') return backup.sendDatabaseBackup(ctx, { toChannel: true });
}

function buildDualUploadScreen(ctx) {
  const ch = archive.resolveChannel();
  const drive = getDriveStatus();
  const dualActive = Boolean(ctx.userData?.dual_upload_mode);
  const text = [
    '☁️ <b>إعدادات ربط Google Drive والرفع المزدوج (من داخل البوت)</b>',
    '━━━━━━━━━━━━━━━━━━',
    'أي ملف تقوم بتوجيهه (Forward) إلى البوت يتم رفعه تلقائياً إلى مكانين في نفس اللحظة:',
    '',
    `1️⃣ <b>قناة البوت:</b> ${ch ? `✅ متصلة وتعمل (<code>${ch}</code>)` : '⚪️ غير مضبوطة (MEDBOT_ARCHIVE_CHANNEL)'}`,
    `2️⃣ <b>حساب Google Drive:</b> ${
      drive.configured
        ? `✅ مربوط وجاهز${drive.userEmail ? ` (${drive.userEmail})` : ''}`
        : '⚪️ غير مربوط بعد — اختر طريقة الربط بالأسفل 👇'
    }`,
    `📁 <b>مجلد الحفظ في Drive:</b> <code>${drive.folderId || drive.folderName}</code>`,
    `🔄 <b>وضع استقبال الملفات:</b> ${dualActive ? '🟢 مفعل لأي ملف مباشر أو موجه' : '🟢 مفعل تلقائياً عند توجيه أي ملف (Forward)'}`,
    '',
    '💡 <b>طرق الربط المباشر من داخل البوت:</b>',
    '• اضغط <b>«🔑 ربط توكن Google Drive»</b> لإرسال التوكن مباشرة في المحادثة.',
    '• أو اضغط <b>«🔄 ربط دائم (Refresh Token)»</b> لربط لا ينتهي ويتجدد تلقائياً.',
    '• أو اضغط <b>«📁 تحديد مجلد Drive»</b> لاختيار مجلد معين في حسابك.',
  ].join('\n');

  const markup = keyboard([
    [btn('⚡ ربط دائم سريع (Google Script — الأسهل)', 'drive_set_script')],
    [
      btn('🔑 ربط توكن Google Drive', 'drive_set_token'),
      btn('🔄 ربط دائم (Refresh)', 'drive_set_refresh'),
    ],
    [
      btn('📁 تحديد مجلد Drive', 'drive_set_folder'),
      btn('🧪 فحص الاتصال الآن', 'drive_test'),
    ],
    [
      btn(
        dualActive ? '🔔 الرفع المباشر بدون توجيه: مفعل' : '🔘 تفعيل الرفع لأي ملف حتى بدون توجيه',
        'drive_toggle_dual',
      ),
    ],
    [btn('⬅️ إدارة المنصة', 'admin'), btn('🏠 الرئيسية', 'home')],
  ]);
  return { text, markup };
}

async function driveRoute(ctx) {
  await ctx.answer();
  delete ctx.userData.drive_wait_script;
  delete ctx.userData.drive_wait_token;
  delete ctx.userData.drive_wait_refresh;
  delete ctx.userData.drive_wait_folder;

  if (ctx.data === 'drive_toggle_dual') {
    ctx.userData.dual_upload_mode = !ctx.userData?.dual_upload_mode;
  } else if (ctx.data === 'drive_set_script') {
    ctx.userData.drive_wait_script = true;
    await ctx.editMessageText(
      [
        '⚡ <b>الربط الدائم الأسهل بحساب Google Drive (في دقيقة واحدة وبدون Client ID)</b>',
        '',
        '1️⃣ افتح <a href="https://script.google.com">script.google.com</a> واضغط <b>New project (مشروع جديد)</b>.',
        '2️⃣ امسح الكود الموجود والصق هذا الكود الصغير فقط:',
        '<pre>function doGet() {\n  DriveApp.getRootFolder();\n  return ContentService.createTextOutput(JSON.stringify({\n    access_token: ScriptApp.getOAuthToken()\n  })).setMimeType(ContentService.MimeType.JSON);\n}</pre>',
        '3️⃣ اضغط <b>Deploy (نشر)</b> ← <b>New deployment</b> ← اختر النوع <b>Web app</b>، واجعل <i>Who has access</i> على <b>Anyone (أي شخص)</b> ثم اضغط Deploy ووافق على الصلاحية.',
        '4️⃣ انسخ الرابط الناتج (ينتهي بـ <code>/exec</code>) وأرسله هنا في المحادثة الآن!',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: keyboard([[btn('❌ إلغاء والعودة', 'drive_menu')]]),
      },
    );
    return;
  } else if (ctx.data === 'drive_set_token') {
    ctx.userData.drive_wait_token = true;
    await ctx.editMessageText(
      [
        '🔑 <b>ربط حساب Google Drive مباشرة من البوت</b>',
        '',
        'أرسل الآن رمز الوصول (<b>Access Token</b>) الخاص بحسابك في Google Drive في رسالة نصية هنا.',
        '',
        '💡 <i>سيقوم البوت بحفظه مشفّراً وتفعيله فوراً وحذف رسالتك تلقائياً للحفاظ على الخصوصية.</i>',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: keyboard([[btn('❌ إلغاء والعودة', 'drive_menu')]]),
      },
    );
    return;
  } else if (ctx.data === 'drive_set_refresh') {
    ctx.userData.drive_wait_refresh = true;
    await ctx.editMessageText(
      [
        '🔄 <b>الربط الدائم التلقائي لحساب Google Drive (عبر OAuth)</b>',
        '',
        '<b>من أين تحصل عليها؟</b>',
        '1️⃣ من <a href="https://console.cloud.google.com/apis/credentials">Google Cloud Credentials</a> أنشئ <b>OAuth client ID</b> (نوع Web application) وأضف الرابط <code>https://developers.google.com/oauthplayground</code> في Authorized redirect URIs لتحصل على <code>CLIENT_ID</code> و <code>CLIENT_SECRET</code>.',
        '2️⃣ افتح <a href="https://developers.google.com/oauthplayground">OAuth 2.0 Playground</a>، ومن أيقونة الإعدادات ⚙️ (أعلى اليمين) فعّل <i>Use your own OAuth credentials</i> وأدخل الـ ID والـ Secret، ثم اختر صلاحية <code>https://www.googleapis.com/auth/drive.file</code> واضغط Authorize ثم <b>Exchange authorization code for tokens</b> لتحصل على <code>REFRESH_TOKEN</code>.',
        '',
        'أرسل القيم الثلاث في رسالة واحدة (كل قيمة في سطر مستقل أو مفصولة بـ <code>|</code>):',
        '<code>CLIENT_ID</code>',
        '<code>CLIENT_SECRET</code>',
        '<code>REFRESH_TOKEN</code>',
        '',
        '💡 <i>أو استخدم زر «⚡ ربط دائم سريع (Google Script)» للربط الدائم في دقيقة واحدة بدون الحاجة لـ Client ID!</i>',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: keyboard([[btn('⚡ استخدام Google Script الأسهل', 'drive_set_script')], [btn('❌ إلغاء والعودة', 'drive_menu')]]),
      },
    );
    return;
  } else if (ctx.data === 'drive_set_folder') {
    ctx.userData.drive_wait_folder = true;
    await ctx.editMessageText(
      [
        '📁 <b>تحديد مجلد الحفظ في Google Drive</b>',
        '',
        'أرسل الآن <b>رابط المجلد</b> من Google Drive (مثل <code>https://drive.google.com/drive/folders/...</code>) أو <b>معرّف المجلد (Folder ID)</b> مباشرة:',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: keyboard([[btn('❌ إلغاء والعودة', 'drive_menu')]]),
      },
    );
    return;
  } else if (ctx.data === 'drive_test') {
    try {
      const token = await resolveDriveAccessToken();
      if (!token) {
        await ctx.editMessageText(
          '⚠️ <b>حساب Google Drive غير مربوط بعد.</b>\n\nاضغط على <b>«🔑 ربط توكن Google Drive»</b> أو <b>«🔄 ربط دائم»</b> أولاً.',
          {
            parse_mode: 'HTML',
            reply_markup: keyboard([[btn('⬅️ رجوع لإعدادات Drive', 'drive_menu')]]),
          },
        );
        return;
      }
      const folderId = await ensureDriveFolder({ accessToken: token });
      const folderLink = folderId ? `https://drive.google.com/drive/folders/${folderId}` : 'https://drive.google.com';
      await ctx.editMessageText(
        [
          '✅ <b>الاتصال بحساب Google Drive ناجح ويعمل 100%!</b>',
          '',
          `📁 <b>مجلد الأرشيف الجاهز:</b> <code>${folderId || 'MEDBOT Archive'}</code>`,
          `🔗 <a href="${folderLink}">فتح مجلد البوت في Google Drive</a>`,
          '',
          'الآن أي ملف توجهه (Forward) إلى البوت سيتم رفعه تلقائياً إلى قناة البوت وإلى هذا المجلد في Google Drive.',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: keyboard([[btn('⬅️ رجوع لإعدادات Drive', 'drive_menu'), btn('🏠 الرئيسية', 'home')]]),
        },
      );
      return;
    } catch (err) {
      await ctx.editMessageText(
        `❌ <b>فشل اختبار الاتصال بـ Google Drive:</b>\n<code>${String(err?.message || err).slice(0, 180)}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: keyboard([[btn('⬅️ رجوع لإعدادات Drive', 'drive_menu')]]),
        },
      );
      return;
    }
  }

  const screen = buildDualUploadScreen(ctx);
  await ctx.editMessageText(screen.text, { parse_mode: 'HTML', reply_markup: screen.markup });
}

async function handleDriveSetupText(ctx) {
  if (ctx.kind !== 'message') return false;
  const raw = String(ctx.text ?? '').trim();
  if (!raw) return false;

  if (ctx.userData?.drive_wait_script) {
    delete ctx.userData.drive_wait_script;
    if (raw === '/cancel') {
      const screen = buildDualUploadScreen(ctx);
      await ctx.reply(screen.text, { parse_mode: 'HTML', reply_markup: screen.markup });
      return true;
    }
    if (!/^https:\/\/script\.google\.com\/macros\/s\//i.test(raw)) {
      await ctx.reply('⚠️ يرجى إرسال رابط Google Apps Script Web App الصحيح (يبدأ بـ <code>https://script.google.com/macros/s/</code> وينتهي بـ <code>/exec</code>).', {
        parse_mode: 'HTML',
        reply_markup: keyboard([[btn('⬅️ رجوع لإعدادات Drive', 'drive_menu')]]),
      });
      return true;
    }
    try {
      setRuntimeSecret('GOOGLE_DRIVE_SCRIPT_URL', raw);
    } catch {
      // Ignore vault errors
    }
    process.env.GOOGLE_DRIVE_SCRIPT_URL = raw;
    setRuntimeDriveSession({ scriptUrl: raw });
    if (ctx.message?.message_id) {
      await ctx.bot.deleteMessage(ctx.from.id, ctx.message.message_id).catch(() => {});
    }
    const screen = buildDualUploadScreen(ctx);
    await ctx.reply(`✅ <b>تم حفظ وتفعيل الربط الدائم عبر Google Script بنجاح!</b>\n\n${screen.text}`, {
      parse_mode: 'HTML',
      reply_markup: screen.markup,
    });
    return true;
  }

  if (ctx.userData?.drive_wait_token) {
    delete ctx.userData.drive_wait_token;
    if (raw === '/cancel') {
      const screen = buildDualUploadScreen(ctx);
      await ctx.reply(screen.text, { parse_mode: 'HTML', reply_markup: screen.markup });
      return true;
    }
    const cleanToken = raw.replace(/^GOOGLE_DRIVE_ACCESS_TOKEN\s*=\s*/i, '').trim();
    try {
      setRuntimeSecret('GOOGLE_DRIVE_ACCESS_TOKEN', cleanToken);
    } catch {
      // Ignore if secret vault is read-only in test env
    }
    process.env.GOOGLE_DRIVE_ACCESS_TOKEN = cleanToken;
    setRuntimeDriveSession({ accessToken: cleanToken });
    if (ctx.message?.message_id) {
      await ctx.bot.deleteMessage(ctx.from.id, ctx.message.message_id).catch(() => {});
    }
    const screen = buildDualUploadScreen(ctx);
    await ctx.reply(`✅ <b>تم ربط وتفعيل حساب Google Drive من داخل البوت بنجاح!</b>\n\n${screen.text}`, {
      parse_mode: 'HTML',
      reply_markup: screen.markup,
    });
    return true;
  }

  if (ctx.userData?.drive_wait_refresh) {
    delete ctx.userData.drive_wait_refresh;
    if (raw === '/cancel') {
      const screen = buildDualUploadScreen(ctx);
      await ctx.reply(screen.text, { parse_mode: 'HTML', reply_markup: screen.markup });
      return true;
    }
    const parts = raw.includes('|')
      ? raw.split('|').map((s) => s.trim()).filter(Boolean)
      : raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) {
      await ctx.reply('⚠️ يرجى إرسال القيم الثلاث (CLIENT_ID ثم CLIENT_SECRET ثم REFRESH_TOKEN) في 3 أسطر أو مفصولة بـ |.', {
        parse_mode: 'HTML',
        reply_markup: keyboard([[btn('⬅️ رجوع لإعدادات Drive', 'drive_menu')]]),
      });
      return true;
    }
    const [clientId, clientSecret, refreshToken] = parts;
    try {
      setRuntimeSecret('GOOGLE_CLIENT_ID', clientId);
      setRuntimeSecret('GOOGLE_CLIENT_SECRET', clientSecret);
      setRuntimeSecret('GOOGLE_REFRESH_TOKEN', refreshToken);
    } catch {
      // Ignore vault errors if any
    }
    process.env.GOOGLE_CLIENT_ID = clientId;
    process.env.GOOGLE_CLIENT_SECRET = clientSecret;
    process.env.GOOGLE_REFRESH_TOKEN = refreshToken;
    if (ctx.message?.message_id) {
      await ctx.bot.deleteMessage(ctx.from.id, ctx.message.message_id).catch(() => {});
    }
    const screen = buildDualUploadScreen(ctx);
    await ctx.reply(`✅ <b>تم حفظ الربط الدائم (Refresh Token) لحساب Google Drive بنجاح!</b>\n\n${screen.text}`, {
      parse_mode: 'HTML',
      reply_markup: screen.markup,
    });
    return true;
  }

  if (ctx.userData?.drive_wait_folder) {
    delete ctx.userData.drive_wait_folder;
    if (raw === '/cancel') {
      const screen = buildDualUploadScreen(ctx);
      await ctx.reply(screen.text, { parse_mode: 'HTML', reply_markup: screen.markup });
      return true;
    }
    const folderId = extractDriveFolderId(raw);
    if (!folderId) {
      await ctx.reply('⚠️ رابط أو معرّف المجلد غير صالح. أرسل رابط مجلد Google Drive أو المعرّف الصحيح.', {
        parse_mode: 'HTML',
        reply_markup: keyboard([[btn('⬅️ رجوع لإعدادات Drive', 'drive_menu')]]),
      });
      return true;
    }
    try {
      setRuntimeSecret('GOOGLE_DRIVE_FOLDER_ID', folderId);
    } catch {
      // Ignore vault errors
    }
    process.env.GOOGLE_DRIVE_FOLDER_ID = folderId;
    setRuntimeDriveSession({ folderId });
    const screen = buildDualUploadScreen(ctx);
    await ctx.reply(`✅ <b>تم تحديد مجلد Google Drive (<code>${folderId}</code>) بنجاح!</b>\n\n${screen.text}`, {
      parse_mode: 'HTML',
      reply_markup: screen.markup,
    });
    return true;
  }

  return false;
}

async function driveCommand(ctx) {
  ctx.userData.dual_upload_mode = true;
  const screen = buildDualUploadScreen(ctx);
  await ctx.reply(screen.text, { parse_mode: 'HTML', reply_markup: screen.markup });
}

async function bundleRoute(ctx) {
  await ctx.answer();
  if (!db.isOwner(ctx.from.id)) return ctx.editMessageText('🔒 ملف البوت الكامل متاح للمالك فقط.');
  return bundleCommand(ctx);
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

async function secretsCommand(ctx) { await secrets.showSecrets(ctx); }

async function bundleCommand(ctx) {
  if (!db.isOwner(ctx.from.id)) { await ctx.reply('🔒 ملف البوت الكامل متاح للمالك فقط.'); return; }
  await ctx.reply('📦 جاري تجهيز ملف البوت الكامل… قد يستغرق ذلك حسب حجم المشروع.');
  let bundle = null;
  try {
    bundle=await buildFullBotBundle();
    if (bundle.size > 49 * 1024 * 1024) throw new Error(`bundle_too_large_for_telegram:${bundle.size}`);
    const bytes=await readFile(bundle.path);
    await ctx.bot.sendDocumentBytes(ctx.from.id,bytes,{filename:'MEDBOT-FULL.tar.gz',caption:`📦 <b>MEDBOT Full Deploy Bundle</b>\nالحجم: ${(bundle.size/1024/1024).toFixed(2)} MB\nيشمل الكود + قاعدة البيانات + الإعدادات + مخزن الأسرار المشفّر.`,parse_mode:'HTML'});
  } catch(error) {
    await ctx.reply(`❌ تعذر إنشاء الملف الكامل: ${error.message}\n\nإذا تجاوز 50MB سنحتاج مسار R2/تنزيل مباشر بدلاً من Telegram.`);
  } finally {
    if (bundle?.path) await rm(path.dirname(bundle.path), { recursive:true, force:true }).catch(()=>{});
  }
}

async function backupCommand(ctx) {
  await backup.sendDatabaseBackup(ctx);
}

async function restoreCommand(ctx) {
  if (!backup.isOwnerForCommand(ctx.from.id)) {
    await ctx.reply('🔒 استعادة البيانات متاحة للمالك فقط.');
    return;
  }
  ctx.userData.restore_waiting = true;
  await ctx.reply('♻️ أرسل الآن ملف MEDBOT Data Backup بصيغة JSON.\n\nلن يتم تعديل البيانات حتى يتم التحقق من الملف بالكامل.\n\nلإلغاء العملية أرسل /cancel.');
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

  // If the deployment recreated an empty filesystem, recover the latest durable
  // snapshot before handlers start serving users. Existing non-empty databases
  // are never overwritten.
  try {
    const result = await restoreRemoteSnapshotIfEmpty({
      url: process.env.MEDBOT_BACKUP_URL,
      token: process.env.MEDBOT_BACKUP_TOKEN,
    });
    if (result.restored) console.log(`MEDBOT restored durable state from ${result.exported_at ?? 'remote backup'}`);
  } catch (error) {
    console.error('MEDBOT durable restore skipped:', error.message);
  }

  // Hydrate only after durable restore: the restored SQLite snapshot may itself
  // contain the encrypted vault. This also ensures managed AI/backup secrets are
  // available before handlers and provider warm-up run.
  try {
    loadRuntimeSecrets();
  } catch (error) {
    console.error('MEDBOT secret vault hydration skipped:', error.message);
  }

  registerHandlers();

  // One non-secret line so a deploy can be diagnosed from the log: where the
  // SQLite file actually lives (an ephemeral path explains lost settings) and
  // whether the archive is wired up. No token, id or value is ever printed.
  try {
    console.log(
      `MEDBOT db: ${db.currentDbPath()} | archive: ${
        archive.isConfigured() ? 'configured' : 'not configured'
      }`,
    );
  } catch {
    // Diagnostics must never block startup.
  }

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

// The single in-flight polling loop, so `runBot` cannot start a second one.
let activePolling = null;

/** How long a graceful shutdown may wait for the in-flight poll before exiting. */
export const SHUTDOWN_DRAIN_GRACE_MS = 8000;

/**
 * Run the bot: migrate, register and long-poll until stopped.
 *
 * Polling starts exactly once. A second call returns the in-flight loop instead
 * of starting a competing one: two long-poll loops would double-process updates
 * and race each other's offset. The function is intentionally not `async` so the
 * identity of the single loop is observable (and testable); it still returns a
 * promise callers can `await`/`catch`.
 */
export function runBot({ token = process.env.BOT_TOKEN, transport = null, shouldStop = null } = {}) {
  if (activePolling) return activePolling;

  activePolling = runPollingLoop({ token, transport, shouldStop }).finally(() => {
    activePolling = null;
  });
  return activePolling;
}

async function runPollingLoop({ token, transport, shouldStop = null }) {
  const { bot } = await createBot({ token, transport });
  if (!bot) throw new Error('BOT_TOKEN is required to run MEDBOT.');

  const me = await bot.getMe().catch(() => null);
  if (me?.username) {
    console.log(`MEDBOT running as @${me.username}`);
  }

  let stopping = false;
  let drainTimer = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('[MEDBOT] SHUTDOWN requested');
    // An in-flight long poll can take up to its 40s transport timeout to return,
    // but a host sends SIGKILL well before that (Render allows ~30s). Bound the
    // drain so the process always exits within the grace window instead of being
    // killed mid-write. The timer is cleared when the loop returns normally.
    drainTimer = setTimeout(() => {
      console.log('[MEDBOT] SHUTDOWN drain grace elapsed; exiting');
      process.exit(0);
    }, SHUTDOWN_DRAIN_GRACE_MS);
    drainTimer.unref?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log('[MEDBOT] TELEGRAM_POLLING_STARTED');

  try {
    await pollUpdates(bot, {
      // An extra predicate lets a caller (a test, or a supervisor) end the loop
      // without a signal; the signal flag remains the production path.
      shouldStop: () => stopping || (typeof shouldStop === 'function' ? shouldStop() : false),
      // A polling failure is logged with a non-secret message and retried by the
      // loop's own backoff; it must never be swallowed into silence.
      onError: (error) => console.error(`[MEDBOT] TELEGRAM_POLLING_ERROR: ${safeErrorMessage(error)}`),
      onRetry: (error, waitSeconds) =>
        console.warn(
          `[MEDBOT] TELEGRAM_POLLING_RETRY in ${waitSeconds}s after: ${safeErrorMessage(error)}`,
        ),
    });
  } finally {
    if (drainTimer) clearTimeout(drainTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    console.log('[MEDBOT] TELEGRAM_POLLING_STOPPED');
  }
}

/**
 * A log-safe rendering of an error.
 *
 * The transport embeds the bot token in the request URL, so an error message
 * that echoes a URL could leak it. Any `bot<token>` segment is masked before the
 * message reaches a log line; no environment value is ever printed.
 */
export function safeErrorMessage(error) {
  const detail = error?.message ?? String(error ?? 'unknown error');
  // Telegram bot tokens look like `<digits>:<alphanumeric>` and are embedded in
  // the request URL, so an error echoing that URL would otherwise leak the token.
  return detail
    .replace(/bot\d{4,}:[A-Za-z0-9_-]{5,}/g, 'bot<redacted>')
    .replace(/bot[0-9A-Za-z_-]{10,}/g, 'bot<redacted>');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBot().catch((error) => {
    console.error('Fatal startup error:', safeErrorMessage(error));
    process.exit(1);
  });
}
