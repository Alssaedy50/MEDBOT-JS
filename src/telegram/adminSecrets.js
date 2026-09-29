import { isOwner } from '../db/admins.js';
import {
  deleteRuntimeSecret,
  getRuntimeSecret,
  getRuntimeSecretNames,
  setRuntimeSecret,
} from '../security/secretVault.js';

const PREFIXES = [
  'secrets_menu',
  'secret_set',
  'secret_delete',
  'secret_validate',
  'secret_help',
];

function owner(ctx) {
  return isOwner(ctx.from.id);
}

export const ADMIN_SECRET_PREFIXES = PREFIXES;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_LENGTH = 10000;

function mask(value) {
  const text = String(value ?? '');
  if (!text) return '∅';
  if (text.length <= 6) return '••••••';
  return `${text.slice(0, 2)}••••${text.slice(-2)}`;
}

/**
 * Parse common environment-variable input forms without changing the value.
 *
 * Supported:
 *   NAME=VALUE
 *   export NAME=VALUE
 *   NAME = VALUE
 *   NAME: VALUE
 *   {"NAME":"VALUE"}
 *   {"NAME":"VALUE","OTHER":"VALUE"}
 *
 * Multiline values are preserved. Only the first assignment delimiter is used.
 */
export function parseSecretInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('EMPTY_SECRET_INPUT');

  if (text.startsWith('{') && text.endsWith('}')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('INVALID_JSON_SECRET_FORMAT'); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('JSON_SECRET_OBJECT_REQUIRED');
    }
    const entries = Object.entries(parsed);
    if (!entries.length) throw new Error('EMPTY_SECRET_OBJECT');
    return entries.map(([name, value]) => {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(`INVALID_SECRET_VALUE_TYPE:${name}`);
      }
      return { name, value: String(value) };
    });
  }

  const withoutExport = text.replace(/^export\\s+/i, '');
  const match = withoutExport.match(/^([A-Za-z_][A-Za-z0-9_]*)\\s*(=|:)\\s*([\\s\\S]*)$/);
  if (!match) throw new Error('INVALID_SECRET_FORMAT');
  return [{ name: match[1], value: match[3] }];
}

export function validateSecretEntry({ name, value }) {
  const normalizedName = String(name ?? '').trim().toUpperCase();
  const normalizedValue = String(value ?? '');

  const errors = [];
  const warnings = [];
  if (!NAME_RE.test(normalizedName)) errors.push('اسم المتغير يجب أن يكون NAME أو NAME_123.');
  if (normalizedName.length > 64) errors.push('اسم المتغير أطول من 64 حرفاً.');
  if (!normalizedValue.trim()) errors.push('القيمة فارغة.');
  if (normalizedValue.length > MAX_VALUE_LENGTH) errors.push('القيمة أطول من الحد المسموح.');
  if (/\\r|\\n/.test(normalizedName)) errors.push('اسم المتغير يحتوي على محارف غير صالحة.');

  // Provider-aware format checks. These are deliberately warnings/errors about
  // shape only; a syntactically plausible token is not proof that it is active.
  const n = normalizedName;
  if (/TELEGRAM.*TOKEN|BOT_TOKEN/i.test(n) && !/^\\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(normalizedValue)) {
    warnings.push('لا تطابق القيمة صيغة Telegram Bot Token المعروفة.');
  }
  if (/OPENAI/i.test(n) && !/^sk-[A-Za-z0-9_-]{10,}/.test(normalizedValue)) {
    warnings.push('لا تطابق القيمة الشكل الشائع لمفتاح OpenAI؛ قد تكون صيغة حديثة/مخصصة.');
  }
  if (/GEMINI|GOOGLE.*API/i.test(n) && normalizedValue.length < 20) {
    warnings.push('القيمة قصيرة مقارنة بمفاتيح Google API المعتادة.');
  }
  if (/GROQ/i.test(n) && !/^gsk_/i.test(normalizedValue)) {
    warnings.push('لا تطابق القيمة البادئة الشائعة لمفتاح Groq.');
  }
  if (/OPENROUTER/i.test(n) && !/^sk-or-/i.test(normalizedValue)) {
    warnings.push('لا تطابق القيمة البادئة الشائعة لمفتاح OpenRouter.');
  }
  if (/^[A-Z0-9_]*(SECRET|TOKEN|KEY|PASSWORD|PRIVATE)[A-Z0-9_]*$/.test(n) && /\\s/.test(normalizedValue)) {
    warnings.push('القيمة تحتوي مسافات؛ هذا قد يكون صحيحاً لبعض الأكواد متعددة الكلمات، لكنه يستحق المراجعة.');
  }

  return { name: normalizedName, value: normalizedValue, valid: errors.length === 0, errors, warnings };
}

