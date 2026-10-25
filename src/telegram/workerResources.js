/**
 * Worker-safe student resource/library navigation.
 *
 * Reads only D1 and deliberately does not import Node/SQLite modules.
 */
import { get, all } from '../db/d1/core.js';
import { getFolders, getFolderView, searchContent, getBreadcrumbs } from '../db/d1/registry.js';
import { getUserLanguage } from '../db/d1/users.js';
import { t } from '../i18n.js';

function esc(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function keyboard(rows) { return { inline_keyboard: rows }; }
function btn(text, callback_data) { return { text, callback_data }; }
function icon(type) {
  return ({ books:'📚', book:'📚', video:'🎥', audio:'🎧', mcq:'📝', summary:'📑', summaries:'📑', photo:'🖼', document:'📄', doc:'📄' }[String(type ?? '').toLowerCase()] ?? '📁');
}
function contentIcon(type) {
  const value = String(type ?? '').toLowerCase();
  if (['photo','image','jpg','jpeg','png','webp'].includes(value)) return '🖼';
  if (['video','mp4','mkv','mov'].includes(value)) return '🎥';
  if (['audio','mp3','m4a','wav'].includes(value)) return '🎧';
  if (['mcq','quiz'].includes(value)) return '📝';
  return '📄';
}
async function language(db, userId) { return (await getUserLanguage(db, Number(userId))) ?? 'ar'; }
async function hidden(db, userId) {
  const admin = await get(db, 'SELECT 1 FROM admins WHERE telegram_id=? AND role IN (?,?,?)', [Number(userId), 'owner', 'admin', 'reviewer']);
  if (admin) return false;
  const row = await get(db, 'SELECT value FROM settings WHERE key=?', ['hidden_features']);
  return String(row?.[0] ?? '').split(',').map((x) => x.trim()).includes('resources');
}
export async function buildWorkerLibraryRoot(db, user) {
  const id = Number(user?.id); const lang = await language(db, id);
  if (await hidden(db, id)) return { text:'🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', reply_markup:keyboard([[btn('🏠 الرئيسية','home')]]) };
  const roots = await getFolders(db, 0);
  const rows = roots.map(([folderId,name,nodeType]) => [btn(`${icon(nodeType)} ${String(name).slice(0,36)}`,`folder:${folderId}`)]);
  rows.push([btn('🔎 بحث في الموارد','search')],[btn('🏠 الرئيسية','home')]);
  return { text: roots.length ? `${t('library_title',lang)}\n\n${t('library_pick_year',lang)}` : `${t('library_title',lang)}\n\n${t('library_empty',lang)}`, reply_markup:keyboard(rows) };
}
export async function buildWorkerFolder(db,user,folderId) {
  const lang=await language(db,Number(user?.id)); const view=await getFolderView(db,Number(folderId));
  if (!view?.folder) return {text:t('not_found',lang),reply_markup:keyboard([[btn('📚 الموارد','resources')],[btn('🏠 الرئيسية','home')]])};
  const [, ,name,nodeType]=view.folder; const lines=[`${icon(nodeType)} <b>${esc(name)}</b>`,`📍 ${esc(view.breadcrumb)}`]; const rows=[];
  if(!view.children.length&&!view.files.length) lines.push('',t('library_area_empty',lang));
  for(const [id,n,type] of view.children) rows.push([btn(`${icon(type)} ${String(n).slice(0,36)}`,`folder:${id}`)]);
  for(const [id,title,,type] of view.files) rows.push([btn(`${contentIcon(type)} ${String(title).slice(0,36)}`,`file:${id}`)]);
  rows.push([btn('⬅️ رجوع',`library:${view.parentId||0}`)],[btn('🔎 بحث في الموارد','search')],[btn('🏠 الرئيسية','home')]);
  return {text:lines.join('\n'),reply_markup:keyboard(rows)};
}
export async function findWorkerResources(db,user,query) {
  const lang=await language(db,Number(user?.id)); const results=await searchContent(db,query); const rows=[]; const lines=[`🔎 <b>نتائج البحث عن: ${esc(query)}</b>`,`📊 ${results.length} نتيجة`,''];
  for(const [id,title,type,,folder,path] of results.slice(0,10)){lines.push(`${contentIcon(type)} <b>${esc(title)}</b>\n   📍 ${esc(path??folder??'')}`);rows.push([btn(`${contentIcon(type)} ${String(title).slice(0,34)}`,`file:${id}`)]);}
  if(!results.length) lines.push(t('search_empty',lang));
  rows.push([btn('🔎 بحث آخر','search')],[btn('📚 الموارد','resources')],[btn('🏠 الرئيسية','home')]);
  return {text:lines.join('\n'),reply_markup:keyboard(rows)};
}
export async function getWorkerFile(db,contentId){ return get(db,'SELECT id,folder_id,title,file_id,file_type FROM content WHERE id=?',[Number(contentId)]); }
export async function buildWorkerFile(db,contentId){ const row=await getWorkerFile(db,contentId); if(!row)return null; return {id:row[0],folderId:row[1],title:row[2],fileId:row[3],fileType:row[4],breadcrumb:await getBreadcrumbs(db,row[1])}; }
export async function buildWorkerSearchableSummary(db){const [folders,files]=await Promise.all([all(db,'SELECT COUNT(*) FROM folders'),all(db,'SELECT COUNT(*) FROM content')]);return {folders:Number(folders?.[0]?.[0]??0),resources:Number(files?.[0]?.[0]??0)};}
