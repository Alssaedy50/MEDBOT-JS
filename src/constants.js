/**
 * MEDBOT domain constants — the single source of truth for the data model.
 *
 * Mirrors the Python MEDBOT `database.py` constants exactly so the two
 * implementations cannot drift: roles, capabilities, scoped permissions,
 * scope types, features, news kinds/lifecycle, subscriptions, delivery
 * states, contribution/message lifecycle and platform settings.
 */

// ---------------------------------------------------------------------------
// Database location
// ---------------------------------------------------------------------------
export const DEFAULT_DB_NAME = 'medbot_v2.sqlite3';
export const DB_PATH_ENV_VAR = 'MEDBOT_DB_PATH';

// ---------------------------------------------------------------------------
// Assistant daily allowance
// ---------------------------------------------------------------------------
// Mirrors Python `main.py` DAILY_LIMIT. The same figure is used for the
// pre-generation quota check and the quota screen, so the two cannot disagree.
export const AI_DAILY_LIMIT = 25;

// ---------------------------------------------------------------------------
// RBAC — roles and capabilities
// ---------------------------------------------------------------------------
// 'none' keeps the row (and username) but revokes admin access.
export const ADMIN_ROLES = Object.freeze(['owner', 'admin', 'reviewer']);
export const ROLES = Object.freeze([...ADMIN_ROLES, 'none']);

export const PERMISSION_KEYS = Object.freeze([
  'can_folders',
  'can_content',
  'can_contributions',
  'can_messages',
  'can_ai',
  'can_admins',
  'can_notifications',
  'can_settings',
  'can_topics',
  'can_visibility',
  'can_archive',
  'can_news',
]);

// Stored in `admins.permissions` to mean "explicitly granted nothing". An
// empty column instead means "legacy row, keep full access".
export const PERMISSIONS_NONE = 'none';

export const PERMISSION_LABELS = Object.freeze({
  can_folders: '📁 إدارة المجلدات',
  can_content: '📄 إدارة المحتوى',
  can_contributions: '📥 مراجعة المساهمات',
  can_messages: '📬 رسائل الطلاب',
  can_ai: '🤖 الذكاء الاصطناعي',
  can_admins: '👥 إدارة المشرفين',
  can_notifications: '🔔 الإشعارات',
  can_settings: '⚙️ إعدادات المنصة',
  can_topics: '🧭 مواضيع البحث',
  can_visibility: '🙈 إظهار/إخفاء الأقسام',
  can_archive: '🗄 أرشيف الطوارئ',
  can_news: '📰 الأخبار',
});

export const PERMISSION_SHORT_LABELS = Object.freeze({
  can_folders: 'الأقسام',
  can_content: 'المحتوى',
  can_contributions: 'المساهمات',
  can_messages: 'الرسائل',
  can_ai: 'الذكاء',
  can_admins: 'المشرفون',
  can_notifications: 'الإشعارات',
  can_settings: 'الإعدادات',
  can_topics: 'المواضيع',
  can_visibility: 'الإظهار',
  can_archive: 'الأرشيف',
  can_news: 'الأخبار',
});

export const ROLE_LABELS = Object.freeze({
  owner: '👑 المالك',
  admin: '🛡 مشرف',
  reviewer: '🔎 مراجع',
  none: '⛔ مُلغى',
});

// Roles an actor may assign from the admin-management UI. The `owner` role is
// deliberately excluded: it is reached only through the explicit, audited
// `transferOwnership` operation, which guarantees exactly one owner.
export const ROLE_ASSIGNABLE = Object.freeze(['admin', 'reviewer', 'none']);

export const ROLE_PERMISSION_PRESETS = Object.freeze({
  owner: Object.freeze(
    Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true])),
  ),
  admin: Object.freeze(
    Object.fromEntries(PERMISSION_KEYS.map((key) => [key, key !== 'can_admins'])),
  ),
  reviewer: Object.freeze(
    Object.fromEntries(
      PERMISSION_KEYS.map((key) => [
        key,
        key === 'can_contributions' || key === 'can_messages',
      ]),
    ),
  ),
  none: Object.freeze(
    Object.fromEntries(PERMISSION_KEYS.map((key) => [key, false])),
  ),
});