export function validateSecretInputs(input) {
  const entries = parseSecretInput(input);
  return entries.map(validateSecretEntry);
}

export async function showSecrets(ctx) {
  if (!owner(ctx)) return ctx.editMessageText('🔒 هذه الصفحة متاحة للمالك فقط.');
  const names = getRuntimeSecretNames();
  const lines = [
    '🔐 <b>المتغيرات والأكواد السرية</b>',
    '',
    'يمكنك إضافة <b>أي متغير</b> جديد؛ لا توجد قائمة ثابتة لمزودي الخدمة.',
    'القيم تحفظ مشفّرة ولا يعرضها البوت كاملة مرة أخرى.',
    '',
    names.length
      ? `المحفوظ حالياً: ${names.map((n) => `<code>${n}</code>`).join(' · ')}`
      : 'لا توجد متغيرات سرية محفوظة.',
  ];
  await ctx.editMessageText(lines.join('\\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ إضافة / تعديل', callback_data: 'secret_set' }],
        [{ text: '🔎 فحص متغير', callback_data: 'secret_validate' }],
        [{ text: '🗑 حذف متغير', callback_data: 'secret_delete' }],
        [{ text: '❓ طريقة الإضافة والتحقق', callback_data: 'secret_help' }],
        [{ text: '⬅️ إدارة المنصة', callback_data: 'admin' }],
      ],
    },
  });
}

async function showHelp(ctx) {
  await ctx.editMessageText(
    '❓ <b>طريقة إضافة المتغيرات السرية</b>\\n\\n' +
      '<b>صيغة واحدة:</b>\\n' +
      '<code>NAME=VALUE</code>\\n\\n' +
      '<b>الصيغ المقبولة أيضاً:</b>\\n' +
      '<code>export NAME=VALUE</code>\\n' +
      '<code>NAME = VALUE</code>\\n' +
      '<code>NAME: VALUE</code>\\n' +
      '<code>{"NAME":"VALUE"}</code>\\n' +
      '<code>{"NAME":"VALUE","OTHER":"VALUE"}</code>\\n\\n' +
      'يمكن أن تكون VALUE متعددة الأسطر، وسيتم حفظها كما أرسلتها.\\n\\n' +
      '<b>التحقق:</b>\\n' +
      '① صحة اسم المتغير.\\n' +
      '② عدم فراغ القيمة وحدود الحجم.\\n' +
      '③ فحص صيغة شائعة لمفاتيح Telegram/OpenAI/Gemini/Groq/OpenRouter عند التعرف عليها.\\n' +
      '④ التحذير لا يعني أن المفتاح خاطئ؛ الاختبار الحقيقي يحتاج اتصالاً بخدمة المزود.\\n\\n' +
      '🔒 القيمة السرية لا تظهر في تقرير الفحص.',
    { reply_markup: { inline_keyboard: [[{ text: '⬅️ المتغيرات', callback_data: 'secrets_menu' }]] } },
  );
}

