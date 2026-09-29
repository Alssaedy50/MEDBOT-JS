import test from 'node:test';
import assert from 'node:assert/strict';
import * as news from '../src/db/d1/news.js';
import * as notifications from '../src/db/d1/notifications.js';
import * as audit from '../src/db/d1/audit.js';

function mockD1() {
  const state = {
    folders: new Map([[1, [1, null, 'Root']]]),
    content: new Map([[7, [7, 1, 'Resource', 'file-7']]]),
    news: new Map(),
    reads: new Set(),
    subscriptions: new Map(),
    deliveries: new Map(),
    notifications: new Map(),
    audits: new Map(),
    nextNews: 1, nextNotification: 1, nextAudit: 1,
  };

  function execute(sql, p = []) {
    if (/INSERT INTO news \(/i.test(sql)) {
      const id = state.nextNews++;
      state.news.set(id, [id, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], p[12], p[13], p[14], 'now', p[15], null]);
      return { changes: 1, last_row_id: id };
    }
    if (/UPDATE news SET status='published'/i.test(sql)) {
      const r = state.news.get(Number(p[1])); if (!r) return { changes: 0, last_row_id: 0 }; r[12] = 'published'; r[17] ??= p[0]; r[18] = null; return { changes: 1, last_row_id: 0 };
    }
    if (/INSERT OR IGNORE INTO news_reads/i.test(sql)) {
      const key = `${p[0]}:${p[1]}`; if (state.reads.has(key)) return { changes: 0, last_row_id: 0 }; state.reads.add(key); return { changes: 1, last_row_id: 0 };
    }
    if (/INSERT OR IGNORE INTO news_subscriptions/i.test(sql)) {
      const key = `${p[0]}:${p[1]}:${p[2]}`; const fresh = !state.subscriptions.has(key); state.subscriptions.set(key,p); return { changes: fresh ? 1 : 0, last_row_id: 0 };
    }
    if (/INSERT OR IGNORE INTO news_deliveries/i.test(sql)) {
      const key = `${p[0]}:${p[1]}`; if (state.deliveries.has(key)) return { changes: 0, last_row_id: 0 }; state.deliveries.set(key, [p[0],p[1],p[2],p[3]??null,0,null,null,null]); return { changes: 1, last_row_id: 0 };
    }
    if (/INSERT INTO news_deliveries/i.test(sql)) {
      const key = `${p[0]}:${p[1]}`; if (!state.deliveries.has(key)) state.deliveries.set(key,[p[0],p[1],p[2],null,0,null,null,null]); else state.deliveries.get(key)[2]='sending'; return { changes: 1, last_row_id: 0 };
    }
    if (/UPDATE news_deliveries SET status='sending'/i.test(sql)) {
      const key=`${p[0]}:${p[1]}`; const r=state.deliveries.get(key); if(!r||!['pending','failed','sending'].includes(r[2])) return {changes:0,last_row_id:0}; r[2]='sending'; return {changes:1,last_row_id:0};
    }
    if (/INSERT INTO notifications/i.test(sql)) { const id=state.nextNotification++; state.notifications.set(id,p); return {changes:1,last_row_id:id}; }
    if (/INSERT INTO audit_log/i.test(sql)) { const id=state.nextAudit++; state.audits.set(id,p); return {changes:1,last_row_id:id}; }
    return { changes: 0, last_row_id: 0 };
  }

  return {
    prepare(sql) {
      return {
        sql, params: [],
        bind(...p) { this.params=p; return this; },
        async raw() {
          const p=this.params??[];
          if (/SELECT id FROM folders WHERE id/i.test(sql)) return state.folders.has(Number(p[0])) ? [[Number(p[0])]] : [];
          if (/SELECT id FROM content WHERE id/i.test(sql)) return state.content.has(Number(p[0])) ? [[Number(p[0])]] : [];
          if (/SELECT id, folder_id, title FROM content/i.test(sql)) { const r=state.content.get(Number(p[0])); return r ? [[r[0],r[1],r[2]]] : []; }
          if (/SELECT id, news_type, title/i.test(sql)) { const r=state.news.get(Number(p[0])); return r ? [r] : []; }
          if (/SELECT 1 FROM news_reads/i.test(sql)) return state.reads.has(`${p[0]}:${p[1]}`) ? [[1]] : [];
          if (/SELECT COUNT\(\*\) FROM news n/i.test(sql)) return [[0]];
          if (/SELECT news_id FROM news_reads/i.test(sql)) return [];
          if (/SELECT topic_kind,topic_value FROM news_subscriptions/i.test(sql)) return [...state.subscriptions.values()].filter(r=>r[0]===p[0]).map(r=>[r[1],r[2]]);
          if (/SELECT DISTINCT user_id FROM news_subscriptions/i.test(sql)) return [...state.subscriptions.values()].filter(r=>r[1]===p[0]&&r[2]===p[1]).map(r=>[r[0]]);
          if (/SELECT user_id FROM news_deliveries/i.test(sql)) return [...state.deliveries.values()].filter(r=>r[0]===p[0]&&['pending','failed'].includes(r[2])).map(r=>[r[1]]);
          if (/SELECT status FROM news_deliveries/i.test(sql)) { const r=state.deliveries.get(`${p[0]}:${p[1]}`); return r ? [[r[2]]] : []; }
          if (/SELECT status,COUNT\(\*\) FROM news_deliveries/i.test(sql)) return [];
          if (/SELECT id FROM news WHERE resource_id/i.test(sql)) return [];
          if (/SELECT name FROM folders/i.test(sql)) { const r=state.folders.get(Number(p[0])); return r ? [[r[2]]] : []; }
          if (/SELECT id, parent_id, name FROM folders/i.test(sql)) return [...state.folders.values()].map(r=>[r[0],r[1],r[2]]);
          if (/SELECT title,folder_id FROM content/i.test(sql)) { const r=state.content.get(Number(p[0])); return r ? [[r[2],r[1]]] : []; }
          if (/SELECT id FROM content WHERE source_contribution_id/i.test(sql)) return [];
          if (/SELECT news_type,COUNT\(\*\) FROM news/i.test(sql)) return [];
          if (/SELECT COUNT\(\*\) FROM notifications/i.test(sql)) return [[state.notifications.size]];
          if (/SELECT id,sender_id,title,body/i.test(sql)) return [...state.notifications.entries()].reverse().map(([id,p])=>[id,...p,null]).slice(0,p[0]);
          if (/SELECT COUNT\(\*\) FROM audit_log/i.test(sql)) return [[state.audits.size]];
          if (/SELECT id,actor_id,actor_role,action/i.test(sql)) return [...state.audits.entries()].reverse().map(([id,p])=>[id,...p,null]).slice(0,p[p.length-1]);
          if (/SELECT 1 FROM admin_scopes/i.test(sql)) return [];
          return [];
        },
        async run() { return { meta: execute(sql,this.params??[]) }; },
      };
    },
    async batch(statements) { return statements.map((s)=>({meta:execute(s.sql,s.params??[])})); },
  };
}

