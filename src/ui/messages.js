/**
 * Contact Admin (📬 التواصل مع الإدارة) — student message surface, the student's
 * own history, and the admin inbox/reply flow.
 *
 * Lifecycle: NEW -> IN_REVIEW -> REPLIED -> CLOSED. A CLOSED message can never be
 * replied to again, and an admin reply is delivered to the original student.
 *
 * Callback namespace mirrors the Python reference: `contact`, `msg_cat:<category>`,
 * `msg_cancel`, `msg_mine`, `admin_messages`, `msg_open:<id>`, `msg_reply:<id>`,
 * `msg_status:<id>:<STATUS>`.
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as workflow from '../workflow.js';
import { btn, escHtml, keyboard } from '../telegram/ui.js';

export const CONTACT_WORKFLOW = 'contact_message';
export const REPLY_WORKFLOW = 'admin_reply';

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

function categoryLabel(category) {
  return db.MESSAGE_CATEGORY_LABELS[category] ?? category;
}

function statusLabel(status) {
  return db.MESSAGE_STATUS_LABELS[status] ?? status;
}

/** The platform-configurable contact label, falling back to the default. */
function contactLabel() {
  try {
    const configured = String(db.getPlatformSetting('contact_text') ?? '').trim();
    return configured || 'تواصل مع المنصة';
  } catch {
    return 'تواصل مع المنصة';
  }
}

function contactKeyboard() {
  return keyboard([
    [btn('💬 رسالة', 'msg_cat:message')],
    [btn('📑 طلب ملخص', 'msg_cat:summary')],
    [btn('💡 اقتراح', 'msg_cat:suggestion')],
    [btn('🚩 بلاغ', 'msg_cat:report')],
    [btn('📥 رسائلي', 'msg_mine')],
    [btn('🏠 الرئيسية', 'home')],
  ]);
}

/** Drop any armed contact/reply state, including the workflow claim. */
function clearContactState(ctx) {
  if (!ctx.userData) return;
  delete ctx.userData.contact_category;
  delete ctx.userData.contact_reply_id;
  const active = ctx.userData[workflow.ACTIVE_KEY];
  if (active === CONTACT_WORKFLOW || active === REPLY_WORKFLOW) {
    workflow.clear(ctx);
  }
}

function isAdmin(userId) {
  try {
    return db.isUserAdmin(userId);
  } catch {
    return false;
  }
}

function canHandleMessages(userId) {
  try {
    return db.userHasPermission(userId, 'can_messages');
  } catch {
    return false;
  }
}

/**
 * True when Contact is hidden for this caller (admins bypass).
 *
 * Contact is reachable before the catch-all router, so it needs its own
 * visibility check to honour the platform's hidden-feature setting.
 */
