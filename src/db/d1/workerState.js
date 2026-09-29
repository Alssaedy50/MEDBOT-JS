import { get, all, run } from './core.js';
export async function getWorkerState(db,userId){const r=await get(db,'SELECT value FROM settings WHERE key=?',['worker_state:'+Number(userId)]);if(!r)return {};try{return JSON.parse(r[0])||{};}catch{return {};}}
export async function setWorkerState(db,userId,state){await run(db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',['worker_state:'+Number(userId),JSON.stringify(state||{})]);return state||{};}
export async function clearWorkerState(db,userId){await run(db,'DELETE FROM settings WHERE key=?',['worker_state:'+Number(userId)]);}
export async function listWorkerStates(db,limit=100){return all(db,"SELECT key,value FROM settings WHERE key LIKE 'worker_state:%' ORDER BY key LIMIT ?",[Math.min(500,Math.max(1,Number(limit)||100))]);}
