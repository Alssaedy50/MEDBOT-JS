import { handleTelegramWebhook } from './telegram/webhook.js';
import { createD1TelegramIdempotencyStore, initTelegramWebhookStore } from './db/d1/telegramUpdates.js';
import { createR2Storage } from './storage/r2.js';
import { createWorkerTelegramDispatcher } from './telegram/workerDispatcher.js';
import { buildWorkerHome, buildWorkerAccount } from './telegram/workerHome.js';
import { buildWorkerLibraryRoot, buildWorkerFolder, findWorkerResources, buildWorkerFile } from './telegram/workerResources.js';
import { buildWorkerLanguage, applyWorkerLanguage, buildWorkerAbout, buildWorkerContact, buildWorkerNews, buildWorkerNewsDetail, buildWorkerMyContributions } from './telegram/workerParity.js';
import { buildWorkerTopics, buildWorkerTopic } from './telegram/workerTopics.js';
import { buildWorkerContributionStart, prepareWorkerContribution, handleWorkerContributionMedia } from './telegram/workerContributions.js';
import { answerWorkerAi } from './telegram/workerAi.js';
import { buildWorkerAdmin, buildWorkerPending, buildWorkerContributionReview, reviewWorkerContribution, buildWorkerAiAdmin, buildWorkerAdmins, buildWorkerAdminUser, applyWorkerAdminRole, buildWorkerRuntime } from './telegram/workerAdmin.js';
import { ensureConfiguredAdmin } from './db/d1/admins.js';
import { buildWorkerAdminSurfaces, buildWorkerFolders, buildWorkerFolderAdmin, createFolderFromText, renameFolderFromText, deleteFolder, buildWorkerContentAdmin, buildWorkerFileAdmin, renameFileFromText, deleteFileWorker, buildWorkerMessages, buildWorkerMessage, closeWorkerMessage, replyWorkerMessage, buildWorkerTopicsAdmin, buildWorkerTopicAdmin, toggleWorkerTopic, buildWorkerSettings, settingPrompt, saveSetting, buildWorkerNewsAdmin, buildWorkerNewsItem, publishWorkerNews, deleteWorkerNews, buildWorkerVisibility, toggleWorkerVisibility } from './telegram/workerAdminParity.js';
import { get } from './db/d1/core.js';

