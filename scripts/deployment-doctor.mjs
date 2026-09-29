import fs from 'node:fs';
import path from 'node:path';
import { buildDeploymentManifest } from '../src/deployment/manifest.js';

export function runDeploymentDoctor({env=process.env,rootDir=process.cwd()}={}) {
  const manifest=buildDeploymentManifest({root:rootDir}); const checks=[];
  const add=(name,status,detail)=>checks.push({name,status,detail});
  for(const file of manifest.required_files) add('file:'+file.path,file.present?'PASS':'FAIL',file.present?'present':'missing required file');
  const v=process.versions.node.split('.').map(Number), nodeOk=v[0]>22||(v[0]===22&&v[1]>=5);
  add('node',nodeOk?'PASS':'FAIL',`running ${process.version}; required ${manifest.node.required}`);
  const bot=String(env.BOT_TOKEN??'').trim(); add('BOT_TOKEN',bot?'PASS':'FAIL',bot?'configured (hidden)':'missing');
  const admin=String(env.ADMIN_ID??'').trim(), adminOk=/^-?\d+$/.test(admin); add('ADMIN_ID',adminOk?'PASS':'FAIL',adminOk?'configured':'missing or invalid Telegram id');
  const dbPath=String(env.MEDBOT_DB_PATH??'').trim()||path.join(rootDir,'medbot_v2.sqlite3');
  try{const dir=path.dirname(path.resolve(dbPath));fs.mkdirSync(dir,{recursive:true});fs.accessSync(dir,fs.constants.R_OK|fs.constants.W_OK);add('database_path','PASS',`path ${dbPath}`)}catch(e){add('database_path','FAIL',`not writable: ${e.message}`)}
  const u=Boolean(String(env.MEDBOT_BACKUP_URL??'').trim()), t=Boolean(String(env.MEDBOT_BACKUP_TOKEN??'').trim());
  add('backup_configuration',u===t?'PASS':'FAIL',u===t?'paired or both absent':'URL and token must be paired');
  const ai=['GEMINI_API_KEY','GROQ_API_KEY','OPENROUTER_API_KEY'].filter(k=>String(env[k]??'').trim());
  add('ai_providers',ai.length?'PASS':'WARN',ai.length?`${ai.length} credential(s) configured; values hidden`:'no AI provider configured');
  const failures=checks.filter(c=>c.status==='FAIL');
  return {ok:!failures.length,runtime:'node',checks,summary:{pass:checks.filter(c=>c.status==='PASS').length,warn:checks.filter(c=>c.status==='WARN').length,fail:failures.length}};
}
if(import.meta.url===`file://${process.argv[1]}`){const r=runDeploymentDoctor();for(const c of r.checks)console.log(`[${c.status}] ${c.name}: ${c.detail}`);console.log(`Summary: PASS=${r.summary.pass} WARN=${r.summary.warn} FAIL=${r.summary.fail}`);if(!r.ok)process.exitCode=1;}
