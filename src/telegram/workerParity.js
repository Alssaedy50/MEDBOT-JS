import { get } from '../db/d1/core.js';
import { getUserLanguage, setUserLanguage } from '../db/d1/users.js';
import { getUserContributions } from '../db/d1/contributions.js';
import { listNews, getNewsDetail, markNewsRead } from '../db/d1/news.js';
import { PLATFORM_SETTING_DEFAULTS, SUPPORTED_LANGUAGES } from '../constants.js';
import { t } from '../i18n.js';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const keyboard = (rows) => ({ inline_keyboard: rows });
const btn = (text, callback_data) => ({ text, callback_data });
async function setting(db, key) { const row = await get(db, 'SELECT value FROM settings WHERE key=?', [key]); return row?.[0] ?? PLATFORM_SETTING_DEFAULTS[key] ?? ''; }

export async function buildWorkerLanguage(db, user) {
  const lang = await getUserLanguage(db, Number(user.id));
  return { text: lang === 'en' ? '🌐 <b>Language</b>\n\nChoose your language:' : '🌐 <b>اللغة</b>\n\nاختر لغة الواجهة:', reply_markup: keyboard([[btn('🇸🇦 العربية','lang_set:ar'),btn('🇬🇧 English','lang_set:en')],[btn(t('home',lang),'home')]]) };
}
export async function applyWorkerLanguage(db, userId, language) { if (!SUPPORTED_LANGUAGES.includes(language)) return false; await setUserLanguage(db, Number(userId), language); return true; }
export async function buildWorkerAbout(db, user) { const lang=await getUserLanguage(db,Number(user.id)); return { text:'ℹ️ <b>'+esc(await setting(db,'platform_name'))+'</b>\n\n'+esc(await setting(db,'platform_about')), reply_markup:keyboard([[btn(t('home',lang),'home')]]) }; }
export async function buildWorkerContact(db, user) { const lang=await getUserLanguage(db,Number(user.id)); return { text:'📬 <b>'+(lang==='en'?'Contact the platform':'تواصل مع المنصة')+'</b>\n\n'+esc(await setting(db,'contact_text')), reply_markup:keyboard([[btn(t('home',lang),'home')]]) }; }
export async function buildWorkerNews(db,user,offset=0) {
 const lang=await getUserLanguage(db,Number(user.id)); const rows=await listNews(db,{status:'published',limit:5,offset:Math.max(0,Number(offset)||0)});
 const lines=[lang==='en'?'📰 <b>News</b>':'📰 <b>الأخبار</b>','']; const buttons=[];
 for(const item of rows){ lines.push((item.news_type==='notify'?'🚨':'📚')+' <b>'+esc(item.title)+'</b>'); if(item.doctor)lines.push('👨‍⚕️ '+esc(item.doctor)); if(item.event_at)lines.push('📅 '+esc(item.event_at)); if(item.body)lines.push(esc(item.body).slice(0,260)); lines.push(''); buttons.push([btn('📰 '+String(item.title).slice(0,32),'news:'+item.id)]); }
 if(!rows.length)lines.push(lang==='en'?'No published news.':'لا توجد أخبار منشورة حالياً.');
 const nav=[]; if(Number(offset)>0)nav.push({text:'⬅️',callback_data:'news_page:'+Math.max(0,Number(offset)-5)}); if(rows.length===5)nav.push({text:'➡️',callback_data:'news_page:'+(Number(offset)+5)}); if(nav.length)buttons.push(nav); buttons.push([btn(t('home',lang),'home')]);
 return {text:lines.join('\n'),reply_markup:keyboard(buttons)};
}
export async function buildWorkerNewsDetail(db,user,newsId) {
 const lang=await getUserLanguage(db,Number(user.id)); const item=await getNewsDetail(db,Number(newsId));
 if(!item||item.status!=='published')return {text:lang==='en'?'News item not found.':'الخبر غير موجود.',reply_markup:keyboard([[btn(t('home',lang),'home')]])};
 await markNewsRead(db,Number(user.id),Number(newsId)); const lines=[(item.news_type==='notify'?'🚨':'📚')+' <b>'+esc(item.title)+'</b>']; if(item.doctor)lines.push('👨‍⚕️ '+esc(item.doctor)); if(item.event_at)lines.push('📅 '+esc(item.event_at)); if(item.body)lines.push('\n'+esc(item.body));
 return {text:lines.join('\n'),reply_markup:keyboard([[btn(lang==='en'?'📰 News':'📰 الأخبار','news')],[btn(t('home',lang),'home')]])};
}
export async function buildWorkerMyContributions(db,user) {
 const lang=await getUserLanguage(db,Number(user.id)); const rows=await getUserContributions(db,Number(user.id),20); const lines=[lang==='en'?'📤 <b>My contributions</b>':'📤 <b>مساهماتي</b>',''];
 for(const row of rows){lines.push('• <b>'+esc(row[1])+'</b> — '+esc(row[3])); if(row[9])lines.push('   📍 '+esc(row[9])); if(row[6])lines.push('   📝 '+esc(row[6]));}
 if(!rows.length)lines.push(lang==='en'?'No contributions yet.':'لا توجد مساهمات بعد.'); return {text:lines.join('\n'),reply_markup:keyboard([[btn(t('home',lang),'home')]])};
}
export async function buildWorkerUnsupported(db,user,feature) {
 const lang=await getUserLanguage(db,Number(user.id)); const names={assistant:lang==='en'?'AI Assistant':'المساعد الذكي',topics:lang==='en'?'Topics':'المواضيع',contributions:lang==='en'?'Contributions':'المساهمات',admin:lang==='en'?'Administration':'الإدارة'};
 const name=names[feature]||feature; const text=lang==='en'?'🛠 <b>'+esc(name)+'</b>\n\nThis surface is being migrated to the Cloudflare runtime. Your existing MEDBOT data remains unchanged.':'🛠 <b>'+esc(name)+'</b>\n\nيجري نقل هذه الوظيفة إلى بيئة Cloudflare. بيانات MEDBOT الحالية لم تتغير.';
 return {text,reply_markup:keyboard([[btn(t('home',lang),'home')]])};
}