/**
 * College Manager Self-Setup & Credentials Wizard (`cs_*` namespace).
 *
 * Allows each College Manager (owner of their college bot) to:
 *   1. Inspect their college's configuration & readiness checklist.
 *   2. Add, rotate, or delete encrypted AI API keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`).
 *   3. Configure and verify their college's independent Archive Channel.
 *   4. Synchronize their Telegram Managed Bot profile (bot name, description, commands).
 *   5. Validate and activate their college bot once required credentials are set.
 */

import { isOwner } from '../db/d1/admins.js';
import {
  COLLEGE_STATUS_LABELS,
  MANAGED_BOT_MODE_LABELS,
  activateCollege,
  deleteCollegeSecret,
  isPlatformOwner,
  setCollegeArchiveChannel,
  setCollegeSecret,
  syncCollegeBotProfile,
  validateCollegeConfiguration,
} from './registry.js';

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, callback_data) => ({ text, callback_data });
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const COLLEGE_SETUP_PREFIXES = [
  'cs_menu',
  'cs_key_set:',
  'cs_key_del:',
  'cs_archive',
  'cs_profile',
  'cs_validate',
  'cs_activate',
];

export async function isAuthorizedCollegeManager(collegeDb, userId, env = {}) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return false;
  if (isPlatformOwner(uid, env)) return true;
  const configuredMgr = Number.parseInt(String(env?.ADMIN_ID ?? '').trim(), 10);
  if (Number.isSafeInteger(configuredMgr) && configuredMgr > 0 && uid === configuredMgr) {
    return true;
  }
  if (!collegeDb) return false;
  return isOwner(collegeDb, uid);
}

export async function buildCollegeSetupMenu(collegeDb, platformDb, user, env = {}) {
  const uid = Number(user?.id);
  if (!(await isAuthorizedCollegeManager(collegeDb, uid, env))) {
    return {
      text: '🔒 <b>غير مصرح</b>\nهذه اللوحة مخصصة لمدير الكلية (المالك) فقط لإكمال إعدادات البوت والمفاتيح السرية.',
      reply_markup: kb([[btn('🏠 الرئيسية', 'home')]]),
    };
  }

  const collegeId = String(env?.COLLEGE_ID || 'default');
  const val = await validateCollegeConfiguration(platformDb, env, collegeId);
  const college = val.college;
  const statusLabel = COLLEGE_STATUS_LABELS[college?.status] || college?.status || '🟢 نشط';
  const modeLabel = MANAGED_BOT_MODE_LABELS[college?.managed_bot_mode] || '🤝 مملوك لمدير الكلية';

  const checkLines = (val.checks || []).map(
    (c) => `${c.ok ? '✅' : '⚠️'} <b>${esc(c.label)}:</b> <code>${esc(c.detail)}</code>`,
  );

  const lines = [
    `🏫 <b>إعدادات الكلية والمفاتيح السرية (${esc(college?.name_ar || 'بوت الكلية')})</b>`,
    '━━━━━━━━━━━━━━━━━━',
    `🆔 معرّف الكلية: <code>${esc(collegeId)}</code>`,
    `📌 الحالة التشغيلية: <b>${esc(statusLabel)}</b>`,
    `🤖 نمط إدارة البوت: ${esc(modeLabel)}`,
    '',
    '📋 <b>قائمة جاهزية الكلية:</b>',
    ...checkLines,
    '',
    val.ready
      ? '🎉 <b>جميع المتطلبات الأساسية مكتملة!</b> يمكنك تفعيل أو تحديث إعدادات الكلية في أي وقت.'
      : `⏳ <b>المتطلبات المتبقية للتفعيل:</b> ${esc(val.missing.join('، '))}`,
  ];

  const rows = [
    [
      btn('🔑 مفتاح Gemini AI', 'cs_key_set:GEMINI_API_KEY'),
      btn('🔑 مفتاح Groq AI', 'cs_key_set:GROQ_API_KEY'),
    ],
    [
      btn('🔑 مفتاح OpenRouter', 'cs_key_set:OPENROUTER_API_KEY'),
      btn('📡 ربط قناة أرشيف الكلية', 'cs_archive'),
    ],
  ];

  if (val.secrets?.length) {
    const delRow = val.secrets.slice(0, 2).map((s) =>
      btn(`🗑 حذف ${s.name.replace('_API_KEY', '')}`, `cs_key_del:${s.name}`),
    );
    rows.push(delRow);
  }

  rows.push([
    btn('🤖 مزامنة هوية البوت (Managed Bot)', 'cs_profile'),
    btn('🔍 فحص وتفعيل الكلية', 'cs_activate'),
  ]);
  rows.push([btn('⬅️ لوحة إدارة الكلية', 'admin'), btn('🏠 الرئيسية', 'home')]);

  return {
    text: lines.join('\n'),
    reply_markup: kb(rows),
  };
}