export async function handleSecretCallback(ctx) {
  if (!owner(ctx)) {
    await ctx.answer({ text: 'غير مصرح', show_alert: true });
    return;
  }
  await ctx.answer();

  if (ctx.data === 'secrets_menu') return showSecrets(ctx);
  if (ctx.data === 'secret_help') return showHelp(ctx);

  if (ctx.data === 'secret_set') {
    ctx.userData.secret_waiting = true;
    return ctx.editMessageText(
      '🔐 <b>إضافة / تعديل متغير</b>\\n\\n' +
        'أرسل مثلاً:\\n<code>GEMINI_API_KEY=القيمة</code>\\n\\n' +
        'أو ألصق عدة متغيرات بصيغة JSON.\\n' +
        'سيتم فحص الصيغة قبل الحفظ، ثم حذف رسالة الإدخال.',
      { parse_mode: 'HTML' },
    );
  }

  if (ctx.data === 'secret_validate') {
    ctx.userData.secret_validate_waiting = true;
    return ctx.editMessageText(
      '🔎 أرسل اسم المتغير فقط، مثل:\\n<code>GEMINI_API_KEY</code>\\n\\n' +
        'سيعرض البوت نتيجة التحقق من وجود القيمة وصيغة الاسم فقط، ولن يعرض السر.',
      { parse_mode: 'HTML' },
    );
  }

  if (ctx.data === 'secret_delete') {
    ctx.userData.secret_delete_waiting = true;
    return ctx.editMessageText(
      '🗑 أرسل اسم المتغير فقط، مثل:\\n<code>GEMINI_API_KEY</code>',
      { parse_mode: 'HTML' },
    );
  }
}

async function deleteInputMessage(ctx) {
  if (ctx.message?.message_id && ctx.bot?.deleteMessage) {
    await ctx.bot.deleteMessage(ctx.from.id, ctx.message.message_id).catch(() => {});
  }
}

export async function handleSecretText(ctx) {
  if (!owner(ctx)) return false;
  const text = String(ctx.text ?? '');

  if (ctx.userData.secret_waiting) {
    ctx.userData.secret_waiting = false;
    try {
      const results = validateSecretInputs(text);
      for (const result of results) {
        if (!result.valid) throw new Error(`${result.name}: ${result.errors.join(' ')}`);
      }
      for (const result of results) setRuntimeSecret(result.name, result.value);

      await deleteInputMessage(ctx);
      const report = results.map((r) =>
        `✅ <code>${r.name}</code> — تم الحفظ مشفّراً${r.warnings.length ? `\\n⚠️ ${r.warnings.join(' ')}` : ''}`,
      ).join('\\n');
      await ctx.reply(report + '\\n\\n🔒 القيم نفسها لا تظهر في الرسالة.', { parse_mode: 'HTML' });
    } catch (error) {
      await deleteInputMessage(ctx);
      await ctx.reply(
        `❌ لم يتم الحفظ.\\n\\n${error.message}\\n\\nاستخدم ❓ طريقة الإضافة والتحقق لمعرفة الصيغ المقبولة.`,
        { parse_mode: 'HTML' },
      );
    }
    return true;
  }

  if (ctx.userData.secret_validate_waiting) {
    ctx.userData.secret_validate_waiting = false;
    const name = text.trim().toUpperCase();
    const value = getRuntimeSecret(name);
    const result = validateSecretEntry({ name, value: value ?? '' });
    await deleteInputMessage(ctx);
    if (!value) {
      await ctx.reply(`❌ <code>${name}</code> غير محفوظ أو لا يمكن فك تشفيره.`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(
        `🔎 <b>نتيجة الفحص</b>\\n\\n<code>${name}</code>\\nالحالة: ${result.valid ? '✅ صيغة سليمة' : '❌ غير سليمة'}\\nالقيمة: ${mask(value)}${result.warnings.length ? `\\n\\n⚠️ ${result.warnings.join(' ')}` : ''}\\n\\nملاحظة: الفحص الشكلي لا يثبت أن الخدمة تقبل المفتاح فعلياً.`,
        { parse_mode: 'HTML' },
      );
    }
    return true;
  }

  if (ctx.userData.secret_delete_waiting) {
    ctx.userData.secret_delete_waiting = false;
    try {
      const name = text.trim().toUpperCase();
      deleteRuntimeSecret(name);
      await deleteInputMessage(ctx);
      await ctx.reply(`✅ تم حذف <code>${name}</code> من المخزن والبيئة الحالية.`, { parse_mode: 'HTML' });
    } catch (error) {
      await deleteInputMessage(ctx);
      await ctx.reply(`❌ لم يتم الحذف: ${error.message}`);
    }
    return true;
  }

  return false;
}
