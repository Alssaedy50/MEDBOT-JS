import { all, get, run, isIntegrityError } from './core.js';
import { SCOPE_TYPES, intOrNull } from '../../constants.js';
const TABLE={folder:'folders',topic:'topics',resource:'content'};
const id=v=>intOrNull(v);

export async function addAdminScope(db,adminId,scopeType,scopeId,createdBy=null){
 const a=id(adminId),s=id(scopeId); if(a===null||s===null||!SCOPE_TYPES.includes(scopeType)) return false;
 if(!(await get(db,`SELECT id FROM ${TABLE[scopeType]} WHERE id=?`,[s])) ) return false;
 try{await run(db,'INSERT INTO admin_scopes (admin_id,scope_type,scope_id,created_by) VALUES (?,?,?,?)',[a,scopeType,s,id(createdBy)]);return true;}catch(error){if(isIntegrityError(error))return true;throw error;}
}
export async function removeAdminScope(db,adminId,scopeType,scopeId){const a=id(adminId),s=id(scopeId);if(a===null||s===null||!SCOPE_TYPES.includes(scopeType))return false;return (await run(db,'DELETE FROM admin_scopes WHERE admin_id=? AND scope_type=? AND scope_id=?',[a,scopeType,s])).changes>0;}
export async function clearAdminScopes(db,adminId){const a=id(adminId);if(a===null)return 0;return (await run(db,'DELETE FROM admin_scopes WHERE admin_id=?',[a])).changes;}
export async function getAdminScopes(db,adminId){const a=id(adminId);if(a===null)return [];return (await all(db,'SELECT scope_type,scope_id,created_at FROM admin_scopes WHERE admin_id=? ORDER BY scope_type,scope_id',[a])).map(r=>({scope_type:r[0],scope_id:r[1],created_at:r[2]}));}
export async function adminHasScopes(db,adminId){return Boolean(await get(db,'SELECT 1 FROM admin_scopes WHERE admin_id=? LIMIT 1',[id(adminId)]));}
async function roots(db,adminId){const rows=await all(db,'SELECT scope_type,scope_id FROM admin_scopes WHERE admin_id=?',[id(adminId)]);const out=new Set();for(const [t,s] of rows){if(t==='folder')out.add(s);if(t==='topic'){for(const r of await all(db,'SELECT folder_id FROM topic_folders WHERE topic_id=?',[s]))out.add(r[0]);}}return out;}
async function contains(db,target,rootSet){let cur=target;const seen=new Set();while(cur!==null&&cur!==undefined&&!seen.has(cur)){if(rootSet.has(cur))return true;seen.add(cur);const r=await get(db,'SELECT parent_id FROM folders WHERE id=?',[cur]);if(!r)break;cur=r[0];}return false;}
export async function folderInAdminScope(db,adminId,folderId){const a=id(adminId),f=id(folderId);if(a===null||f===null)return false;return contains(db,f,await roots(db,a));}
export async function resourceInAdminScope(db,adminId,contentId){const a=id(adminId),c=id(contentId);if(a===null||c===null)return false;const row=await get(db,'SELECT folder_id FROM content WHERE id=?',[c]);if(!row)return false;if(await get(db,"SELECT 1 FROM admin_scopes WHERE admin_id=? AND scope_type='resource' AND scope_id=?",[a,c]))return true;return contains(db,row[0],await roots(db,a));}
export async function isTopicInAdminScope(db,adminId,topicId){const a=id(adminId),t=id(topicId);if(a===null||t===null)return false;return Boolean(await get(db,"SELECT 1 FROM admin_scopes WHERE admin_id=? AND scope_type='topic' AND scope_id=?",[a,t]));}
export async function newsInAdminScope(db,adminId,newsId){const a=id(adminId),n=id(newsId);if(a===null||n===null)return false;const row=await get(db,'SELECT subject_folder_id,section_folder_id,folder_id,resource_id FROM news WHERE id=?',[n]);if(!row)return false;for(const folderId of new Set(row.slice(0,3).filter(v=>v!==null&&v!==undefined&&Number(v)>0))){if(await folderInAdminScope(db,a,folderId))return true;}const resourceId=id(row[3]);return resourceId!==null&&await resourceInAdminScope(db,a,resourceId);}
export async function listFolderIdsUnder(db,rootsInput){const pending=[...(rootsInput??[])].filter(Boolean),seen=new Set();while(pending.length){const cur=pending.pop();if(seen.has(cur))continue;seen.add(cur);for(const r of await all(db,'SELECT id FROM folders WHERE parent_id=?',[cur]))pending.push(r[0]);}return seen;}
export async function scopeRootFolderIds(db,adminId){return roots(db,id(adminId));}
