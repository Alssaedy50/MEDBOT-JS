/**
 * Student contributions (📤 مساهمات الطلاب) and the admin review workflow.
 *
 * Student flow: navigate the real hierarchy restricted to folders that accept
 * contributions (or lead somewhere that does), upload media, then supply a
 * title. Submissions land as `pending`.
 *
 * Admin flow: review pending/needs_revision items, approve (which promotes the
 * contribution into the registry as real content), reject with a reason, or
 * send it back for revision. Every decision is audited and reported to the
 * contributor.
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as authorization from '../authorization.js';
import * as workflow from '../workflow.js';
import { btn, escHtml, keyboard, resourceIcon } from '../telegram/ui.js';

export const CONTRIB_WORKFLOW = 'contrib_upload';
export const REVIEW_NOTE_WORKFLOW = 'review_note';

const TYPE_LABELS = Object.freeze({
  document: '📄 مستند',
  audio: '🎧 صوتي',
  video: '🎥 فيديو',
  photo: '🖼 صورة',
});

const STATUS_LABELS = Object.freeze({
  pending: '⏳ قيد المراجعة',
  approved: '✅ مقبول',
  rejected: '❌ مرفوض',
  needs_revision: '🔁 بحاجة لتعديل',
});

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

function isHiddenFor(ctx, feature) {
  try {
    if (db.isUserAdmin(ctx.from.id)) return false;
    return db.isFeatureHidden(feature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Student: submit
// ---------------------------------------------------------------------------

/**
 * Contribution destination picker.
 *
 * Only branches that lead to a folder accepting contributions are offered, so a
 * student can never drill into a dead end looking for an upload target.
 */
export async function showContributionBrowse(ctx, parentId = 0) {
  if (isHiddenFor(ctx, 'contributions')) {
    await ctx.editMessageText('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }

  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
  }

  // Keep only folders that accept contributions OR contain one deeper.
  const usable = [];
  for (const folder of folders) {
    const [folderId] = folder;
    let accepts = false;
    let hasTarget = false;
    try {
      accepts = db.folderAcceptsContributions(folderId);
      hasTarget = accepts ? true : db.folderHasContributionTarget(folderId);
    } catch {
      hasTarget = false;
    }
    if (accepts || hasTarget) usable.push([...folder, accepts]);
  }

  let breadcrumb = 'الرئيسية 🏠';
  if (parentId) {
    try {
      breadcrumb = db.getBreadcrumbs(parentId);
    } catch {
      breadcrumb = String(parentId);
    }
  }

  const lines = [
    '📤 <b>مساهمات الطلاب</b>',
    '',
    `📍 ${esc(breadcrumb)}`,
    '',
    'اختر القسم الذي تريد المساهمة فيه:',
  ];

  if (!usable.length) lines.push('', 'ℹ️ لا توجد أقسام تستقبل مساهمات في هذا المستوى.');

  const rows = [];
  for (const [folderId, name, nodeType, accepts] of usable) {
    if (accepts) {
      rows.push([
        btn(`✅ ${resourceIcon(nodeType)} ${String(name).slice(0, 26)}`, `contrib_folder:${folderId}`),
      ]);
    } else {
      rows.push([
        btn(`📂 ${resourceIcon(nodeType)} ${String(name).slice(0, 26)}`, `contrib_browse:${folderId}`),
      ]);
    }
  }

  if (parentId) {
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `contrib_browse:${parent || 0}`)]);
  }
  rows.push([btn('📄 مساهماتي', 'my_contributions')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Arm the upload flow for a target folder: the next media message is the file. */
export async function armContribution(ctx, folderId) {
  if (isHiddenFor(ctx, 'contributions')) {
    await ctx.editMessageText('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }

  let accepts = false;
  let name = '';
  try {
    accepts = db.folderAcceptsContributions(folderId);
    const folder = db.getFolder(folderId);
    name = folder ? folder[2] : '';
  } catch {
    accepts = false;
  }

  if (!accepts) {
    await ctx.editMessageText('⚠️ هذا القسم لا يستقبل مساهمات.', {
      reply_markup: keyboard([[btn('⬅️ رجوع', `contrib_browse:${folderId}`)]]),
    });
    return;
  }

  workflow.begin(ctx, CONTRIB_WORKFLOW);
  ctx.userData.contrib_folder = folderId;
  ctx.userData.contrib_state = 'await_file';

  await ctx.editMessageText(
    `📤 <b>المساهمة في: ${esc(name)}</b>\n\n` +
      '📎 أرسل الآن الملف الذي تريد المساهمة به (مستند / صوت / فيديو / صورة).\n\n' +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'contribute')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Determine the Telegram media descriptor from a message. */
export function extractMedia(message) {
  if (!message) return null;
  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileType: 'document',
      suggestedTitle: message.document.file_name || 'Document',
    };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      fileType: 'audio',
      suggestedTitle: message.audio.file_name || message.audio.title || 'Audio',
    };
  }
  if (message.voice) return { fileId: message.voice.file_id, fileType: 'audio', suggestedTitle: 'Voice Note' };
  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileType: 'video',
      suggestedTitle: message.video.file_name || 'Video',
    };
  }
  if (message.photo?.length) {
    return { fileId: message.photo[message.photo.length - 1].file_id, fileType: 'photo', suggestedTitle: 'Photo' };
  }
  return null;
}

