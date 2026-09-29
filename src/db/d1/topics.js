import { all, get } from './core.js';

export async function getTopics(db, activeOnly = false) {
  const sql = activeOnly ? 'SELECT id,name,description,icon,display_order,active FROM topics WHERE active=1 ORDER BY display_order ASC,id ASC' : 'SELECT id,name,description,icon,display_order,active FROM topics ORDER BY display_order ASC,id ASC';
  return all(db, sql);
}
export async function getTopic(db, topicId) {
  return get(db, 'SELECT id,name,description,icon,display_order,active FROM topics WHERE id=?', [Number.parseInt(topicId,10)]);
}
export async function getTopicFolders(db, topicId) {
  return all(db, 'SELECT f.id,f.name,f.node_type,f.accepts_contributions FROM topic_folders tf JOIN folders f ON f.id=tf.folder_id WHERE tf.topic_id=? ORDER BY f.id ASC', [Number.parseInt(topicId,10)]);
}
export async function getTopicResourceCount(db, topicId) {
  const rows=await all(db,'SELECT folder_id FROM topic_folders WHERE topic_id=?',[Number.parseInt(topicId,10)]);
  const pending=rows.map(r=>r[0]); const seen=new Set(); let total=0;
  while(pending.length){const id=pending.pop();if(seen.has(id))continue;seen.add(id);const c=await get(db,'SELECT COUNT(*) FROM content WHERE folder_id=?',[id]);total+=Number(c?.[0]??0);for(const r of await all(db,'SELECT id FROM folders WHERE parent_id=?',[id]))pending.push(r[0]);}
  return total;
}