async function contactHiddenFor(ctx) {
  try {
    if (isAdmin(ctx.from.id)) return false;
    if (!db.isFeatureHidden('contact')) return false;
  } catch {
    return false;
  }

  await ctx.editMessageText('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
    reply_markup: homeKeyboard(),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Student side
// ---------------------------------------------------------------------------

/** The contact screen: category chooser. */
export async function showContact(ctx) {
  clearContactState(ctx);
  await ctx.editMessageText(
    `📬 <b>${esc(contactLabel())}</b>\n\n` +
      'اختر نوع الرسالة التي تريد إرسالها.\n' +
      'يمكنك إرسال رسالة، طلب ملخص، اقتراح، أو بلاغ.',
    { reply_markup: contactKeyboard() },
  );
}

/** Arm the message flow for a category. */
export async function armMessage(ctx, category) {
  if (!db.MESSAGE_CATEGORIES.includes(category)) {
    await ctx.editMessageText('⚠️ نوع الرسالة غير مدعوم.', {
      reply_markup: contactKeyboard(),
    });
    return;
  }

  ctx.userData.contact_category = category;
  workflow.begin(ctx, CONTACT_WORKFLOW);

  await ctx.editMessageText(
    `📝 <b>${esc(categoryLabel(category))}</b>\n\n` +
      'اكتب الآن نص الرسالة وأرسله.\n\n' +
      'لإلغاء العملية اضغط ❌ إلغاء أو أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'msg_cancel')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Notify the admins who can act on messages. Best-effort per recipient. */
async function notifyAdminsNewMessage(bot, messageId, category, body, sender) {
  let admins = [];
  try {
    admins = db.getAdminsWithPermission('can_messages');
  } catch {
    return 0;
  }

  const text =
    '📬 <b>رسالة جديدة من طالب</b>\n\n' +
    `🆔 <code>${messageId}</code>\n` +
    `🏷 النوع: ${esc(categoryLabel(category))}\n` +
    `👤 من: ${esc(sender || 'طالب')}\n\n` +
    `📝 ${esc(String(body).slice(0, 400))}\n\n` +
    'افتح لوحة الإدارة للرد.';

  let delivered = 0;
  for (const [adminId] of admins) {
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'HTML' });
      delivered += 1;
    } catch {
      // An unreachable admin must not fail the submission.
    }
  }
  return delivered;
}

/** Consume the typed message body. Returns handled. */
export async function handleMessageText(ctx) {
  const category = ctx.userData?.contact_category;
  if (!category) return false;
  if (ctx.kind !== 'message') return false;

  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    clearContactState(ctx);
    await ctx.reply('❌ تم إلغاء إرسال الرسالة.', { reply_markup: homeKeyboard() });
    return true;
  }

  if (!workflow.owns(ctx, CONTACT_WORKFLOW)) return false;

  let messageId;
  try {
    messageId = db.createMessage(
      ctx.from.id,
      ctx.from.full_name ?? ctx.from.first_name,
      category,
      text,
    );
  } catch (error) {
    // A validation failure keeps the flow armed so the student can retype.
    if (error instanceof db.MessageValidationError) {
      await ctx.reply(error.message);
      return true;
    }
    clearContactState(ctx);
    await ctx.reply('⚠️ تعذر إرسال الرسالة حالياً. لم يتم تأكيد الإرسال.', {
      reply_markup: homeKeyboard(),
    });
    return true;
  }

  clearContactState(ctx);

  await ctx.reply(
    '✅ <b>تم استلام رسالتك.</b>\n\n' +
      `🆔 رقم الرسالة: <code>${messageId}</code>\n` +
      '🏷 الحالة: 🆕 <b>جديدة</b>\n\n' +
      'ستتم مراجعتها من قبل الإدارة، وسيتم إشعارك عند الرد.\n' +
      'يمكنك متابعة الحالة من «📥 رسائلي».',
    {
      reply_markup: keyboard([
        [btn('📥 رسائلي', 'msg_mine')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );

  try {
    const bot = ctx.getBot();
    if (bot?.sendMessage) {
      await notifyAdminsNewMessage(
        bot,
        messageId,
        category,
        text,
        ctx.from.full_name ?? ctx.from.first_name,
      );
    }
  } catch {
    // Admin notification is best-effort.
  }

  return true;
}

/** A student's own messages and their statuses. */
export async function showMyMessages(ctx) {
  let items = [];
  try {
    items = db.getUserMessages(ctx.from.id);
  } catch {
    items = [];
  }

  if (!items.length) {
    await ctx.editMessageText('📥 <b>رسائلي</b>\n\nلم ترسل أي رسالة بعد.', {
      reply_markup: keyboard([
        [btn('📬 التواصل مع الإدارة', 'contact')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  const lines = ['📥 <b>رسائلي</b>', ''];
  for (const item of items) {
    const [messageId, category, body, status, reply] = item;
    lines.push(`🆔 <code>${messageId}</code> — ${esc(statusLabel(status))}`);
    lines.push(`🏷 ${esc(categoryLabel(category))}`);
    lines.push(`📝 ${esc(String(body).slice(0, 200))}`);
    if (reply) lines.push(`↩️ <b>الرد:</b> ${esc(String(reply).slice(0, 300))}`);
    lines.push('');
  }

  await ctx.editMessageText(lines.join('\n'), {
    reply_markup: keyboard([
      [btn('📬 التواصل مع الإدارة', 'contact')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Admin side
// ---------------------------------------------------------------------------

/** Admin inbox listing, optionally filtered by status. */
export async function showMessageInbox(ctx, status = null) {
  if (!isAdmin(ctx.from.id) || !canHandleMessages(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let items = [];
  let openCount = '?';
  try {
    items = db.getMessagesByStatus(status);
    openCount = db.getOpenMessagesCount();
  } catch {
    items = [];
    openCount = '?';
  }

  const rows = [];
  for (const item of items) {
    const [messageId, , userName, , , messageStatus] = item;
    rows.push([
      btn(
        `${statusLabel(messageStatus)} | ${String(userName || 'طالب').slice(0, 18)} | #${messageId}`,
        `msg_open:${messageId}`,
      ),
    ]);
  }
  rows.push([btn('⬅️ Admin', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    '📬 <b>رسائل الطلاب</b>\n\n' +
      `🟢 غير مغلقة: ${openCount}\n` +
      `📦 الإجمالي المعروض: ${items.length}\n\n` +
      'اختر رسالة لعرضها والرد عليها.',
    { reply_markup: keyboard(rows) },
  );
}

/** One message with its reply/status actions. */
export async function showMessage(ctx, messageId) {
  if (!isAdmin(ctx.from.id) || !canHandleMessages(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  clearContactState(ctx);

  let record;
  try {
    record = db.getMessage(messageId);
  } catch {
    record = null;
  }

  if (!record) {
    await ctx.editMessageText('⚠️ الرسالة غير موجودة.', {
      reply_markup: keyboard([
        [btn('📬 الرسائل', 'admin_messages')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  const [id, userId, userName, category, body, status, adminReply, reviewedBy, createdAt] =
    record;

  let text =
    '📬 <b>رسالة طالب</b>\n\n' +
    `🆔 <code>${id}</code>\n` +
    `👤 ${esc(userName || 'طالب')} (<code>${userId}</code>)\n` +
    `🏷 ${esc(categoryLabel(category))}\n` +
    `📊 الحالة: ${esc(statusLabel(status))}\n` +
    `🕒 ${esc(createdAt ?? '')}\n\n` +
    `📝 ${esc(body)}`;

  if (adminReply) text += `\n\n↩️ <b>الرد الحالي:</b> ${esc(adminReply)}`;
  if (reviewedBy) text += `\n👤 بواسطة: <code>${reviewedBy}</code>`;

  await ctx.editMessageText(text, {
    reply_markup: keyboard([
      [btn('✏️ رد', `msg_reply:${id}`)],
      [btn('👀 قيد المراجعة', `msg_status:${id}:IN_REVIEW`)],
      [btn('🔒 إغلاق', `msg_status:${id}:CLOSED`)],
      [btn('⬅️ الرسائل', 'admin_messages')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
}

/** Arm the reply flow: the next typed message is the reply body. */
export async function armReply(ctx, messageId) {
  if (!isAdmin(ctx.from.id) || !canHandleMessages(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let record;
  try {
    record = db.getMessage(messageId);
  } catch {
    record = null;
  }
  if (!record) {
    await ctx.editMessageText('⚠️ الرسالة غير موجودة.', { reply_markup: homeKeyboard() });
    return;
  }
  if (record[5] === 'CLOSED') {
    await ctx.editMessageText('🔒 هذه الرسالة مغلقة ولا يمكن الرد عليها.', {
      reply_markup: keyboard([
        [btn('📬 الرسائل', 'admin_messages')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  workflow.begin(ctx, REPLY_WORKFLOW);
  ctx.userData.contact_reply_id = Number(messageId);

  await ctx.editMessageText(
    '✏️ <b>الرد على الرسالة</b>\n\n' +
      `اكتب نص الرد للرسالة <code>${messageId}</code> وأرسله.\n\n` +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('⬅️ الرسالة', `msg_open:${messageId}`)],
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

  if (!canHandleMessages(ctx.from.id)) {
    clearContactState(ctx);
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    clearContactState(ctx);
    await ctx.reply('❌ تم إلغاء الرد.', { reply_markup: homeKeyboard() });
    return true;
  }

  let result;
  try {
    result = db.replyToMessage(Number(messageId), ctx.from.id, text);
  } catch {
    result = null;
  }

  clearContactState(ctx);

  if (!result) {
    await ctx.reply('ℹ️ تعذر الرد. الرسالة غير موجودة أو مغلقة.', {
      reply_markup: keyboard([
        [btn('📬 الرسائل', 'admin_messages')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return true;
  }

  const [studentId, repliedId] = result;

  await ctx.reply(`✅ تم إرسال الرد على الرسالة <code>${repliedId}</code>.`, {
    reply_markup: keyboard([
      [btn('📬 الرسائل', 'admin_messages')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });

  try {
    const bot = ctx.getBot();
    if (bot?.sendMessage) {
      await bot.sendMessage(
        studentId,
        '📬 <b>رد الإدارة على رسالتك</b>\n\n' +
          `🆔 <code>${repliedId}</code>\n\n` +
          `↩️ ${esc(text)}`,
        { parse_mode: 'HTML' },
      );
    }
  } catch {
    // The reply is stored even if the student cannot be reached.
  }

  await audit.logAction(ctx.from.id, 'message_reply', {
    targetType: 'message',
    targetId: repliedId,
  });

  return true;
}

/** Change a message's status (IN_REVIEW / CLOSED / ...). */
async function changeStatus(ctx, messageId, status) {
  if (!isAdmin(ctx.from.id) || !canHandleMessages(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!db.MESSAGE_STATUSES.includes(status)) {
    await ctx.editMessageText('⚠️ حالة غير معروفة.', { reply_markup: homeKeyboard() });
    return;
  }

  let ok = false;
  try {
    ok = db.setMessageStatus(messageId, status);
  } catch {
    ok = false;
  }

  if (!ok) {
    await ctx.editMessageText('⚠️ تعذر تحديث الحالة.', {
      reply_markup: keyboard([
        [btn('📬 الرسائل', 'admin_messages')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  await audit.logAction(ctx.from.id, 'message_status', {
    targetType: 'message',
    targetId: messageId,
    details: `status=${status}`,
  });

  await showMessage(ctx, messageId);
}

/** Callback handler for the message namespace. */
export async function messagesCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  if (data === 'contact') {
    if (await contactHiddenFor(ctx)) return;
    await showContact(ctx);
    return;
  }

  if (data.startsWith('msg_cat:')) {
    if (await contactHiddenFor(ctx)) return;
    await armMessage(ctx, data.slice('msg_cat:'.length));
    return;
  }

  if (data === 'msg_cancel') {
    await showContact(ctx);
    return;
  }

  if (data === 'msg_mine') {
    clearContactState(ctx);
    await showMyMessages(ctx);
    return;
  }

  if (data === 'admin_messages') {
    clearContactState(ctx);
    await showMessageInbox(ctx, null);
    return;
  }

  if (data.startsWith('msg_open:')) {
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

  if (data.startsWith('msg_status:')) {
    const parts = data.split(':');
    const messageId = Number.parseInt(parts[1], 10);
    const status = parts[2];
    if (Number.isNaN(messageId) || !status) {
      await ctx.editMessageText('⚠️ طلب غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await changeStatus(ctx, messageId, status);
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

// The Python handler pattern also claims `admin_messages`, the student-inbox
// button reachable from the home screen. Without it the tap falls to the
// catch-all. Registered before the generic `admin` route, so it wins.
export const MESSAGE_PREFIXES = ['contact', 'msg_', 'admin_messages'];

/** `/contact` shortcut for the contact screen. */
export async function contactCommand(ctx) {
  clearContactState(ctx);

  try {
    if (!isAdmin(ctx.from.id) && db.isFeatureHidden('contact')) {
      await ctx.reply('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
        reply_markup: homeKeyboard(),
      });
      return;
    }
  } catch {
    // A settings read failure must not block the contact screen.
  }

  await ctx.reply('📬 <b>التواصل مع الإدارة</b>\n\nاختر نوع الرسالة التي تريد إرسالها.', {
    reply_markup: contactKeyboard(),
  });
}
