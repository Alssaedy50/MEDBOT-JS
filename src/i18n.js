/**
 * Centralised localization (i18n) for MEDBOT.
 *
 * One table of canonical keys -> {ar, en}. Callers resolve text with
 * `t(key, lang)`; they never branch on the language themselves, so adding a
 * language is a one-place change rather than a hunt for scattered `if lang`
 * conditions.
 *
 * Unknown keys fall back to the key itself and never throw, so a missing
 * translation degrades to something visible instead of breaking a handler.
 */

export const DEFAULT_LANGUAGE = 'ar';

const TRANSLATIONS = {
  // ---- Generic -------------------------------------------------------
  home: { ar: '🏠 الرئيسية', en: '🏠 Home' },
  back: { ar: '⬅️ رجوع', en: '⬅️ Back' },
  cancel: { ar: '❌ إلغاء', en: '❌ Cancel' },
  unauthorized: { ar: '🔒 غير مصرح.', en: '🔒 Unauthorized.' },
  done: { ar: '✅ تم بنجاح.', en: '✅ Done.' },
  not_found: { ar: '⚠️ العنصر غير موجود.', en: '⚠️ Not found.' },
  admin_only: {
    ar: '🔒 هذه المنطقة مخصصة للمشرفين المعتمدين فقط.',
    en: '🔒 This area is for authorized admins only.',
  },
  cancel_operation: { ar: '❌ تم إلغاء العملية الجارية.', en: '❌ Operation cancelled.' },
  no_operation: { ar: 'ℹ️ لا توجد عملية قيد التنفيذ.', en: 'ℹ️ No operation in progress.' },

  // ---- Main menu / welcome ------------------------------------------
  menu_resources: { ar: '📚 موارد المنصة', en: '📚 Resources' },
  menu_assistant: { ar: '🤖 المساعد', en: '🤖 Assistant' },
  menu_contributions: { ar: '📤 مساهمات الطلاب', en: '📤 Student Contributions' },
  menu_my_contributions: { ar: '📄 مساهماتي', en: '📄 My Contributions' },
  menu_account: { ar: '📊 حسابي', en: '📊 My Account' },
  menu_contact: { ar: '📬 تواصل مع المنصة', en: '📬 Contact' },
  menu_about: { ar: 'ℹ️ عن المنصة', en: 'ℹ️ About' },
  menu_admin: { ar: '🛠 إدارة المنصة', en: '🛠 Administration' },
  menu_topics: { ar: '🧭 المواضيع', en: '🧭 Topics' },
  menu_language: { ar: '🌐 اللغة', en: '🌐 Language' },
  menu_news: { ar: '📰 الأخبار', en: '📰 News' },

  welcome: {
    ar: '🩺 *{platform}*\n\nمرحباً بك دكتور {name}.\n\n' +
      'منصة أكاديمية طبية تساعدك على الوصول إلى الموارد المسجلة ' +
      'والبحث فيها واستخدام المساعد الذكي ضمن محتوى المنصة.\n\n' +
      'اختر الخدمة التي تريد استخدامها:',
    en: '🩺 *{platform}*\n\nWelcome, Dr. {name}.\n\n' +
      'A medical academic platform for reaching and searching the ' +
      'registered resources and using the assistant within the platform ' +
      'content.\n\nChoose a service:',
  },
  choose_service: { ar: 'اختر الخدمة التي تريد استخدامها:', en: 'Choose a service:' },
  welcome_greeting: {
    ar: 'مرحباً بك دكتور {name}.',
    en: 'Welcome, Dr. {name}.',
  },

  // ---- Account / language -------------------------------------------
  account_title: { ar: '📊 *حسابي*', en: '📊 *My Account*' },
  account_language: { ar: '🌐 اللغة', en: '🌐 Language' },
  language_title: {
    ar: '🌐 *اختيار اللغة*\n\nاختر لغة واجهة المنصة.',
    en: '🌐 *Language*\n\nChoose the platform interface language.',
  },
  language_saved: {
    ar: '✅ تم حفظ اللغة: 🇸🇦 العربية',
    en: '✅ Language saved: 🇬🇧 English',
  },

  // ---- Search / topics ---------------------------------------------
  topics_title: {
    ar: '🧭 *مواضيع البحث*\n\nاختر موضوعاً للوصول السريع إلى الموارد المسجلة:',
    en: '🧭 *Search Topics*\n\nChoose a topic for quick access to registered resources:',
  },
  topics_empty: {
    ar: 'ℹ️ لا توجد مواضيع مسجلة حالياً.',
    en: 'ℹ️ No topics registered yet.',
  },
  topic_open_title: {
    ar: '🧭 *{name}*\n\nاختر القسم الذي تريد فتحه:',
    en: '🧭 *{name}*\n\nChoose a section to open:',
  },
  topic_no_sections: {
    ar: 'ℹ️ لا توجد أقسام مرتبطة بهذا الموضوع بعد.',
    en: 'ℹ️ No sections linked to this topic yet.',
  },
  topic_choose_section: {
    ar: 'اختر القسم الذي تريد فتحه:',
    en: 'Choose a section to open:',
  },
  topic_unavailable: {
    ar: '⚠️ الموضوع غير متاح.',
    en: '⚠️ This topic is unavailable.',
  },
  topics_open_resources: { ar: '🔎 فتح المصادر', en: '🔎 Open resources' },
  search_empty: {
    ar: 'المورد المطلوب غير مسجل حالياً في MEDBOT.',
    en: 'The requested resource is not currently registered in MEDBOT.',
  },
  library_title: { ar: '📚 *موارد المنصة*', en: '📚 *Resources*' },
  library_pick_year: {
    ar: 'اختر السنة أو القسم الذي تريد الدخول إليه:',
    en: 'Choose the year or section to open:',
  },
  library_pick_section: { ar: 'اختر القسم:', en: 'Choose a section:' },
  library_empty: {
    ar: 'ℹ️ لا توجد أقسام مسجلة في هذا المستوى حالياً.',
    en: 'ℹ️ No sections registered at this level yet.',
  },
  library_area_empty: {
    ar: 'ℹ️ لا توجد أقسام أو موارد مسجلة هنا حالياً.',
    en: 'ℹ️ No sections or resources registered here yet.',
  },
  folder_pick: { ar: 'اختر القسم أو المورد:', en: 'Choose a section or resource:' },
  invalid_id: { ar: '⚠️ معرف غير صالح.', en: '⚠️ Invalid identifier.' },

  contrib_preview: { ar: '🔍 معاينة المساهمة', en: '🔍 Preview contribution' },
  contrib_not_found: {
    ar: 'المساهمة غير موجودة أو تمت معالجتها بالفعل.',
    en: 'The contribution does not exist or has already been processed.',
  },
  contrib_student: { ar: '👤 الطالب', en: '👤 Student' },
  contrib_title_label: { ar: '📄 العنوان', en: '📄 Title' },
  contrib_type_label: { ar: '📎 النوع', en: '📎 Type' },
  contrib_destination: { ar: '🧭 الوجهة', en: '🧭 Destination' },
  contrib_status_label: { ar: '🏷 الحالة', en: '🏷 Status' },
  contrib_no_file: {
    ar: '⚠️ لا يوجد ملف مرفق بهذه المساهمة.',
    en: '⚠️ No file is attached to this contribution.',
  },
  contrib_preview_note: {
    ar: '⬆️ هذه هي المساهمة كما وصلت. لم تتغيّر حالتها.',
    en: '⬆️ This is the submission as received. Its status is unchanged.',
  },
  contrib_preview_failed: {
    ar: '⚠️ تعذر إرسال الملف من Telegram حالياً.',
    en: '⚠️ The file could not be sent through Telegram right now.',
  },
  contrib_back_to_review: { ar: '⬅️ المساهمة', en: '⬅️ Contribution' },
  pending_short: { ar: '📥 المعلقة', en: '📥 Pending' },
  approve_action: { ar: '✅ قبول', en: '✅ Approve' },
  reject_action: { ar: '❌ رفض', en: '❌ Reject' },

  // ---- Administration ----------------------------------------------
  admin_panel_title: { ar: '🛠 *إدارة المنصة*', en: '🛠 *Administration*' },
  admin_pending_contributions: {
    ar: '📤 المساهمات المعلقة',
    en: '📤 Pending contributions',
  },
  admin_open_messages: {
    ar: '📬 رسائل الطلاب غير المغلقة',
    en: '📬 Open student messages',
  },
  admin_choose_action: { ar: 'اختر الإجراء:', en: 'Choose an action:' },

  admin_sections: {
    ar: '🗂 إدارة الأقسام والفروع',
    en: '🗂 Manage sections & branches',
  },
  admin_contributions: { ar: '📥 مراجعة المساهمات', en: '📥 Review contributions' },
  admin_messages: { ar: '📬 رسائل الطلاب', en: '📬 Student messages' },
  admin_ai: { ar: '🤖 سجل الذكاء الاصطناعي', en: '🤖 AI Registry' },
  admin_runtime: { ar: '📊 حالة التشغيل', en: '📊 Runtime' },
  admin_admins: { ar: '👥 إدارة المشرفين', en: '👥 Admins' },
  admin_audit: { ar: '📜 سجل التدقيق', en: '📜 Audit Log' },
  admin_settings: { ar: '⚙️ إعدادات المنصة', en: '⚙️ Settings' },
  admin_notifications: { ar: '🔔 الإشعارات', en: '🔔 Notifications' },
  admin_topics: { ar: '🧭 مواضيع البحث', en: '🧭 Search Topics' },

  // ---- Ownership / permissions -------------------------------------
  ownership_transfer: { ar: '👑 نقل الملكية', en: '👑 Ownership Transfer' },
  ownership_title: {
    ar: '👑 *نقل الملكية*\n\nاختر المشرف الذي تريد نقل ملكية المنصة إليه:',
    en: '👑 *Ownership Transfer*\n\nChoose the admin to transfer ownership to:',
  },
  ownership_none: {
    ar: 'ℹ️ لا يوجد مشرف آخر يمكن نقل الملكية إليه.',
    en: 'ℹ️ No other admin is available to receive ownership.',
  },
  ownership_confirm: {
    ar: '⚠️ سيصبح الحساب <code>{target}</code> المالك الجديد، ' +
      'وسيتحوّل دورك إلى مشرف.\n\nهل تريد المتابعة؟',
    en: '⚠️ Account <code>{target}</code> will become the new owner and ' +
      'your role will change to admin.\n\nContinue?',
  },
  permissions_title: { ar: '🔐 *الصلاحيات*', en: '🔐 *Permissions*' },
  role_title: { ar: '👑 *الدور*', en: '👑 *Role*' },
  permissions_grant: { ar: '✅ منح', en: '✅ Grant' },
  permissions_revoke: { ar: '⛔ إلغاء', en: '⛔ Revoke' },

  // ---- Sections / branches -----------------------------------------
  section_parent: { ar: 'القسم الأب', en: 'Parent' },
  section_root: { ar: 'الجذر', en: 'Root' },
  move_title: {
    ar: '🚚 *نقل القسم*\n\n📁 القسم: <b>{name}</b>\n\n' +
      'اختر القسم الأب الجديد (الجذر أو أي قسم):',
    en: '🚚 *Move section*\n\n📁 Section: <b>{name}</b>\n\n' +
      'Choose the new parent (Root or any section):',
  },
  move_to_root: { ar: '🏠 نقل إلى الجذر', en: '🏠 Move to Root' },
  move_here: { ar: '✅ النقل إلى هنا', en: '✅ Move here' },
  move_self: { ar: 'لا يمكن نقل القسم إلى نفسه', en: 'A section cannot move into itself' },
  move_descendant: {
    ar: 'لا يمكن نقل قسم إلى داخل أحد تفرعاته',
    en: 'A section cannot move into one of its descendants',
  },
  move_ok: { ar: '✅ تم نقل القسم بنجاح.', en: '✅ Section moved successfully.' },

  // ---- Settings ------------------------------------------------------
  settings_title: { ar: '⚙️ *إعدادات المنصة*', en: '⚙️ *Platform Settings*' },
  settings_prompt: {
    ar: 'أرسل النص الجديد في رسالة، أو اضغط ❌ إلغاء.',
    en: 'Send the new text in a message, or press ❌ Cancel.',
  },
  settings_saved: { ar: '✅ تم حفظ الإعداد.', en: '✅ Setting saved.' },
  settings_invalid: { ar: '⚠️ نص غير صالح.', en: '⚠️ Invalid text.' },

  // ---- Notifications -------------------------------------------------
  notifications_title: { ar: '🔔 *الإشعارات*', en: '🔔 *Notifications*' },
  notifications_prompt: {
    ar: 'أرسل نص الإشعار الذي تريد إرساله إلى جميع المستخدمين.\n\n' +
      'لإلغاء العملية أرسل /cancel.',
    en: 'Send the notification body to broadcast to all users.\n\n' +
      'Send /cancel to abort.',
  },
  notifications_sending: {
    ar: '⏳ جارٍ إرسال الإشعار...',
    en: '⏳ Sending notification...',
  },
  notifications_sent: {
    ar: '✅ تم إرسال الإشعار إلى {delivered} من {recipients} مستخدم.',
    en: '✅ Notification delivered to {delivered} of {recipients} users.',
  },
  notifications_history: { ar: '📜 سجل الإشعارات', en: '📜 Notification history' },
  notifications_new: { ar: '✍️ إرسال إشعار', en: '✍️ Send notification' },
  notifications_empty: {
    ar: 'ℹ️ لم يتم إرسال أي إشعار بعد.',
    en: 'ℹ️ No notifications sent yet.',
  },

  // ---- News Center ---------------------------------------------------
  news_title: {
    ar: '📰 *مركز الأخبار*\n\nكل الأخبار مرتبة من الأحدث إلى الأقدم.',
    en: '📰 *News Center*\n\nAll news, newest first.',
  },
  news_empty: {
    ar: 'ℹ️ لا توجد أخبار منشورة حالياً.',
    en: 'ℹ️ No news has been published yet.',
  },
  news_open: { ar: '📖 قراءة الخبر', en: '📖 Read the post' },
  news_view_resource: { ar: '📂 عرض المورد', en: '📂 Open the resource' },
  news_open_section: { ar: '🗂 فتح القسم', en: '🗂 Open the section' },
  news_read: { ar: '✅ مقروء', en: '✅ Read' },
  news_unread: { ar: '🔵 جديد', en: '🔵 New' },
  news_mark_all_read: { ar: '✅ تحديد الكل كمقروء', en: '✅ Mark all as read' },
  news_no_match: {
    ar: '⚠️ الخبر غير موجود.',
    en: '⚠️ This news item was not found.',
  },
  news_more: { ar: '🔽 المزيد', en: '🔽 More' },
  news_back_feed: { ar: '⬅️ الأخبار', en: '⬅️ News' },
  news_subs: { ar: '⚙️ اشتراكات الأخبار', en: '⚙️ News subscriptions' },
};

