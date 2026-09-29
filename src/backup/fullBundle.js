import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveDbPath } from '../db/core.js';

const EXCLUDES = [
  '.git','node_modules','.wrangler','coverage','backups','.agent_tmp',
  '*.sqlite3-wal','*.sqlite3-shm','.env','.env.*'
];

function run(command,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
    let stderr=''; child.stderr.on('data',(d)=>{stderr+=d.toString();});
    child.on('error',reject); child.on('close',(code)=>code===0?resolve():reject(new Error(stderr||`command_failed:${code}`)));
  });
}
async function addFile(tarPath, sourcePath, arcPath) {
  await run('tar',['-rf',tarPath,'-C',path.dirname(sourcePath),path.basename(sourcePath)]);
  // arcPath is documented in the manifest; tar is intentionally kept simple.
  return arcPath;
}
export async function buildFullBotBundle() {
  const root=process.cwd();
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'medbot-full-'));
  const tarPath=path.join(temp,'MEDBOT-FULL.tar');
  const outPath=path.join(temp,'MEDBOT-FULL.tar.gz');
  const dbPath=resolveDbPath();
  const manifest={
    format:'medbot-full-deploy-bundle',
    version:1,
    created_at:new Date().toISOString(),
    project:'MEDBOT-JS',
    includes:['source','package configuration','SQLite data','encrypted runtime secret vault','deployment configuration'],
    excludes:EXCLUDES,
    database_path:dbPath,
    secret_note:'Runtime secrets are encrypted inside the database and require the same BOT_TOKEN to decrypt. BOT_TOKEN itself is never included.',
    resource_note:'Registered Telegram file_ids remain in the database. Telegram file_ids belong to the current bot and cannot be transferred to another bot; a future resource-export step should upload source files to durable object storage for true cross-bot portability.',
  };
  await fsp.writeFile(path.join(temp,'BUNDLE-MANIFEST.json'),JSON.stringify(manifest,null,2));
  // Source/config/data. Runtime-only directories and plaintext .env are excluded.
  const excludeArgs=EXCLUDES.flatMap((x)=>['--exclude',x]);
  await run('tar',['-cf',tarPath,...excludeArgs,'-C',root,'.']);
  if (fs.existsSync(dbPath) && path.resolve(dbPath)!==path.resolve(path.join(root,path.basename(dbPath)))) {
    await run('tar',['-rf',tarPath,'-C',path.dirname(dbPath),path.basename(dbPath)]);
  }
  await run('tar',['-rf',tarPath,'-C',temp,'BUNDLE-MANIFEST.json']);
  await run('gzip',['-9','-f',tarPath]);
  await fsp.rename(`${tarPath}.gz`,outPath);
  return {path:outPath, size:(await fsp.stat(outPath)).size, manifest};
}
