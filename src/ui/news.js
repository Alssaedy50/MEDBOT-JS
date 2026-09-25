/**
 * News Center + News publishing and subscriptions (الأخبار) for MEDBOT.
 *
 * Two first-class news kinds, one shared chronological feed:
 *   notify  -> 🚨 Important / Urgent
 *   section -> 📚 Section News
 *
 * A resource is NOT a kind: it is an optional *linked reference* on a Section
 * News item.
 *
 * Design rules held here:
 *
 *  * The feed is deliberately the *only* public list, ordered newest-first with
 *    pagination. `archived` rows are the admin lifecycle (hidden), so the
 *    student feed stays simple and predictable.
 *  * Real references only. A news row points at a live folder/content id; the
 *    detail screen resolves the *current* name and breadcrumb from the registry
 *    and offers a navigation button only when the referenced row still exists.
 *  * Read tracking is standalone (`news_reads`), so the unread badge on the home
 *    page is one cheap query and a duplicate read is impossible.
 *
 * Admin surface (📰 News) offers exactly three entries — ➕ Publish News,
 * 📋 Published News, 🗄 Archive — on top of the draft → preview → publish →
 * archive lifecycle.
 */

import * as db from '../db/index.js';
import * as audit from '../audit.js';
import * as authorization from '../authorization.js';
import * as i18n from '../i18n.js';
import * as newsDelivery from '../newsDelivery.js';
import * as workflow from '../workflow.js';
import { btn, escHtml, keyboard, resourceIcon, tailInt, threeParts } from '../telegram/ui.js';

// Callback data prefixes owned by this module.
export const NEWS_CALLBACKS = [
  'news',
  'news_open:',
  'news_more:',
  'news_readall',
  'news_filter:',
  'news_subs',
  'news_sub:',
  'news_unsub:',
  'news_subs_sections',
  'news_subs_section:',
  'news_subs_back',
  'admin_news',
  'news_admin_all',
  'news_admin_published',
  'news_admin_archived',
  'news_admin_view:',
  'news_admin_preview:',
  'news_admin_pub:',
  'news_admin_archive:',
  'news_admin_restore:',
  'news_admin_delete:',
  'news_admin_deliveries:',
  'news_admin_retry:',
  'news_new',
  'news_new:',
  'news_pick_child:',
  'news_pick_root:',
  'news_ref_child:',
  'news_ref_root:',
  'news_ref_set_section:',
  'news_ref_subject:',
  'news_ref_set_subject:',
  'news_ref_unset_subject:',
  'news_ref_resource:',
  'news_ref_set_resource:',
  'news_ref_unlink:',
];

// Admin publish-wizard state keys.
const STATE_TYPE = 'news_new_type';
const STATE_STEP = 'news_new_step';
const STATE_TITLE = 'news_new_title';
const STATE_BODY = 'news_new_body';
const STATE_DOCTOR = 'news_new_doctor';
const STATE_EVENT = 'news_new_event';
const STATE_SECTION = 'news_new_section';
const STATE_RESOURCE = 'news_new_resource';

const ALL_STATE_KEYS = [
  STATE_TYPE,
  STATE_STEP,
  STATE_TITLE,
  STATE_BODY,
  STATE_DOCTOR,
  STATE_EVENT,
  STATE_SECTION,
  STATE_RESOURCE,
];

// One workflow for the whole wizard: re-entering it is idempotent and
// `workflow.begin` only cancels *other* flows, so advancing from the title step
// to the body step never wipes the title it just captured.
export const NEWS_WORKFLOW = 'news_draft';