/**
 * Resolve `key` for `lang`, formatting any `params`.
 *
 * Never throws: an unknown key returns the key, and a bad format string returns
 * the raw template, so a translation gap can never break a handler.
 */
export function t(key, lang = DEFAULT_LANGUAGE, params = null) {
  const entry = TRANSLATIONS[key];
  if (entry === undefined) return key;

  const template = entry[lang] ?? entry[DEFAULT_LANGUAGE] ?? key;
  if (!params || !Object.keys(params).length) return template;

  try {
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      name in params ? String(params[name]) : match,
    );
  } catch {
    return template;
  }
}

/** Languages the i18n layer can render. */
export function availableLanguages() {
  const languages = new Set();
  for (const entry of Object.values(TRANSLATIONS)) {
    for (const lang of Object.keys(entry)) languages.add(lang);
  }
  return [...languages].sort();
}

const LEGACY_TEXT_PAIRS = Object.freeze([
  ['🏠 الرئيسية','🏠 Home'],['⬅️ رجوع','⬅️ Back'],['❌ إلغاء','❌ Cancel'],
  ['🔒 غير مصرح.','🔒 Unauthorized.'],['🔒 غير مصرح','🔒 Unauthorized'],
  ['⚠️ إجراء غير معروف.','⚠️ Unknown action.'],['⚠️ إجراء غير معروف','⚠️ Unknown action'],
  ['⚠️ معرف غير صالح.','⚠️ Invalid identifier.'],['⚠️ معرف غير صالح','⚠️ Invalid identifier'],
  ['⚠️ طلب غير صالح.','⚠️ Invalid request.'],['⚠️ طلب غير صالح','⚠️ Invalid request'],
  ['⚠️ العنصر غير موجود.','⚠️ Item not found.'],['⚠️ العنصر غير موجود','⚠️ Item not found'],
  ['🛠 هذا القسم غير متاح مؤقتاً للصيانة أو التحديث.','🛠 This section is temporarily unavailable for maintenance or updates.'],
  ['🔒 هذه المنطقة مخصصة للمشرفين المعتمدين فقط.','🔒 This area is for authorized admins only.'],
  ['📚 موارد المنصة','📚 Resources'],['🧭 المواضيع','🧭 Topics'],['🤖 المساعد','🤖 Assistant'],
  ['📰 الأخبار','📰 News'],['📤 مساهمات الطلاب','📤 Student Contributions'],['📄 مساهماتي','📄 My Contributions'],
  ['📊 حسابي','📊 My Account'],['📬 تواصل مع المنصة','📬 Contact'],['ℹ️ عن المنصة','ℹ️ About'],
  ['🌐 اللغة','🌐 Language'],['🛠 إدارة المنصة','🛠 Administration'],
  ['🗂 إدارة الأقسام والفروع','🗂 Manage Sections & Branches'],['📄 إدارة المحتوى','📄 Manage Content'],
  ['📥 مراجعة المساهمات','📥 Review Contributions'],['📬 رسائل الطلاب','📬 Student Messages'],
  ['🧭 مواضيع البحث','🧭 Search Topics'],['🔔 الإشعارات','🔔 Notifications'],
  ['🤖 سجل الذكاء الاصطناعي','🤖 AI Registry'],['🗄 أرشيف الطوارئ','🗄 Emergency Archive'],
  ['⚙️ إعدادات المنصة','⚙️ Platform Settings'],['🙈 إظهار/إخفاء الأقسام','🙈 Show/Hide Sections'],
  ['👥 إدارة المشرفين','👥 Admins'],['👑 نقل الملكية','👑 Transfer Ownership'],['📜 سجل التدقيق','📜 Audit Log'],
  ['📊 حالة التشغيل','📊 Runtime'],['اختر الإجراء الذي تريد تنفيذه:','Choose the action:'],
  ['الرئيسية 🏠','Home 🏠'],['⬅️ إدارة المنصة','⬅️ Administration'],['⬅️ الأقسام','⬅️ Sections'],
  ['⬅️ إدارة الأقسام','⬅️ Section Management'],['⬅️ القسم الأب','⬅️ Parent Section'],
  ['➕ إنشاء قسم جديد','➕ Create New Section'],['➕ إضافة قسم فرعي','➕ Add Subsection'],
  ['📤 رفع مورد','📤 Upload Resource'],['✏️ إعادة تسمية','✏️ Rename'],['📦 تغيير النوع','📦 Change Type'],
  ['⛔ إيقاف استقبال المساهمات','⛔ Disable Contributions'],['✅ تفعيل استقبال المساهمات','✅ Enable Contributions'],
  ['🚚 نقل القسم','🚚 Move Section'],['🗑 حذف القسم','🗑 Delete Section'],
  ['📂 أقسام فرعية:','📂 Subsections:'],['📄 موارد:','📄 Resources:'],
  ['يستقبل مساهمات','Accepts contributions'],['لا يستقبل مساهمات','Does not accept contributions'],
  ['↳ دخول','↳ Open'],['⚠️ القسم غير موجود.','⚠️ Section not found.'],
  ['🚫 هذا القسم خارج نطاق مسؤوليتك.','🚫 This section is outside your assigned scope.'],
  ['🗂 إدارة الأقسام','🗂 Section Management'],['🌐 كل الأقسام.','🌐 All sections.'],
  ['• لا توجد أقسام في هذا المستوى.','• No sections at this level.'],
  ['📄 إدارة المحتوى','📄 Content Management'],['• لا توجد أقسام أو موارد في هذا المستوى.','• No sections or resources at this level.'],
  ['⬆️ رفع مورد هنا','⬆️ Upload Resource Here'],['🚫 هذا المورد خارج نطاق مسؤوليتك.','🚫 This resource is outside your assigned scope.'],
  ['⚠️ المورد غير موجود.','⚠️ Resource not found.'],['🏷 تغيير النوع','🏷 Change Type'],['🚚 نقل','🚚 Move'],['🗑 حذف','🗑 Delete'],
  ['⬆️ رفع مورد إلى:','⬆️ Upload Resource To:'],['أرسل الآن الملف (مستند / صوت / فيديو / صورة).','Send the file now (document / audio / video / image).'],
  ['📥 تم استلام المورد','📥 Resource received'],['📄 العنوان المقترح:','📄 Suggested title:'],['📎 النوع:','📎 Type:'],
  ['اختر طريقة تسجيل العنوان:','Choose how to record the title:'],['✅ تسجيل بالعنوان المقترح','✅ Use Suggested Title'],
  ['✏️ إدخال عنوان مخصص','✏️ Enter Custom Title'],['⚠️ القسم الهدف غير صالح.','⚠️ Invalid target section.'],
  ['⚠️ لا يوجد ملف Telegram صالح للتسجيل.','⚠️ No valid Telegram file to register.'],
  ['⚠️ تعذر تسجيل المورد. لم يتم تأكيد الإضافة.','⚠️ Could not register the resource. The addition was not confirmed.'],
  ['✅ تم إضافة المورد:','✅ Resource added:'],['🔧 إدارة المورد','🔧 Manage Resource'],
  ['⚠️ انتهت جلسة الرفع. ابدأ العملية من جديد.','⚠️ The upload session expired. Start again.'],
  ['✏️ العنوان المخصص','✏️ Custom Title'],['✏️ إعادة تسمية المورد','✏️ Rename Resource'],
  ['🏷 تغيير نوع المورد','🏷 Change Resource Type'],['🚚 نقل المورد','🚚 Move Resource'],
  ['اختر المجلد الهدف:','Choose the target folder:'],['🚫 المجلد الهدف خارج نطاق مسؤوليتك.','🚫 The target folder is outside your assigned scope.'],
  ['⚠️ تعذّر إكمال إنشاء القسم.','⚠️ Could not complete section creation.'],
  ['👥 إدارة المشرفين','👥 Admin Management'],['👑 المالك:','👑 Owner:'],['🛡 المشرفون:','🛡 Admins:'],
  ['🔎 المراجعون:','🔎 Reviewers:'],['⛔ الملغون:','⛔ Revoked:'],
  ['اختر مشرفاً لإدارة دوره وصلاحياته ونطاقه:','Choose an admin to manage their role, permissions, and scope:'],
  ['➕ إضافة مشرف','➕ Add Admin'],['⚙️ إدارة الصلاحيات','⚙️ Manage Permissions'],['ℹ️ صلاحيات الأدوار','ℹ️ Role Permissions'],
  ['⬅️ إدارة المشرفين','⬅️ Admin Management'],['👑 صلاحيات الأدوار','👑 Role Permissions'],
  ['⚙️ إدارة الصلاحيات والنطاقات','⚙️ Manage Permissions & Scopes'],['🛡 الصلاحيات المتاحة (Scope-aware)','🛡 Available Permissions (Scope-aware)'],
  ['🧭 النطاقات','🧭 Scopes'],['⚠️ المشرف غير موجود.','⚠️ Admin not found.'],['بدون اسم','Unnamed'],
  ['👁 معاينة واجهة المشرف','👁 Preview Admin Interface'],['📝 الاسم:','📝 Name:'],['👑 الدور:','👑 Role:'],
  ['🔐 ما يستطيع هذا الحساب الوصول إليه','🔐 What This Account Can Access'],
  ['⛔ لا يملك أي صلاحية إدارية حالياً.','⛔ This account currently has no administrative permissions.'],
  ['🔐 تعديل صلاحيات هذا المشرف','🔐 Edit Admin Permissions'],['⬅️ المشرفون','⬅️ Admins'],
  ['👑 المالك يملك كل الصلاحيات بلا استثناء، ولا يمكن تخفيضه إلا بنقل الملكية.','👑 The owner has all permissions and can only be downgraded by transferring ownership.'],
  ['🔐 الصلاحيات:','🔐 Permissions:'],['🧭 النطاق (Phase 3):','🧭 Scope (Phase 3):'],
  ['🌐 غير مقيّد — يملك وصولاً على مستوى المنصة بالكامل.','🌐 Unrestricted — full platform-level access.'],
  ['👑 تغيير الدور','👑 Change Role'],['🧭 إدارة النطاق','🧭 Manage Scope'],['🔐 تعديل الصلاحيات','🔐 Edit Permissions'],
  ['♻️ إعادة التفعيل (مشرف)','♻️ Reactivate (Admin)'],['⛔ سحب الوصول','⛔ Revoke Access'],
  ['🗂 قسم:','🗂 Section:'],['🧭 موضوع:','🧭 Topic:'],['📄 مورد:','📄 Resource:'],
  ['الدور يحدد الحزمة الأساسية للصلاحيات. يمكنك تعديل الصلاحيات فردياً بعد ذلك.','The role defines the base permission set. You can adjust permissions individually afterward.'],
  ['⚠️ لا يمكن تطبيق هذا الدور.','⚠️ This role cannot be applied.'],['⚠️ صلاحية غير معروفة.','⚠️ Unknown permission.'],
  ['⚠️ لا يمكن تعديل صلاحيات هذا الحساب.','⚠️ This account permissions cannot be changed.'],
  ['اضغط على أي صلاحية لمنحها أو سحبها.','Press any permission to grant or revoke it.'],
  ['⚠️ لا يمكن سحب وصول المالك.','⚠️ The owner’s access cannot be revoked.'],
  ['🔒 نقل الملكية متاح للمالك الحالي فقط.','🔒 Ownership transfer is available only to the current owner.'],
  ['⚠️ سيصبح الحساب المختار المالك الجديد، وسيتحوّل دورك إلى مشرف.','⚠️ The selected account will become the new owner, and your role will become admin.'],
  ['لا يمكن التراجع إلا بموافقة المالك الجديد.','This cannot be reversed without the new owner’s approval.'],
  ['اختر المشرف:','Choose the admin:'],['ℹ️ لا يوجد مشرف آخر يمكن نقل الملكية إليه.','ℹ️ No other admin is available to receive ownership.'],
  ['✅ تأكيد النقل','✅ Confirm Transfer'],['⚠️ تأكيد نقل الملكية','⚠️ Confirm Ownership Transfer'],['هل تريد المتابعة؟','Continue?'],
  ['👑 تم نقل ملكية المنصة إليك','👑 Platform ownership has been transferred to you'],['أصبحت الآن المالك بحقوق كاملة.','You are now the owner with full permissions.'],
  ['🧭 نطاق المسؤولية','🧭 Responsibility Scope'],['🌐 غير مقيّد','🌐 Unrestricted'],
  ['بدون أي نطاق، يملك المشرف وصولاً على مستوى المنصة بالكامل داخل صلاحياته.','Without a scope, the admin has platform-wide access within their permissions.'],
  ['أضف نطاقاً لتقييده على فرع محدد من شجرة المنصة.','Add a scope to restrict access to a specific branch of the platform tree.'],
  ['🔒 مقيّد بـ','🔒 Restricted to'],['➕ إضافة نطاق','➕ Add Scope'],['🗑 إزالة نطاق','🗑 Remove Scope'],['🧹 إزالة كل النطاقات','🧹 Remove All Scopes'],
  ['✅ قسم','✅ Section'],['✅ موضوع','✅ Topic'],['✅ مورد','✅ Resource'],
  ['🧭 إضافة نطاق','🧭 Add Scope'],['⬅️ النطاق','⬅️ Scope'],['ℹ️ لا توجد عناصر في هذا المستوى.','ℹ️ No items at this level.'],
  ['🗑 إزالة نطاق','🗑 Remove Scope'],['اختر النطاق الذي تريد إزالته:','Choose the scope to remove:'],
  ['⚙️ إعدادات المنصة','⚙️ Platform Settings'],['اضغط على أي إعداد لتعديل نصه. تُطبَّق التغييرات فوراً على كل المستخدمين.','Press any setting to edit its text. Changes apply immediately to all users.'],
  ['⬅️ الإعدادات','⬅️ Settings'],['⚠️ إعداد غير معروف.','⚠️ Unknown setting.'],['القيمة الحالية:','Current value:'],
  ['أرسل النص الجديد في رسالة، أو اضغط ❌ إلغاء.','Send the new text in a message, or press ❌ Cancel.'],
  ['⚠️ لم ترسل أي نص. أرسل النص الجديد، أو /cancel للإلغاء.','⚠️ No text was sent. Send the new text, or /cancel to abort.'],
  ['⚠️ تعذّر حفظ الإعداد بسبب خطأ في قاعدة البيانات. لم يتم تغيير القيمة.','⚠️ Could not save the setting because of a database error. The value was not changed.'],
  ['✅ تم حفظ الإعداد:','✅ Setting saved:'],['🔔 الإشعارات','🔔 Notifications'],
  ['أرسل إشعاراً لكل مستخدمي المنصة، أو اطّلع على سجل الإشعارات السابقة.','Send a notification to all platform users, or view notification history.'],
  ['📜 آخر الإشعارات:','📜 Latest notifications:'],['✍️ إرسال إشعار','✍️ Send Notification'],['📜 سجل الإشعارات','📜 Notification History'],
  ['أرسل نص الإشعار الذي تريد إرساله إلى جميع المستخدمين.','Send the notification text you want to send to all users.'],
  ['⏳ جارٍ إرسال الإشعار...','⏳ Sending notification...'],['ℹ️ لم يتم إرسال أي إشعار بعد.','ℹ️ No notifications sent yet.'],
  ['🔒 سجل التدقيق متاح للمالك ومن يملك صلاحية إدارة المشرفين.','🔒 The audit log is available to the owner and admins with admin-management permission.'],
  ['📜 كل السجل','📜 All Audit Entries'],['📊 إجمالي الأحداث:','📊 Total events:'],
  ['🤖 سجل الذكاء الاصطناعي','🤖 AI Registry'],['📊 إجمالي النماذج المسجّلة:','📊 Total registered models:'],
  ['📈 النماذج المستخدمة اليوم:','📈 Models used today:'],['• لا توجد بيانات استخدام بعد.','• No usage data yet.'],
  ['🏆 أكثر الطلاب استخداماً:','🏆 Top Students by Usage:'],['📊 حالة التشغيل','📊 Runtime Status'],
  ['🗂 الأقسام:','🗂 Sections:'],['📄 الموارد:','📄 Resources:'],['👥 المشرفون:','👥 Admins:'],
  ['📥 مساهمات بانتظار المراجعة:','📥 Contributions pending review:'],['📜 أحداث التدقيق:','📜 Audit events:'],
  ['🗃 قاعدة البيانات:','🗃 Database:'],['🗄 أرشيف الطوارئ:','🗄 Emergency Archive:'],
  ['🔄 إعادة مزامنة الموارد','🔄 Resync Resources'],['♻️ إعادة محاولة الفاشلة','♻️ Retry Failed'],['📊 حالة المزامنة','📊 Sync Status'],
  ['🗄 <b>أرشيف الطوارئ للموارد</b>','🗄 <b>Emergency Resource Archive</b>'],
  ['المتغير مضبوط:','Variable configured:'],['نعم','Yes'],['لا','No'],['📡 القناة:','📡 Channel:'],
  ['🤖 حالة البوت:','🤖 Bot status:'],['📤 الإرسال:','📤 Sending:'],['غير متاح','Unavailable'],
  ['الحالة:','Status:'],['السبب:','Reason:'],['🟢 جاهز','🟢 Ready'],['⚪ غير مضبوط','⚪ Not configured'],
  ['🔴 قيمة غير صالحة','🔴 Invalid value'],['🔴 غير قابل للوصول','🔴 Unreachable'],['🔴 صلاحية ناقصة','🔴 Missing permission'],
  ['🟡 غير متحقق','🟡 Unverified'],['⚪ غير معروف','⚪ Unknown'],['المنشئ','Creator'],['مشرف','Administrator'],
  ['عضو فقط','Member only'],['مقيّد','Restricted'],['غادر','Left'],['مطرود','Kicked'],
  ['📋 كل الأخبار','📋 All News'],['📋 الأخبار المنشورة','📋 Published News'],['🗄 الأرشيف','🗄 Archive'],
  ['➕ نشر خبر','➕ Create News'],['أنشئ الخبر كمسودة، راجعه، ثم انشره — ويُوصَل المشتركون تلقائياً.','Create the news item as a draft, review it, then subscribers are notified automatically.'],
  ['• لا توجد أخبار في هذا العرض.','• No news in this view.'],['اضغط على أي خبر للفتح والتحكم.','Press any news item to open and manage it.'],
  ['↩️ عرض العمل','↩️ View Draft'],['🗂 اختيار القسم','🗂 Choose Section'],['📢 نشر','📢 Publish'],
  ['🧪 المادة (اختياري)','🧪 Linked Resource (optional)'],['🔗 تغيير المورد المرتبط','🔗 Change Linked Resource'],
  ['✂️ إلغاء ربط المورد','✂️ Unlink Resource'],['🔗 ربط مورد (اختياري)','🔗 Link Resource (optional)'],
  ['👁 معاينة','👁 Preview'],['👁 عرض','👁 View'],['🗄 أرشفة','🗄 Archive'],['📬 سجل التوصيل','📬 Delivery Log'],
  ['♻️ استرجاع كمسودة','♻️ Restore as Draft'],['⚠️ الخبر غير موجود.','⚠️ News item not found.'],['⬅️ إدارة الأخبار','⬅️ News Management'],
  ['🚨 هام / عاجل','🚨 Important / Urgent'],['مثال: تغيير موعد اختبار الأحد.','Example: Sunday exam schedule change.'],
  ['اكتب عنوان خبر القسم، ثم اختر القسم الحقيقي من الشجرة.','Write the section news title, then choose the real section from the tree.'],
  ['📋 <b>عنوان الخبر</b>','📋 <b>News Title</b>'],['أرسل عنوان الخبر في رسالة واحدة.','Send the news title in one message.'],
  ['📝 <b>نص الخبر</b>','📝 <b>News Body</b>'],['أرسل النص كما سيظهر للطالب، أو /skip لتجاهله.','Send the text as it should appear to students, or /skip to skip it.'],
  ['👨‍⚕️ <b>الدكتور/المُرسل</b> (اختياري)','👨‍⚕️ <b>Doctor/Sender</b> (optional)'],
  ['📅 <b>الموعد/التوقيت</b> (اختياري)','📅 <b>Date/Time</b> (optional)'],
  ['⚠️ تعذّر إنشاء الخبر (عنوان مفقود).','⚠️ Could not create the news item (missing title).'],
  ['⚠️ تعذّر إنشاء الخبر. تحقق من العنوان والنص.','⚠️ Could not create the news item. Check the title and body.'],
  ['اختر القسم الحقيقي من الشجرة، ثم راجع الخبر وانشره.','Choose the real section from the tree, then review and publish the news item.'],
  ['راجع الخبر ثم اضغط 📢 نشر لإظهاره للطلاب.','Review the news item, then press 📢 Publish to show it to students.'],
  ['🔎 مراجعة ونشر','🔎 Review & Publish'],['🟢 <b>اختيار المورد</b>','🟢 <b>Choose Resource</b>'],
  ['اختر موردًا موجودًا فعليًا من القائمة.','Choose a real resource from the list.'],['✂️ بدون مادة','✂️ No Resource'],
  ['⚠️ المادة غير موجودة.','⚠️ Linked resource not found.'],['🔁 إعادة المحاولة','🔁 Retry'],
  ['🧭 <b>مواضيع البحث</b>','🧭 <b>Search Topics</b>'],['➕ إنشاء موضوع','➕ Create Topic'],['⬅️ المواضيع','⬅️ Topics'],
  ['⚠️ الموضوع غير موجود.','⚠️ Topic not found.'],['⛔ معطّل','⛔ Disabled'],['📂 <b>الأقسام المرتبطة</b>','📂 <b>Linked Sections</b>'],
  ['🔗 ربط قسم','🔗 Link Section'],['⛔ تعطيل','⛔ Disable'],['✅ تفعيل','✅ Enable'],['🔽 تقديم','🔽 Move Up'],['🔼 تأخير','🔼 Move Down'],
  ['🗑 حذف الموضوع','🗑 Delete Topic'],['➕ <b>إنشاء موضوع</b>','➕ <b>Create Topic</b>'],
  ['أرسل اسم الموضوع (مثال: علم وظائف الأعضاء).','Send the topic name (example: Physiology).'],['⚠️ اسم غير صالح.','⚠️ Invalid name.'],
  ['⚠️ أرسل رقم القسم (ID) الصحيح.','⚠️ Send a valid section ID.'],['✅ تم ربط القسم بالموضوع.','✅ Section linked to topic.'],
  ['⚠️ تعذر ربط القسم (تأكد من رقم القسم).','⚠️ Could not link the section (check the section ID).'],['🔗 ربط','🔗 Link'],
  ['🔗 <b>ربط قسم بالموضوع</b>','🔗 <b>Link Section to Topic</b>'],
  ['تنقّل بين الأقسام ثم اضغط «🔗 ربط» بجانب القسم المطلوب.','Navigate between sections, then press “🔗 Link” beside the desired section.'],
  ['📬 <b>التواصل مع الإدارة</b>','📬 <b>Contact Administration</b>'],['اختر نوع الرسالة التي تريد إرسالها.','Choose the type of message you want to send.'],
  ['💬 رسالة','💬 Message'],['📑 طلب ملخص','📑 Summary Request'],['💡 اقتراح','💡 Suggestion'],['🚩 بلاغ','🚩 Report'],
  ['📥 رسائلي','📥 My Messages'],['يمكنك إرسال رسالة، طلب ملخص، اقتراح، أو بلاغ.','You can send a message, summary request, suggestion, or report.'],
  ['⚠️ نوع الرسالة غير مدعوم.','⚠️ Unsupported message type.'],['اكتب الآن نص الرسالة وأرسله.','Write the message text and send it now.'],
  ['لإلغاء العملية اضغط ❌ إلغاء أو أرسل /cancel.','Press ❌ Cancel or send /cancel to cancel.'],
  ['📬 <b>رسالة جديدة من طالب</b>','📬 <b>New student message</b>'],['🏷 النوع:','🏷 Type:'],['👤 من:','👤 From:'],
  ['افتح لوحة الإدارة للرد.','Open the admin panel to reply.'],['❌ تم إلغاء إرسال الرسالة.','❌ Message sending cancelled.'],
  ['⚠️ تعذر إرسال الرسالة حالياً. لم يتم تأكيد الإرسال.','⚠️ Could not send the message. Submission was not confirmed.'],
  ['✅ <b>تم استلام رسالتك.</b>','✅ <b>Your message has been received.</b>'],['🏷 الحالة:','🏷 Status:'],
  ['ستتم مراجعتها من قبل الإدارة، وسيتم إشعارك عند الرد.','The administration will review it and notify you when they reply.'],
  ['يمكنك متابعة الحالة من «📥 رسائلي».','You can track it from “📥 My Messages”.'],['📥 <b>رسائلي</b>','📥 <b>My Messages</b>'],
  ['لم ترسل أي رسالة بعد.','You have not sent any messages yet.'],['📬 التواصل مع الإدارة','📬 Contact Administration'],['طالب','Student'],
  ['📬 <b>رسائل الطلاب</b>','📬 <b>Student Messages</b>'],['🟢 غير مغلقة:','🟢 Open:'],['📦 الإجمالي المعروض:','📦 Displayed total:'],
  ['اختر رسالة لعرضها والرد عليها.','Choose a message to view and reply.'],['⚠️ الرسالة غير موجودة.','⚠️ Message not found.'],
  ['📬 الرسائل','📬 Messages'],['📬 <b>رسالة طالب</b>','📬 <b>Student Message</b>'],['📊 الحالة:','📊 Status:'],
  ['↩️ <b>الرد الحالي:</b>','↩️ <b>Current reply:</b>'],['👤 بواسطة:','👤 By:'],['✏️ رد','✏️ Reply'],
  ['👀 قيد المراجعة','👀 In Review'],['🔒 إغلاق','🔒 Close'],['⬅️ الرسائل','⬅️ Messages'],
  ['🔒 هذه الرسالة مغلقة ولا يمكن الرد عليها.','🔒 This message is closed and cannot be replied to.'],
  ['✏️ <b>الرد على الرسالة</b>','✏️ <b>Reply to Message</b>'],['اكتب نص الرد للرسالة','Write the reply for message'],
  ['❌ تم إلغاء الرد.','❌ Reply cancelled.'],['ℹ️ تعذر الرد. الرسالة غير موجودة أو مغلقة.','ℹ️ Could not reply. The message does not exist or is closed.'],
  ['⚠️ حالة غير معروفة.','⚠️ Unknown status.'],['⚠️ تعذر تحديث الحالة.','⚠️ Could not update status.'],
  ['🤖 <b>المساعد الذكي</b>','🤖 <b>AI Assistant</b>'],
  ['🔎 بحث في موارد المنصة','🔎 Search Platform Resources'],['🔎 <b>بحث في موارد المنصة</b>','🔎 <b>Search Platform Resources</b>'],
  ['للعثور على قسم أو مورد مسجّل فعلاً في MEDBOT والوصول إليه مباشرة.','Find a section or resource actually registered in MEDBOT and open it directly.'],
  ['🤖 <b>اسأل المساعد الذكي</b>','🤖 <b>Ask the AI Assistant</b>'],
  ['لأسئلة علمية أو عامة. الإجابات العلمية تُدعم بمصادر NCBI PubMed عند توفرها.','For scientific or general questions. Scientific answers are supported by NCBI PubMed sources when available.'],
  ['ℹ️ هذا المساعد ليس بديلاً عن الطبيب ولا يقدّم تشخيصاً شخصياً.','ℹ️ This assistant is not a substitute for a doctor and does not provide personal diagnoses.'],
  ['اكتب اسم المادة أو القسم أو المورد الذي تبحث عنه.','Enter the subject, section, or resource you are looking for.'],['مثال:','Example:'],
  ['اكتب سؤالك العلمي أو العام.','Enter your scientific or general question.'],
  ['⚠️ السؤال الطبي يُجاب بإجابة أكاديمية إنجليزية ثم شرح عربي موجز،','⚠️ Medical questions are answered with an academic English answer followed by a brief Arabic explanation,'],
  ['مع مصادر PubMed عند توفرها. المساعد لا يغني عن تقييم الطبيب.','with PubMed sources when available. The assistant does not replace medical evaluation.'],
  ['⛔ استهلكت الحد اليومي لاستخدام المساعد الذكي.','⛔ You have reached the daily AI assistant limit.'],
  ['يمكنك المحاولة مجدداً غداً.','You can try again tomorrow.'],['⏳ جارٍ المعالجة...','⏳ Processing...'],
  ['⚠️ تعذّر الوصول إلى خدمة الذكاء الاصطناعي حالياً.','⚠️ The AI service is currently unavailable.'],['🔁 سؤال آخر','🔁 Ask Another Question'],
  ['🤖 المتبقي اليوم:','🤖 Remaining today:'],['⚠️ لم يتم إنتاج إجابة.','⚠️ No answer was generated.'],
  ['📤 <b>مساهمات الطلاب</b>','📤 <b>Student Contributions</b>'],['اختر القسم الذي تريد المساهمة فيه:','Choose the section you want to contribute to:'],
  ['ℹ️ لا توجد أقسام تستقبل مساهمات في هذا المستوى.','ℹ️ No sections accept contributions at this level.'],['📄 الملف مستلم.','📄 File received.'],
  ['✍️ أرسل الآن عنوان المورد (اسم واضح ومحدد).','✍️ Send the resource title now (a clear, specific name).'],
  ['🔎 مراجعة','🔎 Review'],['ℹ️ لا توجد مساهمات بعد.','ℹ️ No contributions yet.'],['🔁 إعادة إرسال','🔁 Resubmit'],
  ['⚠️ المساهمة غير موجودة.','⚠️ Contribution not found.'],['🔒 يمكن لصاحب المساهمة فقط إعادة إرسالها.','🔒 Only the contribution owner can resubmit it.'],
  ['ℹ️ هذه المساهمة ليست بحاجة إلى تعديل.','ℹ️ This contribution does not need revision.'],['⬅️ مساهماتي','⬅️ My Contributions'],
  ['⚠️ تعذّر إعادة الإرسال.','⚠️ Could not resubmit the contribution.'],['📥 <b>مراجعة المساهمات</b>','📥 <b>Review Contributions</b>'],
  ['ℹ️ لا توجد مساهمات بانتظار المراجعة.','ℹ️ No contributions are waiting for review.'],['⬅️ المساهمات','⬅️ Contributions'],
  ['🚫 هذه المساهمة خارج نطاق مسؤوليتك.','🚫 This contribution is outside your assigned scope.'],
  ['👁 معاينة الملف','👁 Preview File'],['⚠️ تعذّر إرسال الملف من Telegram.','⚠️ Could not send the file through Telegram.'],
  ['⚠️ لا يوجد ملف مرفق أو تعذّر إرساله.','⚠️ No file is attached or it could not be sent.'],
  ['⬆️ هذه هي المساهمة كما وصلت. لم تتغيّر حالتها.','⬆️ This is the contribution as received. Its status is unchanged.'],
  ['⚠️ المساهمة غير موجودة أو تمت معالجتها بالفعل.','⚠️ The contribution does not exist or has already been processed.'],
  ['🗂 فتح القسم','🗂 Open Section'],['✅ <b>تم قبول مساهمتك</b>','✅ <b>Your contribution was approved</b>'],
  ['أصبحت الآن مورداً متاحاً في المنصة. شكراً لك!','It is now an available resource on the platform. Thank you!'],
  ['تم رفض مساهمتك','Your contribution was rejected'],['مساهمتك بحاجة إلى تعديل','Your contribution needs revision'],
  ['يمكنك مراجعة سبب الرفض في 📄 مساهماتي.','You can review the rejection reason in 📄 My Contributions.'],
  ['يرجى إعادة إرسالها عبر 📄 مساهماتي.','Please resubmit it through 📄 My Contributions.'],
  ['🔎 بحث في الموارد','🔎 Search Resources'],['🔎 بحث آخر','🔎 Search Again'],
  ['⚠️ تعذّر إرسال الملف من Telegram حالياً.','⚠️ Could not send the file through Telegram right now.'],['✅ تم إرسال المورد.','✅ Resource sent.'],
  ['🔎 <b>بحث في موارد المنصة</b>','🔎 <b>Search Platform Resources</b>'],
  ['اكتب اسم مادة أو قسم أو مورد، وسيبحث MEDBOT في الموارد المسجّلة فقط.','Enter a subject, section, or resource name. MEDBOT searches only registered resources.'],
  ['مثال: CBC · فسيولوجيا · منهج السنة الثانية','Example: CBC · Physiology · Second-year curriculum'],
  ['نتائج البحث عن:','Search results for:'],['قسم بدون موارد مسجّلة','Section with no registered resources'],['مورد','resource'],
  ['📄 مستند','📄 Document'],['🎧 صوتي','🎧 Audio'],['🎥 فيديو','🎥 Video'],['🖼 صورة','🖼 Image'],
  ['⏳ قيد المراجعة','⏳ Pending Review'],['✅ مقبول','✅ Approved'],['❌ مرفوض','❌ Rejected'],['🔁 بحاجة لتعديل','🔁 Needs Revision'],
  ['⚠️ نوع الرسالة غير مدعوم.','⚠️ Unsupported message type.'],
  ['⚠️ تعذر إرسال الرسالة حالياً. لم يتم تأكيد الإرسال.','⚠️ Could not send the message. Submission was not confirmed.'],
  ['ℹ️ لا توجد أخبار منشورة حالياً.','ℹ️ No published news yet.'],
  ['📖 قراءة الخبر','📖 Read News'],['📂 عرض المورد','📂 Open Resource'],['🗂 فتح القسم','🗂 Open Section'],
  ['✅ مقروء','✅ Read'],['🔵 جديد','🔵 New'],['🔽 المزيد','🔽 More'],['⬅️ الأخبار','⬅️ News'],
  ['⚙️ اشتراكات الأخبار','⚙️ News Subscriptions'],['📋 كل الأخبار','📋 All News'],
  ['🚨 أخبار هام / عاجل','🚨 Important / Urgent News'],['📚 أخبار الأقسام','📚 Section News'],
  ['🔔 الإشعارات','🔔 Notifications'],['⚙️ <b>اشتراكات الأخبار</b>','⚙️ <b>News Subscriptions</b>'],
  ['اختر ما يصلك كرسالة خاصة.','Choose what you receive as private messages.'],
  ['📚 إدارة الأقسام المتابَعة','📚 Manage Followed Sections'],['⚠️ نوع غير معروف.','⚠️ Unknown type.'],
  ['⚠️ قسم غير صالح.','⚠️ Invalid section.'],['⚠️ القسم غير موجود.','⚠️ Section not found.'],
  ['📬 سجل التوصيل','📬 Delivery Log'],['🔁 إعادة المحاولة','🔁 Retry'],
]);