function json(data, status = 200) {
  return new globalThis.Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function backupEndpoint(request, env) {
  if (!env.FILES || !env.BACKUP_SECRET) return json({ ok:false, error:'backup_not_configured' }, 503);
  if (request.headers.get('Authorization') !== `Bearer ${env.BACKUP_SECRET}`) return json({ ok:false, error:'unauthorized' }, 401);
  if (request.method === 'PUT') {
    await env.FILES.put('backups/latest.json', request.body, { httpMetadata: { contentType:'application/json; charset=utf-8' } });
    return json({ ok:true, stored:'backups/latest.json' });
  }
  if (request.method === 'GET') {
    const object = await env.FILES.get('backups/latest.json');
    if (!object) return json({ ok:false, error:'not_found' }, 404);
    return new globalThis.Response(object.body, { status:200, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
  }
  return json({ok:false,error:'method_not_allowed'},405);
}

function healthResponse(env = {}) {
  return json({
    ok: true, service: 'MEDBOT', runtime: 'cloudflare-worker', phase: 11,
    telegram_webhook: 'adapter_enabled', telegram_domain_router: 'phase15-core-parity',
    database: env.DB ? 'd1-bound' : 'd1-missing',
    object_storage: env.FILES ? 'r2-bound' : 'r2-missing',
  });
}

function telegramBot(token) {
  if (!token) return null;
  async function call(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`telegram_${method}_failed`);
    const body = await response.json();
    if (!body.ok) throw new Error(`telegram_${method}_rejected`);
    return body.result;
  }
  return {
    sendMessage: (chatId, text, options = {}) => call('sendMessage', { chat_id: chatId, text, ...options }),
    editMessageText: (text, options = {}) => call('editMessageText', { text, ...options }),
    answerCallbackQuery: (id) => call('answerCallbackQuery', { callback_query_id: id }),
    sendDocument: (chatId, document, options = {}) => call('sendDocument', { chat_id: chatId, document, ...options }),
    sendPhoto: (chatId, photo, options = {}) => call('sendPhoto', { chat_id: chatId, photo, ...options }),
    sendVideo: (chatId, video, options = {}) => call('sendVideo', { chat_id: chatId, video, ...options }),
    sendAudio: (chatId, audio, options = {}) => call('sendAudio', { chat_id: chatId, audio, ...options }),
  };
}

async function dispatchTelegramUpdate(update, { env }) {
  const bot = telegramBot(env.TELEGRAM_BOT_TOKEN);
  if (!bot) throw new Error('telegram_bot_token_not_configured');
  const handlers = {
    command: async (ctx) => {
      const command = String(ctx.text).trim().split(/\s+/, 1)[0].split('@', 1)[0].slice(1);
      if (command === 'start') { await ensureConfiguredAdmin(ctx.db,env.ADMIN_ID,ctx.from.id===Number(env.ADMIN_ID)?ctx.from.username:null); const menu = await buildWorkerHome(ctx.db, ctx.from); return ctx.reply(menu.text, { reply_markup: menu.reply_markup }); }
      if (command === 'help') { const menu=await buildWorkerAbout(ctx.db,ctx.from); return ctx.reply(menu.text,{reply_markup:menu.reply_markup}); }
      if (command === 'quota') { const menu=await buildWorkerAccount(ctx.db,ctx.from); return ctx.reply(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (command === 'whoami') { const admin = await get(db,'SELECT role FROM admins WHERE telegram_id=?',[ctx.from.id]); const role=admin?.[0]??'none'; return ctx.reply('🆔 <b>مُعرّف Telegram:</b> <code>'+ctx.from.id+'</code>\\n\\n🔐 الصلاحية: '+role,{parse_mode:'HTML'}); }
      if (command === 'contact') { const menu=await buildWorkerContact(ctx.db,ctx.from); return ctx.reply(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (command === 'cancel') { ctx.userData={}; return ctx.reply('❌ تم إلغاء العملية الجارية.',{reply_markup:{inline_keyboard:[[ {text:'🏠 الرئيسية',callback_data:'home'} ]]}}); }
      if (command === 'ask') { const question=String(ctx.text).replace(/^\\/ask\\b/i,'').trim(); if(question){ const result=await answerWorkerAi(ctx.db,ctx.from,question,env); return ctx.reply(result.text,{parse_mode:'HTML'}); } ctx.userData.ai_chat=true; return ctx.reply('🤖 <b>المساعد الذكي</b>\\n\\nاكتب سؤالك الطبي الآن.', { parse_mode:'HTML' }); }
      if (command === 'contribute') { const menu=await buildWorkerContributionStart(ctx.db,ctx.from); return ctx.reply(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (command === 'search') {
        ctx.userData.library_search = true;
        return ctx.reply('🔎 <b>بحث في موارد المنصة</b>\\n\\nاكتب اسم مادة أو قسم أو مورد.', { reply_markup: { inline_keyboard: [[{ text:'🏠 الرئيسية', callback_data:'home' }]] } });
      }
      throw new Error('worker_command_not_migrated');
    },
    callback: async (ctx) => {
      if (ctx.data === 'language') { const menu=await buildWorkerLanguage(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('lang_set:')) { const ok=await applyWorkerLanguage(ctx.db,ctx.from.id,ctx.data.split(':')[1]); const menu=await buildWorkerHome(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(ok?menu.text:'⚠️ لغة غير مدعومة.',{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'about') { const menu=await buildWorkerAbout(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'contact') { const menu=await buildWorkerContact(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'news') { const menu=await buildWorkerNews(ctx.db,ctx.from,0); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('news_page:')) { const menu=await buildWorkerNews(ctx.db,ctx.from,Number(ctx.data.split(':')[1])||0); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('news:')) { const menu=await buildWorkerNewsDetail(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'my_contributions') { const menu=await buildWorkerMyContributions(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'topics') { const menu=await buildWorkerTopics(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('topic:')) { const menu=await buildWorkerTopic(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'contributions') { const menu=await buildWorkerContributionStart(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('contrib_folder:')) { const folderId=Number(ctx.data.split(':')[1]); const result=await prepareWorkerContribution(ctx.db,ctx.from,folderId); if(result.ok)ctx.userData.contribution_folder=folderId; await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'assistant') { ctx.userData.ai_chat=true; await ctx.answer(); return ctx.editMessageText('🤖 <b>المساعد الذكي</b>\\n\\nاكتب سؤالك الطبي الآن.',{reply_markup:{inline_keyboard:[[ {text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'admin') { const menu=await buildWorkerAdmin(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'admin_pending') { const menu=await buildWorkerPending(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_contrib:')) { const menu=await buildWorkerContributionReview(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_approve:')||ctx.data.startsWith('admin_reject:')) { const action=ctx.data.startsWith('admin_approve:')?'approve':'reject'; const id=Number(ctx.data.split(':')[1]); const result=await reviewWorkerContribution(ctx.db,ctx.from,id,action); await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'📥 المساهمات',callback_data:'admin_pending'},{text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'admin_surfaces') { const menu=await buildWorkerAdminSurfaces(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'admin_folders' || ctx.data.startsWith('admin_folders:')) { const id=Number(ctx.data.split(':')[1]||0); const menu=await buildWorkerFolders(ctx.db,ctx.from,id); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_folder:')) { const menu=await buildWorkerFolderAdmin(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_folder_create:')) { ctx.userData.admin_folder_create=Number(ctx.data.split(':')[1]||0); await ctx.answer(); return ctx.editMessageText('✏️ أرسل اسم القسم الجديد الآن.',{reply_markup:{inline_keyboard:[[ {text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_folder_rename:')) { ctx.userData.admin_folder_rename=Number(ctx.data.split(':')[1]); await ctx.answer(); return ctx.editMessageText('✏️ أرسل الاسم الجديد الآن.',{reply_markup:{inline_keyboard:[[ {text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_folder_delete:')) { const result=await deleteFolder(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'⬅️ الأقسام',callback_data:'admin_folders:0'},{text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'admin_content' || ctx.data.startsWith('admin_content:')) { const menu=await buildWorkerContentAdmin(ctx.db,ctx.from,Number(ctx.data.split(':')[1]||0)); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_file:')) { const menu=await buildWorkerFileAdmin(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_file_rename:')) { ctx.userData.admin_file_rename=Number(ctx.data.split(':')[1]); await ctx.answer(); return ctx.editMessageText('✏️ أرسل العنوان الجديد الآن.',{reply_markup:{inline_keyboard:[[ {text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_file_delete:')) { const result=await deleteFileWorker(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'⬅️ الموارد',callback_data:'admin_content'},{text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'admin_messages') { const menu=await buildWorkerMessages(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_msg:')) { const menu=await buildWorkerMessage(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_msg_reply:')) { ctx.userData.admin_msg_reply=Number(ctx.data.split(':')[1]); await ctx.answer(); return ctx.editMessageText('↩️ أرسل الرد الآن.',{reply_markup:{inline_keyboard:[[ {text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_msg_close:')) { const result=await closeWorkerMessage(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'⬅️ الرسائل',callback_data:'admin_messages'},{text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'admin_topics') { const menu=await buildWorkerTopicsAdmin(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_topic:')) { const menu=await buildWorkerTopicAdmin(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_topic_toggle:')) { const result=await toggleWorkerTopic(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'⬅️ المواضيع',callback_data:'admin_topics'},{text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'admin_settings') { const menu=await buildWorkerSettings(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_setting:')) { const key=ctx.data.split(':')[1]; const result=await settingPrompt(ctx.db,ctx.from,key); ctx.userData.admin_setting=key; await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'⬅️ الإعدادات',callback_data:'admin_settings'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'admin_news') { const menu=await buildWorkerNewsAdmin(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_news_item:')) { const menu=await buildWorkerNewsItem(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_news_publish:')) { const result=await publishWorkerNews(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'⬅️ الأخبار',callback_data:'admin_news'},{text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_news_delete:')) { const result=await deleteWorkerNews(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'⬅️ الأخبار',callback_data:'admin_news'},{text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'admin_visibility') { const menu=await buildWorkerVisibility(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_visibility_toggle:')) { const result=await toggleWorkerVisibility(ctx.db,ctx.from,ctx.data.split(':')[1]); const menu=await buildWorkerVisibility(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'admin_runtime') { const menu=await buildWorkerRuntime(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'admin_ai') { const menu=await buildWorkerAiAdmin(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data === 'admin_admins') { const menu=await buildWorkerAdmins(ctx.db,ctx.from); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_user:')) { const menu=await buildWorkerAdminUser(ctx.db,ctx.from,Number(ctx.data.split(':')[1])); await ctx.answer(); return ctx.editMessageText(menu.text,{reply_markup:menu.reply_markup,parse_mode:'HTML'}); }
      if (ctx.data.startsWith('admin_role:')) { const parts=ctx.data.split(':'); const result=await applyWorkerAdminRole(ctx.db,ctx.from,Number(parts[1]),parts[2]); await ctx.answer(); return ctx.editMessageText(result.text,{reply_markup:{inline_keyboard:[[ {text:'⬅️ المشرفون',callback_data:'admin_admins'},{text:'🏠 الرئيسية',callback_data:'home'} ]]},parse_mode:'HTML'}); }
      if (ctx.data === 'resources') {
        const menu = await buildWorkerLibraryRoot(ctx.db, ctx.from);
        await ctx.answer();
        return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
      }
      if (ctx.data === 'search') {
        ctx.userData.library_search = true;
        await ctx.answer();
        return ctx.editMessageText('🔎 <b>بحث في موارد المنصة</b>\\n\\nاكتب اسم مادة أو قسم أو مورد.', { reply_markup: { inline_keyboard: [[{ text:'🏠 الرئيسية', callback_data:'home' }]] }, parse_mode: 'HTML' });
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
        const file = await buildWorkerFile(ctx.db, contentId);
        if (!file) throw new Error('worker_resource_not_found');
        const options = { caption: `📄 <b>${String(file.title).replace(/</g,'&lt;').replace(/>/g,'&gt;')}</b>\\n🗂 ${String(file.breadcrumb).replace(/</g,'&lt;').replace(/>/g,'&gt;')}`, parse_mode:'HTML' };
        if (file.fileType === 'photo') await bot.sendPhoto(ctx.from.id, file.fileId, options);
        else if (file.fileType === 'video') await bot.sendVideo(ctx.from.id, file.fileId, options);
        else if (file.fileType === 'audio') await bot.sendAudio(ctx.from.id, file.fileId, options);
        else await bot.sendDocument(ctx.from.id, file.fileId, options);
        await ctx.answer();
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
      throw new Error('worker_callback_not_migrated');
    },
  };
  handlers.message = async (ctx) => {
    if (ctx.userData?.admin_folder_create !== undefined) { const id=ctx.userData.admin_folder_create; delete ctx.userData.admin_folder_create; const result=await createFolderFromText(ctx.db,ctx.from,id,ctx.text); return ctx.reply(result.text,{parse_mode:'HTML'}); }
    if (ctx.userData?.admin_folder_rename) { const id=ctx.userData.admin_folder_rename; delete ctx.userData.admin_folder_rename; const result=await renameFolderFromText(ctx.db,ctx.from,id,ctx.text); return ctx.reply(result.text,{parse_mode:'HTML'}); }
    if (ctx.userData?.admin_file_rename) { const id=ctx.userData.admin_file_rename; delete ctx.userData.admin_file_rename; const result=await renameFileFromText(ctx.db,ctx.from,id,ctx.text); return ctx.reply(result.text,{parse_mode:'HTML'}); }
    if (ctx.userData?.admin_msg_reply) { const id=ctx.userData.admin_msg_reply; delete ctx.userData.admin_msg_reply; const result=await replyWorkerMessage(ctx.db,ctx.from,id,ctx.text,ctx.bot); return ctx.reply(result.text,{parse_mode:'HTML'}); }
    if (ctx.userData?.admin_setting) { const key=ctx.userData.admin_setting; delete ctx.userData.admin_setting; const result=await saveSetting(ctx.db,ctx.from,key,ctx.text); return ctx.reply(result.text,{parse_mode:'HTML'}); }

    if (ctx.userData?.ai_chat) { ctx.userData.ai_chat=false; const result=await answerWorkerAi(ctx.db,ctx.from,ctx.text,env); return ctx.reply(result.text,{parse_mode:'HTML'}); }
    if (ctx.userData?.library_search) {
      ctx.userData.library_search = false;
      const result = await findWorkerResources(ctx.db, ctx.from, ctx.text);
      return ctx.reply(result.text, { reply_markup: result.reply_markup, parse_mode: 'HTML' });
    }
    return ctx.reply('ℹ️ استخدم أزرار MEDBOT للتنقل، أو /search للبحث داخل الموارد.', { reply_markup: { inline_keyboard: [[{ text:'🏠 الرئيسية', callback_data:'home' }]] } });
  };
  handlers.media = async (ctx) => { if (ctx.userData?.contribution_folder) { const result=await handleWorkerContributionMedia(ctx.db,ctx.from,ctx.message,ctx.userData.contribution_folder); ctx.userData.contribution_folder=null; return ctx.reply(result.text,{parse_mode:'HTML'}); } return ctx.reply('ℹ️ اختر أولاً قسم المساهمات ثم أرسل المورد.'); };
  const dispatch = createWorkerTelegramDispatcher({ bot, db: env.DB, handlers });
  return dispatch(update);
}

async function webhookResponse(request, env) {
  if (!env.DB) return json({ ok: false, error: 'd1_not_configured' }, 503);
  await initTelegramWebhookStore(env.DB);
  const idempotency = createD1TelegramIdempotencyStore(env.DB);
  return handleTelegramWebhook(request, { env, idempotency, dispatch: dispatchTelegramUpdate });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return healthResponse(env);
    if (url.pathname === '/backup/latest') return backupEndpoint(request, env);
    if (url.pathname === '/telegram/webhook') return webhookResponse(request, env);
    if (url.pathname === '/storage/status') {
      return json({ ok: Boolean(env.FILES), storage: env.FILES ? 'r2' : 'unconfigured', adapter: env.FILES ? Boolean(createR2Storage(env.FILES)) : false });
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
};
