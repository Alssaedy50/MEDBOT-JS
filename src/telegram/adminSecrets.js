import { isOwner } from '../db/admins.js';
import { deleteRuntimeSecret, getRuntimeSecretNames, setRuntimeSecret } from '../security/secretVault.js';

const PREFIXES = ['secrets_menu','secret_set','secret_delete'];
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

function owner(ctx) { return isOwner(ctx.from.id); }
function maskName(name) {
  const n=String(name);
  return n.length<=4 ? '••••' : `${n.slice(0,2)}••••${n.slice(-2)}`;
}
function parseAssignment(text) {
  const raw=String(text??'').trim();
  const eq=raw.indexOf('=');
  if(eq<=0) return null;
  const name=raw.slice(0,eq).trim();
  const value=raw.slice(eq+1);
  if(!NAME_RE.test(name)) return null;
  return {name:name.toUpperCase(),value};
}
function validationHelp() {
  return [
    '🧩 <b>طريقة الإضافة</b>',
    '',
    '<code>NAME=VALUE</code>',
    '',
    'أمثلة:',
    '<code>GEMINI_API_KEY=AIza...</code>',
    '<code>OPENROUTER_API_KEY=sk-or-...</code>',
    '<code>MY_SERVICE_TOKEN=abc123</code>',
    '<code>DATABASE_URL=postgresql://...</code>',
    '<code>JWT_SECRET=base64_or_any_secret</code>',
    '',
    'يمكن أن تحتوي VALUE على أي صيغة نصية: رموز، شرطات، /، :، =، @، #، +، مسافات…',
    'ولا يحتاج اسم المتغير إلى أن يكون معروفاً مسبقاً.',
    '',
    '⚠️ التحقق داخل البوت يتحقق من <b>الصيغة والبنية</b> ويحفظ القيمة كما أرسلتها، لكنه لا يستطيع إثبات أن Token خارجي صالح إلا بعد استخدامه مع خدمته.',
  ].join('\\n');
}
export const ADMIN_SECRET_PREFIXES = PREFIXES;

export async function showSecrets(ctx) {
  if (!owner(ctx)) return ctx.editMessageText('🔒 هذه الصفحة متاحة للمالك فقط.');
  const names = getRuntimeSecretNames();
  const lines = [
    '🔐 <b>متغيرات وأكواد المنصة السرية</b>',
    '',
    'الميزة ديناميكية: أضف أي متغير بيئي جديد دون تعديل الكود.',
    validationHelp(),
    '',
    names.length ? `المحفوظ حالياً: ${names.map(maskName).map((n,i)=>`<code>${n}</code>`).join(' · ')}` : 'لا توجد متغيرات سرية محفوظة.',
  ];
  await ctx.editMessageText(lines.join('\\n'), { parse_mode:'HTML', reply_markup:{inline_keyboard:[
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
    ctx.userData.secret_delete_waiting = false;
    return ctx.editMessageText(
      '🔐 <b>إضافة متغير سري</b>\\n\\n' +
      '<b>الصيغة:</b> <code>NAME=VALUE</code>\\n\\n' +
      validationHelp() +
      '\\n\\nبعد الإرسال ستُحذف رسالة الإدخال تلقائياً، ولن يعرض البوت القيمة مرة أخرى.',
      {parse_mode:'HTML'},
    );
  }
  if (ctx.data === 'secret_delete') {
    ctx.userData.secret_delete_waiting = true;
    ctx.userData.secret_waiting = false;
    return ctx.editMessageText('🗑 أرسل اسم المتغير فقط، مثل <code>MY_SERVICE_TOKEN</code>.',{parse_mode:'HTML'});
  }
}

export async function handleSecretText(ctx) {
  if (!owner(ctx)) return false;
  const text=String(ctx.text??'').trim();
  if (ctx.userData.secret_waiting) {
    ctx.userData.secret_waiting=false;
    const assignment=parseAssignment(text);
    if (!assignment) { await ctx.reply('⚠️ الصيغة غير صحيحة.\\n\\nاستخدم <code>NAME=VALUE</code> حيث NAME يبدأ بحرف ويحتوي حروفاً/أرقاماً/_ فقط.',{parse_mode:'HTML'}); return true; }
    try {
      const name=setRuntimeSecret(assignment.name,assignment.value);
      if (ctx.message?.message_id) await ctx.bot.deleteMessage(ctx.from.id,ctx.message.message_id).catch(()=>{});
      await ctx.reply(`✅ تم حفظ <code>${name}</code> بنجاح.\\n\\nالقيمة مشفّرة ولا يمكن عرضها من البوت.\\n\\nللتأكد من صلاحية Token خارجي، استخدم خيار "اختبار الاتصال" الخاص بالخدمة إن كان مدعوماً.`,{parse_mode:'HTML'});
    } catch(error) { await ctx.reply(`❌ لم يتم الحفظ: ${error.message}`); }
    return true;
  }
  if (ctx.userData.secret_delete_waiting) {
    ctx.userData.secret_delete_waiting=false;
    const name=text.toUpperCase();
    if(!NAME_RE.test(name)){await ctx.reply('⚠️ اسم المتغير غير صحيح.');return true;}
    try { deleteRuntimeSecret(name); await ctx.reply(`✅ تم حذف <code>${name}</code>.`,{parse_mode:'HTML'}); }
    catch(error){ await ctx.reply(`❌ لم يتم الحذف: ${error.message}`); }
    return true;
  }
  return false;
}
