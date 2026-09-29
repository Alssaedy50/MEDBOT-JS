import test from 'node:test';
import assert from 'node:assert/strict';
import * as ai from '../src/db/d1/aiRegistry.js';

function mockD1() {
  const rows = [];
  const db = {
    prepare(sql) {
      const stmt = { params: [], bind(...p) { this.params = p; return this; },
        async raw() {
          const p = this.params;
          if (/SELECT id FROM ai_registry WHERE provider/i.test(sql)) return rows.filter(r => r.provider===p[0] && r.model===p[1] && r.endpoint===p[2]).slice(0,1).map(r=>[r.id]);
          if (/SELECT id,provider,model/i.test(sql)) return rows.filter(r=>r.availability==='AVAILABLE').map(r=>[r.id,r.provider,r.model,r.endpoint,r.availability,r.auth_status,r.latency_ms,r.success_rate,r.capabilities]);
          if (/SELECT id,provider,model,endpoint/i.test(sql)) return rows.map(r=>[r.id,r.provider,r.model,r.endpoint,r.availability,r.auth_status,r.latency_ms,r.success_rate,r.capabilities,r.last_success,r.last_failure,r.last_test,r.notes,r.error_category,r.timeout_behavior,r.rate_limit_behavior]);
          if (/SELECT r.id,r.provider/i.test(sql)) return rows.map(r=>[r.id,r.provider,r.model,r.availability,0,0,0,0,null]);
          if (/SELECT user_id,COUNT/i.test(sql)) return [];
          return [];
        },
        async run() {
          const p=this.params;
          if (/INSERT INTO ai_registry/i.test(sql)) { if(!rows.some(r=>r.provider===p[0]&&r.model===p[1]&&r.endpoint===p[2])) rows.push({id:rows.length+1,provider:p[0],model:p[1],endpoint:p[2],availability:p[3],auth_status:p[4],capabilities:p[5]}); return {meta:{changes:1,last_row_id:rows.length}}; }
          if (/UPDATE ai_registry SET/i.test(sql)) return {meta:{changes:1,last_row_id:0}};
          if (/INSERT INTO ai_model_usage/i.test(sql)) return {meta:{changes:1,last_row_id:1}};
          return {meta:{changes:0,last_row_id:0}};
        }
      }; return stmt;
    }
  }; return db;
}

test('D1 AI registry ensure is idempotent', async () => {
  const db=mockD1();
  const first=await ai.aiRegistryEnsure(db,'groq','model-a','https://example.test');
  const second=await ai.aiRegistryEnsure(db,'groq','model-a','https://example.test');
  assert.equal(first,1); assert.equal(second,1); assert.equal((await ai.aiRegistryGetAll(db)).length,1);
});

test('D1 AI usage recording is best effort', async () => { assert.equal(await ai.aiUsageRecord(mockD1(),1,{userId:7,latencyMs:120,success:true}),true); });

test('D1 AI registry rejects empty provider/model/endpoint', async () => { assert.equal(await ai.aiRegistryEnsure(mockD1(),'','',''),null); });