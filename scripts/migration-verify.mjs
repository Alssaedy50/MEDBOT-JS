import { withDb } from '../src/db/core.js';

export function verifyDatabase(target=null){
  const required=['users','folders','content','contributions','settings','admins','ai_registry','ai_model_usage','messages','audit_log','topics','topic_folders','notifications','archive_sync','news','news_reads','news_subscriptions','news_deliveries','admin_scopes'];
  const checks=[];
  const add=(name,ok,detail)=>checks.push({name,status:ok?'PASS':'FAIL',detail});
  withDb((db)=>{
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r[0]));
    for(const t of required)add('table:'+t,tables.has(t),tables.has(t)?'present':'missing');
    const fk=db.prepare('PRAGMA foreign_key_check').all(); add('foreign_keys',!fk.length,!fk.length?'no violations':`${fk.length} violation(s)`);
    const refs=[
      ['content_folder_refs','SELECT COUNT(*) FROM content c LEFT JOIN folders f ON f.id=c.folder_id WHERE f.id IS NULL'],
      ['contribution_folder_refs','SELECT COUNT(*) FROM contributions c LEFT JOIN folders f ON f.id=c.folder_id WHERE f.id IS NULL'],
      ['topic_folder_refs','SELECT COUNT(*) FROM topic_folders tf LEFT JOIN topics t ON t.id=tf.topic_id LEFT JOIN folders f ON f.id=tf.folder_id WHERE t.id IS NULL OR f.id IS NULL'],
      ['news_resource_refs','SELECT COUNT(*) FROM news n LEFT JOIN content c ON c.id=n.resource_id WHERE n.resource_id IS NOT NULL AND c.id IS NULL'],
      ['news_folder_refs','SELECT COUNT(*) FROM news n LEFT JOIN folders f ON f.id=n.section_folder_id WHERE n.section_folder_id IS NOT NULL AND f.id IS NULL'],
    ];
    for(const [n,q] of refs){const c=Number(db.prepare(q).get()[0]??0);add(n,c===0,c===0?'no broken references':`${c} broken reference(s)`);}
    const owners=Number(db.prepare("SELECT COUNT(*) FROM admins WHERE role='owner'").get()[0]??0);add('owner_invariant',owners<=1,`${owners} owner row(s); maximum one`);
    const secrets=db.prepare("SELECT value FROM settings WHERE key LIKE 'secret.v1.%'").all();let malformed=0;
    for(const row of secrets){try{const p=JSON.parse(String(row[0]));if(p?.v!==1||!p.iv||!p.tag||!p.data)malformed++}catch{malformed++}}
    add('secret_vault_shape',malformed===0,malformed===0?`${secrets.length} encrypted secret envelope(s) valid`:`${malformed} malformed envelope(s)`);
  },target);
  const failures=checks.filter(c=>c.status==='FAIL'); return {ok:!failures.length,checks,summary:{pass:checks.filter(c=>c.status==='PASS').length,fail:failures.length}};
}
if(import.meta.url===`file://${process.argv[1]}`){try{const r=verifyDatabase();for(const c of r.checks)console.log(`[${c.status}] ${c.name}: ${c.detail}`);if(!r.ok)process.exitCode=1}catch(e){console.error(e.message);process.exitCode=1}}
