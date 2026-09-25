/**
 * Search Topics (🧭 المواضيع) — student browse plus admin management.
 *
 * A topic is a curated entry point that links to registered folders, so it never
 * duplicates the hierarchy. Unlinking a folder (or deleting a topic) only removes
 * link rows; the folders and their resources are untouched.
 *
 * Callback namespace mirrors the Python reference: `topics`, `topic_open:<id>`,
 * `admin_topics`, `topics_view:<id>`, `topics_create`, `topics_link:<id>`,
 * `topics_pick:<t>:<f>`, `topics_pick_child:<t>:<f>`, `topics_pick_root:<t>:<f>`,
 * `topics_unlink:<t>:<f>`, `topics_toggle:<id>`, `topics_order:<id>:<delta>`,
 * `topics_delete:<id>`.
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as i18n from '../i18n.js';
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

/** Admin gate for the Search Topics surfaces (RBAC: can_topics). */
function isManager(userId) {
  try {
    return db.userHasPermission(userId, 'can_topics');
  } catch {
    return false;
  }
}

async function lang(userId) {
  try {
    return db.getUserLanguage(userId);
  } catch {
    return i18n.DEFAULT_LANGUAGE;
  }
}

/**
 * True when Search Topics is hidden for this caller (admins bypass).
 *
 * Topics is reachable before the catch-all router, so it needs its own
 * visibility check to honour the platform's hidden-feature setting.
 */