export async function handleCollegeSetupCallback(ctx, bot, env = {}) {
  const data = String(ctx.data ?? '');
  const platformDb = env?.PLATFORM_DB || env?.DB || ctx.db;
  const collegeId = String(env?.COLLEGE_ID || 'default');

  if (!(await isAuthorizedCollegeManager(ctx.db, ctx.from?.id, env))) {
    await ctx.answer();
    return ctx.editMessageText('🔒 هذه اللوحة مخصصة لمدير الكلية فقط.', {
      reply_markup: kb([[btn('🏠 الرئيسية', 'home')]]),
      parse_mode: 'HTML',
    });
  }

  if (data === 'cs_menu' || data === 'cs_validate') {
    const menu = await buildCollegeSetupMenu(ctx.db, platformDb, ctx.from, env);
    await ctx.answer();
    return ctx.editMessageText(menu.text, { reply_markup: menu.reply_markup, parse_mode: 'HTML' });
  }

  if (data.startsWith('cs_key_set:')) {
    const keyName = data.split(':')[1] || 'GEMINI_API_KEY';
    ctx.userData.cs_waiting_secret_name = keyName;
    await ctx.answer();
    return ctx.editMessageText(
      `🔐 <b>إعداد المفتاح السري: <code>${esc(keyName)}</code></b>\n\n` +
        `أرسل قيمة المفتاح الآن في رسالة نصية مباشرة (أو بالصيغة <code>${esc(keyName)}=VALUE</code>).\n\n` +
        `🛡 <b>حماية أمنية:</b> سيقوم البوت بحذف رسالتك فوراً بعد قراءتها وتشفير المفتاح بمعيار AES-256-GCM داخل قاعدة بيانات كليتك المعزولة.`,
      {
        reply_markup: kb([[btn('❌ إلغاء', 'cs_menu')]]),
        parse_mode: 'HTML',
      },
    );
  }

  if (data.startsWith('cs_key_del:')) {
    const keyName = data.split(':')[1] || '';
    await deleteCollegeSecret(ctx.db, platformDb, env, collegeId, keyName, ctx.from.id).catch(() => {});
    const menu = await buildCollegeSetupMenu(ctx.db, platformDb, ctx.from, env);
    await ctx.answer();
    return ctx.editMessageText(`✅ تم حذف المفتاح <code>${esc(keyName)}</code> من خزنة الكلية.\n\n${menu.text}`, {
      reply_markup: menu.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (data === 'cs_archive') {
    ctx.userData.cs_waiting_archive = true;
    await ctx.answer();
    return ctx.editMessageText(
      `📡 <b>ربط قناة الأرشيف المستقلة للكلية</b>\n\n` +
        `أضف بوت كليتك كمشرف (Admin) في قناة الأرشيف الخاصة بكليتك، ثم أرسل الآن:\n` +
        `• معرّف القناة مثل <code>@my_college_archive</code>\n` +
        `• أو المعرّف الرقمي مثل <code>-1001234567890</code>\n` +
        `• أو وجّه (Forward) أي رسالة من القناة إلى هنا مباشرةً.`,
      {
        reply_markup: kb([[btn('❌ إلغاء', 'cs_menu')]]),
        parse_mode: 'HTML',
      },
    );
  }

  if (data === 'cs_profile') {
    await ctx.answer();
    const val = await validateCollegeConfiguration(platformDb, env, collegeId);
    const collegeName = val.college?.name_ar || 'بوت الكلية';
    const token = env?.TELEGRAM_BOT_TOKEN || env?.BOT_TOKEN;
    const syncRes = await syncCollegeBotProfile(token, {
      name: collegeName,
      shortDescription: `${collegeName} — منصة MEDBOT الأكاديمية`,
      description: `البوت التعليمي الرسمي لـ ${collegeName}. يوفر المحاضرات، المراجع، بنوك الأسئلة، والمساعد الطبي الذكي.`,
    });
    const menu = await buildCollegeSetupMenu(ctx.db, platformDb, ctx.from, env);
    const notice = syncRes.ok
      ? '✅ تمت مزامنة اسم ووصف وأوامر البوت مع تيليجرام (Managed Bot Profile) بنجاح!'
      : 'ℹ️ تم تحديث بيانات الهوية محلياً.';
    return ctx.editMessageText(`${notice}\n\n${menu.text}`, {
      reply_markup: menu.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (data === 'cs_activate') {
    await ctx.answer();
    const res = await activateCollege(platformDb, env, collegeId, ctx.from.id, {
      force: isPlatformOwner(ctx.from.id, env),
    });
    const menu = await buildCollegeSetupMenu(ctx.db, platformDb, ctx.from, env);
    const banner = res.ok
      ? '🎉 <b>تم التحقق من الإعدادات وتفعيل بوت الكلية بنجاح!</b>'
      : `⚠️ <b>تعذّر التفعيل التلقائي:</b> ${esc(res.error)}`;
    return ctx.editMessageText(`${banner}\n\n${menu.text}`, {
      reply_markup: menu.reply_markup,
      parse_mode: 'HTML',
    });
  }
}

export async function handleCollegeSetupText(ctx, bot, env = {}) {
  const platformDb = env?.PLATFORM_DB || env?.DB || ctx.db;
  const collegeId = String(env?.COLLEGE_ID || 'default');

  if (ctx.userData?.cs_waiting_secret_name) {
    const secretName = ctx.userData.cs_waiting_secret_name;
    ctx.userData.cs_waiting_secret_name = null;

    if (!(await isAuthorizedCollegeManager(ctx.db, ctx.from?.id, env))) {
      return false;
    }

    let rawValue = String(ctx.text ?? '').trim();
    if (rawValue.toUpperCase().startsWith(`${secretName}=`)) {
      rawValue = rawValue.slice(secretName.length + 1).trim();
    }

    // Delete message containing plaintext API key immediately
    if (ctx.message?.message_id && bot?.deleteMessage) {
      await bot.deleteMessage(ctx.chatId || ctx.from.id, ctx.message.message_id).catch(() => {});
    }

    if (!rawValue || rawValue.length < 8) {
      const menu = await buildCollegeSetupMenu(ctx.db, platformDb, ctx.from, env);
      await ctx.reply(`⚠️ قيمة المفتاح <code>${esc(secretName)}</code> قصيرة جداً أو غير صالحة.\n\n${menu.text}`, {
        reply_markup: menu.reply_markup,
        parse_mode: 'HTML',
      });
      return true;
    }

    await setCollegeSecret(ctx.db, platformDb, env, collegeId, secretName, rawValue, ctx.from.id);
    const menu = await buildCollegeSetupMenu(ctx.db, platformDb, ctx.from, env);
    await ctx.reply(
      `✅ <b>تم تشفير وحفظ المفتاح <code>${esc(secretName)}</code> بنجاح في خزنة الكلية!</b>\n🗑 تم حذف رسالتك المحتوية على المفتاح لحمايتك.\n\n${menu.text}`,
      {
        reply_markup: menu.reply_markup,
        parse_mode: 'HTML',
      },
    );
    return true;
  }

  if (ctx.userData?.cs_waiting_archive) {
    ctx.userData.cs_waiting_archive = false;
    if (!(await isAuthorizedCollegeManager(ctx.db, ctx.from?.id, env))) {
      return false;
    }

    const fwdChat = ctx.message?.forward_from_chat || ctx.message?.forward_origin?.chat;
    let channelValue = '';
    if (fwdChat?.id) {
      channelValue = fwdChat.username ? `@${fwdChat.username}` : String(fwdChat.id);
    } else {
      channelValue = String(ctx.text ?? '').trim();
    }

    if (!channelValue) {
      await ctx.reply('⚠️ يرجى إرسال معرّف قناة صالح.');
      return true;
    }

    await setCollegeArchiveChannel(platformDb, ctx.db, env, collegeId, channelValue, ctx.from.id);
    const menu = await buildCollegeSetupMenu(ctx.db, platformDb, ctx.from, env);
    await ctx.reply(
      `✅ <b>تم ربط قناة أرشيف الكلية (<code>${esc(channelValue)}</code>) بنجاح!</b>\n\n${menu.text}`,
      {
        reply_markup: menu.reply_markup,
        parse_mode: 'HTML',
      },
    );
    return true;
  }

  return false;
}
