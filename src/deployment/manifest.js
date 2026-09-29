import fs from 'node:fs';
import path from 'node:path';
import { resolveDbPath } from '../db/core.js';

export const DEPLOYMENT_MANIFEST_FORMAT = 'medbot-deployment';
export const DEPLOYMENT_MANIFEST_VERSION = 1;
export const REQUIRED_ENV = Object.freeze(['BOT_TOKEN', 'ADMIN_ID']);
export const OPTIONAL_ENV = Object.freeze([
  'GEMINI_API_KEY','GROQ_API_KEY','OPENROUTER_API_KEY','MEDBOT_DB_PATH',
  'MEDBOT_ARCHIVE_CHANNEL','MEDBOT_BACKUP_URL','MEDBOT_BACKUP_TOKEN','MEDBOT_BACKUP_CHAT_ID',
]);

export function buildDeploymentManifest({ root = process.cwd() } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const requiredFiles = [
    'package.json','package-lock.json','src/index.js','src/telegram/bot.js',
    'src/db/migrations.js','src/db/core.js',
  ].map((file) => ({ path:file, present:fs.existsSync(path.join(root,file)) }));
  return {
    format: DEPLOYMENT_MANIFEST_FORMAT, version: DEPLOYMENT_MANIFEST_VERSION, project:'MEDBOT-JS',
    runtime: {
      production:{platform:'Node.js',database:'SQLite',telegram:'long-polling'},
      parallel:{platform:'Cloudflare Worker',database:'D1',object_storage:'R2',telegram:'webhook'},
    },
    node:{required:packageJson.engines?.node ?? '>=22.5.0'}, package_manager:'npm',
    database:{type:'sqlite',path_env:'MEDBOT_DB_PATH',default_path:resolveDbPath()},
    required_environment:[...REQUIRED_ENV], optional_environment:[...OPTIONAL_ENV],
    cloudflare_bindings:['DB','FILES'], required_files:requiredFiles,
    restore_steps:['validate manifest','restore database','configure runtime','rekey secrets if bot changes','rebind Telegram resources','verify migration','run preflight','start MEDBOT'],
  };
}