export const ROLE_DESCRIPTIONS = Object.freeze({
  owner:
    '👑 المالك — حساب واحد فقط في المنصة.\n' +
    '• كل الصلاحيات بلا استثناء، بما فيها إدارة المشرفين ونقل الملكية.\n' +
    '• لا يمكن إلغاؤه أو تخفيضه دون تعيين مالك جديد أولاً.',
  admin:
    '🛡 مشرف — مدير منصة مفوّض.\n' +
    '• إدارة الأقسام والمحتوى، مراجعة المساهمات، رسائل الطلاب،\n' +
    '  الذكاء الاصطناعي، الإشعارات، الإعدادات، المواضيع، وإظهار/إخفاء الأقسام.\n' +
    '• لا يملك إدارة المشرفين ولا نقل الملكية.',
  reviewer:
    '🔎 مراجع — دور للمراجعة فقط.\n' +
    '• مراجعة المساهمات والرد على رسائل الطلاب.\n' +
    '• لا يملك أي تعديل على الأقسام أو المحتوى أو الإعدادات.',
  none:
    '⛔ مُلغى — تم سحب وصول المشرف مع الاحتفاظ بالبيانات.\n' +
    '• لا يملك أي صلاحية إدارية.',
});

// ---------------------------------------------------------------------------
// Phase 3 — Scoped RBAC
// ---------------------------------------------------------------------------
// The coarse `PERMISSION_KEYS` remain the single source of truth for "can this
// admin reach this surface at all". The scope layer adds a finer, scope-aware
// decision on top: a named operation maps to exactly one coarse key and is
// evaluated against a target object by `authorization.can()`.
//
// `authorization.js` is the ONLY place that combines the two. An unknown
// operation is denied.
export const SCOPED_PERMISSIONS = Object.freeze([
  'resource.view',
  'resource.create',
  'resource.edit',
  'resource.delete',
  'news.view',
  'news.create',
  'news.edit',
  'news.publish',
  'news.archive',
  'section.view',
  'section.manage',
  'contribution.review',
  'notification.send',
  'ai_registry.manage',
]);

export const SCOPED_PERMISSION_COARSE = Object.freeze({
  'resource.view': 'can_content',
  'resource.create': 'can_content',
  'resource.edit': 'can_content',
  'resource.delete': 'can_content',
  'news.view': 'can_news',
  'news.create': 'can_news',
  'news.edit': 'can_news',
  'news.publish': 'can_news',
  'news.archive': 'can_news',
  'section.view': 'can_folders',
  'section.manage': 'can_folders',
  'contribution.review': 'can_contributions',
  'notification.send': 'can_notifications',
  'ai_registry.manage': 'can_ai',
});

export const SCOPED_PERMISSION_LABELS = Object.freeze({
  'resource.view': '👁 عرض الموارد',
  'resource.create': '➕ إنشاء مورد',
  'resource.edit': '✏️ تعديل مورد',
  'resource.delete': '🗑 حذف مورد',
  'news.view': '👁 عرض الأخبار',
  'news.create': '📝 إنشاء خبر',
  'news.edit': '✏️ تعديل خبر',
  'news.publish': '📢 نشر خبر',
  'news.archive': '🗄 أرشفة خبر',
  'section.view': '👁 عرض الأقسام',
  'section.manage': '🗂 إدارة الأقسام',
  'contribution.review': '📥 مراجعة المساهمات',
  'notification.send': '🔔 إرسال إشعار',
  'ai_registry.manage': '🤖 إدارة AI Registry',
});

// Scope target kinds. A scope restricts an admin to a real registry object:
//   folder   -> that folder and all of its descendants
//   topic    -> every folder linked to that Search Topic (and descendants)
//   resource -> that one content row
// `folder`/`resource` reference the existing `folders`/`content` tables — no
// second hierarchy is introduced. `topic` references the existing `topics`.
export const SCOPE_TYPES = Object.freeze(['folder', 'topic', 'resource']);

export const SCOPE_TYPE_LABELS = Object.freeze({
  folder: '🗂 قسم',
  topic: '🧭 موضوع',
  resource: '📄 مورد',
});

// ---------------------------------------------------------------------------
// Public navigation features (hide/show from the home page)
// ---------------------------------------------------------------------------
export const FEATURES = Object.freeze([
  'resources',
  'assistant',
  'contributions',
  'my_contributions',
  'account',
  'topics',
  'news',
  'language',
  'contact',
  'about',
  'admin_panel',
]);

