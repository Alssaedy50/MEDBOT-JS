import { getUserLanguage } from '../db/d1/users.js';
import { getTopics, getTopic, getTopicFolders, getTopicResourceCount } from '../db/d1/topics.js';
const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const kb=rows=>({inline_keyboard:rows}); const btn=(text,callback_data)=>({text,callback_data});
const nav=(lang)=>[btn(lang==='en'?'🏠 Home':'🏠 الرئيسية','home')];
export async function buildWorkerTopics(db,user){
 const lang=await getUserLanguage(db,Number(user.id)); const topics=await getTopics(db,true);
 const lines=[lang==='en'?'🧭 <b>Topics</b>':'🧭 <b>المواضيع</b>','']; const buttons=[];
 for(const row of topics){lines.push((row[3]||'🧭')+' <b>'+esc(row[1])+'</b>'+(row[2]?' — '+esc(row[2]):''));buttons.push([btn((row[3]||'🧭')+' '+String(row[1]).slice(0,36),'topic:'+row[0])]);}
 if(!topics.length)lines.push(lang==='en'?'No active topics.':'لا توجد مواضيع نشطة حالياً.'); buttons.push(nav(lang)[0]); return {text:lines.join('\n'),reply_markup:kb(buttons)};
}
export async function buildWorkerTopic(db,user,topicId){
 const lang=await getUserLanguage(db,Number(user.id)); const topic=await getTopic(db,topicId);
 if(!topic||!topic[5])return {text:lang==='en'?'Topic not found.':'الموضوع غير موجود.',reply_markup:kb(nav(lang))};
 const folders=await getTopicFolders(db,topicId); const count=await getTopicResourceCount(db,topicId);
 const lines=[(topic[3]||'🧭')+' <b>'+esc(topic[1])+'</b>'];if(topic[2])lines.push(esc(topic[2]));lines.push('',lang==='en'?'📚 '+count+' resources':'📚 '+count+' مورداً','');
 const buttons=folders.map(f=>[btn('📂 '+String(f[1]).slice(0,40),'folder:'+f[0])]);buttons.push([btn(lang==='en'?'🧭 Topics':'🧭 المواضيع','topics'),btn(lang==='en'?'🏠 Home':'🏠 الرئيسية','home')]);return {text:lines.join('\n'),reply_markup:kb(buttons)};
}