async function topicsHiddenFor(ctx) {
  try {
    if (db.isUserAdmin(ctx.from.id)) return false;
    if (!db.isFeatureHidden('topics')) return false;
  } catch {
    return false;
  }

  await ctx.editMessageText('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
    reply_markup: homeKeyboard(),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Student browse
// ---------------------------------------------------------------------------

/** The topic menu: a link to the library, then each active topic with a count. */
async function topicsMenu(ctx, language) {
  const rows = [[btn(i18n.t('topics_open_resources', language), 'library:0')]];

  let topics = [];
  try {
    topics = db.getTopics(true);
  } catch {
    topics = [];
  }

  for (const topic of topics) {
    let count = 0;
    try {
      count = db.topicResourceCount(topic.id);
    } catch {
      count = 0;
    }
    const icon = topic.icon || '🧭';
    rows.push([btn(`${icon} ${String(topic.name).slice(0, 30)} (${count})`, `topic_open:${topic.id}`)]);
  }

  rows.push([btn(i18n.t('home', language), 'home')]);
  return { rows, topics };
}

/**
 * Public topic list. Deliberately distinct from the library browser: a topic is a
 * curated academic index, while the library shows the full registered hierarchy.
 */
export async function showTopics(ctx) {
  const language = await lang(ctx.from.id);

  const { rows, topics } = await topicsMenu(ctx, language);
  const body = topics.length
    ? i18n.t('topics_title', language)
    : `${i18n.t('topics_title', language)}\n\n${i18n.t('topics_empty', language)}`;

  await ctx.editMessageText(body, { reply_markup: keyboard(rows) });
}

/** The sections linked to a topic, then normal folder navigation. */
export async function showTopic(ctx, topicId) {
  const language = await lang(ctx.from.id);

  let topic;
  try {
    topic = db.getTopic(topicId);
  } catch {
    topic = null;
  }

  if (!topic || !topic.active) {
    await ctx.editMessageText(i18n.t('topic_unavailable', language), {
      reply_markup: keyboard([
        [btn(i18n.t('menu_topics', language), 'topics')],
        [btn(i18n.t('home', language), 'home')],
      ]),
    });
    return;
  }

  let folders = [];
  try {
    folders = db.getTopicFolders(topicId);
  } catch {
    folders = [];
  }

  const rows = [];
  for (const [folderId, name, nodeType] of folders) {
    rows.push([btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 35)}`, `folder:${folderId}`)]);
  }
  if (!rows.length) rows.push([btn(i18n.t('topic_no_sections', language), 'noop')]);

  rows.push([btn(i18n.t('menu_topics', language), 'topics')]);
  rows.push([btn(i18n.t('home', language), 'home')]);

  const body =
    `${topic.icon || '🧭'} <b>${esc(topic.name)}</b>\n\n` +
    (topic.description ? `${esc(topic.description)}\n\n` : '') +
    i18n.t('topic_choose_section', language);

  await ctx.editMessageText(body, { reply_markup: keyboard(rows) });
}

// ---------------------------------------------------------------------------
// Admin management
// ---------------------------------------------------------------------------

async function adminTopicsMenu(topics) {
  const rows = [];
  for (const topic of topics) {
    const mark = topic.active ? '✅' : '⛔';
    rows.push([btn(`${mark} ${String(topic.name).slice(0, 28)}`, `topics_view:${topic.id}`)]);
  }
  rows.push([btn('➕ إنشاء موضوع', 'topics_create')]);
  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);
  return rows;
}

/** Admin topic manager. */
export async function showAdminTopics(ctx) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (ctx.userData) {
    delete ctx.userData.topics_create;
    delete ctx.userData.topics_link_id;
  }

  let topics = [];
  try {
    topics = db.getTopics(false);
  } catch {
    topics = [];
  }

  await ctx.editMessageText(
    '🧭 <b>مواضيع البحث</b>\n\n' +
      'المواضيع هي مداخل رئيسية لمجالات أكاديمية كبرى، وترتبط بأقسام ' +
      'مسجّلة. اختر موضوعاً لإدارته.',
    { reply_markup: keyboard(await adminTopicsMenu(topics)) },
  );
}

/** One topic's admin detail: linked sections and every mutation. */
export async function showTopicAdmin(ctx, topicId) {
  if (!isManager(ctx.from.id)) {
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
    await ctx.editMessageText('⚠️ الموضوع غير موجود.', {
      reply_markup: keyboard([[btn('⬅️ المواضيع', 'admin_topics')]]),
    });
    return;
  }

  let folders = [];
  try {
    folders = db.getTopicFolders(topicId);
  } catch {
    folders = [];
  }

  const lines = [
    '🧭 <b>إدارة الموضوع</b>',
    `🏷 الاسم: ${esc(topic.name)}`,
    `📊 الحالة: ${topic.active ? '✅ مفعّل' : '⛔ معطّل'}`,
    `🔢 الترتيب: ${esc(topic.display_order ?? 0)}`,
  ];
  if (topic.description) lines.push(`📝 ${esc(topic.description)}`);

  lines.push('', '📂 <b>الأقسام المرتبطة</b>');
  const rows = [];
  if (folders.length) {
    for (const [folderId, name] of folders) {
      lines.push(`• ${esc(name)}`);
      rows.push([btn(`✂️ إزالة ${String(name).slice(0, 22)}`, `topics_unlink:${topicId}:${folderId}`)]);
    }
  } else {
    lines.push('• لا توجد أقسام مرتبطة بعد.');
  }

  rows.push([btn('🔗 ربط قسم', `topics_link:${topicId}`)]);
  rows.push([btn(topic.active ? '⛔ تعطيل' : '✅ تفعيل', `topics_toggle:${topicId}`)]);
  rows.push([
    btn('🔽 تقديم', `topics_order:${topicId}:-1`),
    btn('🔼 تأخير', `topics_order:${topicId}:1`),
  ]);
  rows.push([btn('🗑 حذف الموضوع', `topics_delete:${topicId}`)]);
  rows.push([btn('⬅️ المواضيع', 'admin_topics')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Arm topic creation: the next typed message is the name (and optional description). */
export async function armTopicCreate(ctx) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  workflow.begin(ctx, TOPIC_CREATE_WORKFLOW);
  ctx.userData.topics_create = true;

  await ctx.editMessageText(
    '➕ <b>إنشاء موضوع</b>\n\n' +
      'أرسل اسم الموضوع (مثال: علم وظائف الأعضاء).\n\n' +
      'يمكنك كتابة الوصف بعد اسم الموضوع في سطر منفصل.',
    {
      reply_markup: keyboard([
        [btn('❌ إلغاء', 'admin_topics')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    },
  );
}

/**
 * Consume a typed topic name (create) or folder id (link). Returns handled.
 */
export async function handleTopicsText(ctx) {
  const creating = ctx.userData?.topics_create;
  const linking = ctx.userData?.topics_link_id;

  if (!creating && !linking) return false;
  if (ctx.kind !== 'message') return false;

  // Another workflow may have claimed this input; only the active flow may consume it.
  if (creating && !workflow.owns(ctx, TOPIC_CREATE_WORKFLOW)) return false;
  if (linking && !workflow.owns(ctx, TOPIC_LINK_WORKFLOW)) return false;

  if (!isManager(ctx.from.id)) {
    workflow.clear(ctx);
    delete ctx.userData.topics_create;
    delete ctx.userData.topics_link_id;
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  const text = String(ctx.text ?? '').trim();

  if (text === '/cancel') {
    workflow.clear(ctx);
    delete ctx.userData.topics_create;
    delete ctx.userData.topics_link_id;
    await ctx.reply('❌ تم إلغاء العملية.', {
      reply_markup: keyboard([
        [btn('🧭 المواضيع', 'admin_topics')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return true;
  }

  if (creating) {
    workflow.clear(ctx);
    delete ctx.userData.topics_create;

    const parts = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const name = parts[0] ?? '';
    const description = parts.length > 1 ? parts.slice(1).join(' ') : null;

    let newId = null;
    try {
      newId = db.addTopic(name, description);
    } catch {
      newId = null;
    }

    if (!newId) {
      await ctx.reply('⚠️ اسم غير صالح.', {
        reply_markup: keyboard([
          [btn('🧭 المواضيع', 'admin_topics')],
          [btn('🏠 الرئيسية', 'home')],
        ]),
      });
      return true;
    }

    await audit.logAction(ctx.from.id, 'topic_create', {
      targetType: 'topic',
      targetId: newId,
    });
    await ctx.reply(`✅ تم إنشاء الموضوع: <b>${esc(name)}</b>`, {
      reply_markup: keyboard([
        [btn('🧭 إدارة الموضوع', `topics_view:${newId}`)],
        [btn('🧭 المواضيع', 'admin_topics')],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return true;
  }

  // Linking a folder by id.
  const digits = text.replace(/\D+/g, '');
  const folderId = digits ? Number.parseInt(digits, 10) : 0;
  const topicId = ctx.userData.topics_link_id;
  workflow.clear(ctx);
  delete ctx.userData.topics_link_id;

  if (!folderId || folderId <= 0) {
    await ctx.reply('⚠️ أرسل رقم القسم (ID) الصحيح.', {
      reply_markup: keyboard([
        [btn('🧭 إدارة الموضوع', `topics_view:${topicId}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return true;
  }

  let ok = false;
  try {
    ok = db.linkTopicFolder(topicId, folderId);
  } catch {
    ok = false;
  }

  if (ok) {
    await audit.logAction(ctx.from.id, 'topic_link', {
      targetType: 'topic',
      targetId: topicId,
      details: `folder=${folderId}`,
    });
  }

  await ctx.reply(ok ? '✅ تم ربط القسم بالموضوع.' : '⚠️ تعذر ربط القسم (تأكد من رقم القسم).', {
    reply_markup: keyboard([
      [btn('🧭 إدارة الموضوع', `topics_view:${topicId}`)],
      [btn('🧭 المواضيع', 'admin_topics')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
  return true;
}

/**
 * Offer the current folder tree so the admin can pick a folder to link.
 *
 * Navigation and linking are separate buttons: the name drills down, «🔗 ربط»
 * commits. Linking a section also covers its subsections and resources.
 */
export async function pickTopicFolder(ctx, topicId, parentId = 0) {
  workflow.begin(ctx, TOPIC_LINK_WORKFLOW);
  ctx.userData.topics_link_id = topicId;
  delete ctx.userData.topics_create;

  await renderLinkPicker(ctx, topicId, parentId);
}

async function renderLinkPicker(ctx, topicId, parentId) {
  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
  }

  let breadcrumb = 'الجذر';
  if (parentId) {
    try {
      breadcrumb = db.getBreadcrumbs(parentId);
    } catch {
      breadcrumb = String(parentId);
    }
  }

  const rows = [];
  for (const [folderId, name, nodeType] of folders) {
    rows.push([
      btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 18)}`, `topics_pick_child:${topicId}:${folderId}`),
      btn('🔗 ربط', `topics_pick:${topicId}:${folderId}`),
    ]);
  }

  if (parentId) {
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `topics_pick_root:${topicId}:${parent || 0}`)]);
  }

  rows.push([btn('⬅️ إدارة الموضوع', `topics_view:${topicId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    '🔗 <b>ربط قسم بالموضوع</b>\n\n' +
      `📍 ${esc(breadcrumb)}\n\n` +
      'تنقّل بين الأقسام ثم اضغط «🔗 ربط» بجانب القسم المطلوب. ' +
      'ربط قسم يضمّ أيضاً كل أقسامه الفرعية وموارده.',
    { reply_markup: keyboard(rows) },
  );
}

/** Toggle a topic's active flag. */
export async function toggleTopicActive(ctx, topicId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let topic;
  try {
    topic = db.getTopic(topicId);
  } catch {
    topic = null;
  }

  if (topic) {
    const next = !topic.active;
    try {
      db.updateTopic(topicId, { active: next });
    } catch {
      // The re-render below shows the persisted truth either way.
    }
    await audit.logAction(ctx.from.id, 'topic_toggle', {
      targetType: 'topic',
      targetId: topicId,
      details: `active=${next}`,
    });
  }

  await showTopicAdmin(ctx, topicId);
}

/** Move a topic up (delta -1) or down (delta 1) in the display order. */
export async function reorderTopic(ctx, topicId, delta) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let topic;
  try {
    topic = db.getTopic(topicId);
  } catch {
    topic = null;
  }

  if (topic) {
    const nextOrder = Math.max(0, Number(topic.display_order ?? 0) + delta);
    try {
      db.updateTopic(topicId, { displayOrder: nextOrder });
    } catch {
      // Non-fatal: the detail screen shows the stored order.
    }
  }

  await showTopicAdmin(ctx, topicId);
}

/** Unlink a folder from a topic. The folder itself is untouched. */
async function unlinkFolder(ctx, topicId, folderId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let ok = false;
  try {
    ok = db.unlinkTopicFolder(topicId, folderId);
  } catch {
    ok = false;
  }

  if (ok) {
    await audit.logAction(ctx.from.id, 'topic_unlink', {
      targetType: 'topic',
      targetId: topicId,
      details: `folder=${folderId}`,
    });
  }

  await showTopicAdmin(ctx, topicId);
}

/** Link a folder to a topic from the picker. */
async function linkFolder(ctx, topicId, folderId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let ok = false;
  try {
    ok = db.linkTopicFolder(topicId, folderId);
  } catch {
    ok = false;
  }

  if (ok) {
    await audit.logAction(ctx.from.id, 'topic_link', {
      targetType: 'topic',
      targetId: topicId,
      details: `folder=${folderId}`,
    });
  }

  delete ctx.userData?.topics_link_id;
  delete ctx.userData?.topics_create;
  await showTopicAdmin(ctx, topicId);
}

/** Delete a topic (folders/resources are untouched). */
export async function deleteTopic(ctx, topicId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let ok = false;
  try {
    ok = db.deleteTopic(topicId);
  } catch {
    ok = false;
  }

  if (ok) {
    await audit.logAction(ctx.from.id, 'topic_delete', { targetType: 'topic', targetId: topicId });
  }

  await showAdminTopics(ctx);
}

/** Callback handler for the topics namespace. */
export async function topicsCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  const intArg = (raw) => {
    const value = Number.parseInt(raw, 10);
    return Number.isNaN(value) ? null : value;
  };

  // ---- Public ----------------------------------------------------
  if (data === 'topics') {
    if (await topicsHiddenFor(ctx)) return;
    await showTopics(ctx);
    return;
  }

  if (data.startsWith('topic_open:')) {
    if (await topicsHiddenFor(ctx)) return;
    const topicId = intArg(data.split(':')[1]);
    if (topicId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await showTopic(ctx, topicId);
    return;
  }

  // ---- Admin: list / detail / mutations --------------------------
  if (data === 'admin_topics') {
    await showAdminTopics(ctx);
    return;
  }

  if (data.startsWith('topics_view:')) {
    const topicId = intArg(data.split(':')[1]);
    if (topicId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await showTopicAdmin(ctx, topicId);
    return;
  }

  if (data === 'topics_create') {
    await armTopicCreate(ctx);
    return;
  }

  if (data.startsWith('topics_link:')) {
    const topicId = intArg(data.split(':')[1]);
    if (topicId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await pickTopicFolder(ctx, topicId, 0);
    return;
  }

  if (data.startsWith('topics_pick_child:') || data.startsWith('topics_pick_root:')) {
    const [, rawTopic, rawFolder] = data.split(':');
    const topicId = intArg(rawTopic);
    const folderId = intArg(rawFolder);
    if (topicId === null || folderId === null) {
      await ctx.editMessageText('⚠️ طلب غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await renderLinkPicker(ctx, topicId, folderId);
    return;
  }

  if (data.startsWith('topics_pick:')) {
    const [, rawTopic, rawFolder] = data.split(':');
    const topicId = intArg(rawTopic);
    const folderId = intArg(rawFolder);
    if (topicId === null || folderId === null) {
      await ctx.editMessageText('⚠️ طلب غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await linkFolder(ctx, topicId, folderId);
    return;
  }

  if (data.startsWith('topics_unlink:')) {
    const [, rawTopic, rawFolder] = data.split(':');
    const topicId = intArg(rawTopic);
    const folderId = intArg(rawFolder);
    if (topicId === null || folderId === null) {
      await ctx.editMessageText('⚠️ طلب غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await unlinkFolder(ctx, topicId, folderId);
    return;
  }

  if (data.startsWith('topics_toggle:')) {
    const topicId = intArg(data.split(':')[1]);
    if (topicId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await toggleTopicActive(ctx, topicId);
    return;
  }

  if (data.startsWith('topics_order:')) {
    const [, rawTopic, rawDelta] = data.split(':');
    const topicId = intArg(rawTopic);
    const delta = intArg(rawDelta);
    if (topicId === null || delta === null) {
      await ctx.editMessageText('⚠️ طلب غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await reorderTopic(ctx, topicId, delta);
    return;
  }

  if (data.startsWith('topics_delete:')) {
    const topicId = intArg(data.split(':')[1]);
    if (topicId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await deleteTopic(ctx, topicId);
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}

export const TOPIC_PREFIXES = [
  'topics',
  'topic_open:',
  'admin_topics',
  'topics_view:',
  'topics_create',
  'topics_link:',
  'topics_pick:',
  'topics_pick_child:',
  'topics_pick_root:',
  'topics_unlink:',
  'topics_toggle:',
  'topics_order:',
  'topics_delete:',
];
