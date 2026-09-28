/**
 * Home page, main menu, account, language and about surfaces.
 */

import * as db from '../db/index.js';
import * as i18n from '../i18n.js';
import { AI_DAILY_LIMIT } from '../constants.js';
import { btn, escHtml, keyboard } from '../telegram/ui.js';

export function esc(value) {
  return escHtml(value);
}

export function homeKeyboard(language = i18n.DEFAULT_LANGUAGE) {
  return keyboard([[btn(i18n.t('home', language), 'home')]]);
}

async function lang(userId) {
  try {
    return db.getUserLanguage(userId);
  } catch {
    return i18n.DEFAULT_LANGUAGE;
  }
}

export function platformSettings() {
  try {
    return db.getPlatformSettings();
  } catch {
    return { ...db.PLATFORM_SETTING_DEFAULTS };
  }
}

export function buildMenu(userId, language = i18n.DEFAULT_LANGUAGE) {
  let hidden = new Set();
  try {
    hidden = db.getHiddenFeatures();
  } catch {
    hidden = new Set();
  }

  const visible = (feature) => !hidden.has(feature);
  const menu = {
    resources: ['menu_resources', 'resources'],
    topics: ['menu_topics', 'topics'],
    assistant: ['menu_assistant', 'assistant'],
    news: ['menu_news', 'news'],
    contributions: ['menu_contributions', 'contribute'],
    my_contributions: ['menu_my_contributions', 'my_contributions'],
    account: ['menu_account', 'account'],
    contact: ['menu_contact', 'contact'],
    about: ['menu_about', 'about'],
    language: ['menu_language', 'language'],
  };

  const rows = [];
  for (const [feature, [key, callback]] of Object.entries(menu)) {
    if (visible(feature)) rows.push([btn(i18n.t(key, language), callback)]);
  }

  let isAdmin = false;
  try {
    isAdmin = db.isUserAdmin(userId);
  } catch {
    isAdmin = false;
  }
  if (isAdmin) rows.push([btn(i18n.t('menu_admin', language), 'admin')]);

  return keyboard(rows);
}

export async function homeText(userId, firstName = '') {
  const language = await lang(userId);
  const settings = platformSettings();

  let unread = 0;
  try {
    unread = db.getUnreadNewsCount(userId);
  } catch {
    unread = 0;
  }

  const name = String(firstName ?? '').trim() || (language === 'en' ? 'Doctor' : 'دكتور');
  const base = i18n.t('welcome', language, { platform: settings.platform_name, name });
  const badge = unread
    ? language === 'en'
      ? `\n\n📰 You have ${unread} unread news item${unread === 1 ? '' : 's'}.`
      : `\n\n📰 لديك ${unread} خبر غير مقروء.`
    : '';

  return `${base}${badge}`;
}

export async function showHome(ctx) {
  const userId = ctx.from.id;
  const language = await lang(userId);
  const text = await homeText(userId, ctx.from.first_name ?? ctx.from.full_name);
  const markup = buildMenu(userId, language);

  if (ctx.kind === 'callback') await ctx.editMessageText(text, { reply_markup: markup });
  else await ctx.reply(text, { reply_markup: markup });
}

export async function showLanguage(ctx) {
  const current = await lang(ctx.from.id);
  const rows = [
    [btn(`${current === 'ar' ? '✅ ' : ''}🇸🇦 العربية`, 'lang_set:ar')],
    [btn(`${current === 'en' ? '✅ ' : ''}🇬🇧 English`, 'lang_set:en')],
    [btn(i18n.t('back', current), 'home')],
    [btn(i18n.t('home', current), 'home')],
  ];
  await ctx.editMessageText(i18n.t('language_title', current), { reply_markup: keyboard(rows) });
}

export async function setLanguage(ctx, language) {
  const userId = ctx.from.id;
  const changed = db.setUserLanguage(userId, language);
  if (changed) {
    try {
      const audit = await import('../audit.js');
      await audit.logAction(userId, 'language_set', {
        targetType: 'user',
        targetId: userId,
        details: language,
      });
    } catch {
      // Auditing is best-effort.
    }
  }
  await showHome(ctx);
}

export async function showAccount(ctx) {
  const userId = ctx.from.id;
  const language = await lang(userId);
  let quota = 0;
  try { quota = db.getRemainingQuota(userId, AI_DAILY_LIMIT); } catch {}
  let contributions = 0;
  try { contributions = db.getUserContributions(userId, 50).length; } catch {}
  let readPercent = 0;
  try {
    const total = db.countNews({ status: 'published' });
    const unread = db.getUnreadNewsCount(userId);
    readPercent = total ? Math.round(((total - unread) / total) * 100) : 100;
  } catch { readPercent = 100; }

  const handle = ctx.from.username ? `@${ctx.from.username}` : '—';
  const text = language === 'en'
    ? `${i18n.t('account_title', language)}\n\n👤 ${esc(ctx.from.first_name ?? ctx.from.full_name)}\n🆔 <code>${userId}</code>\n🔗 ${esc(handle)}\n\n🤖 AI allowance remaining today: ${quota}/${AI_DAILY_LIMIT}\n📤 My contributions: ${contributions}\n📰 News read: ${readPercent}%\n🌐 🇬🇧 English`
    : `${i18n.t('account_title', language)}\n\n👤 ${esc(ctx.from.first_name ?? ctx.from.full_name)}\n🆔 <code>${userId}</code>\n🔗 ${esc(handle)}\n\n🤖 استهلاك المساعد اليوم: ${quota}/${AI_DAILY_LIMIT} متبقٍ\n📤 مساهماتي: ${contributions}\n📰 نسبة الأخبار المقروءة: ${readPercent}%\n🌐 🇸🇦 العربية`;

  await ctx.editMessageText(text, {
    reply_markup: keyboard([
      [btn(i18n.t('menu_my_contributions', language), 'my_contributions')],
      [btn(i18n.t('menu_language', language), 'language')],
      [btn(i18n.t('home', language), 'home')],
    ]),
  });
}

export async function showAbout(ctx) {
  const settings = platformSettings();
  const language = await lang(ctx.from.id);
  const body = String(settings.platform_about ?? '').trim() ||
    (language === 'en' ? 'Platform information has not been added yet.' : 'لم تُضف معلومات عن المنصة بعد.');

  await ctx.editMessageText(`ℹ️ <b>${esc(settings.platform_name)}</b>\n\n${esc(body)}`, {
    reply_markup: keyboard([[btn(i18n.t('home', language), 'home')]]),
  });
}

export function contactText(language = i18n.DEFAULT_LANGUAGE) {
  const settings = platformSettings();
  return String(settings.contact_text ?? '').trim() ||
    (language === 'en'
      ? 'You can contact the platform administration through the 📬 Contact option.'
      : 'يمكنك التواصل مع إدارة المنصة عبر خيار 📬 تواصل مع المنصة.');
}
