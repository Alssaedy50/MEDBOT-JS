/**
 * Rebind embedded Telegram resources to a new bot.
 *
 * Run from the extracted MEDBOT-FULL bundle on the destination platform:
 *   BOT_TOKEN=... node scripts/rebind-bundle-resources.mjs
 *
 * Only files embedded in resources/ are uploaded. The original bot's file_id
 * values are replaced with the new bot's file_ids, so the copied database keeps
 * working even when the bot identity changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const token=String(process.env.BOT_TOKEN??'').trim();
if(!token) throw new Error('BOT_TOKEN is required');
const root=process.cwd();
const manifest=JSON.parse(fs.readFileSync(path.join(root,'BUNDLE-MANIFEST.json'),'utf8'));
const dbPath=process.env.MEDBOT_DB_PATH||path.join(root,'medbot_v2.sqlite3');
const db=new DatabaseSync(dbPath);
function upload(method,filePath,field='document'){
  const form=new FormData(); form.set('chat_id',String(process.env.ADMIN_ID||'0'));
  form.set(field,new Blob([fs.readFileSync(filePath)]),path.basename(filePath));
  return fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',body:form}).then(async r=>{const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.description||method);return d.result;});
}
for(const item of manifest.resource_files||[]){
  if(!item.included) continue;
  const local=path.join(root,item.path);
  if(!fs.existsSync(local)) continue;
  let method='sendDocument',field='document',type=item.file_type;
  if(type==='photo' && fs.statSync(local).size<=10*1024*1024){method='sendPhoto';field='photo';}
  else if(type==='video'){method='sendVideo';field='video';}
  else if(type==='audio'){method='sendAudio';field='audio';}
  const result=await upload(method,local,field);
  const file=result.document?.file_id||result.photo?.at(-1)?.file_id||result.video?.file_id||result.audio?.file_id;
  if(!file) throw new Error(`No file_id returned for content ${item.id}`);
  db.prepare('UPDATE content SET file_id=?, file_type=? WHERE id=?').run(file,method==='sendDocument'&&type==='photo'?'doc':type,file?item.id:item.id);
  console.log(`Rebound resource ${item.id}: ${item.title}`);
}
db.close();
console.log('Resource rebind completed.');
