import { get } from '../db/d1/core.js';
import { registerUser, getUserLanguage, getRemainingQuota } from '../db/d1/users.js';
import { getUnreadNewsCount, countNews } from '../db/d1/news.js';
import { AI_DAILY_LIMIT, DEFAULT_LANGUAGE, FEATURES, PLATFORM_SETTING_DEFAULTS } from '../constants.js';
import { t } from '../i18n.js';

const MENU = [
  ['resources', 'menu_resources', 'resources'], ['topics', 'menu_topics', 'topics'],
  ['assistant', 'menu_assistant', 'assistant'], ['news', 'menu_news', 'news'],
  ['contributions', 'menu_contributions', 'contribute'], ['my_contributions', 'menu_my_contributions', 'my_contributions'],
  ['account', 'menu_account', 'account'], ['contact', 'menu_contact', 'contact'],
  ['about', 'menu_about', 'about'], ['language', 'menu_language', 'language'],
];

async function setting(db, key) {
  const row = await get(db, 'SELECT value FROM settings WHERE key=?', [key]);
  return row?.[0] ?? PLATFORM_SETTING_DEFAULTS[key] ?? '';
}

async function hidden(db) {
  const raw = await setting(db, 'hidden_features');
  return new Set(String(raw).split(',').map((x) => x.trim()).filter((x) => FEATURES.includes(x)));
}

export async function buildWorkerHome(db, user) {
  const id = Number(user?.id);
  if (!Number.isSafeInteger(id)) throw new TypeError('Invalid Telegram user id');
  await registerUser(db, id, user?.username ?? null, [user?.first_name, user?.last_name].filter(Boolean).join(' ') || null);
  const language = await getUserLanguage(db, id);
  const hidden = await hidden(db);
  const rows = MENU.filter(([feature]) => !hidden.has(feature))
    .map(([, key, callback]) => [{ text: t(key, language), callback_data: callback }]);
  const admin = await get(db, 'SELECT 1 FROM admins WHERE user_id=? AND role IN (?,?,?)', [id, 'owner', 'admin', 'reviewer']);
  if (admin && !hidden.has('admin_panel')) rows.push([{ text: t('menu_admin', language), callback_data: 'admin' }]);
  const platform = await setting(db, 'platform_name');
  const name = String(user?.first_name ?? '').trim() || (language === 'en' ? 'Doctor' : 'دكتور');
  const unread = await getUnreadNewsCount(db, id);
  const badge = unread ? (language === 'en' ? `\\n\\n📰 You have ${unread} unread news item${unread === 1 ? '' : 's'}.` : `\\n\\n📰 لديك ${unread} خبر غير مقروء.`) : '';
  return { language, text: t('welcome', language, { platform, name }) + badge, reply_markup: { inline_keyboard: rows } };
}

export async function buildWorkerAccount(db, user) {
  const id = Number(user?.id);
  await registerUser(db, id, user?.username ?? null, [user?.first_name, user?.last_name].filter(Boolean).join(' ') || null);
  const language = await getUserLanguage(db, id);
  const quota = await getRemainingQuota(db, id, AI_DAILY_LIMIT);
  const contributions = await get(db, 'SELECT COUNT(*) FROM contributions WHERE user_id=?', [id]);
  const total = await countNews(db, { status: 'published' });
  const unread = await getUnreadNewsCount(db, id);
  const percent = total ? Math.round(((total - unread) / total) * 100) : 100;
  const handle = user?.username ? '@' + user.username : '—';
  const text = language === 'en'
    ? `${t('account_title', language)}\\n\\n👤 ${user?.first_name ?? ''}\\n🆔 <code>${id}</code>\\n🔗 ${handle}\\n\\n🤖 AI allowance remaining today: ${quota}/${AI_DAILY_LIMIT}\\n📤 My contributions: ${Number(contributions?.[0] ?? 0)}\\n📰 News read: ${percent}%\\n🌐 🇬🇧 English`
    : `${t('account_title', language)}\\n\\n👤 ${user?.first_name ?? ''}\\n🆔 <code>${id}</code>\\n🔗 ${handle}\\n\\n🤖 استهلاك المساعد اليوم: ${quota}/${AI_DAILY_LIMIT} متبقٍ\\n📤 مساهماتي: ${Number(contributions?.[0] ?? 0)}\\n📰 نسبة الأخبار المقروءة: ${percent}%\\n🌐 🇸🇦 العربية`;
  return { language, text, reply_markup: { inline_keyboard: [
    [{ text: t('menu_my_contributions', language), callback_data: 'my_contributions' }],
    [{ text: t('menu_language', language), callback_data: 'language' }],
    [{ text: t('home', language), callback_data: 'home' }],
  ] } };
}