export const FEATURE_LABELS = Object.freeze({
  resources: '📚 موارد المنصة',
  assistant: '🤖 المساعد',
  contributions: '📤 مساهمات الطلاب',
  my_contributions: '📄 مساهماتي',
  account: '📊 حسابي',
  topics: '🧭 المواضيع',
  news: '📰 الأخبار',
  language: '🌐 اللغة',
  contact: '📬 تواصل مع المنصة',
  about: 'ℹ️ عن المنصة',
  admin_panel: '🛠 إدارة المنصة (دخول المشرفين)',
});

export const SETTING_HIDDEN_FEATURES = 'hidden_features';

// ---------------------------------------------------------------------------
// Platform settings (admin-editable identity / interface content)
// ---------------------------------------------------------------------------
export const PLATFORM_SETTING_KEYS = Object.freeze([
  'platform_name',
  'platform_about',
  'welcome_message',
  'help_text',
  'contact_text',
]);

export const PLATFORM_SETTING_DEFAULTS = Object.freeze({
  platform_name: 'MEDBOT',
  platform_about:
    'MEDBOT منصة أكاديمية طبية عبر Telegram لتنظيم والوصول إلى ' +
    'الموارد التعليمية الطبية المسجلة.',
  welcome_message: 'مرحباً بك في MEDBOT.',
  help_text:
    'استخدم 📚 الموارد للوصول إلى المكتبة، و🔎 البحث للبحث داخل ' +
    'الموارد المسجلة، و🤖 المساعد للأسئلة الطبية.',
  contact_text: 'تواصل مع المنصة',
});

export const PLATFORM_SETTING_LABELS = Object.freeze({
  platform_name: '🏷 اسم المنصة',
  platform_about: 'ℹ️ نبذة عن المنصة',
  welcome_message: '👋 رسالة الترحيب',
  help_text: '❓ نص المساعدة',
  contact_text: '📮 نص التواصل',
});

export const SETTINGS_MAX_LENGTH = 1500;

// ---------------------------------------------------------------------------
// User language preference (i18n)
// ---------------------------------------------------------------------------
export const SUPPORTED_LANGUAGES = Object.freeze(['ar', 'en']);
export const DEFAULT_LANGUAGE = 'ar';
export const LANGUAGE_LABELS = Object.freeze({
  ar: '🇸🇦 العربية',
  en: '🇬🇧 English',
});

// Persisted owner identity. Set by an explicit ownership transfer so a restart
// (which re-asserts ADMIN_ID) can never silently revert the transfer.
export const SETTING_OWNER_ID = 'owner_id';
// The ADMIN_ID that was last bootstrapped. Lets a restart (same configured id)
// preserve an explicit ownership transfer, while a genuine ADMIN_ID change
// still re-asserts the newly configured owner.
export const SETTING_CONFIGURED_ADMIN = 'configured_admin_id';

// ---------------------------------------------------------------------------
// News Core (الأخبار)
// ---------------------------------------------------------------------------
// Two independent, first-class news kinds:
//   notify  -> 🚨 Important / Urgent
//   section -> 📚 Section News
//
// A resource, explanation post or announcement is NOT a separate news kind: it
// is an optional *linked reference* on a Section News item. The legacy
// `resource` kind is still recognised on read/migration so old rows keep
// working, but nothing new is ever created with it.
export const NEWS_TYPES = Object.freeze(['notify', 'section']);
export const LEGACY_NEWS_TYPES = Object.freeze(['resource']);
export const NEWS_TYPE_ALIASES = Object.freeze({ resource: 'section' });

export const NEWS_TYPE_LABELS = Object.freeze({
  notify: '🚨 هام / عاجل',
  section: '📚 أخبار الأقسام',
  // Legacy display label for an un-migrated row.
  resource: '📚 أخبار الأقسام',
});

export const NEWS_TYPE_ICONS = Object.freeze({
  notify: '🚨',
  section: '📚',
  resource: '📚',
});

// Lifecycle. `draft` is the preview stage, `published` is visible in the News
// Center, `archived` is hidden but kept.
export const NEWS_STATUSES = Object.freeze(['draft', 'published', 'archived']);

export const NEWS_STATUS_LABELS = Object.freeze({
  draft: '📝 مسودة',
  published: '✅ منشور',
  archived: '🗄 مؤرشف',
});

export const NEWS_VISIBILITIES = Object.freeze(['all', 'students']);
export const NEWS_DELIVERY_SCOPES = Object.freeze(['all', 'subscribed']);