test('D1 news lifecycle, reads and subscriptions are idempotent', async () => {
  const db=mockD1();
  const id=await news.createNews(db,{newsType:'section',title:'MSK Update',sectionFolderId:1});
  assert.equal(id,1);
  assert.equal(await news.publishNews(db,id),true);
  const row=await news.getNews(db,id); assert.equal(row.title,'MSK Update'); assert.equal(row.status,'published');
  assert.equal(await news.markNewsRead(db,10,id),true);
  assert.equal(await news.markNewsRead(db,10,id),false);
  assert.deepEqual(await news.getNewsSubscriptions(db,10),[]);
  assert.equal(await news.addNewsSubscription(db,10,'type','section'),true);
  assert.equal(await news.addNewsSubscription(db,10,'type','section'),true);
  assert.deepEqual(await news.resolveNewsRecipients(db,'section'),[10]);
});

test('D1 delivery reservation and claim are retry-safe', async () => {
  const db=mockD1();
  assert.deepEqual(await news.reserveNewsDeliveries(db,1,[10,10,11]),[10,11]);
  assert.deepEqual(await news.reserveNewsDeliveries(db,1,[10,11]),[]);
  assert.equal(await news.claimNewsDelivery(db,1,10),true);
  assert.equal(await news.claimNewsDelivery(db,1,10),true);
});

test('D1 notifications and audit use async storage contracts', async () => {
  const db=mockD1();
  assert.equal(await notifications.recordNotification(db,1,'Title','Body'),1);
  assert.equal(await notifications.getNotificationsCount(db),1);
  assert.equal(await audit.addAuditEntry(db,1,'admin','news.publish','news',1,'ok'),true);
  assert.equal(await audit.getAuditCount(db),1);
});
