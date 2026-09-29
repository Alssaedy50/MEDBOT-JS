import { getUserLanguage } from '../db/d1/users.js';
import { getFolders } from '../db/d1/registry.js';
import { addContribution } from '../db/d1/contributions.js';

const kb=rows=>({inline_keyboard:rows});const btn=(text,callback_data)=>({text,callback_data});
export async function buildWorkerContributionStart(db,user){
 const lang=await getUserLanguage(db,Number(user.id));const folders=await getFolders(db,null);
 const eligible=[];
 for(const f of folders){if(f[3])eligible.push(f);}
 const lines=[lang==='en'?'📤 <b>Contribute a resource</b>':'📤 <b>إضافة مساهمة</b>','',lang==='en'?'Choose a section that accepts contributions:':'اختر القسم الذي يستقبل المساهمات:'];
 const buttons=eligible.map(f=>[btn('📂 '+String(f[1]).slice(0,40),'contrib_folder:'+f[0])]);
 if(!eligible.length)lines.push(lang==='en'?'No section is currently accepting contributions.':'لا يوجد قسم يستقبل مساهمات حالياً.');
 buttons.push([btn(lang==='en'?'🏠 Home':'🏠 الرئيسية','home')]);return {text:lines.join('\\n'),reply_markup:kb(buttons)};
}
export async function prepareWorkerContribution(db,user,folderId){
 const lang=await getUserLanguage(db,Number(user.id));const row=await (await import('../db/d1/core.js')).get(db,'SELECT id,name,accepts_contributions FROM folders WHERE id=?',[Number(folderId)]);
 if(!row||!row[2])return {ok:false,text:lang==='en'?'This section does not accept contributions.':'هذا القسم لا يستقبل مساهمات.'};
 return {ok:true,text:lang==='en'?'📎 Send the resource as a document, photo, audio, or video and put its title in the caption.':'📎 أرسل المورد كملف أو صورة أو صوت أو فيديو، واكتب عنوان المورد في الوصف (caption).'};
}
function mediaOf(message){
 if(message?.document)return ['document',message.document.file_id];
 if(message?.photo?.length)return ['photo',message.photo[message.photo.length-1].file_id];
 if(message?.video)return ['video',message.video.file_id];
 if(message?.audio)return ['audio',message.audio.file_id];
 return null;
}
export async function handleWorkerContributionMedia(db,user,message,folderId){
 const lang=await getUserLanguage(db,Number(user.id));const media=mediaOf(message);const title=String(message?.caption??'').trim();
 if(!media)return {text:lang==='en'?'Please send a document, photo, audio, or video.':'أرسل مستنداً أو صورة أو ملفاً صوتياً أو فيديو.'};
 if(!title)return {text:lang==='en'?'Add the resource title in the caption and send it again.':'اكتب عنوان المورد في الوصف (caption) ثم أرسله مرة أخرى.'};
 try{await addContribution(db,Number(user.id),[user.first_name,user.last_name].filter(Boolean).join(' ')||user.username||String(user.id),Number(folderId),title,media[1],media[0]);return {text:lang==='en'?'✅ Contribution submitted for review.':'✅ تم تسجيل المساهمة وإرسالها للمراجعة.'};}
 catch(error){return {text:error?.message|| (lang==='en'?'Could not submit the contribution.':'تعذر تسجيل المساهمة.')};}
}
