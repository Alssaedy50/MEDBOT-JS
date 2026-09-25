/**
 * Contact Admin (📬 تواصل مع المنصة) — student message surface and the admin
 * inbox/reply flow.
 *
 * Lifecycle: NEW -> IN_REVIEW -> REPLIED -> CLOSED. A CLOSED message can never
 * be replied to again, and an admin reply is delivered to the original student.
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as workflow from '../workflow.js';
import { btn, escHtml, keyboard } from '../telegram/ui.js';

export const CONTACT_WORKFLOW = 'contact_message';
export const REPLY_WORKFLOW = 'admin_reply';

const CATEGORY_LABELS = Object.freeze({
  suggestion: '💡 اقتراح',
  problem: '⚠️ مشكلة',
  resource: '📚 طلب مورد',
  other: '💬 أخرى',
});

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

function statusLabel(status) {
  return (
    {
      NEW: '🆕 جديد',
      IN_REVIEW: '👀 قيد المراجعة',
      REPLIED: '✅ تم الرد',
      CLOSED: '🔒 مغلق',
    }[status] ?? status
  );
}

/**
 * Student view: the contact menu plus their own message history.
 */
export async function showContact(ctx) {
  let messages = [];
  try {
    messages = db.getUserMessages(ctx.from.id, 10);
  } catch {
    messages = [];
  }

  const lines = [
    '📬 <b>تواصل مع المنصة</b>',
    '',
    'اختر نوع الرسالة ثم أرسل نصها في رسالة واحدة.',
    '',
  ];

  if (messages.length) {
    lines.push('📜 <b>رسائلك السابقة:</b>');
    for (const row of messages) {
      const [messageId, category, , status, reply] = row;
      lines.push(
        `• #${messageId} ${CATEGORY_LABELS[category] ?? category} — ${statusLabel(status)}`,
      );
      if (reply) lines.push(`   ↳ الرد: ${esc(String(reply).slice(0, 80))}`);
    }
  }

  const rows = [
    [btn('💡 اقتراح', 'msg_suggestion')],
    [btn('⚠️ مشكلة', 'msg_problem')],
    [btn('📚 طلب مورد', 'msg_resource')],
    [btn('💬 أخرى', 'msg_other')],
    [btn('🏠 الرئيسية', 'home')],
  ];

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Arm the message flow for a category. */
export async function armMessage(ctx, category) {
  if (!db.MESSAGE_CATEGORIES.includes(category)) {
    await ctx.editMessageText('⚠️ نوع رسالة غير معروف.', { reply_markup: homeKeyboard() });
    return;
  }

  workflow.begin(ctx, CONTACT_WORKFLOW);
  ctx.userData.contact_category = category;

  await ctx.editMessageText(
    `📬 <b>${CATEGORY_LABELS[category] ?? category}</b>\n\n` +
      'أرسل نص رسالتك في رسالة واحدة.\n\n' +
      `ℹ️ الحد الأقصى ${db.MAX_MESSAGE_BODY_LENGTH} حرفاً.\n` +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'contact')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Consume the typed message body. Returns handled. */
export async function handleMessageText(ctx) {
  const category = ctx.userData?.contact_category;
  if (!category) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, CONTACT_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    workflow.clear(ctx);
    delete ctx.userData.contact_category;
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  let messageId;
  try {
    messageId = db.createMessage(
      ctx.from.id,
      ctx.from.full_name ?? ctx.from.first_name,
      category,
      text,
    );
  } catch (error) {
    await ctx.reply(`⚠️ ${error.message}`, { reply_markup: homeKeyboard() });
    return true;
  }

  workflow.clear(ctx);
  delete ctx.userData.contact_category;

  // Notify admins who can handle messages.
  try {
    const recipients = db.getAdminsWithPermission('can_messages');
    const bot = ctx.bot;
    if (bot?.sendMessage) {
      const notification =
        `📬 <b>رسالة جديدة #${messageId}</b>\n\n` +
        `👤 ${esc(ctx.from.full_name ?? ctx.from.first_name)}\n` +
        `🆔 <code>${ctx.from.id}</code>\n` +
        `🏷 ${CATEGORY_LABELS[category] ?? category}\n\n` +
        `${esc(text.slice(0, 300))}`;
      for (const [adminId] of recipients) {
        try {
          await bot.sendMessage(adminId, notification, {
            parse_mode: 'HTML',
            reply_markup: keyboard([[btn('📬 فتح الرسالة', `msg_view:${messageId}`)]]),
          });
        } catch {
          // One unreachable admin must not fail the submission.
        }
      }
    }
  } catch {
    // Admin notification is best-effort.
  }

  await ctx.reply(`✅ تم إرسال رسالتك (#${messageId}). سيتم الرد عليك قريباً.`, {
    reply_markup: keyboard([[btn('📬 تواصل مع المنصة', 'contact')], [btn('🏠 الرئيسية', 'home')]]),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Admin inbox
// ---------------------------------------------------------------------------

function canHandleMessages(userId) {
  try {
    return db.userHasPermission(userId, 'can_messages');
  } catch {
    return false;
  }
}

/** Admin inbox listing, optionally filtered by status. */
export async function showMessageInbox(ctx, status = null) {
  if (!canHandleMessages(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let messages = [];
  let openCount = 0;
  try {
    messages = db.getMessagesByStatus(status, 20);
    openCount = db.getOpenMessagesCount();
  } catch {
    messages = [];
    openCount = 0;
  }

  const lines = [
    '📬 <b>رسائل الطلاب</b>',
    '',
    `🆕 غير مغلقة: ${openCount}`,
    '',
  ];

  if (!messages.length) {
    lines.push('• لا توجد رسائل في هذا العرض.');
  } else {
    for (const row of messages) {
      const [messageId, , userName, category, , messageStatus] = row;
      lines.push(
        `• #${messageId} ${CATEGORY_LABELS[category] ?? category} — ${statusLabel(messageStatus)}\n   👤 ${esc(userName ?? '')}`,
      );
    }
  }

  const rows = [];
  for (const row of messages) {
    const [messageId, , , , , messageStatus] = row;
    rows.push([btn(`#${messageId} · ${statusLabel(messageStatus)}`, `msg_view:${messageId}`)]);
  }
  rows.push([btn('🆕 غير المغلقة', 'msg_open')]);
  rows.push([btn('📋 كل الرسائل', 'msg_all')]);
  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** One message with its reply/close actions. */
export async function showMessage(ctx, messageId) {
  if (!canHandleMessages(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let message;
  try {
    message = db.getMessage(messageId);
  } catch {
    message = null;
  }

  if (!message) {
    await ctx.editMessageText('⚠️ الرسالة غير موجودة.', {
      reply_markup: keyboard([[btn('⬅️ الرسائل', 'msg_open')]]),
    });
    return;
  }

  const [, userId, userName, category, body, status, adminReply, reviewedBy] = message;

  const lines = [
    `📬 <b>رسالة #${messageId}</b>`,
    '',
    `👤 ${esc(userName ?? '')} · 🆔 <code>${userId}</code>`,
    `🏷 ${CATEGORY_LABELS[category] ?? category}`,
    `📊 ${statusLabel(status)}`,
    '',
    esc(body),
  ];

  if (adminReply) {
    lines.push('', '💬 <b>الرد:</b>', esc(adminReply));
  }
  if (reviewedBy) lines.push('', `👤 بواسطة: <code>${reviewedBy}</code>`);

  const rows = [];
  if (status !== 'CLOSED') {
    rows.push([btn('✍️ رد', `msg_reply:${messageId}`)]);
    if (status === 'NEW') rows.push([btn('👀 قيد المراجعة', `msg_review:${messageId}`)]);
    rows.push([btn('🔒 إغلاق', `msg_close:${messageId}`)]);
  }
  rows.push([btn('⬅️ الرسائل', 'msg_open')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Arm the reply flow: the next typed message is the reply body. */
export async function armReply(ctx, messageId) {
  if (!canHandleMessages(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let message;
  try {
    message = db.getMessage(messageId);
  } catch {
    message = null;
  }
  if (!message) {
    await ctx.editMessageText('⚠️ الرسالة غير موجودة.', { reply_markup: homeKeyboard() });
    return;
  }
  if (message[5] === 'CLOSED') {
    await ctx.editMessageText('⚠️ لا يمكن الرد على رسالة مغلقة.', {
      reply_markup: keyboard([[btn('⬅️ الرسالة', `msg_view:${messageId}`)]]),
    });
    return;
  }

  workflow.begin(ctx, REPLY_WORKFLOW);
  ctx.userData.contact_reply_id = messageId;

  await ctx.editMessageText(
    `✍️ <b>الرد على رسالة #${messageId}</b>\n\n` +
      'أرسل نص الرد في رسالة واحدة.\n\n' +
      `ℹ️ الحد الأقصى ${db.MAX_MESSAGE_REPLY_LENGTH} حرفاً.\n` +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', `msg_view:${messageId}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Consume the typed reply body, deliver it to the student. Returns handled. */
export async function handleReplyText(ctx) {
  const messageId = ctx.userData?.contact_reply_id;
  if (!messageId) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, REPLY_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    workflow.clear(ctx);
    delete ctx.userData.contact_reply_id;
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  if (!canHandleMessages(ctx.from.id)) {
    workflow.clear(ctx);
    delete ctx.userData.contact_reply_id;
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  let result;
  try {
    result = db.replyToMessage(messageId, ctx.from.id, text);
  } catch {
    result = null;
  }

  workflow.clear(ctx);
  delete ctx.userData.contact_reply_id;

  if (!result) {
    await ctx.reply('⚠️ تعذّر إرسال الرد (الرسالة مغلقة أو غير موجودة).', {
      reply_markup: keyboard([[btn('⬅️ الرسائل', 'msg_open')]]),
    });
    return true;
  }

  const [studentId] = result;

  await audit.logAction(ctx.from.id, 'message_reply', {
    targetType: 'message',
    targetId: messageId,
  });

  // Deliver the reply to the original student.
  try {
    const bot = ctx.getBot();
    if (bot?.sendMessage) {
      await bot.sendMessage(studentId, `📬 <b>رد إدارة المنصة على رسالتك #${messageId}</b>\n\n${esc(text)}`, {
        parse_mode: 'HTML',
      });
    }
  } catch {
    // The reply is stored even if the student cannot be reached.
  }

  await ctx.reply(`✅ تم إرسال الرد للطالب (#${messageId}).`, {
    reply_markup: keyboard([
      [btn('📬 فتح الرسالة', `msg_view:${messageId}`)],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
  return true;
}

/** Callback handler for the message namespace. */
export async function messagesCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  // Student side.
  if (data === 'contact') {
    await showContact(ctx);
    return;
  }
  if (data.startsWith('msg_') && !data.startsWith('msg_view:') && !data.startsWith('msg_reply:') && !data.startsWith('msg_review:') && !data.startsWith('msg_close:') && data !== 'msg_open' && data !== 'msg_all') {
    const category = data.slice(4);
    if (db.MESSAGE_CATEGORIES.includes(category)) {
      await armMessage(ctx, category);
      return;
    }
  }

  // Admin side.
  if (data === 'msg_open') {
    await showMessageInbox(ctx, null);
    return;
  }
  if (data === 'msg_all') {
    await showMessageInbox(ctx, null);
    return;
  }
  if (data.startsWith('msg_view:')) {
    const messageId = Number.parseInt(data.split(':')[1], 10);
    if (Number.isNaN(messageId)) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await showMessage(ctx, messageId);
    return;
  }
  if (data.startsWith('msg_reply:')) {
    const messageId = Number.parseInt(data.split(':')[1], 10);
    if (Number.isNaN(messageId)) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await armReply(ctx, messageId);
    return;
  }
  if (data.startsWith('msg_review:')) {
    const messageId = Number.parseInt(data.split(':')[1], 10);
    if (!Number.isNaN(messageId) && canHandleMessages(ctx.from.id)) {
      db.setMessageStatus(messageId, 'IN_REVIEW');
      await audit.logAction(ctx.from.id, 'message_status', {
        targetType: 'message',
        targetId: messageId,
        details: 'IN_REVIEW',
      });
    }
    await showMessage(ctx, messageId);
    return;
  }
  if (data.startsWith('msg_close:')) {
    const messageId = Number.parseInt(data.split(':')[1], 10);
    if (!Number.isNaN(messageId) && canHandleMessages(ctx.from.id)) {
      db.setMessageStatus(messageId, 'CLOSED');
      await audit.logAction(ctx.from.id, 'message_status', {
        targetType: 'message',
        targetId: messageId,
        details: 'CLOSED',
      });
    }
    await showMessage(ctx, messageId);
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const MESSAGE_PREFIXES = ['contact', 'msg_'];