export function esc(value) {
  return escHtml(value);
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

function typeLabel(newsType) {
  return db.NEWS_TYPE_LABELS[newsType] ?? db.NEWS_TYPE_ICONS[newsType] ?? '📰';
}

function toIntOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function lang(userId) {
  try {
    return db.getUserLanguage(userId);
  } catch {
    return i18n.DEFAULT_LANGUAGE;
  }
}

function isManager(userId) {
  try {
    return db.userHasPermission(userId, 'can_news');
  } catch {
    return false;
  }
}

/**
 * News ids a scope-restricted admin may manage, or null when unrestricted.
 *
 * null = platform-wide (owner / unscoped admin). A scoped admin gets only the
 * news rows anchored in — or referencing a resource inside — their scope.
 */
function scopedNewsIds(userId) {
  try {
    if (db.isOwner(userId)) return null;
    if (!db.adminHasScopes(userId)) return null;
    return db.listNewsIdsForAdmin(userId);
  } catch {
    return new Set();
  }
}

function isScopeRestricted(userId) {
  return authorization.isScopeRestricted(userId);
}

// ---------------------------------------------------------------------------
// Student side — 📰 News Center
// ---------------------------------------------------------------------------

/**
 * The student News Center: chronological, paginated, read-aware.
 *
 * Only published news is listed (drafts/archived stay in the admin view). The
 * unread state is resolved in one query for the page.
 */
export async function showNewsFeed(ctx, { page = 0, newsType = null } = {}) {
  const userId = ctx.from.id;
  const language = await lang(userId);
  const pageSize = db.NEWS_PAGE_SIZE;

  let safePage = Number.parseInt(page, 10);
  if (Number.isNaN(safePage) || safePage < 0) safePage = 0;

  const filterType = db.NEWS_TYPES.includes(newsType) ? newsType : null;

  let items = [];
  let total = 0;
  try {
    items = db.listNews({
      status: 'published',
      newsType: filterType,
      limit: pageSize,
      offset: safePage * pageSize,
    });
    total = db.countNews({ status: 'published', newsType: filterType });
  } catch {
    items = [];
    total = 0;
  }

  // Resolve read state for this page only, in a single query.
  let readIds = new Set();
  if (items.length) {
    try {
      readIds = db.getReadNewsIds(
        userId,
        items.map((item) => item.id),
      );
    } catch {
      readIds = new Set();
    }
  }

  const lines = [i18n.t('news_title', language)];
  if (!items.length) {
    lines.push('', i18n.t('news_empty', language));
  } else {
    lines.push(`\n📄 ${safePage * pageSize + 1}–${safePage * pageSize + items.length} / ${total}`);
  }

  const rows = [];
  for (const item of items) {
    const isRead = readIds.has(item.id);
    rows.push([
      btn(`${isRead ? '✅ ' : '🔵 '}${String(item.title).slice(0, 34)}`, `news_open:${item.id}`),
    ]);
  }

  // Explicit, self-describing type filters: the two real kinds plus "all".
  // No icon-only chips and no "resource" filter — a linked resource lives
  // inside a Section News item, it is not a kind of its own.
  rows.push([btn('📋 كل الأخبار', 'news_filter:all')]);
  for (const key of db.NEWS_TYPES) {
    rows.push([btn(db.NEWS_TYPE_LABELS[key], `news_filter:${key}`)]);
  }

  if (safePage + 1 < Math.ceil(total / Math.max(pageSize, 1))) {
    rows.push([btn(i18n.t('news_more', language), `news_more:${safePage + 1}`)]);
  }

  if (items.length) {
    rows.push([btn(i18n.t('news_mark_all_read', language), 'news_readall')]);
  }

  rows.push([btn(i18n.t('news_subs', language), 'news_subs')]);
  rows.push([btn(i18n.t('home', language), 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/**
 * The student-facing detail body for one resolved news row.
 *
 * Shared by the student reader and the admin preview so both always show the
 * same real registry context (current names/breadcrumb, not a copy).
 */
export function detailLines(news, _language) {
  const lines = [
    `${db.NEWS_TYPE_ICONS[news.news_type] ?? '📰'} <b>${esc(news.title)}</b>`,
    `🏷 ${typeLabel(news.news_type)}`,
  ];

  if (news.subject_name) lines.push(`🧪 المادة: ${esc(news.subject_name)}`);
  if (news.section_name) lines.push(`🗂 القسم: ${esc(news.section_name)}`);
  if (news.folder_path) lines.push(`📍 ${esc(news.folder_path)}`);
  if (news.doctor) lines.push(`👨‍⚕️ ${esc(news.doctor)}`);
  if (news.event_at) lines.push(`📅 ${esc(news.event_at)}`);

  const listed = news.published_at || news.created_at;
  if (listed) lines.push(`🕒 ${esc(listed)}`);

  lines.push('');
  if (news.body) lines.push(esc(news.body));

  // A linked resource/announcement is part of the item, never a kind itself.
  if (news.resource_present) {
    lines.push('', `📄 ${esc(news.resource_title ?? '')}`);
  }

  return lines;
}

/**
 * The real access button(s) for a resolved news row (or none).
 *
 * A linked resource yields a direct "open resource" button; otherwise the
 * item's real section is offered. Buttons are built from live registry ids
 * only, so a removed target simply offers nothing.
 */
export function detailAccessRows(news, language) {
  const rows = [];
  if (news.resource_present && news.resource_id) {
    rows.push([btn(i18n.t('news_view_resource', language), `file:${news.resource_id}`)]);
  }
  if (news.folder_id) {
    rows.push([btn(i18n.t('news_open_section', language), `folder:${news.folder_id}`)]);
  }
  return rows;
}

/**
 * Open one news item, mark it read, and offer the right access action.
 *
 * A student may only open **published** news: `draft` and `archived` are admin
 * lifecycle states, so a stale/invented callback id can never expose
 * unpublished text. When the row is refused no read record is created.
 */
export async function openNews(ctx, newsId, admin = false) {
  const userId = ctx.from.id;
  const language = await lang(userId);

  let news;
  try {
    news = db.getNewsDetail(newsId);
  } catch {
    news = null;
  }

  // Only a published row is visible on the student path. A non-published row is
  // treated exactly like a missing one: no text, no read record.
  if (news && !admin && news.status !== 'published') news = null;

  if (!news) {
    await ctx.editMessageText(i18n.t('news_no_match', language), {
      reply_markup: keyboard([[btn(i18n.t('news_back_feed', language), 'news')]]),
    });
    return;
  }

  // An unread news is marked read on open (idempotent). Admin previews never
  // record a read.
  if (!admin) {
    try {
      db.markNewsRead(userId, newsId);
    } catch {
      // A read-tracking failure must not block the view.
    }
  }

  const rows = detailAccessRows(news, language);
  rows.push([btn(i18n.t('news_back_feed', language), 'news')]);
  rows.push([btn(i18n.t('home', language), 'home')]);

  await ctx.editMessageText(detailLines(news, language).join('\n'), {
    reply_markup: keyboard(rows),
  });
}

/** Mark every published news item read for the caller. */
export async function markAllRead(ctx) {
  try {
    db.markAllNewsRead(ctx.from.id);
  } catch {
    // Best-effort.
  }
  await showNewsFeed(ctx);
}

// ---------------------------------------------------------------------------
// Student side — ⚙️ News subscriptions
// ---------------------------------------------------------------------------
// Subscriptions decide *private delivery only*: nothing here changes what the
// News Center lists. A student subscribes to a whole kind or to one real section
// (a folder), and only then do matching items reach a Telegram inbox.

/** The caller's subscription set plus the two kind toggles, in O(1) queries. */
function subscriptionState(userId) {
  let subs = [];
  try {
    subs = db.getNewsSubscriptions(userId);
  } catch {
    subs = [];
  }
  const typeSubs = new Set(subs.filter(([kind]) => kind === db.NEWS_SUB_TYPE).map(([, value]) => value));
  const sectionIds = new Set(
    subs.filter(([kind]) => kind === db.NEWS_SUB_SECTION).map(([, value]) => value),
  );
  return { subs, typeSubs, sectionIds };
}

/**
 * The ⚙️ News Subscriptions screen.
 *
 * Two kind toggles plus a sections entry, each labelled explicitly and each
 * showing its current state ("مشترك ✓" / "غير مشترك"). Subscriptions control
 * private delivery only — the News Center still lists everything.
 */
export async function showSubscriptions(ctx) {
  const userId = ctx.from.id;
  const language = await lang(userId);
  const { typeSubs, sectionIds } = subscriptionState(userId);

  const labelFor = {
    notify: '🚨 أخبار هام / عاجل',
    section: '📚 أخبار الأقسام',
  };

  const lines = [
    '⚙️ <b>اشتراكات الأخبار</b>',
    '',
    'اختر ما يصلك كرسالة خاصة. 📰 مركز الأخبار يعرض كل الأخبار المنشورة للجميع، والاشتراك يتحكم فقط في التوصيل الخاص.',
    '',
  ];

  const rows = [];
  for (const newsType of db.NEWS_TYPES) {
    const on = typeSubs.has(newsType);
    rows.push([
      btn(labelFor[newsType] ?? newsType, `news_sub:${newsType}`),
      btn(on ? 'مشترك ✓' : 'غير مشترك', `news_sub:${newsType}`),
    ]);
    lines.push(`${labelFor[newsType] ?? newsType} — ${on ? 'مشترك ✓' : 'غير مشترك'}`);
  }

  const sectionsLabel = sectionIds.size
    ? `📚 إدارة الأقسام المتابَعة (${sectionIds.size})`
    : '📚 إدارة الأقسام المتابَعة';
  rows.push([btn(sectionsLabel, 'news_subs_sections')]);
  rows.push([btn(i18n.t('news_back_feed', language), 'news')]);
  rows.push([btn(i18n.t('home', language), 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Subscribe/unsubscribe the caller to a whole news kind (idempotent). */
export async function toggleSubscription(ctx, newsType) {
  const userId = ctx.from.id;
  if (!db.NEWS_TYPES.includes(newsType)) {
    await ctx.editMessageText('⚠️ نوع غير معروف.', { reply_markup: homeKeyboard() });
    return;
  }

  const { typeSubs } = subscriptionState(userId);
  try {
    if (typeSubs.has(newsType)) {
      db.removeNewsSubscription(userId, db.NEWS_SUB_TYPE, newsType);
    } else {
      db.addNewsSubscription(userId, db.NEWS_SUB_TYPE, newsType);
    }
  } catch {
    // A failed toggle simply re-renders the current state.
  }

  await showSubscriptions(ctx);
}

/**
 * Browse the real folder hierarchy and subscribe to one section.
 *
 * The tree is the live registry, so the student can only pick a section that
 * actually exists. A section subscription is per exact folder — no synthetic
 * taxonomy.
 */
export async function showSectionSubscriptions(ctx, parentId = 0) {
  const userId = ctx.from.id;
  const language = await lang(userId);
  const { sectionIds } = subscriptionState(userId);

  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
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
    const icon = resourceIcon(nodeType);
    const subscribed = sectionIds.has(String(folderId));
    const marker = subscribed ? '✅ ' : '';
    rows.push([
      btn(`${marker}${icon} ${String(name).slice(0, 20)}`, `news_subs_section:${folderId}`),
      btn(subscribed ? 'مشترك ✓' : 'غير مشترك', `news_subs_section:${folderId}`),
    ]);
    rows.push([btn(`↳ دخول ${String(name).slice(0, 18)}`, `news_pick_child:${folderId}`)]);
  }

  if (parentId) {
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `news_pick_root:${parent || 0}`)]);
  }

  rows.push([btn('⚙️ اشتراكات الأخبار', 'news_subs')]);
  rows.push([btn(i18n.t('home', language), 'home')]);

  await ctx.editMessageText(
    '📚 <b>إدارة الأقسام المتابَعة</b>\n\n' +
      `📍 ${esc(breadcrumb)}\n\n` +
      'اضغط على القسم للاشتراك/إلغاء الاشتراك، أو «↳ دخول» للتنقل داخله.',
    { reply_markup: keyboard(rows) },
  );
}

/** Subscribe/unsubscribe the caller to one real folder section. */
export async function toggleSectionSubscription(ctx, rawFolderId) {
  const userId = ctx.from.id;
  const folderId = toIntOrNull(rawFolderId);
  if (folderId === null) {
    await ctx.editMessageText('⚠️ قسم غير صالح.', { reply_markup: homeKeyboard() });
    return;
  }

  let folder;
  try {
    folder = db.getFolder(folderId);
  } catch {
    folder = null;
  }
  if (!folder) {
    await ctx.editMessageText('⚠️ القسم غير موجود.', { reply_markup: homeKeyboard() });
    return;
  }

  const { sectionIds } = subscriptionState(userId);
  try {
    if (sectionIds.has(String(folderId))) {
      db.removeNewsSubscription(userId, db.NEWS_SUB_SECTION, String(folderId));
    } else {
      db.addNewsSubscription(userId, db.NEWS_SUB_SECTION, String(folderId));
    }
  } catch {
    // A failed toggle simply re-renders the current state.
  }

  // Return to the same tree level so repeated toggles stay in place.
  const parentId = folder[1] !== null && folder[1] !== undefined ? folder[1] : 0;
  await showSectionSubscriptions(ctx, parentId);
}

// ---------------------------------------------------------------------------
// Admin side — 📰 Publishing Center
// ---------------------------------------------------------------------------

/** The 📰 News admin entry: Publish / Published / Archive. */
function adminMenu() {
  return keyboard([
    [btn('➕ نشر خبر', 'news_new')],
    [btn('📋 الأخبار المنشورة', 'news_admin_published')],
    [btn('🗄 الأرشيف', 'news_admin_archived')],
    [btn('⬅️ إدارة المنصة', 'admin')],
    [btn('🏠 الرئيسية', 'home')],
  ]);
}

/**
 * Map an admin view to the `listNews` status filter.
 *
 * `active`    is the default working set (draft + published, archived excluded);
 * `published` is the explicit "Published News" list;
 * `archived`  reaches the archived rows so they can be restored;
 * `all`       is the unfiltered list.
 */
function statusFilterForView(view) {
  if (view === 'archived') return ['archived', false];
  if (view === 'published') return ['published', false];
  if (view === 'all') return [null, true];
  return [null, false];
}

/** Every content row as (id, folder_id, title), newest first (bounded). */
function listAllContent() {
  try {
    return db.withDb((conn) =>
      conn
        .prepare('SELECT id, folder_id, title FROM content ORDER BY id DESC LIMIT 200')
        .all(),
    );
  } catch {
    return [];
  }
}

/**
 * Return the missing required reference for a row, or ''.
 *
 * A 📚 Section News item must point at a real section folder before it can be
 * published. A linked resource on a Section item is optional, so it never
 * blocks publishing.
 */
export function referenceMissingFor(news) {
  if (news.news_type === 'section' && !news.section_folder_id) return 'section';
  return '';
}

/**
 * Admin News surface: the publishing menu plus the row listings.
 *
 * Every row is a `news_admin_view:<id>` button, so an admin can open any news
 * item — including archived ones — and reach its publish/archive/restore/delete
 * actions.
 */
export async function showAdminNews(ctx, view = 'menu') {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (ctx.userData) clearState(ctx);

  const [status, includeArchived] = statusFilterForView(view);
  const scopedIds = scopedNewsIds(ctx.from.id);

  let rowsData = [];
  let archivedCount = 0;
  let counts = {};
  try {
    rowsData = db.listNews({ status, includeArchived, limit: 200 });
    archivedCount = db.countNews({ status: 'archived', includeArchived: true });
    counts = db.getNewsCountsByType();
  } catch {
    rowsData = [];
    archivedCount = 0;
    counts = {};
  }

  // A draft left behind by a cancelled wizard has no navigable entry point, so
  // a draft missing its required reference is not listed here.
  if (status === null && !includeArchived) {
    rowsData = rowsData.filter(
      (row) => !(row.status === 'draft' && referenceMissingFor(row)),
    );
  }

  if (scopedIds !== null) {
    rowsData = rowsData.filter((row) => scopedIds.has(row.id));
    counts = {};
    for (const item of rowsData) {
      counts[item.news_type] = (counts[item.news_type] ?? 0) + 1;
    }
    try {
      const archivedRows = db.listNews({ status: 'archived', includeArchived: true, limit: 500 });
      archivedCount = archivedRows.filter((row) => scopedIds.has(row.id)).length;
    } catch {
      archivedCount = 0;
    }
  }

  rowsData = rowsData.slice(0, 20);

  const title =
    {
      archived: '🗄 <b>الأخبار المؤرشفة</b>',
      all: '📋 <b>كل الأخبار</b>',
      published: '📋 <b>الأخبار المنشورة</b>',
    }[view] ?? '📰 <b>الأخبار</b>';

  const lines = [
    title,
    '',
    'أنشئ الخبر كمسودة، راجعه، ثم انشره — ويُوصَل المشتركون تلقائيًا.',
    '',
    `🚨 ${counts.notify ?? 0} | 📚 ${counts.section ?? 0}  ·  🗄 ${archivedCount}`,
    '',
  ];

  if (!rowsData.length) {
    lines.push('• لا توجد أخبار في هذا العرض.');
  } else {
    for (const item of rowsData) {
      const state = db.NEWS_STATUS_LABELS[item.status] ?? item.status;
      lines.push(
        `• ${db.NEWS_TYPE_ICONS[item.news_type] ?? '📰'} ${esc(String(item.title).slice(0, 40))} — ${esc(state)}`,
      );
    }
    lines.push('', 'اضغط على أي خبر للفتح والتحكم.');
  }

  const buttons = [];
  for (const item of rowsData) {
    const state = db.NEWS_STATUS_LABELS[item.status] ?? '';
    buttons.push([
      btn(
        `${db.NEWS_TYPE_ICONS[item.news_type] ?? '📰'} ${String(item.title).slice(0, 26)} · ${state}`,
        `news_admin_view:${item.id}`,
      ),
    ]);
  }

  // The three required entries, always reachable; a contextual "all" filter is
  // added only inside a listing so the entry screen stays unambiguous.
  buttons.push([btn('➕ نشر خبر', 'news_new')]);
  buttons.push([btn('📋 الأخبار المنشورة', 'news_admin_published')]);
  buttons.push([btn('🗄 الأرشيف', 'news_admin_archived')]);
  if (['all', 'archived', 'published'].includes(view)) {
    buttons.push([btn('↩️ عرض العمل', 'admin_news')]);
  }
  buttons.push([btn('⬅️ إدارة المنصة', 'admin')]);
  buttons.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(buttons) });
}

/**
 * Actions for one news row, shaped by its lifecycle state.
 *
 * draft     -> Preview / Publish / Delete / Back
 * published -> View    / Archive / Delete / Back
 * archived  -> View    / Restore / Delete / Back
 *
 * `back` defaults to the listing that owns the row so an archived item returns
 * to the archive view and everything else to the working set.
 */
export function adminItemMenu(news, back = null) {
  const target =
    back ?? (news.status === 'archived' ? 'news_admin_archived' : 'admin_news');

  const rows = [];
  if (news.status === 'draft') {
    // A section news needs its real section before it can publish; a linked
    // resource is optional and offered separately.
    if (news.news_type === 'section') {
      if (!news.section_folder_id) {
        rows.push([btn('🗂 اختيار القسم', `news_ref_root:${news.id}:0`)]);
      } else {
        rows.push([btn('📢 نشر', `news_admin_pub:${news.id}`)]);
        // The subject is a distinct, explicit optional branch — never inferred
        // from the section's position in the tree.
        rows.push([btn('🧪 المادة (اختياري)', `news_ref_subject:${news.id}:0`)]);
      }
      if (news.resource_id) {
        rows.push([btn('🔗 تغيير المورد المرتبط', `news_ref_resource:${news.id}`)]);
        rows.push([btn('✂️ إلغاء ربط المورد', `news_ref_unlink:${news.id}`)]);
      } else {
        rows.push([btn('🔗 ربط مورد (اختياري)', `news_ref_resource:${news.id}`)]);
      }
    } else {
      rows.push([btn('📢 نشر', `news_admin_pub:${news.id}`)]);
    }
    rows.push([btn('👁 معاينة', `news_admin_preview:${news.id}`)]);
  } else if (news.status === 'published') {
    rows.push([btn('👁 عرض', `news_admin_preview:${news.id}`)]);
    rows.push([btn('🗄 أرشفة', `news_admin_archive:${news.id}`)]);
    rows.push([btn('📬 سجل التوصيل', `news_admin_deliveries:${news.id}`)]);
  } else if (news.status === 'archived') {
    rows.push([btn('👁 عرض', `news_admin_preview:${news.id}`)]);
    rows.push([btn('♻️ استرجاع كمسودة', `news_admin_restore:${news.id}`)]);
    rows.push([btn('📬 سجل التوصيل', `news_admin_deliveries:${news.id}`)]);
  }

  rows.push([btn('🗑 حذف', `news_admin_delete:${news.id}`)]);
  rows.push([btn('⬅️ رجوع', target)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);
  return keyboard(rows);
}

/** Admin manage view of one news row: status + lifecycle actions. */
export async function showAdminNewsItem(ctx, newsId, back = null) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let news;
  try {
    news = db.getNewsDetail(newsId);
  } catch {
    news = null;
  }

  if (!news) {
    await ctx.editMessageText('⚠️ الخبر غير موجود.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  // Scope gate: an out-of-scope news id must not expose its lifecycle actions.
  if (!authorization.can(ctx.from.id, 'news.view', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  const status = db.NEWS_STATUS_LABELS[news.status] ?? news.status;
  const language = await lang(ctx.from.id);
  const lines = detailLines(news, language);
  lines.splice(2, 0, `📊 ${esc(status)}`);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: adminItemMenu(news, back) });
}

/**
 * Render the student-facing view of a news row for an authorised admin.
 *
 * Read-only: nothing is marked read, and the lifecycle buttons stay reachable
 * so the admin can act right after reviewing.
 */
export async function previewAdminNews(ctx, newsId, back = 'admin_news') {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let news;
  try {
    news = db.getNewsDetail(newsId);
  } catch {
    news = null;
  }

  if (!news) {
    await ctx.editMessageText('⚠️ الخبر غير موجود.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  const language = await lang(ctx.from.id);
  const lines = ['🔎 <b>معاينة (كما يراها الطالب)</b>', ''];
  lines.push(...detailLines(news, language));

  const rows = detailAccessRows(news, language);
  rows.push(...adminItemMenu(news, back).inline_keyboard);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/**
 * Begin the "➕ Publish News" form.
 *
 * With no `newsType` the admin first chooses the kind; with a kind, the draft
 * wizard starts.
 *
 * Lands the row as a `draft` — nothing reaches students before an explicit
 * publish. The typed steps are: title → body → doctor (optional) → event
 * (optional), then a 📚 Section News item routes to the real section picker.
 * Section/resource references are never typed.
 */
export async function startCreateNews(ctx, newsType = null) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  // No kind chosen yet: show the type chooser, gated by the caller's scope.
  if (!newsType) {
    const scoped = isScopeRestricted(ctx.from.id);
    const rows = [
      [btn('🚨 هام / عاجل', 'news_new:notify')],
      [btn('📚 أخبار الأقسام', 'news_new:section')],
      [btn('❌ إلغاء', 'admin_news')],
      [btn('🏠 الرئيسية', 'home')],
    ];
    let note =
      '\n\n🚨 <b>هام / عاجل</b> متاح للمشرفين بصلاحية عامة على كل الأقسام فقط.\n' +
      '📚 <b>أخبار الأقسام</b> متاح لمشرفي الأقسام ضمن نطاقهم.';
    if (scoped) {
      note =
        '\n\nأدوارك تسمح بنشر 📚 <b>أخبار الأقسام</b> ضمن الأقسام المخصصة لك. ' +
        '🚨 الهام/العاجل يتطلب صلاحية عامة.';
    }
    await ctx.editMessageText(`➕ <b>نشر خبر</b>\n\nاختر نوع الخبر:${note}`, {
      reply_markup: keyboard(rows),
    });
    return;
  }

  if (!db.NEWS_TYPES.includes(newsType)) {
    await ctx.editMessageText('⚠️ نوع غير معروف.', { reply_markup: adminMenu() });
    return;
  }

  // A scope-restricted admin cannot author a platform-wide 🚨 notification: it
  // has no folder target, so it can never be placed inside their scope.
  if (newsType === 'notify' && isScopeRestricted(ctx.from.id)) {
    await ctx.editMessageText(
      '🚫 خبر «هام / عاجل» عام على مستوى المنصة ولا يقع داخل نطاق مسؤوليتك. ' +
        'استخدم 📚 أخبار الأقسام.',
      { reply_markup: keyboard([[btn('⬅️ الأخبار', 'admin_news')]]) },
    );
    return;
  }

  workflow.begin(ctx, NEWS_WORKFLOW);
  ctx.userData[STATE_TYPE] = newsType;
  for (const key of [STATE_TITLE, STATE_BODY, STATE_DOCTOR, STATE_EVENT, STATE_SECTION, STATE_RESOURCE]) {
    delete ctx.userData[key];
  }
  ctx.userData[STATE_STEP] = 'title';

  const label = db.NEWS_TYPE_LABELS[newsType] ?? newsType;
  const hint =
    {
      notify: 'مثال: محاضرة اليوم — 10:00 بقاعة 3.',
      section: 'اكتب عنوان خبر القسم، ثم اختر القسم الحقيقي من الشجرة.',
    }[newsType] ?? '';

  await ctx.editMessageText(
    `${db.NEWS_TYPE_ICONS[newsType] ?? '📰'} <b>خبر جديد — ${esc(label)}</b>\n\n` +
      '📋 <b>عنوان الخبر</b>\nأرسل عنوان الخبر في رسالة واحدة.\n' +
      (hint ? `\n${hint}\n` : '') +
      '\nلإلغاء العملية أرسل /cancel.',
    { reply_markup: keyboard([[btn('❌ إلغاء', 'admin_news')], [btn('🏠 الرئيسية', 'home')]]) },
  );
}

/** The step the wizard is currently waiting for, or '' when idle. */
export function wizardStep(ctx) {
  if (ctx.userData[STATE_TYPE] === undefined || ctx.userData[STATE_TYPE] === null) return '';
  const step = ctx.userData[STATE_STEP];
  if (!['title', 'body', 'doctor', 'event'].includes(step)) return '';
  return step;
}

/** Consume typed input for the admin news wizard. Returns handled. */
export async function handleNewsText(ctx) {
  const step = wizardStep(ctx);
  if (!step) return false;
  if (ctx.kind !== 'message' && ctx.kind !== 'media') return false;
  if (!workflow.owns(ctx, NEWS_WORKFLOW)) return false;

  if (!isManager(ctx.from.id)) {
    clearState(ctx);
    await ctx.reply('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return true;
  }

  const text = String(ctx.text ?? '').trim();
  const cancelMarkup = keyboard([[btn('❌ إلغاء', 'admin_news')], [btn('🏠 الرئيسية', 'home')]]);

  if (text === '/cancel') {
    clearState(ctx);
    await ctx.reply('❌ تم إلغاء العملية.', { reply_markup: cancelMarkup });
    return true;
  }

  const newsType = ctx.userData[STATE_TYPE];

  // ---- Step: title ---------------------------------------------------
  if (step === 'title') {
    ctx.userData[STATE_TITLE] = text;
    ctx.userData[STATE_STEP] = 'body';
    workflow.begin(ctx, NEWS_WORKFLOW);
    await ctx.reply(
      '📝 أرسل الآن نص الخبر كما سيظهر للطالب، أو أرسل /skip لتجاهله.\n\n' +
        'لإلغاء العملية أرسل /cancel.',
      { reply_markup: cancelMarkup },
    );
    return true;
  }

  // ---- Step: body ----------------------------------------------------
  if (step === 'body') {
    ctx.userData[STATE_BODY] = text === '/skip' ? null : text;
    ctx.userData[STATE_STEP] = 'doctor';
    await ctx.reply('👨‍⚕️ اذكر اسم الطبيب/المُرسل إن أردت، أو أرسل /skip.\n\nلإلغاء العملية أرسل /cancel.', {
      reply_markup: cancelMarkup,
    });
    return true;
  }

  // ---- Step: doctor --------------------------------------------------
  if (step === 'doctor') {
    ctx.userData[STATE_DOCTOR] = text === '/skip' ? null : text;
    ctx.userData[STATE_STEP] = 'event';
    await ctx.reply('📅 اذكر موعد الحدث/الاختبار إن وُجد، أو أرسل /skip.\n\nلإلغاء العملية أرسل /cancel.', {
      reply_markup: cancelMarkup,
    });
    return true;
  }

  // ---- Step: event -> create draft -----------------------------------
  ctx.userData[STATE_EVENT] = text === '/skip' ? null : text;

  const title = ctx.userData[STATE_TITLE];
  const body = ctx.userData[STATE_BODY];
  const doctor = ctx.userData[STATE_DOCTOR];
  const eventAt = ctx.userData[STATE_EVENT];
  delete ctx.userData[STATE_TITLE];
  delete ctx.userData[STATE_BODY];
  delete ctx.userData[STATE_DOCTOR];
  delete ctx.userData[STATE_EVENT];
  delete ctx.userData[STATE_TYPE];
  delete ctx.userData[STATE_STEP];

  if (!title) {
    await ctx.reply('⚠️ تعذّر إنشاء الخبر (عنوان مفقود).', { reply_markup: cancelMarkup });
    return true;
  }

  const newsId = db.createNews({
    newsType,
    title,
    body,
    doctor,
    eventAt,
    senderId: ctx.from.id,
    status: 'draft',
  });

  if (!newsId) {
    await ctx.reply('⚠️ تعذّر إنشاء الخبر. تحقق من العنوان والنص.', { reply_markup: cancelMarkup });
    return true;
  }

  await audit.logAction(ctx.from.id, 'news_create', {
    targetType: 'news',
    targetId: newsId,
    details: `type=${newsType}`,
  });

  // A section news must point at a real registry row before it can publish;
  // route straight to the picker so a bogus id can never be typed.
  const nextHint =
    newsType === 'section'
      ? 'اختر القسم الحقيقي من الشجرة أدناه.'
      : 'راجعها ثم اضغط 📢 نشر لإظهارها للطلاب.';

  await ctx.reply(`✅ تم إنشاء مسودة: <b>${esc(title)}</b>\n\n${nextHint}`, {
    reply_markup: keyboard([
      [btn('🔎 مراجعة الخبر', `news_admin_view:${newsId}`)],
      [btn('📰 الأخبار', 'admin_news')],
      [btn('🏠 الرئيسية', 'home')],
    ]),
  });
  return true;
}

function clearState(ctx) {
  for (const key of ALL_STATE_KEYS) delete ctx.userData[key];
}

/**
 * Publish a draft, then privately deliver it to subscribers.
 *
 * Publishing is authoritative: the row flips to `published` first. Delivery runs
 * after (best-effort) — a Telegram failure never rolls back the publish, it is
 * recorded per recipient and retryable from the delivery log.
 */
export async function publishDraft(ctx, newsId) {
  let news;
  try {
    news = db.getNewsDetail(newsId);
  } catch {
    news = null;
  }
  if (!news) {
    await ctx.editMessageText('⚠️ الخبر غير موجود.', { reply_markup: homeKeyboard() });
    return;
  }

  // Scope gate: publishing is a scoped operation.
  if (!authorization.can(ctx.from.id, 'news.publish', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأخبار', 'admin_news')]]),
    });
    return;
  }

  if (referenceMissingFor(news)) {
    await ctx.editMessageText('⚠️ لا يمكن النشر قبل اختيار القسم الحقيقي من المنصة.', {
      reply_markup: keyboard([
        [btn('⬅️ الخبر', `news_admin_view:${newsId}`)],
        [btn('🏠 الرئيسية', 'home')],
      ]),
    });
    return;
  }

  if (db.publishNews(newsId)) {
    await audit.logAction(ctx.from.id, 'news_publish', {
      targetType: 'news',
      targetId: newsId,
    });
    try {
      await newsDelivery.enqueuePublishDelivery(ctx.getBot(), newsId);
    } catch {
      // The publish already happened; a delivery failure is recorded per user.
    }
  }
  await showAdminNewsItem(ctx, newsId);
}

async function archiveItem(ctx, newsId) {
  if (!authorization.can(ctx.from.id, 'news.archive', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }
  if (db.archiveNews(newsId)) {
    await audit.logAction(ctx.from.id, 'news_archive', {
      targetType: 'news',
      targetId: newsId,
    });
  }
  await showAdminNewsItem(ctx, newsId);
}

async function restoreItem(ctx, newsId) {
  if (!authorization.can(ctx.from.id, 'news.archive', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }
  if (db.restoreNews(newsId)) {
    await audit.logAction(ctx.from.id, 'news_restore', {
      targetType: 'news',
      targetId: newsId,
    });
  }
  await showAdminNewsItem(ctx, newsId);
}

async function deleteItem(ctx, newsId) {
  if (!authorization.can(ctx.from.id, 'news.edit', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }
  if (db.deleteNews(newsId)) {
    await audit.logAction(ctx.from.id, 'news_delete', {
      targetType: 'news',
      targetId: newsId,
    });
  }
  await showAdminNews(ctx);
}

/**
 * Auto-generate (once) a 📚 Section News row for a registered resource.
 *
 * Integration hook for the resource system: called after a resource is
 * registered (admin upload / approved contribution). Strictly best-effort and
 * idempotent: never throws into the caller, creates at most one news row per
 * content id, lands it as `draft` and publishes it, then delivers to section
 * subscribers. Returns the news id, or null.
 */
export async function publishNewsForResource(bot, contentId, senderId = null) {
  let newsId;
  try {
    newsId = db.createResourceNewsForContent(contentId, senderId, 'draft');
  } catch {
    return null;
  }
  if (!newsId) return null;

  try {
    const existing = db.getNews(newsId);
    if (existing && existing.status === 'published') return newsId; // already handled
  } catch {
    // Fall through and try to publish.
  }

  try {
    db.publishNews(newsId);
  } catch {
    return newsId;
  }

  try {
    await newsDelivery.enqueuePublishDelivery(bot, newsId);
  } catch {
    // Delivery is failure-isolated.
  }

  return newsId;
}

// ---------------------------------------------------------------------------
// Admin reference pickers (real registry only)
// ---------------------------------------------------------------------------

/** Browse the live folder tree to set a section news' real reference. */
export async function pickSection(ctx, newsId, parentId = 0) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  // Scope gate: a scoped admin can only reference a folder they own.
  if (!authorization.can(ctx.from.id, 'news.edit', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  const scopedIds = scopedNewsIds(ctx.from.id);

  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
  }

  // Filter the browse tree to the admin's scope when restricted.
  if (scopedIds !== null) {
    const roots = db.topicFolderRoots(ctx.from.id);
    const allowed = db.listFolderIdsUnder(roots);
    folders = folders.filter((folder) => allowed.has(folder[0]));
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
    rows.push([
      btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 18)}`, `news_ref_child:${newsId}:${folderId}`),
      btn('✅ اختيار', `news_ref_set_section:${newsId}:${folderId}`),
    ]);
  }

  if (parentId) {
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `news_ref_root:${newsId}:${parent || 0}`)]);
  }

  rows.push([btn('⬅️ الخبر', `news_admin_view:${newsId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    '🗂 <b>اختيار القسم</b>\n\n' +
      `📍 ${esc(breadcrumb)}\n\n` +
      'تنقّل ثم اضغط «✅ اختيار» بجانب القسم الحقيقي للخبر.',
    { reply_markup: keyboard(rows) },
  );
}

/** Browse the live registry to set a resource news' real reference. */
export async function pickResource(ctx, newsId, folderId = null) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  // Scope gate: a scoped admin can only reference their own resources.
  if (!authorization.can(ctx.from.id, 'news.edit', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  const scoped = isScopeRestricted(ctx.from.id);
  let allowedFolders = null;
  if (scoped) {
    const roots = db.topicFolderRoots(ctx.from.id);
    allowedFolders = db.listFolderIdsUnder(roots);
  }

  const folderOk = (fid) => allowedFolders === null || allowedFolders.has(fid);

  const rows = [];

  if (folderId === null || folderId === undefined) {
    // Root listing: recent resources plus the entry folders to browse.
    const files = listAllContent().filter((file) => folderOk(file[1]));
    for (const [contentId, , title] of files.slice(0, 25)) {
      rows.push([
        btn(`📄 ${String(title).slice(0, 24)}`, `news_ref_set_resource:${newsId}:${contentId}`),
      ]);
    }
    let folders = [];
    try {
      folders = db.getFolders(0);
    } catch {
      folders = [];
    }
    folders = folders.filter((folder) => folderOk(folder[0]));
    for (const [fid, name, nodeType] of folders) {
      rows.push([
        btn(`📁 ${resourceIcon(nodeType)} ${String(name).slice(0, 20)}`, `news_ref_resource:${newsId}:${fid}`),
      ]);
    }
    rows.push([btn('⬅️ الخبر', `news_admin_view:${newsId}`)]);
    rows.push([btn('🏠 الرئيسية', 'home')]);

    await ctx.editMessageText(
      '🟢 <b>اختيار المورد</b>\n\n' + '📍 الرئيسية 🏠\n\n' + 'اختر موردًا موجودًا فعليًا من القائمة.',
      { reply_markup: keyboard(rows) },
    );
    return;
  }

  let files = [];
  try {
    files = db.getFiles(folderId);
  } catch {
    files = [];
  }
  for (const [contentId, title] of files.slice(0, 25)) {
    rows.push([
      btn(`📄 ${String(title).slice(0, 24)}`, `news_ref_set_resource:${newsId}:${contentId}`),
    ]);
  }

  let folders = [];
  try {
    folders = db.getFolders(folderId);
  } catch {
    folders = [];
  }
  folders = folders.filter((folder) => folderOk(folder[0]));
  for (const [fid, name, nodeType] of folders) {
    rows.push([
      btn(`📁 ${resourceIcon(nodeType)} ${String(name).slice(0, 20)}`, `news_ref_resource:${newsId}:${fid}`),
    ]);
  }

  let breadcrumb = String(folderId);
  try {
    breadcrumb = db.getBreadcrumbs(folderId);
  } catch {
    breadcrumb = String(folderId);
  }
  let parent = 0;
  try {
    parent = db.getParentId(folderId);
  } catch {
    parent = 0;
  }
  rows.push([
    btn('⬅️ رجوع', parent ? `news_ref_resource:${newsId}:${parent}` : `news_ref_resource:${newsId}`),
  ]);
  rows.push([btn('⬅️ الخبر', `news_admin_view:${newsId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    '🟢 <b>اختيار المورد</b>\n\n' +
      `📍 ${esc(breadcrumb)}\n\n` +
      'اختر موردًا موجودًا فعليًا من القائمة.',
    { reply_markup: keyboard(rows) },
  );
}

/** Point a section news at a real folder (validated server-side). */
export async function setSectionReference(ctx, newsId, rawFolderId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let news;
  try {
    news = db.getNews(newsId);
  } catch {
    news = null;
  }
  if (!news || news.news_type !== 'section') {
    await ctx.editMessageText('⚠️ الخبر غير موجود.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!authorization.can(ctx.from.id, 'news.edit', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  // Scope gate: the chosen folder must be inside the admin's responsibility.
  if (!authorization.can(ctx.from.id, 'news.edit', 'folder', rawFolderId)) {
    await ctx.editMessageText('🚫 هذا القسم خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الخبر', `news_admin_view:${newsId}`)]]),
    });
    return;
  }

  let folder;
  try {
    folder = db.getFolder(toIntOrNull(rawFolderId));
  } catch {
    folder = null;
  }
  if (!folder) {
    await ctx.editMessageText('⚠️ القسم غير موجود.', { reply_markup: homeKeyboard() });
    return;
  }

  // Store ONLY the section the author picked. `subject_folder_id` is a distinct,
  // explicitly chosen optional branch and is never guessed from the parent
  // depth: a section can be any real node (a year, a block or a leaf), so its
  // parent says nothing about what the subject is.
  let ok = false;
  try {
    ok = db.updateNews(newsId, { section_folder_id: folder[0] });
  } catch {
    ok = false;
  }

  if (ok) {
    await audit.logAction(ctx.from.id, 'news_reference', {
      targetType: 'news',
      targetId: newsId,
      details: `section=${folder[0]}`,
    });
  }
  await showAdminNewsItem(ctx, newsId);
}

/** Browse the live folder tree to set a section news' optional subject. */
export async function pickSubject(ctx, newsId, parentId = 0) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!authorization.can(ctx.from.id, 'news.edit', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  const scopedIds = scopedNewsIds(ctx.from.id);

  let folders = [];
  try {
    folders = db.getFolders(parentId);
  } catch {
    folders = [];
  }
  if (scopedIds !== null) {
    const roots = db.topicFolderRoots(ctx.from.id);
    const allowed = db.listFolderIdsUnder(roots);
    folders = folders.filter((folder) => allowed.has(folder[0]));
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
    rows.push([
      btn(`${resourceIcon(nodeType)} ${String(name).slice(0, 18)}`, `news_ref_subject:${newsId}:${folderId}`),
      btn('✅ اختيار', `news_ref_set_subject:${newsId}:${folderId}`),
    ]);
  }

  if (parentId) {
    let parent = 0;
    try {
      parent = db.getParentId(parentId);
    } catch {
      parent = 0;
    }
    rows.push([btn('⬅️ رجوع', `news_ref_subject:${newsId}:${parent || 0}`)]);
  }

  rows.push([btn('✂️ بدون مادة', `news_ref_unset_subject:${newsId}`)]);
  rows.push([btn('⬅️ الخبر', `news_admin_view:${newsId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(
    '🧪 <b>اختيار المادة (اختياري)</b>\n\n' +
      `📍 ${esc(breadcrumb)}\n\n` +
      'المادة فرع اختياري يختاره المؤلف صراحةً. تنقّل ثم اضغط «✅ اختيار»، أو اختر «بدون مادة».',
    { reply_markup: keyboard(rows) },
  );
}

/** Point a section news at an explicitly chosen subject, or clear it. */
export async function setSubjectReference(ctx, newsId, rawFolderId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!authorization.can(ctx.from.id, 'news.edit', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  const folderId = toIntOrNull(rawFolderId);

  // Clearing the optional subject is a normal edit, not a scope breach.
  if (folderId === null) {
    let cleared = false;
    try {
      cleared = db.updateNews(newsId, { subject_folder_id: null });
    } catch {
      cleared = false;
    }
    if (cleared) {
      await audit.logAction(ctx.from.id, 'news_reference', {
        targetType: 'news',
        targetId: newsId,
        details: 'subject=unlinked',
      });
    }
    await showAdminNewsItem(ctx, newsId);
    return;
  }

  if (!authorization.can(ctx.from.id, 'news.edit', 'folder', folderId)) {
    await ctx.editMessageText('🚫 هذه المادة خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الخبر', `news_admin_view:${newsId}`)]]),
    });
    return;
  }

  let folder;
  try {
    folder = db.getFolder(folderId);
  } catch {
    folder = null;
  }
  if (!folder) {
    await ctx.editMessageText('⚠️ المادة غير موجودة.', { reply_markup: homeKeyboard() });
    return;
  }

  let ok = false;
  try {
    ok = db.updateNews(newsId, { subject_folder_id: folder[0] });
  } catch {
    ok = false;
  }

  if (ok) {
    await audit.logAction(ctx.from.id, 'news_reference', {
      targetType: 'news',
      targetId: newsId,
      details: `subject=${folder[0]}`,
    });
  }
  await showAdminNewsItem(ctx, newsId);
}

/** Point a section news at a real content row (validated server-side). */
export async function setResourceReference(ctx, newsId, rawContentId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!authorization.can(ctx.from.id, 'news.edit', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ إدارة الأخبار', 'admin_news')]]),
    });
    return;
  }

  // Scope gate: the chosen resource must be inside the admin's responsibility.
  if (!authorization.can(ctx.from.id, 'news.edit', 'resource', rawContentId)) {
    await ctx.editMessageText('🚫 هذا المورد خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الخبر', `news_admin_view:${newsId}`)]]),
    });
    return;
  }

  let record;
  try {
    record = db.getFileRecord(toIntOrNull(rawContentId));
  } catch {
    record = null;
  }
  if (!record) {
    await ctx.editMessageText('⚠️ المورد غير موجود.', { reply_markup: homeKeyboard() });
    return;
  }

  let ok = false;
  try {
    ok = db.updateNews(newsId, { resource_id: record[0] });
  } catch {
    ok = false;
  }

  if (ok) {
    await audit.logAction(ctx.from.id, 'news_reference', {
      targetType: 'news',
      targetId: newsId,
      details: `resource=${record[0]}`,
    });
  }
  await showAdminNewsItem(ctx, newsId);
}

/**
 * Remove the optional resource link from a Section News item.
 *
 * A linked resource is optional metadata, so clearing it is a normal edit
 * (audited), not a lifecycle change. The item's real section reference is
 * untouched.
 */
export async function unlinkResourceReference(ctx, newsId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!authorization.can(ctx.from.id, 'news.edit', 'news', newsId)) {
    await ctx.editMessageText('🚫 هذا الخبر خارج نطاق مسؤوليتك.', {
      reply_markup: keyboard([[btn('⬅️ الأخبار', 'admin_news')]]),
    });
    return;
  }

  let ok = false;
  try {
    ok = db.updateNews(newsId, { resource_id: null });
  } catch {
    ok = false;
  }

  if (ok) {
    await audit.logAction(ctx.from.id, 'news_reference', {
      targetType: 'news',
      targetId: newsId,
      details: 'resource=unlinked',
    });
  }
  await showAdminNewsItem(ctx, newsId);
}

/** Admin view of one item's private-delivery log (counts + recent rows). */
export async function showNewsDeliveries(ctx, newsId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  let counts = {};
  let rowsData = [];
  try {
    counts = db.getNewsDeliveryCounts(newsId);
    rowsData = db.getNewsDeliveries(newsId, null, 30);
  } catch {
    counts = {};
    rowsData = [];
  }

  const lines = [
    '📬 <b>سجل التوصيل</b>',
    '',
    `✅ منشور: ${counts.sent ?? 0}  ·  ⏳ معلّق: ${counts.pending ?? 0}` +
      `  ·  📤 قيد الإرسال: ${counts.sending ?? 0}  ·  ⚠️ فشل: ${counts.failed ?? 0}`,
  ];

  if (rowsData.length) {
    lines.push('');
    for (const row of rowsData) {
      lines.push(`• <code>${row.user_id}</code> — ${esc(row.status)} (${row.attempts})`);
    }
  }

  const rows = [];
  if (counts.failed || counts.pending) {
    rows.push([btn('🔁 إعادة المحاولة', `news_admin_retry:${newsId}`)]);
  }
  rows.push([btn('⬅️ الخبر', `news_admin_view:${newsId}`)]);
  rows.push([btn('🏠 الرئيسية', 'home')]);

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard(rows) });
}

/** Retry the pending/failed deliveries of one item (never resent). */
export async function retryDeliveries(ctx, newsId) {
  if (!isManager(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  try {
    const result = await newsDelivery.retryFailed(ctx.getBot(), newsId);
    if (result.sent || result.failed) {
      await audit.logAction(ctx.from.id, 'news_delivery_retry', {
        targetType: 'news',
        targetId: newsId,
        details: `sent=${result.sent}, failed=${result.failed}`,
      });
    }
  } catch {
    // A retry failure is surfaced by the refreshed delivery log.
  }

  await showNewsDeliveries(ctx, newsId);
}

// ---------------------------------------------------------------------------
// Callback dispatch
// ---------------------------------------------------------------------------

/** True when the News Center is hidden for this caller (admins bypass). */
async function newsHiddenFor(ctx) {
  try {
    if (db.isUserAdmin(ctx.from.id)) return false;
    if (!db.isFeatureHidden('news')) return false;
  } catch {
    return false;
  }

  await ctx.editMessageText('🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.', {
    reply_markup: homeKeyboard(),
  });
  return true;
}

export async function newsCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  // ---- Public (student) ------------------------------------------
  if (data === 'news') {
    if (await newsHiddenFor(ctx)) return;
    await showNewsFeed(ctx);
    return;
  }

  if (data.startsWith('news_open:')) {
    if (await newsHiddenFor(ctx)) return;
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await openNews(ctx, newsId);
    return;
  }

  if (data.startsWith('news_more:')) {
    if (await newsHiddenFor(ctx)) return;
    await showNewsFeed(ctx, { page: tailInt(data) ?? 0 });
    return;
  }

  if (data.startsWith('news_filter:')) {
    if (await newsHiddenFor(ctx)) return;
    const newsType = data.split(':')[1];
    await showNewsFeed(ctx, { newsType: newsType === 'all' ? null : newsType });
    return;
  }

  if (data === 'news_readall') {
    if (await newsHiddenFor(ctx)) return;
    await markAllRead(ctx);
    return;
  }

  if (data === 'news_subs' || data === 'news_subs_back') {
    if (await newsHiddenFor(ctx)) return;
    await showSubscriptions(ctx);
    return;
  }

  if (data.startsWith('news_sub:')) {
    if (await newsHiddenFor(ctx)) return;
    await toggleSubscription(ctx, data.split(':')[1]);
    return;
  }

  if (data === 'news_subs_sections') {
    if (await newsHiddenFor(ctx)) return;
    await showSectionSubscriptions(ctx);
    return;
  }

  if (data.startsWith('news_subs_section:')) {
    if (await newsHiddenFor(ctx)) return;
    await toggleSectionSubscription(ctx, data.split(':')[1]);
    return;
  }

  if (data.startsWith('news_pick_child:')) {
    if (await newsHiddenFor(ctx)) return;
    await showSectionSubscriptions(ctx, tailInt(data) ?? 0);
    return;
  }

  if (data.startsWith('news_pick_root:')) {
    if (await newsHiddenFor(ctx)) return;
    await showSectionSubscriptions(ctx, tailInt(data) ?? 0);
    return;
  }

  // ---- Admin -----------------------------------------------------
  if (data === 'admin_news') {
    await showAdminNews(ctx, 'menu');
    return;
  }
  if (data === 'news_admin_all') {
    await showAdminNews(ctx, 'all');
    return;
  }
  if (data === 'news_admin_published') {
    await showAdminNews(ctx, 'published');
    return;
  }
  if (data === 'news_admin_archived') {
    await showAdminNews(ctx, 'archived');
    return;
  }
  if (data === 'news_new') {
    await startCreateNews(ctx);
    return;
  }
  if (data.startsWith('news_new:')) {
    await startCreateNews(ctx, data.split(':')[1]);
    return;
  }

  if (data.startsWith('news_admin_view:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await showAdminNewsItem(ctx, newsId);
    return;
  }

  if (data.startsWith('news_admin_preview:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await previewAdminNews(ctx, newsId);
    return;
  }

  if (data.startsWith('news_admin_pub:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await publishDraft(ctx, newsId);
    return;
  }

  if (data.startsWith('news_admin_archive:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await archiveItem(ctx, newsId);
    return;
  }

  if (data.startsWith('news_admin_restore:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await restoreItem(ctx, newsId);
    return;
  }

  if (data.startsWith('news_admin_delete:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    if (!isManager(ctx.from.id)) {
      await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
      return;
    }
    await deleteItem(ctx, newsId);
    return;
  }

  if (data.startsWith('news_admin_deliveries:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await showNewsDeliveries(ctx, newsId);
    return;
  }

  if (data.startsWith('news_admin_retry:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await retryDeliveries(ctx, newsId);
    return;
  }

  // ---- Admin reference pickers (real registry only) ---------------
  if (data.startsWith('news_ref_child:')) {
    const [, newsId, folderId] = threeParts(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await pickSection(ctx, newsId, folderId ?? 0);
    return;
  }

  if (data.startsWith('news_ref_root:')) {
    const [, newsId, folderId] = threeParts(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await pickSection(ctx, newsId, folderId ?? 0);
    return;
  }

  if (data.startsWith('news_ref_set_section:')) {
    const [, newsId, folderId] = threeParts(data);
    if (newsId === null || folderId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await setSectionReference(ctx, newsId, folderId);
    return;
  }

  if (data.startsWith('news_ref_set_subject:')) {
    const [, newsId, folderId] = threeParts(data);
    if (newsId === null || folderId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await setSubjectReference(ctx, newsId, folderId);
    return;
  }

  if (data.startsWith('news_ref_subject:')) {
    const [, newsId, folderId] = threeParts(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await pickSubject(ctx, newsId, folderId ?? 0);
    return;
  }

  if (data.startsWith('news_ref_unset_subject:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await setSubjectReference(ctx, newsId, null);
    return;
  }

  if (data.startsWith('news_ref_set_resource:')) {
    const [, newsId, contentId] = threeParts(data);
    if (newsId === null || contentId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await setResourceReference(ctx, newsId, contentId);
    return;
  }

  if (data.startsWith('news_ref_unlink:')) {
    const newsId = tailInt(data);
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await unlinkResourceReference(ctx, newsId);
    return;
  }

  if (data.startsWith('news_ref_resource:')) {
    // Optional folder id: "news_ref_resource:<news_id>" or ":<news_id>:<fid>"
    const parts = data.split(':');
    const newsId = parts.length > 1 ? toIntOrNull(parts[1]) : null;
    const folderId = parts.length > 2 ? toIntOrNull(parts[2]) : null;
    if (newsId === null) {
      await ctx.editMessageText('⚠️ معرف غير صالح.', { reply_markup: homeKeyboard() });
      return;
    }
    await pickResource(ctx, newsId, folderId);
    return;
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
}
