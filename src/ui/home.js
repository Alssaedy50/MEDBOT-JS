/**
 * Home page, main menu, account, language and about surfaces.
 *
 * The home page is the single entry point: it renders only the features that
 * are currently visible, and adds the admin entry point for admins. Hiding a
 * feature removes its button here and is enforced again in that feature's own
 * callback handler, so hiding is not merely cosmetic.
 */

import * as db from '../db/index.js';
import * as i18n from '../i18n.js';
import { AI_DAILY_LIMIT } from '../constants.js';
import { btn, escHtml, keyboard } from '../telegram/ui.js';

export function esc(value) {
  return escHtml(value);
}

export function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

async function lang(userId) {
  try {
    return db.getUserLanguage(userId);
  } catch {
    return i18n.DEFAULT_LANGUAGE;
  }
}

/** Resolve the platform identity, falling back to the MEDBOT defaults. */
export function platformSettings() {
  try {
    return db.getPlatformSettings();
  } catch {
    return { ...db.PLATFORM_SETTING_DEFAULTS };
  }
}

/**
 * Build the home-page keyboard from the *visible* features.
 *
 * Admins always keep their own entry point so they can restore a hidden
 * feature during maintenance.
 */
export function buildMenu(userId) {
  let hidden = new Set();
  try {
    hidden = db.getHiddenFeatures();
  } catch {
    hidden = new Set();
  }

  const visible = (feature) => !hidden.has(feature);
  const rows = [];

  if (visible('resources')) rows.push([btn('📚 موارد المنصة', 'resources')]);
  if (visible('topics')) rows.push([btn('🧭 المواضيع', 'topics')]);
  if (visible('assistant')) rows.push([btn('🤖 المساعد', 'assistant')]);
  if (visible('news')) rows.push([btn('📰 الأخبار', 'news')]);
  if (visible('contributions')) rows.push([btn('📤 مساهمات الطلاب', 'contribute')]);
  if (visible('my_contributions')) rows.push([btn('📄 مساهماتي', 'my_contributions')]);
  if (visible('account')) rows.push([btn('📊 حسابي', 'account')]);
  if (visible('contact')) rows.push([btn('📬 تواصل مع المنصة', 'contact')]);
  if (visible('about')) rows.push([btn('ℹ️ عن المنصة', 'about')]);
  if (visible('language')) rows.push([btn('🌐 اللغة', 'language')]);

  let isAdmin = false;
  try {
    isAdmin = db.isUserAdmin(userId);
  } catch {
    isAdmin = false;
  }
  if (isAdmin) rows.push([btn('🛠 إدارة المنصة', 'admin')]);

  return keyboard(rows);
}

/** Full home-page text. */
export async function homeText(userId, firstName = '') {
  const language = await lang(userId);
  const settings = platformSettings();

  let unread = 0;
  try {
    unread = db.getUnreadNewsCount(userId);
  } catch {
    unread = 0;
  }

  const name = String(firstName ?? '').trim() || 'Doctor';
  const base = i18n.t('welcome', language, {
    platform: settings.platform_name,
    name,
  });

  const badge = unread ? `\n\n📰 لديك ${unread} خبر غير مقروء.` : '';
  return `${base}${badge}`;
}

/** Render (or edit into) the home page. */
export async function showHome(ctx) {
  const userId = ctx.from.id;
  const text = await homeText(userId, ctx.from.first_name ?? ctx.from.full_name);
  const markup = buildMenu(userId);

  if (ctx.kind === 'callback') {
    await ctx.editMessageText(text, { reply_markup: markup });
  } else {
    await ctx.reply(text, { reply_markup: markup });
  }
}

/**
 * Language picker.
 *
 * The choice is persisted per user, so every subsequent screen is rendered in
 * the chosen language without any per-handler branching.
 */
export async function showLanguage(ctx) {
  const current = await lang(ctx.from.id);

  const rows = [
    [btn(`${current === 'ar' ? '✅ ' : ''}🇸🇦 العربية`, 'lang_set:ar')],
    [btn(`${current === 'en' ? '✅ ' : ''}🇬🇧 English`, 'lang_set:en')],
    [btn('⬅️ رجوع', 'home')],
    [btn('🏠 الرئيسية', 'home')],
  ];

  await ctx.editMessageText(i18n.t('language_title', current), { reply_markup: keyboard(rows) });
}

/** Persist a language choice and re-render the home page. */
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

/** Personal account screen: identity + today's assistant allowance. */
export async function showAccount(ctx) {
  const userId = ctx.from.id;
  const language = await lang(userId);

  let quota = 0;
  try {
    quota = db.getRemainingQuota(userId, AI_DAILY_LIMIT);
  } catch {
    quota = 0;
  }

  let contributions = 0;
  try {
    contributions = db.getUserContributions(userId, 50).length;
  } catch {
    contributions = 0;
  }

  let readPercent = 0;
  try {
    const total = db.countNews({ status: 'published' });
    const unread = db.getUnreadNewsCount(userId);
    readPercent = total ? Math.round(((total - unread) / total) * 100) : 100;
  } catch {
    readPercent = 100;
  }

  const handle = ctx.from.username ? `@${ctx.from.username}` : '—';
  const languageLabel = language === 'en' ? '🇬🇧 English' : '🇸🇦 العربية';

  await ctx.editMessageText(
    `${i18n.t('account_title', language)}\n\n` +
      `👤 ${esc(ctx.from.first_name ?? ctx.from.full_name)}\n` +
      `🆔 <code>${userId}</code>\n` +
      `🔗 ${esc(handle)}\n\n` +
      `🤖 استهلاك المساعد اليوم: ${quota}/${AI_DAILY_LIMIT} متبقٍ\n` +
      `📤 مساهماتي: ${contributions}\n` +
      `📰 نسبة الأخبار المقروءة: ${readPercent}%\n` +
      `🌐 ${languageLabel}`,
    {
      reply_markup: keyboard([
        [btn('📄 مساهماتي', 'my_contributions')],
        [btn('🌐 اللغة', 'language')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** About screen from the admin-editable platform settings. */
export async function showAbout(ctx) {
  const settings = platformSettings();

  const body = String(settings.platform_about ?? '').trim() || 'لم تُضف معلومات عن المنصة بعد.';

  await ctx.editMessageText(
    `ℹ️ <b>${esc(settings.platform_name)}</b>\n\n${esc(body)}`,
    { reply_markup: keyboard([[btn('🏠 الرئيسية', 'home')]]) },
  );
}

/** Contact instructions from the admin-editable platform settings. */
export function contactText() {
  const settings = platformSettings();
  return (
    String(settings.contact_text ?? '').trim() ||
    'يمكنك التواصل مع إدارة المنصة عبر خيار 📬 تواصل مع المنصة.'
  );
}
