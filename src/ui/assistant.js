/**
 * Student AI assistant surface.
 *
 * The two modes are explicit here — the student picks either "🔎 بحث في موارد
 * المنصة" (registry search) or "🤖 اسأل المساعد الذكي" (AI chat) — so a
 * navigation question is never answered from the model's own idea of a medical
 * curriculum, and a medical question never leaks platform structure.
 *
 * The per-user daily allowance is consumed before generation, so a rate-limited
 * student cannot burn provider quota.
 */

import * as db from '../db/index.js';
import * as ai from '../ai/index.js';
import * as i18n from '../i18n.js';
import * as workflow from '../workflow.js';
import { btn, escHtml, keyboard } from '../telegram/ui.js';

const AI_DAILY_LIMIT = 20;
export const ASSISTANT_WORKFLOW = 'ai_chat';

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

async function lang(userId) {
  try {
    return db.getUserLanguage(userId);
  } catch {
    return i18n.DEFAULT_LANGUAGE;
  }
}

/** True when the assistant is hidden for this caller (admins bypass). */
async function assistantHiddenFor(ctx) {
  try {
    if (db.isUserAdmin(ctx.from.id)) return false;
    if (!db.isFeatureHidden('assistant')) return false;
  } catch {
    return false;
  }

  await ctx.editMessageText('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
    reply_markup: homeKeyboard(),
  });
  return true;
}

/** The assistant menu: pick a mode. */
export async function showAssistantMenu(ctx) {
  await ctx.editMessageText(
    '🤖 <b>المساعد الذكي</b>\n\n' +
      '🔎 <b>بحث في موارد المنصة</b>\n' +
      'للعثور على قسم أو مورد مسجّل فعلاً في MEDBOT والوصول إليه مباشرة.\n\n' +
      '🤖 <b>اسأل المساعد الذكي</b>\n' +
      'لأسئلة علمية أو عامة. الإجابات العلمية تُدعم بمصادر NCBI PubMed عند توفرها.\n\n' +
      'ℹ️ هذا المساعد ليس بديلاً عن الطبيب ولا يقدّم تشخيصاً شخصياً.',
    {
      reply_markup: keyboard([
        [btn('🔎 بحث في موارد المنصة', 'ai_search')],
        [btn('🤖 اسأل المساعد الذكي', 'ai_chat')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

function modePrompt(mode) {
  if (mode === 'search') {
    return (
      '🔎 <b>بحث في موارد المنصة</b>\n\n' +
      'اكتب اسم المادة أو القسم أو المورد الذي تبحث عنه.\n\n' +
      'مثال: CBC · فسيولوجيا · ملخصات السنة الثانية\n\n' +
      'لإلغاء العملية أرسل /cancel.'
    );
  }
  return (
    '🤖 <b>اسأل المساعد الذكي</b>\n\n' +
    'اكتب سؤالك العلمي أو العام.\n\n' +
    'ℹ️ السؤال الطبي يُجاب بإجابة أكاديمية إنجليزية ثم شرح عربي موجز، ' +
    'مع مصادر PubMed عند توفرها. المساعد لا يغني عن تقييم الطبيب.\n\n' +
    'لإلغاء العملية أرسل /cancel.'
  );
}

/** Arm the assistant workflow and prompt for the query. */
export async function armAssistant(ctx, mode) {
  workflow.begin(ctx, ASSISTANT_WORKFLOW);
  ctx.userData.ai_mode = mode;

  await ctx.editMessageText(modePrompt(mode), {
    reply_markup: keyboard([[btn('❌ إلغاء', 'assistant')], [btn('🏠 الرئيسية', 'home')]]),
  });
}

/** The armed mode ('search' | 'chat'), or '' when idle. */
export function assistantMode(ctx) {
  const mode = ctx.userData?.ai_mode;
  return mode === 'search' || mode === 'chat' ? mode : '';
}

/**
 * Consume the typed query, enforce the daily allowance, then answer.
 *
 * Returns handled. The allowance is checked *before* generation so a limited
 * student never consumes provider quota.
 */
export async function handleAssistantText(ctx) {
  const mode = assistantMode(ctx);
  if (!mode) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, ASSISTANT_WORKFLOW)) return false;

  const userId = ctx.from.id;
  const language = await lang(userId);
  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    workflow.clear(ctx);
    delete ctx.userData.ai_mode;
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }

  if (!text) return false;

  // Consume one request from today's allowance.
  let allowed = false;
  let remaining = 0;
  try {
    [allowed, remaining] = db.checkAndIncrementQuota(userId, AI_DAILY_LIMIT);
  } catch {
    allowed = true;
    remaining = 0;
  }

  if (!allowed) {
    await ctx.reply(
      '⛔ استهلكت الحد اليومي لاستخدام المساعد الذكي.\n' +
        `يمكنك المحاولة مجدداً غداً. (الحد: ${AI_DAILY_LIMIT} طلب/يوم)`,
      { reply_markup: homeKeyboard() },
    );
    return true;
  }

  await ctx.reply('⏳ جارٍ المعالجة...');

  let result;
  try {
    result =
      mode === 'search'
        ? await ai.generatePlatformSearchResult(text, userId)
        : await ai.generateAiChatResult(text, userId);
  } catch {
    result = { text: '⚠️ تعذّر الوصول إلى خدمة الذكاء الاصطناعي حالياً.', actions: [] };
  }

  const rows = [];
  for (const action of result.actions ?? []) {
    rows.push([btn(action.label, action.callback)]);
  }
  rows.push([btn('🔁 سؤال آخر', `ai_${mode}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  const footer = `\n\n────────\n🤖 المتبقي اليوم: ${Math.max(0, remaining)}`;
  await ctx.reply(`${result.text ?? ''}${footer}`, { reply_markup: keyboard(rows) });

  // Re-arm so a follow-up message hits the same mode.
  workflow.begin(ctx, ASSISTANT_WORKFLOW);
  return true;
}

/** Callback handler for the assistant namespace. */
export async function assistantCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  if (data === 'assistant') {
    if (await assistantHiddenFor(ctx)) return;
    await showAssistantMenu(ctx);
    return;
  }

  if (data === 'ai_search' || data === 'ai_chat') {
    if (await assistantHiddenFor(ctx)) return;
    await armAssistant(ctx, data === 'ai_search' ? 'search' : 'chat');
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const ASSISTANT_PREFIXES = ['assistant', 'ai_search', 'ai_chat'];