// Subscriptions live in `news_subscriptions(user_id, topic_kind, topic_value)`.
// `type` subscribes to a whole news kind; `section` subscribes to one real
// folder (topic_value is the folder id as text). No new taxonomy is introduced:
// a section is a folder.
export const NEWS_SUB_TYPE = 'type';
export const NEWS_SUB_SECTION = 'section';
export const NEWS_SUB_KINDS = Object.freeze([NEWS_SUB_TYPE, NEWS_SUB_SECTION]);

// Private delivery lifecycle per (news, user). `skipped` records a recipient
// who was no longer relevant at send time; `failed` is retryable. `sending` is
// a transient claim written *before* the Telegram call so a crash mid-send is
// recoverable without a false "sent".
export const NEWS_DELIVERY_STATUSES = Object.freeze([
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
]);

// A `sending` claim older than this is treated as a crashed attempt and reset
// to `pending` on recovery.
export const NEWS_DELIVERY_STALE_SECONDS = 900;

// `news.source` value for a resource-generated news row.
export const NEWS_SOURCE_AUTO = 'resource';

export const MAX_NEWS_TITLE_LENGTH = 200;
export const MAX_NEWS_BODY_LENGTH = 3000;
export const MAX_NEWS_DOCTOR_LENGTH = 120;
export const MAX_NEWS_EVENT_LENGTH = 120;

// Default page size for the chronological News Center feed.
export const NEWS_PAGE_SIZE = 5;

// ---------------------------------------------------------------------------
// Contribution review workflow
// ---------------------------------------------------------------------------
export const CONTRIBUTION_STATUSES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'needs_revision',
]);
export const REVIEWABLE_STATUSES = Object.freeze(['pending', 'needs_revision']);

export const MAX_CONTRIBUTION_TITLE_LENGTH = 200;
export const MAX_CONTRIBUTION_FILE_ID_LENGTH = 512;
export const CONTRIBUTION_FILE_TYPES = Object.freeze([
  'document',
  'audio',
  'video',
  'photo',
]);

// ---------------------------------------------------------------------------
// Contact Admin messaging
// ---------------------------------------------------------------------------
export const MESSAGE_CATEGORIES = Object.freeze([
  'message',
  'summary',
  'suggestion',
  'report',
]);

export const MESSAGE_CATEGORY_LABELS = Object.freeze({
  message: '💬 رسالة',
  summary: '📑 ملخص',
  suggestion: '💡 اقتراح',
  report: '🚩 بلاغ',
});

export const MESSAGE_STATUSES = Object.freeze([
  'NEW',
  'IN_REVIEW',
  'REPLIED',
  'CLOSED',
]);
export const MESSAGE_OPEN_STATUSES = Object.freeze(['NEW', 'IN_REVIEW']);

export const MESSAGE_STATUS_LABELS = Object.freeze({
  NEW: '🆕 جديدة',
  IN_REVIEW: '👀 قيد المراجعة',
  REPLIED: '✅ تم الرد',
  CLOSED: '🔒 مغلقة',
});

export const MAX_MESSAGE_BODY_LENGTH = 1500;
export const MAX_MESSAGE_REPLY_LENGTH = 1500;

// ---------------------------------------------------------------------------
// Emergency Resource Archive
// ---------------------------------------------------------------------------
export const ARCHIVE_STATUSES = Object.freeze([
  'pending',
  'published',
  'failed',
  'skipped',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a stored/legacy news kind onto its canonical kind. */
export function normalizeNewsType(newsType) {
  const value = String(newsType ?? '').trim();
  return NEWS_TYPE_ALIASES[value] ?? value;
}

/** Serialise a permission mapping to the stored comma-separated form. */
export function permissionsToString(permissions) {
  if (!permissions) return '';
  if (typeof permissions === 'string') return permissions;
  const granted = PERMISSION_KEYS.filter((key) => permissions[key]);
  if (!granted.length) return PERMISSIONS_NONE;
  return granted.join(',');
}

/**
 * Parse stored permissions.
 *
 * Empty/null means "all granted" (pre-migration admins keep full access).
 * The `PERMISSIONS_NONE` sentinel means "explicitly granted nothing".
 */
export function permissionsFromString(raw) {
  if (raw === null || raw === undefined || !String(raw).trim()) {
    return defaultPermissions();
  }
  if (String(raw).trim() === PERMISSIONS_NONE) {
    return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, false]));
  }
  const granted = new Set(
    String(raw)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
  return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, granted.has(key)]));
}

export function defaultPermissions() {
  return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true]));
}

/** Coerce a value to an integer, or null when it is not numeric. */
export function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}
