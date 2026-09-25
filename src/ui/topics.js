/**
 * Search Topics (🧭 المواضيع) — student browse + admin management.
 *
 * A topic is a curated entry point that connects to registered folders, so it
 * never duplicates the hierarchy. Deleting a topic or a folder only removes link
 * rows; the folders and their resources are untouched.
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as workflow from '../workflow.js';
import { btn, escHtml, keyboard, resourceIcon } from '../telegram/ui.js';

export const TOPIC_CREATE_WORKFLOW = 'topics_create';
export const TOPIC_LINK_WORKFLOW = 'topics_link';

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

// ---------------------------------------------------------------------------
// Student browse
// ---------------------------------------------------------------------------

/** Topics list with real registered resource counts. */
export async function showTopics(ctx) {
  let topics = [];
  try {
    topics = db.getTopics(true);
  } catch {
    topics = [];
  }

  const lines = ['🧭 <b>مواضيع البحث</b>', ''];

  if (!topics.length) {
    lines.push('ℹ️ لا توجد مواضيع مسجلة حالياً.');
  } else {
    lines.push('اختر موضوعاً للوصول السريع إلى الموارد المسجّلة:', '');
    for (const topic of topics) {
      lines.push(`${topic.icon} <b>${esc(topic.name)}</b> — ${db.topicResourceCount(topic.id)} مورد`);
    }
  }

  const rows = [];
  for (const topic of topics) {
    rows.push([btn(`${topic.icon} ${String(topic.name).slice(0, 32)}`, `topic_open:${topic.id}`)]);
  }
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** One topic: its linked real sections. */
export async function showTopic(ctx, topicId) {
  let topic;
  try {
    topic = db.getTopic(topicId);
  } catch {
    topic = null;
  }

  if (!topic || !topic.active) {
    await ctx.editMessageText('⚠️ الموضوع غير متاح.', {
      reply_markup: keyboard([[btn('⬅️ المواضيع', 'topics')]]),
    });
    return;
  }

  let folders = [];
  try {
    folders = db.getTopicFolders(topicId);
  } catch {
    folders = [];
  }

  const lines = [`${topic.icon} <b>${esc(topic.name)}</b>`];
  if (topic.description) lines.push('', esc(topic.description));
  lines.push('', folders.length ? 'اختر القسم الذي تريد فتحه:' : 'ℹ️ لا توجد أقسام مرتبطة بهذا الموضوع بعد.');

  const rows = [];
  for (const [folderId, name, nodeType] of folders) {
    rows.push([btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 32)}`, `folder:${folderId}`)]);
  }
  rows.push([btn('⬅️ المواضيع', 'topics')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

// ---------------------------------------------------------------------------
// Admin management
// ---------------------------------------------------------------------------

function canManageTopics(userId) {
  try {
    return db.userHasPermission(userId, 'can_topics');
  } catch {
    return false;
  }
}

/** Admin topic manager. */
export async function showTopicManager(ctx) {
  if (!canManageTopics(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let topics = [];
  try {
    topics = db.getTopics(false);
  } catch {
    topics = [];
  }

  const lines = [
    '🧭 <b>إدارة مواضيع البحث</b>',
    '',
    'الموضوع نقطة دخول مرتبطة بأقسام حقيقية في المنصة — لا ينسخ الشجرة.',
    '',
  ];

  if (!topics.length) lines.push('• لا توجد مواضيع بعد.');

  const rows = [];
  for (const topic of topics) {
    const mark = topic.active ? '👁' : '🙈';
    lines.push(
      `${mark} ${topic.icon} <b>${esc(topic.name)}</b> — ${db.topicResourceCount(topic.id)} مورد`,
    );
    rows.push([btn(`${mark} ${topic.icon} ${String(topic.name).slice(0, 24)}`, `topic_mgr:${topic.id}`)]);
  }

  rows.push([btn('➕ موضوع جديد', 'topic_new')]);
  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** One topic's admin detail. */
export async function showTopicAdmin(ctx, topicId) {
  if (!canManageTopics(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let topic;
  try {
    topic = db.getTopic(topicId);
  } catch {
    topic = null;
  }
  if (!topic) {
    await ctx.editMessageText('⚠️ الموضوع غير موجود.', { reply_markup: keyboard([[btn('⬅️ المواضيع', 'admin_topics')]]) });
    return;
  }

  let count = 0;
  try {
    count = db.topicResourceCount(topicId);
  } catch {
    count = 0;
  }

  const rows = [
    [btn(topic.active ? '🙈 تعطيل' : '👁 تفعيل', `topic_toggle:${topicId}`)],
    [btn('🔗 ربط قسم', `topic_link_start:${topicId}`)],
    [btn('👁 عرض كطالب', `topic_open:${topicId}`)],
    [btn('🗑 حذف', `topic_delete:${topicId}`)],
    [btn('⬅️ المواضيع', 'admin_topics')],
    [btn('🏠 الرئيسية', 'home')],
  ];

  await ctx.editMessageText(
    `${topic.icon} <b>${esc(topic.name)}</b>\n\n` +
      (topic.description ? `${esc(topic.description)}\n\n` : '') +
      `📊 ${count} مورد مسجّل مرتبط\n` +
      `👁 ${topic.active ? 'مُفعّل' : 'مُعطّل'}`,
    { reply_markup: keyboard(rows) },
  );
}

/** Arm topic creation: the next typed message is the name. */
export async function armTopicCreate(ctx) {
  if (!canManageTopics(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  workflow.begin(ctx, TOPIC_CREATE_WORKFLOW);
  await ctx.editMessageText(
    '➕ <b>موضوع جديد</b>\n\nأرسل اسم الموضوع في رسالة واحدة.\n\nلإلغاء العملية أرسل /cancel.',
    {
      reply_markup: keyboard([[btn('❌ إلغاء', 'admin_topics')], [btn('🏠 الرئيسية', 'home')]]),
    },
  );
}

/** Consume the new topic name. Returns handled. */
export async function handleTopicCreateText(ctx) {
  if (!ctx.userData?.topics_create) return false;
  if (ctx.kind !== 'message') return false;
  if (!workflow.owns(ctx, TOPIC_CREATE_WORKFLOW)) return false;

  const text = String(ctx.text ?? '').trim();
  if (text === '/cancel') {
    workflow.clear(ctx);
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: homeKeyboard() });
    return true;
  }
  if (!text) return false;

  if (!canManageTopics(ctx.from.id)) {
    workflow.clear(ctx);
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  let topicId;
  try {
    topicId = db.addTopic(text);
  } catch {
    topicId = null;
  }

  workflow.clear(ctx);

  if (!topicId) {
    await ctx.reply('⚠️ تعذّر إنشاء الموضوع (اسم غير صالح).', {
      reply_markup: keyboard([[btn('⬅️ المواضيع', 'admin_topics')]]),
    });
    return true;
  }

  await audit.logAction(ctx.from.id, 'topic_create', { targetType: 'topic', targetId: topicId });

  await ctx.reply(`✅ تم إنشاء الموضوع: <b>${esc(text)}</b>\n\nاربط به الأقسام الحقيقية من قائمة المواضيع.`, {
    reply_markup: keyboard([
      [btn('🔧 إدارة الموضوع', `topic_mgr:${topicId}`)],
      [btn('⬅️ المواضيع', 'admin_topics')],
    ]),
  });
  return true;
}

/** Browse the real hierarchy to link a folder to a topic. */
export async function pickTopicFolder(ctx, topicId, parentId = 0) {
  if (!canManageTopics(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
  }

  let linked = new Set();
  try {
    linked = new Set(db.getTopicFolders(topicId).map((row) => row[0]));
  } catch {
    linked = new Set();
  }

  let breadcrumb = 'الرئيسية 🏠';
  if (parentId) {
    try {
      breadcrumb = db.getBreadcrumbs(parentId);
    } catch {
      breadcrumb = String(parentId);
    }
  }

  const rows = [];
  for (const [folderId, name, nodeType] of folders) {
    const isLinked = linked.has(folderId);
    rows.push([
      btn(
        `${isLinked ? '✅ ' : ''}${resourceIcon(nodeType)} ${String(name).slice(0, 16)}`,
        `topic_link_toggle:${topicId}:${folderId}`,
      ),
      btn('↳ دخول', `topic_link_browse:${topicId}:${folderId}`),
    ]);
  }

  if (parentId) {
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `topic_link_browse:${topicId}:${parent || 0}`)]);
  }

  rows.push([btn('⬅️ الموضوع', `topic_mgr:${topicId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    '🔗 <b>ربط الأقسام بالموضوع</b>\n\n' +
      `📍 ${esc(breadcrumb)}\n\n` +
      'اضغط على القسم للربط/الإلغاء، أو «↳ دخول» للتنقل داخله.',
    { reply_markup: keyboard(rows) },
  );
}

/** Toggle a topic<->folder link. */
export async function toggleTopicFolder(ctx, topicId, folderId) {
  if (!canManageTopics(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let linked = new Set();
  try {
    linked = new Set(db.getTopicFolders(topicId).map((row) => row[0]));
  } catch {
    linked = new Set();
  }

  const nowLinked = linked.has(folderId);

  try {
    if (nowLinked) {
      db.unlinkTopicFolder(topicId, folderId);
    } else {
      db.linkTopicFolder(topicId, folderId);
    }
  } catch {
    // A failed toggle simply re-renders the current state.
  }

  await audit.logAction(ctx.from.id, nowLinked ? 'topic_unlink' : 'topic_link', {
    targetType: 'topic',
    targetId: topicId,
    details: `folder=${folderId}`,
  });

  // Return to the same tree level.
  let parent = 0;
  try {
    parent = db.getParentId(folderId);
  } catch {
    parent = 0;
  }
  await pickTopicFolder(ctx, topicId, parent);
}

/** Toggle a topic's active flag. */
export async function toggleTopicActive(ctx, topicId) {
  if (!canManageTopics(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let topic;
  try {
    topic = db.getTopic(topicId);
  } catch {
    topic = null;
  }
  if (!topic) {
    await ctx.editMessageText('⚠️ الموضوع غير موجود.', { reply_markup: keyboard([[btn('⬅️ المواضيع', 'admin_topics')]]) });
    return;
  }

  db.updateTopic(topicId, { active: !topic.active });
  await audit.logAction(ctx.from.id, 'topic_toggle', {
    targetType: 'topic',
    targetId: topicId,
    details: topic.active ? 'off' : 'on',
  });
  await showTopicAdmin(ctx, topicId);
}

/** Delete a topic (folders/resources are untouched). */
export async function deleteTopic(ctx, topicId) {
  if (!canManageTopics(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (db.deleteTopic(topicId)) {
    await audit.logAction(ctx.from.id, 'topic_delete', { targetType: 'topic', targetId: topicId });
  }
  await showTopicManager(ctx);
}

/** Callback handler for the topics namespace. */
export async function topicsCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  // Public browse.
  if (data === 'topics') {
    await showTopics(ctx);
    return;
  }
  if (data.startsWith('topic_open:')) {
    await showTopic(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }

  // Admin.
  if (data === 'admin_topics') {
    await showTopicManager(ctx);
    return;
  }
  if (data === 'topic_new') {
    await armTopicCreate(ctx);
    return;
  }
  if (data.startsWith('topic_mgr:')) {
    await showTopicAdmin(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('topic_toggle:')) {
    await toggleTopicActive(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('topic_delete:')) {
    await deleteTopic(ctx, Number.parseInt(data.split(':')[1], 10));
    return;
  }
  if (data.startsWith('topic_link_start:')) {
    await pickTopicFolder(ctx, Number.parseInt(data.split(':')[1], 10), 0);
    return;
  }
  if (data.startsWith('topic_link_browse:')) {
    const [, topicId, folderId] = data.split(':');
    await pickTopicFolder(ctx, Number.parseInt(topicId, 10), Number.parseInt(folderId, 10) || 0);
    return;
  }
  if (data.startsWith('topic_link_toggle:')) {
    const [, topicId, folderId] = data.split(':');
    await toggleTopicFolder(ctx, Number.parseInt(topicId, 10), Number.parseInt(folderId, 10));
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const TOPIC_PREFIXES = ['topics', 'topic_open:', 'topic_new', 'topic_mgr:', 'topic_toggle:', 'topic_delete:', 'topic_link_', 'admin_topics'];