function replaceKnownPhrases(text, sourceLanguage, targetLanguage) {
  if (sourceLanguage === targetLanguage) return text;
  let output = String(text ?? '');
  for (const [ar, en] of LEGACY_TEXT_PAIRS) {
    const from = sourceLanguage === 'ar' ? ar : en;
    const to = sourceLanguage === 'ar' ? en : ar;
    const isSafePhrase = from.length >= 6 || /[\u{1F300}-\u{1FAFF}]/u.test(from);
    if (isSafePhrase && from && output.includes(from)) output = output.split(from).join(to);
  }
  return output;
}

export function localizeText(text, targetLanguage = DEFAULT_LANGUAGE, sourceLanguage = null) {
  const target = targetLanguage === 'en' ? 'en' : 'ar';
  const raw = String(text ?? '');
  if (!raw) return raw;
  const source = sourceLanguage === 'ar' || sourceLanguage === 'en'
    ? sourceLanguage
    : /[\u0600-\u06FF]/.test(raw) ? 'ar' : 'en';
  let localized = replaceKnownPhrases(raw, source, target);
  if (target === 'en') localized = localized.replaceAll('🔎 بحث في موارد المنصة', '🔎 Search Platform Resources');
  if (target === 'ar') localized = localized.replaceAll('🔎 Search Platform Resources', '🔎 بحث في موارد المنصة');
  return localized;
}

export function localizeMarkup(markup, targetLanguage = DEFAULT_LANGUAGE) {
  if (!markup || typeof markup !== 'object') return markup;
  if (!Array.isArray(markup.inline_keyboard)) return markup;
  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map((row) =>
      Array.isArray(row)
        ? row.map((button) =>
            button && typeof button === 'object' && !button.url
              ? { ...button, text: localizeText(button.text, targetLanguage) }
              : button,
          )
        : row,
    ),
  };
}

export function localizeOutgoing({ text = null, markup = null, targetLanguage = DEFAULT_LANGUAGE, sourceLanguage = null } = {}) {
  return {
    text: text === null || text === undefined ? text : localizeText(text, targetLanguage, sourceLanguage),
    markup: localizeMarkup(markup, targetLanguage),
  };
}