/**
 * Handle a media message for the contribution flow; then ask for the title.
 *
 * Returns handled.
 */
export async function handleContributionMedia(ctx) {
  const folderId = ctx.userData?.contrib_folder;
  if (!folderId) return false;
  if (ctx.userData.contrib_state !== 'await_file') return false;
  if (!workflow.owns(ctx, CONTRIB_WORKFLOW)) return false;

  const media = extractMedia(ctx.message);
  if (!media) return false;

  ctx.userData.contrib_file_id = media.fileId;
  ctx.userData.contrib_file_type = media.fileType;
  ctx.userData.contrib_state = 'await_title';
  workflow.begin(ctx, CONTRIB_WORKFLOW);

  await ctx.reply(
    '📄 الملف مستلم.\n\n' +
      '✍️ أرسل الآن عنوان المورد (اسم واضح ومحدد).\n\n' +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'contribute')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
  return true;
}

/** Consume the title and register the contribution. Returns handled. */
export async function handleContributionText(ctx) {
  const folderId = ctx.userData?.contrib_folder;
  if (!folderId) return false;
  if (ctx.kind !== 'message') return false;
  if (ctx.userData.contrib_state !== 'await_title') return false;
  if (!workflow.owns(ctx, CONTRIB_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    workflow.clear(ctx);
    delete ctx.userData.contrib_folder;
    delete ctx.userData.contrib_file_id;
    delete ctx.userData.contrib_file_type;
    delete ctx.userData.contrib_state;
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  const fileId = ctx.userData.contrib_file_id;
  const fileType = ctx.userData.contrib_file_type;

  let contributionId;
  try {
    contributionId = db.addContribution(
      ctx.from.id,
      ctx.from.full_name ?? ctx.from.first_name,
      folderId,
      text,
      fileId,
      fileType,
    );
  } catch (error) {
    await ctx.reply(`⚠️ ${error.message}`, { reply_markup: homeKeyboard() });
    return true;
  }

  const folderName = (() => {
    try {
      const folder = db.getFolder(folderId);
      return folder ? folder[2] : '';
    } catch {
      return '';
    }
  })();

  workflow.clear(ctx);
  delete ctx.userData.contrib_folder;
  delete ctx.userData.contrib_file_id;
  delete ctx.userData.contrib_file_type;
  delete ctx.userData.contrib_state;

  // Notify reviewers who hold contribution.review.
  try {
    const bot = ctx.bot;
    if (bot?.sendMessage) {
      const recipients = db.getAdminsWithPermission('can_contributions');
      const notification =
        `📥 <b>مساهمة جديدة #${contributionId}</b>\n\n` +
        `👤 ${esc(ctx.from.full_name ?? ctx.from.first_name)}\n` +
        `📄 ${esc(text)}\n` +
        `🗂 ${esc(folderName)}\n` +
        `📎 ${TYPE_LABELS[fileType] ?? fileType}`;
      for (const [adminId] of recipients) {
        try {
          await bot.sendMessage(adminId, notification, {
            parse_mode: 'HTML',
            reply_markup: keyboard([[btn('🔎 مراجعة', `review:${contributionId}`)]]),
          });
        } catch {
          // One unreachable admin must not fail the submission.
        }
      }
    }
  } catch {
    // Admin notification is best-effort.
  }

  await ctx.reply(
    `✅ تم إرسال مساهمتك (#${contributionId}) للمراجعة.\n\n` +
      `📄 ${esc(text)}\n🗂 ${esc(folderName)}`,
    {
      reply_markup: keyboard([
        [btn('📄 مساهماتي', 'my_contributions')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
  return true;
}

/** Student: own contribution history with real destination paths. */
export async function showMyContributions(ctx) {
  if (isHiddenFor(ctx, 'my_contributions')) {
    await ctx.editMessageText('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }

  let rowsData = [];
  try {
    rowsData = db.getUserContributions(ctx.from.id, 20);
  } catch {
    rowsData = [];
  }

  const lines = ['📄 <b>مساهماتي</b>', ''];

  if (!rowsData.length) {
    lines.push('ℹ️ لا توجد مساهمات بعد.');
  } else {
    for (const row of rowsData) {
      const [contributionId, title, fileType, status, , rejectionReason, reviewNote, , path] = row;
      lines.push(
        `• #${contributionId} ${TYPE_LABELS[fileType] ?? fileType} ${esc(title)}\n` +
          `   📊 ${STATUS_LABELS[status] ?? status}`,
      );
      if (path) lines.push(`   📍 ${esc(path)}`);
      if (rejectionReason) lines.push(`   ❌ ${esc(rejectionReason)}`);
      if (reviewNote) lines.push(`   🔁 ${esc(reviewNote)}`);
    }
  }

  const rows = [];
  for (const row of rowsData) {
    const [contributionId, title, , status] = row;
    if (status === 'needs_revision') {
      rows.push([btn(`🔁 إعادة إرسال #${contributionId}`, `resubmit:${contributionId}`)]);
    } else {
      rows.push([
        btn(`#${contributionId} · ${STATUS_LABELS[status] ?? status} · ${String(title).slice(0, 18)}`, 'noop'),
      ]);
    }
  }
  rows.push([btn('📤 مساهمة جديدة', 'contribute')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Arm a resubmission: the next media message replaces the file. */
export async function armResubmit(ctx, contributionId) {
  let contribution;
  try {
    contribution = db.getContribution(contributionId);
  } catch {
    contribution = null;
  }

  if (!contribution) {
    await ctx.editMessageText('⚠️ المساهمة غير موجودة.', { reply_markup: homeKeyboard() });
    return;
  }
  if (Number(contribution[1]) !== Number(ctx.from.id)) {
    await ctx.editMessageText('🔒 يمكن لصاحب المساهمة فقط إعادة إرسالها.', {
      reply_markup: homeKeyboard(),
    });
    return;
  }
  if (contribution[7] !== 'needs_revision') {
    await ctx.editMessageText('ℹ️ هذه المساهمة ليست بحاجة إلى تعديل.', {
      reply_markup: keyboard([[btn('⬅️ مساهماتي', 'my_contributions')]]),
    });
    return;
  }

  workflow.begin(ctx, CONTRIB_WORKFLOW);
  ctx.userData.contrib_resubmit_id = contributionId;
  ctx.userData.contrib_state = 'resubmit_file';

  await ctx.editMessageText(
    `🔁 <b>إعادة إرسال المساهمة #${contributionId}</b>\n\n` +
      '📎 أرسل الملف الجديد، ثم أرسل العنوان بعد ذلك.\n\n' +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'my_contributions')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Handle the resubmission media (then a title). Returns handled. */
export async function handleResubmitMedia(ctx) {
  if (ctx.userData?.contrib_state !== 'resubmit_file') return false;
  if (!workflow.owns(ctx, CONTRIB_WORKFLOW)) return false;

  const media = extractMedia(ctx.message);
  if (!media) return false;

  ctx.userData.contrib_resubmit_file_id = media.fileId;
  ctx.userData.contrib_resubmit_file_type = media.fileType;
  ctx.userData.contrib_state = 'resubmit_title';
  workflow.begin(ctx, CONTRIB_WORKFLOW);

  await ctx.reply('✍️ أرسل الآن العنوان الجديد.', {
    reply_markup: keyboard([
      [btn('❌ إلغاء', 'my_contributions')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
  return true;
}

/** Consume the resubmission title and apply it. Returns handled. */
export async function handleResubmitText(ctx) {
  if (ctx.userData?.contrib_state !== 'resubmit_title') return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, CONTRIB_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();
  if (text === '/cancel') {
    workflow.clear(ctx);
    for (const key of [
      'contrib_resubmit_id',
      'contrib_resubmit_file_id',
      'contrib_resubmit_file_type',
      'contrib_state',
    ]) {
      delete ctx.userData[key];
    }
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  const contributionId = ctx.userData.contrib_resubmit_id;
  const fileId = ctx.userData.contrib_resubmit_file_id;
  const fileType = ctx.userData.contrib_resubmit_file_type;

  let result;
  try {
    result = db.resubmitContribution(contributionId, ctx.from.id, text, fileId, fileType);
  } catch {
    result = [false, '⚠️ تعذّر إعادة الإرسال.'];
  }

  workflow.clear(ctx);
  for (const key of [
    'contrib_resubmit_id',
    'contrib_resubmit_file_id',
    'contrib_resubmit_file_type',
    'contrib_state',
  ]) {
    delete ctx.userData[key];
  }

  const [ok, message] = result;
  if (!ok) {
    await ctx.reply(message, { reply_markup: keyboard([[btn('📄 مساهماتي', 'my_contributions')]]) });
    return true;
  }

  await ctx.reply(`✅ تم إعادة إرسال المساهمة (#${contributionId}) للمراجعة.`, {
    reply_markup: keyboard([
      [btn('📄 مساهماتي', 'my_contributions')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Admin: review
// ---------------------------------------------------------------------------

function canReview(userId) {
  try {
    return db.userHasPermission(userId, 'can_contributions');
  } catch {
    return false;
  }
}

/** Review queue: pending + needs_revision, scoped when the admin is restricted. */
export async function showPendingContributions(ctx) {
  if (!canReview(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let rowsData = [];
  try {
    rowsData = db.getReviewableContributionsList();
  } catch {
    rowsData = [];
  }

  const scopedIds = authorization.isScopeRestricted(ctx.from.id);

  const lines = ['📥 <b>مراجعة المساهمات</b>', ''];
  const rows = [];

  for (const row of rowsData) {
    const [contributionId, , userName, title, , fileType, folderId, status] = row;

    // A scope-restricted admin only sees contributions inside their scope.
    if (scopedIds && !authorization.can(ctx.from.id, 'contribution.review', 'contribution', contributionId)) {
      continue;
    }

    let path = '';
    try {
      path = db.getBreadcrumbs(folderId);
    } catch {
      path = '';
    }

    lines.push(
      `• #${contributionId} ${TYPE_LABELS[fileType] ?? fileType} ${esc(title)}\n` +
        `   👤 ${esc(userName ?? '')} · 📊 ${STATUS_LABELS[status] ?? status}` +
        (path ? `\n   📍 ${esc(path)}` : ''),
    );
    rows.push([btn(`#${contributionId} · ${String(title).slice(0, 24)}`, `review:${contributionId}`)]);
  }

  if (!rows.length) lines.push('ℹ️ لا توجد مساهمات بانتظار المراجعة.');

  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** One contribution in review: preview media + the four decisions. */
export async function showContributionPreview(ctx, contributionId) {
  if (!canReview(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let contribution;
  try {
    contribution = db.getContribution(contributionId);
  } catch {
    contribution = null;
  }

  if (!contribution) {
    await ctx.editMessageText('⚠️ المساهمة غير موجودة.', {
      reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')]]),
    });
    return;
  }

  if (!authorization.can(ctx.from.id, 'contribution.review', 'contribution', contributionId)) {
    await ctx.editMessageText('🚫 هذه المساهمة خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')]]),
    });
    return;
  }

  const [id, userId, userName, folderId, title, fileId, fileType, status, , , reviewNote, rejectionReason] =
    contribution;

  let path = '';
  try {
    const folder = db.getFolder(folderId);
    path = folder ? db.getBreadcrumbs(folderId) : '';
  } catch {
    path = '';
  }

  const lines = [
    `🔍 <b>مراجعة المساهمة #${id}</b>`,
    '',
    `👤 ${esc(userName ?? '')} · 🆔 <code>${userId}</code>`,
    `📄 ${esc(title)}`,
    `📎 ${TYPE_LABELS[fileType] ?? fileType}`,
    `🧭 ${esc(path)}`,
    `📊 ${STATUS_LABELS[status] ?? status}`,
  ];
  if (rejectionReason) lines.push(`❌ سبب الرفض السابق: ${esc(rejectionReason)}`);
  if (reviewNote) lines.push(`🔁 ملاحظة التعديل: ${esc(reviewNote)}`);

  const rows = [];
  if (['pending', 'needs_revision'].includes(status)) {
    rows.push([btn('✅ قبول', `approve:${id}`)]);
    rows.push([btn('❌ رفض', `reject:${id}`)]);
    rows.push([btn('🔁 طلب تعديل', `revise:${id}`)]);
  }
  rows.push([btn('👁 معاينة الملف', `preview:${id}`)]);
  rows.push([btn('⬅️ المساهمات', 'admin_pending')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  // Deliver the media to the reviewer so they can see what they are judging.
  if (fileId && ctx.bot) {
    try {
      const caption = `📎 <b>${esc(title)}</b>`;
      if (fileType === 'photo') {
        await ctx.bot.sendPhoto(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
      } else if (fileType === 'video') {
        await ctx.bot.sendVideo(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
      } else if (fileType === 'audio') {
        await ctx.bot.sendAudio(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
      } else {
        await ctx.bot.sendDocument(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
      }
    } catch {
      lines.push('', '⚠️ تعذّر إرسال الملف من Telegram.');
    }
  }

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Preview the submitted media without changing the contribution's status. */
export async function previewContribution(ctx, contributionId) {
  let contribution;
  try {
    contribution = db.getContribution(contributionId);
  } catch {
    contribution = null;
  }
  if (!contribution || !canReview(ctx.from.id)) {
    await ctx.editMessageText('⚠️ المساهمة غير موجودة أو تمت معالجتها.', {
      reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')]]),
    });
    return;
  }
  if (!authorization.can(ctx.from.id, 'contribution.review', 'contribution', contributionId)) {
    await ctx.editMessageText('🚫 هذه المساهمة خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')]]),
    });
    return;
  }

  const [, , userName, , title, fileId, fileType] = contribution;
  const bot = ctx.getBot();
  const caption = `👁 <b>${esc(title)}</b>\n👤 ${esc(userName ?? '')}\n📎 ${TYPE_LABELS[fileType] ?? fileType}`;

  try {
    if (!fileId) throw new Error('no file');
    if (fileType === 'photo') {
      await bot.sendPhoto(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
    } else if (fileType === 'video') {
      await bot.sendVideo(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
    } else if (fileType === 'audio') {
      await bot.sendAudio(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
    } else {
      await bot.sendDocument(ctx.from.id, fileId, { caption, parse_mode: 'HTML' });
    }
  } catch {
    await ctx.reply('⚠️ لا يوجد ملف مرفق أو تعذّر إرساله.', {
      reply_markup: keyboard([[btn('⬅️ المساهمة', `review:${contributionId}`)]]),
    });
    return;
  }

  await ctx.reply('⬆️ هذه هي المساهمة كما وصلت. لم تتغيّر حالتها.', {
    reply_markup: keyboard([[btn('⬅️ المساهمة', `review:${contributionId}`)]]),
  });
}

/** Approve: promote the contribution into the real registry, then notify. */
export async function approveContribution(ctx, contributionId) {
  if (!authorization.can(ctx.from.id, 'contribution.review', 'contribution', contributionId)) {
    await ctx.editMessageText('🚫 هذه المساهمة خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')]]),
    });
    return;
  }

  let result;
  try {
    result = db.approveContribution(contributionId, ctx.from.id);
  } catch {
    result = null;
  }

  if (!result) {
    await ctx.editMessageText('⚠️ المساهمة غير موجودة أو تمت معالجتها بالفعل.', {
      reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')]]),
    });
    return;
  }

  const [folderId, title, , , userId, contentId] = result;

  await audit.logAction(ctx.from.id, 'contribution_approve', {
    targetType: 'contribution',
    targetId: contributionId,
    details: `content=${contentId}`,
  });

  // The approved contribution is now a real resource: generate its Section News.
  try {
    const newsUi = await import('./news.js');
    await newsUi.publishNewsForResource(ctx.getBot(), contentId, ctx.from.id);
  } catch {
    // News generation is best-effort.
  }

  // Mirror the newly approved resource to the Emergency Archive. Best-effort:
  // a publication problem never fails the approval.
  try {
    const { publishResource } = await import('../archive.js');
    await publishResource(ctx.getBot(), contentId, true);
  } catch {
    // Archive mirroring is best-effort.
  }

  // Tell the contributor.
  try {
    const bot = ctx.getBot();
    if (bot?.sendMessage) {
      await bot.sendMessage(
        userId,
        `✅ <b>تم قبول مساهمتك</b>\n\n📄 ${esc(title)}\n\n` +
          'أصبحت الآن مورداً متاحاً في المنصة. شكراً لك!',
        { parse_mode: 'HTML', reply_markup: keyboard([[btn('🗂 فتح القسم', `folder:${folderId}`)]]) },
      );
    }
  } catch {
    // Notification is best-effort.
  }

  await ctx.editMessageText(`✅ تم قبول المساهمة #${contributionId} وإضافتها كمورد.`, {
    reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')], [btn('🏠 الرئيسية', 'home')]]),
  });
}

/**
 * Arm the reject/revise note flow.
 *
 * Exported because both the `reject:<id>` and `revise:<id>` callbacks are
 * legitimate entry points into the same "collect a note, then decide" step.
 */
export async function decideRejectOrRevise(ctx, contributionId, kind) {
  if (!authorization.can(ctx.from.id, 'contribution.review', 'contribution', contributionId)) {
    await ctx.editMessageText('🚫 هذه المساهمة خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')]]),
    });
    return;
  }

  workflow.begin(ctx, REVIEW_NOTE_WORKFLOW);
  ctx.userData.review_note_kind = kind;
  ctx.userData.review_note_id = contributionId;

  await ctx.editMessageText(
    `${kind === 'reject' ? '❌ رفض' : '🔁 طلب تعديل'} المساهمة #${contributionId}\n\n` +
      'أرسل السبب/الملاحظة في رسالة واحدة، أو أرسل /skip لبدون ملاحظة.\n\n' +
      'لإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', `review:${contributionId}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/** Consume the reject/revise note and apply the decision. Returns handled. */
export async function handleReviewNoteText(ctx) {
  const kind = ctx.userData?.review_note_kind;
  if (!kind) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, REVIEW_NOTE_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();
  const contributionId = ctx.userData.review_note_id;

  if (text === '/cancel') {
    workflow.clear(ctx);
    delete ctx.userData.review_note_kind;
    delete ctx.userData.review_note_id;
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  const note = text === '/skip' ? null : text;

  workflow.clear(ctx);
  delete ctx.userData.review_note_kind;
  delete ctx.userData.review_note_id;

  const rejecting = kind === 'reject';
  let result;
  try {
    result = rejecting
      ? db.rejectContribution(contributionId, ctx.from.id, note)
      : db.requestContributionRevision(contributionId, ctx.from.id, note);
  } catch {
    result = null;
  }

  if (!result) {
    await ctx.reply('⚠️ المساهمة غير موجودة أو تمت معالجتها بالفعل.', {
      reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')]]),
    });
    return true;
  }

  const [userId] = result;

  await audit.logAction(
    ctx.from.id,
    rejecting ? 'contribution_reject' : 'contribution_revise',
    { targetType: 'contribution', targetId: contributionId, details: note ?? '' },
  );

  try {
    const bot = ctx.getBot();
    if (bot?.sendMessage) {
      const header = rejecting ? '❌ تم رفض مساهمتك' : '🔁 مساهمتك بحاجة إلى تعديل';
      const hint = rejecting
        ? 'يمكنك مراجعة سبب الرفض في 📄 مساهماتي.'
        : 'يرجى إعادة إرسالها عبر 📄 مساهماتي.';
      await bot.sendMessage(userId, `${header}\n\n${note ? `${esc(note)}\n\n` : ''}${hint}`, {
        parse_mode: 'HTML',
        reply_markup: keyboard([[btn('📄 مساهماتي', 'my_contributions')]]),
      });
    }
  } catch {
    // Notification is best-effort.
  }

  await ctx.reply(`✅ تم تحديث المساهمة #${contributionId}.`, {
    reply_markup: keyboard([[btn('⬅️ المساهمات', 'admin_pending')], [btn('🏠 الرئيسية', 'home')]]),
  });
  return true;
}

/** Callback handler for both the student and admin contribution namespaces. */
export async function contributionsCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  // ---- Student ---------------------------------------------------
  if (data === 'contribute') {
    await showContributionBrowse(ctx);
    return;
  }
  if (data.startsWith('contrib_browse:')) {
    await showContributionBrowse(ctx, Number.parseInt(data.split(':')[1], 10) || 0);
    return;
  }
  if (data.startsWith('contrib_folder:')) {
    await armContribution(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data === 'my_contributions') {
    await showMyContributions(ctx);
    return;
  }
  if (data.startsWith('resubmit:')) {
    await armResubmit(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }

  // ---- Admin -----------------------------------------------------
  if (data === 'admin_pending') {
    await showPendingContributions(ctx);
    return;
  }
  if (data.startsWith('review:')) {
    await showContributionPreview(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('preview:')) {
    await previewContribution(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('approve:')) {
    await approveContribution(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('reject:')) {
    await decideRejectOrRevise(ctx, Number.parseInt(data.split(':')[1], 10), 'reject');
    return;
  }
  if (data.startsWith('revise:')) {
    await decideRejectOrRevise(ctx, Number.parseInt(data.split(':')[1], 10), 'revise');
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const CONTRIBUTION_PREFIXES = [
  'contribute',
  'contrib_browse:',
  'contrib_folder:',
  'my_contributions',
  'resubmit:',
  'admin_pending',
  'review:',
  'preview:',
  'approve:',
  'reject:',
  'revise:',
];
