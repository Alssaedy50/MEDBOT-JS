import fs from 'node:fs/promises';
import { isOwner } from '../db/admins.js';
import {
  exportDatabaseSnapshot,
  snapshotToJson,
  snapshotFromJson,
  restoreDatabaseSnapshot,
  writeSnapshotFile,
} from '../db/backup.js';

let timer = null;
let running = false;

export function isOwnerForCommand(userId) {
  try { return isOwner(userId); } catch { return false; }
}

function caption(snapshot) {
  const tables = snapshot.tables.length;
  const rows = snapshot.tables.reduce((sum, table) => sum + table.rows.length, 0);
  return (
    '🛡 <b>MEDBOT Data Backup</b>\n\n' +
    `🗂 الجداول: ${tables}\n📊 السجلات: ${rows}\n🕒 ${snapshot.exported_at}\n` +
    '🔐 استخدم هذا الملف فقط لاستعادة بيانات MEDBOT.'
  );
}

export async function sendDatabaseBackup(ctx, { toChannel = false } = {}) {
  if (!ownerOnly(ctx.from.id)) {
    await ctx.reply('🔒 النسخ الاحتياطي الكامل متاح للمالك فقط.');
    return false;
  }

  const snapshot = exportDatabaseSnapshot();
  const json = snapshotToJson(snapshot);
  const filename = `medbot-state-${new Date().toISOString().slice(0,10)}.json`;
  const target = toChannel ? (process.env.MEDBOT_BACKUP_CHAT_ID || '').trim() : ctx.from.id;

  if (!target) {
    await ctx.reply('⚠️ لم يتم ضبط MEDBOT_BACKUP_CHAT_ID للقناة. سأرسل النسخة إلى محادثتك.');
  }

  try {
    await ctx.bot.sendDocumentBytes(target || ctx.from.id, Buffer.from(json, 'utf8'), {
      filename,
      caption: caption(snapshot),
      parse_mode: 'HTML',
    });
    if (target && String(target) !== String(ctx.from.id)) {
      await ctx.reply('✅ تم حفظ نسخة البيانات في قناة النسخ الاحتياطي.');
    }
    return true;
  } catch (error) {
    await ctx.reply(`⚠️ تعذر إرسال نسخة البيانات: ${String(error.message ?? error)}`);
    return false;
  }
}

export async function sendDatabaseBackupToChannel(bot) {
  const chatId = (process.env.MEDBOT_BACKUP_CHAT_ID || '').trim();
  if (!chatId || !bot?.sendDocumentBytes) return false;
  const snapshot = exportDatabaseSnapshot();
  const json = snapshotToJson(snapshot);
  const filename = `medbot-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await bot.sendDocumentBytes(chatId, Buffer.from(json, 'utf8'), {
    filename,
    caption: caption(snapshot),
    parse_mode: 'HTML',
  });
  return true;
}

/**
 * Durable external backup. The Worker endpoint stores the latest snapshot in
 * R2. This is optional: Telegram channel backup remains independently useful.
 */
export async function pushRemoteBackup(fetchImpl = fetch) {
  const url = (process.env.MEDBOT_BACKUP_URL || '').trim();
  const token = (process.env.MEDBOT_BACKUP_TOKEN || '').trim();
  if (!url || !token) return false;
  const snapshot = exportDatabaseSnapshot();
  const response = await fetchImpl(url.replace(/\/$/, '') + '/latest', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: snapshotToJson(snapshot),
  });
  if (!response.ok) throw new Error(`remote_backup_put_failed:${response.status}`);
  return true;
}

export function scheduleAutomaticBackup() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    if (running) return;
    running = true;
    try {
      await pushRemoteBackup();
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (token && (process.env.MEDBOT_BACKUP_CHAT_ID || '').trim()) {
        const { TelegramTransport } = await import('./client.js');
        const bot = new TelegramTransport(token);
        await sendDatabaseBackupToChannel(bot);
      }
    } catch (error) {
      console.error('MEDBOT automatic backup failed:', error.message);
    } finally {
      running = false;
    }
  }, 1500);
  timer.unref?.();
}

export async function restoreFromUploadedFile(ctx, fileId) {
  if (!ownerOnly(ctx.from.id)) {
    await ctx.reply('🔒 استعادة البيانات متاحة للمالك فقط.');
    return false;
  }
  try {
    const file = await ctx.bot.getFile(fileId);
    const bytes = await ctx.bot.downloadFile(file.file_path);
    const snapshot = snapshotFromJson(Buffer.from(bytes).toString('utf8'));
    restoreDatabaseSnapshot(snapshot);
    await ctx.reply('✅ تمت استعادة بيانات MEDBOT بنجاح. أعد تشغيل البوت إذا كان هناك شاشات قديمة مفتوحة.');
    return true;
  } catch (error) {
    await ctx.reply(`❌ فشلت استعادة البيانات: ${String(error.message ?? error)}`);
    return false;
  }
}

export async function saveLocalBackup() {
  const snapshot = exportDatabaseSnapshot();
  return writeSnapshotFile(snapshot);
}
