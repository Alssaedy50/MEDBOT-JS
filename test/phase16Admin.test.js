import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerAdmin, buildWorkerPending } from '../src/telegram/workerAdmin.js';
import { buildWorkerContext } from '../src/telegram/workerContext.js';
import { getWorkerState, setWorkerState } from '../src/db/d1/workerState.js';

function dbMock(){const data=new Map();return {prepare(sql){return {bind(...p){return {async raw(){if(sql.includes('SELECT value')){const v=data.get(p[0]);return v?[v]:[];}return [];},async run(){if(sql.startsWith('INSERT'))data.set(p[0],p[1]);else if(sql.startsWith('DELETE'))data.delete(p[0]);return {meta:{changes:1,last_row_id:1}};}};}};}};}

test('Phase 16 Worker context remains media-aware',()=>{const c=buildWorkerContext({update:{message:{from:{id:7},chat:{id:7},photo:[{file_id:'x'}]}}});assert.equal(c.kind,'media');});
test('Phase 16 durable worker state round-trips',async()=>{const db=dbMock();await setWorkerState(db,7,{ai_chat:true,folder:3});assert.deepEqual(await getWorkerState(db,7),{ai_chat:true,folder:3});});
test('Phase 16 admin builders are exported',()=>{assert.equal(typeof buildWorkerAdmin,'function');assert.equal(typeof buildWorkerPending,'function');});
