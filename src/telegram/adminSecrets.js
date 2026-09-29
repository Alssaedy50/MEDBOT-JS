import { isOwner } from '../db/admins.js';
import { deleteRuntimeSecret, getRuntimeSecretNames, parseSecretAssignment, setRuntimeSecret } from '../security/secretVault.js';

const PREFIXES = ['secrets_menu','secret_set','secret_delete','secret_confirm'];

function owner(ctx) { return isOwner(ctx.from.id); }

export const ADMIN_SECRET_PREFIXES = PREFIXES;

export async function showSecrets(ctx) {
  if (!owner(ctx)) return ctx.editMessageText('🔒 هذه الصفحة متاحة للمالك فقط.');
  const names = getRuntimeSecretNames();
  const lines = [
    '🔐 <b>متغيرات وأكواد المنصة السرية</b>',
    '',
    'القيم محفوظة مشفّرة ولا يعرضها البوت مرة أخرى.',
    'يمكن استخدام الأسماء في النظام مثل GEMINI_API_KEY وGROQ_API_KEY وOPENROUTER_API_KEY.',
    '',
    names.length ? `المحفوظ حالياً: ${names.map((n)=>`<code>${n}</code>`).join(' · ')}` : 'لا توجد متغيرات سرية محفوظة.',
  ];
  await ctx.editMessageText(lines.join('\\n'), { reply_markup:{inline_keyboard:[
    [{text:'➕ إضافة / تعديل متغير',callback_data:'secret_set'}],
    [{text:'🗑 حذف متغير',callback_data:'secret_delete'}],
    [{text:'⬅️ إدارة المنصة',callback_data:'admin'}],
  ]}});
}

export async function handleSecretCallback(ctx) {
  if (!owner(ctx)) { await ctx.answer({text:'غير مصرح',show_alert:true}); return; }
  await ctx.answer();
  if (ctx.data === 'secrets_menu') return showSecrets(ctx);
  if (ctx.data === 'secret_set') {
    ctx.userData.secret_waiting = true;
    return ctx.editMessageText('🔐 أرسل المتغير بهذا الشكل فقط:\\n\\n<code>GEMINI_API_KEY=القيمة</code>\\n\\nسيتم حذف رسالة الإدخال بعد قراءتها. لا تستخدم BOT_TOKEN أو ADMIN_ID هنا.', {parse_mode:'HTML'});
  }
  if (ctx.data === 'secret_delete') {
    ctx.userData.secret_delete_waiting = true;
    return ctx.editMessageText('🗑 أرسل اسم المتغير فقط، مثل:\\n<code>GEMINI_API_KEY</code>');
  }
}

export async function handleSecretText(ctx) {
  if (!owner(ctx)) return false;
  const text = String(ctx.text ?? '').trim();
  if (ctx.userData.secret_waiting) {
    ctx.userData.secret_waiting = false;
    const match = text.match(/^([A-Za-z][A-Za-z0-9_]*)=(.*)$/s);
    if (!match) { await ctx.reply('⚠️ الصيغة غير صحيحة. استخدم NAME=VALUE.'); return true; }
    try {
      const name=setRuntimeSecret(match[1],match[2]);
      if (ctx.message?.message_id) await ctx.bot.deleteMessage(ctx.from.id, ctx.message.message_id).catch(()=>{});
      await ctx.reply(`✅ تم حفظ <code>${name}</code> مشفّراً. القيمة لا يمكن عرضها من البوت.`,{parse_mode:'HTML'});
    } catch (error) { await ctx.reply(`❌ لم يتم الحفظ: ${error.message}`); }
    return true;
  }
  if (ctx.userData.secret_delete_waiting) {
    ctx.userData.secret_delete_waiting = false;
    try {
      const name=String(text).trim().toUpperCase();
      deleteRuntimeSecret(name);
      await ctx.reply(`✅ تم حذف <code>${name}</code>.`,{parse_mode:'HTML'});
    } catch(error){ await ctx.reply(`❌ لم يتم الحذف: ${error.message}`); }
    return true;
  }
  return false;
}
