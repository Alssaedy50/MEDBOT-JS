/**
 * Central Platform Owner Bot (`pf_*` namespace & `/platform` control plane).
 *
 * Allows the Platform Developer (Super-Owner) to:
 *   - Provision new colleges with isolated databases, independent bot tokens, and assigned managers.
 *   - Support Telegram Managed Bots (college-owned bots with technical platform management).
 *   - Validate, activate, suspend, resume, or decommission any college bot.
 *   - Configure and toggle the mandatory developer platform channel across all college bots.
 *   - Inspect the centralized platform audit log.
 */

import {
  COLLEGE_STATUS,
  COLLEGE_STATUS_LABELS,
  MANAGED_BOT_MODES,
  MANAGED_BOT_MODE_LABELS,
  activateCollege,
  configureCollegeBotWebhook,
  createCollege,
  decommissionCollege,
  getCollege,
  isPlatformOwner,
  listColleges,
  listPlatformAuditLogs,
  setCollegeBotToken,
  suspendCollege,
  updateCollegeManager,
  validateCollegeConfiguration,
} from './registry.js';
import {
  getPlatformChannelConfig,
  setPlatformMandatoryChannel,
} from './membershipGate.js';

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, callback_data) => ({ text, callback_data });
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const PLATFORM_OWNER_PREFIXES = [
  'pf_hub',
  'pf_list',
  'pf_new',
  'pf_ch',
  'pf_ch_set',
  'pf_ch_toggle',
  'pf_audit',
  'pf_c:',
  'pf_act:',
  'pf_susp:',
  'pf_val:',
  'pf_mgr:',
  'pf_tok:',
  'pf_mode:',
  'pf_wh:',
  'pf_del:',
];

export async function buildPlatformOwnerHub(platformDb, user, env = {}) {
  if (!isPlatformOwner(user?.id, env)) {
    return {
      text: '🔒 <b>غير مصرح</b>\nهذه اللوحة مخصصة لمالك ومطور المنصة المركزية فقط.',
      reply_markup: kb([[btn('🏠 الرئيسية', 'home')]]),
    };
  }

  const colleges = await listColleges(platformDb, env);
  const chConfig = await getPlatformChannelConfig(platformDb, env);

  const activeCount = colleges.filter((c) => c.status === COLLEGE_STATUS.ACTIVE).length;
  const pendingCount = colleges.filter((c) => c.status === COLLEGE_STATUS.PENDING_SETUP).length;
  const suspendedCount = colleges.filter((c) => c.status === COLLEGE_STATUS.SUSPENDED).length;

  const text = [
    '🏛 <b>لوحة مالك المنصة المركزية (Multi-College Control Plane)</b>',
    '━━━━━━━━━━━━━━━━━━',
    `🏫 <b>إجمالي الكليات المسجلة:</b> ${colleges.length}`,
    `🟢 <b>نشطة:</b> ${activeCount} · 🟡 <b>قيد الإعداد:</b> ${pendingCount} · 🔴 <b>موقوفة:</b> ${suspendedCount}`,
    '',
    `📢 <b>قناة المنصة الإجبارية الموحدة:</b> ${
      chConfig.enabled && chConfig.channelId
        ? `✅ مفعّلة (<code>${esc(chConfig.channelId)}</code>)`
        : '⚪️ غير مفعّلة'
    }`,
    '',
    'اختر الإجراء المطلوب لإدارة الكليات أو البوتات أو القناة المركزية:',
  ].join('\n');

  const rows = [
    [
      btn(`🏫 إدارة الكليات (${colleges.length})`, 'pf_list'),
      btn('➕ إنشاء كلية جديدة', 'pf_new'),
    ],
    [
      btn('📢 قناة المنصة الإجبارية', 'pf_ch'),
      btn('📜 سجل التدقيق المركزي', 'pf_audit'),
    ],
    [btn('🏠 الرئيسية', 'home')],
  ];

  return { text, reply_markup: kb(rows) };
}

export async function buildPlatformCollegesList(platformDb, user, env = {}) {
  if (!isPlatformOwner(user?.id, env)) {
    return buildPlatformOwnerHub(platformDb, user, env);
  }
  const colleges = await listColleges(platformDb, env);
  const iconFor = (status) =>
    status === COLLEGE_STATUS.ACTIVE
      ? '🟢'
      : status === COLLEGE_STATUS.SUSPENDED
        ? '🔴'
        : status === COLLEGE_STATUS.DECOMMISSIONED
          ? '⚫️'
          : '🟡';

  const lines = [
    '🏫 <b>قائمة الكليات المسجلة في المنصة</b>',
    '━━━━━━━━━━━━━━━━━━',
    colleges.length
      ? 'اضغط على أي كلية لعرض تفاصيلها، فحص جاهزيتها، تعيين مديرها، أو تفعيل/إيقاف البوت الخاص بها:'
      : 'لا توجد كليات مسجلة بعد.',
  ];

  const rows = colleges.map((c) => [
    btn(
      `${iconFor(c.status)} ${c.name_ar} (${c.college_id})`,
      `pf_c:${c.college_id}`,
    ),
  ]);

  rows.push([btn('➕ إنشاء كلية جديدة', 'pf_new')]);
  rows.push([btn('⬅️ لوحة المنصة المركزية', 'pf_hub')]);

  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

export async function buildPlatformCollegeDetail(platformDb, user, collegeId, env = {}) {
  if (!isPlatformOwner(user?.id, env)) {
    return buildPlatformOwnerHub(platformDb, user, env);
  }
  const validation = await validateCollegeConfiguration(platformDb, env, collegeId);
  const c = validation.college;
  if (!c) {
    return {
      text: '⚠️ الكلية المطلوبة غير موجودة.',
      reply_markup: kb([[btn('⬅️ قائمة الكليات', 'pf_list')]]),
    };
  }

  const statusLabel = COLLEGE_STATUS_LABELS[c.status] || c.status;
  const modeLabel = MANAGED_BOT_MODE_LABELS[c.managed_bot_mode] || c.managed_bot_mode;
  const checkLines = validation.checks.map(
    (chk) => `${chk.ok ? '✅' : '⚠️'} <b>${esc(chk.label)}:</b> <code>${esc(chk.detail)}</code>`,
  );

  const webhookPath =
    c.college_id === 'default'
      ? '/telegram/webhook'
      : `/telegram/webhook/${c.college_id}`;

  const lines = [
    `🏫 <b>بطاقة إدارة الكلية: ${esc(c.name_ar)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    `🆔 <b>المعرّف (Slug):</b> <code>${esc(c.college_id)}</code>`,
    `📌 <b>الحالة:</b> ${esc(statusLabel)}`,
    c.suspension_reason ? `⛔ <b>سبب الإيقاف:</b> ${esc(c.suspension_reason)}` : null,
    `🤖 <b>نمط ملكية البوت:</b> ${esc(modeLabel)}`,
    `🔗 <b>مسار الـ Webhook:</b> <code>${esc(c.webhook_url || webhookPath)}</code>`,
    '',
    '📋 <b>فحص العزل والاعتمادات:</b>',
    ...checkLines,
  ].filter(Boolean);

  const rows = [];
  if (c.status !== COLLEGE_STATUS.ACTIVE) {
    rows.push([
      btn('✅ تفعيل الكلية الآن', `pf_act:${c.college_id}`),
      btn('🔍 فحص الجاهزية', `pf_val:${c.college_id}`),
    ]);
  } else if (c.college_id !== 'default') {
    rows.push([
      btn('⏸ إيقاف مؤقت للكلية', `pf_susp:${c.college_id}`),
      btn('🔍 فحص الجاهزية', `pf_val:${c.college_id}`),
    ]);
  } else {
    rows.push([btn('🔍 فحص الجاهزية', `pf_val:${c.college_id}`)]);
  }

  rows.push([
    btn('🤖 تعيين/تحديث توكن البوت', `pf_tok:${c.college_id}`),
    btn('👤 تعيين مدير الكلية', `pf_mgr:${c.college_id}`),
  ]);

  rows.push([
    btn('🔄 تبديل نمط Managed Bot', `pf_mode:${c.college_id}`),
    btn('🔗 تفعيل Webhook تلقائياً', `pf_wh:${c.college_id}`),
  ]);

  if (c.college_id !== 'default' && c.status !== COLLEGE_STATUS.DECOMMISSIONED) {
    rows.push([btn('🗑 إلغاء تفعيل الكلية (Decommission)', `pf_del:${c.college_id}`)]);
  }

  rows.push([btn('⬅️ قائمة الكليات', 'pf_list'), btn('🏛 لوحة المنصة', 'pf_hub')]);

  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

export async function buildPlatformChannelScreen(platformDb, user, env = {}) {
  if (!isPlatformOwner(user?.id, env)) {
    return buildPlatformOwnerHub(platformDb, user, env);
  }
  const cfg = await getPlatformChannelConfig(platformDb, env);
  const text = [
    '📢 <b>إعدادات قناة المنصة المركزية (الاشتراك الإجباري الموحد)</b>',
    '━━━━━━━━━━━━━━━━━━',
    `📌 <b>الحالة:</b> ${cfg.enabled && cfg.channelId ? '🟢 مفعّل على جميع بوتات الكليات' : '⚪️ غير مفعّل'}`,
    `🆔 <b>معرّف القناة:</b> <code>${esc(cfg.channelId || 'غير مضبوط')}</code>`,
    `🏷 <b>اسم القناة:</b> ${esc(cfg.channelTitle || '—')}`,
    `🔗 <b>رابط الانضمام:</b> ${esc(cfg.channelUrl || 'يُشتق تلقائياً من @username')}`,
    '',
    '💡 عند تفعيل هذا الخيار، يتحقق النظام مركزياً من اشتراك أي طالب أو مستخدم في قناة المطور قبل السماح له باستخدام أي بوت كلية.',
  ].join('\n');

  const rows = [
    [
      btn('⚙️ ضبط قناة المنصة الإجبارية', 'pf_ch_set'),
      btn(cfg.enabled ? '⏸ تعطيل الشرط مؤقتاً' : '▶️ تفعيل الشرط', 'pf_ch_toggle'),
    ],
    [btn('⬅️ لوحة المنصة المركزية', 'pf_hub')],
  ];

  return { text, reply_markup: kb(rows) };
}

export async function buildPlatformAuditScreen(platformDb, user, env = {}) {
  if (!isPlatformOwner(user?.id, env)) {
    return buildPlatformOwnerHub(platformDb, user, env);
  }
  const logs = await listPlatformAuditLogs(platformDb, { limit: 15 });
  const lines = [
    '📜 <b>سجل التدقيق الأمني المركزي للمنصة (Audit Log)</b>',
    '━━━━━━━━━━━━━━━━━━',
    logs.length
      ? logs
          .map(
            (l) =>
              `• <code>${esc(l.action)}</code> ${l.collegeId ? `[<b>${esc(l.collegeId)}</b>]` : ''} — بواسطة <code>${esc(l.actorId ?? 'system')}</code>`,
          )
          .join('\n')
      : 'لا توجد أحداث مسجلة بعد.',
  ];

  return {
    text: lines.join('\n'),
    reply_markup: kb([[btn('⬅️ لوحة المنصة المركزية', 'pf_hub')]]),
  };
}

export function clearPlatformWizardState(userData) {
  if (!userData) return;
  userData.pf_new_college = false;
  userData.pf_set_channel = false;
  userData.pf_set_mgr_college = null;
  userData.pf_set_tok_college = null;
  userData.pf_suspend_college = null;
}

export async function handlePlatformOwnerCallback(ctx, bot, env = {}, requestUrl = null) {
  const data = String(ctx.data ?? '');
  const platformDb = env?.PLATFORM_DB || env?.DB || ctx.db;

  if (!isPlatformOwner(ctx.from?.id, env)) {
    await ctx.answer();
    return ctx.editMessageText('🔒 هذه اللوحة مخصصة لمالك ومطور المنصة المركزية فقط.', {
      reply_markup: kb([[btn('🏠 الرئيسية', 'home')]]),
      parse_mode: 'HTML',
    });
  }

  clearPlatformWizardState(ctx.userData);

  if (data === 'pf_hub') {
    const screen = await buildPlatformOwnerHub(platformDb, ctx.from, env);
    await ctx.answer();
    return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: 'HTML' });
  }

  if (data === 'pf_list') {
    const screen = await buildPlatformCollegesList(platformDb, ctx.from, env);
    await ctx.answer();
    return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: 'HTML' });
  }

  if (data === 'pf_new') {
    ctx.userData.pf_new_college = true;
    await ctx.answer();
    return ctx.editMessageText(
      [
        '➕ <b>إنشاء / تسجيل كلية جديدة في المنصة</b>',
        '━━━━━━━━━━━━━━━━━━',
        'أرسل بيانات الكلية في رسالة واحدة بالترتيب التالي (مفصولة بعلامة <code>|</code> أو في أسطر):',
        '',
        '<code>slug | اسم الكلية بالعربية | Telegram ID لمدير الكلية | توكن البوت (اختياري)</code>',
        '',
        '📌 <b>مثال 1 (مع توكن البوت):</b>',
        '<code>pharmacy | كلية الصيدلة | 123456789 | 77889900:AAH...</code>',
        '',
        '📌 <b>مثال 2 (بدون توكن حالياً — يربطه مدير الكلية لاحقاً):</b>',
        '<code>dentistry | كلية طب الأسنان | 987654321</code>',
      ].join('\n'),
      {
        reply_markup: kb([[btn('❌ إلغاء', 'pf_list')]]),
        parse_mode: 'HTML',
      },
    );
  }

  if (data === 'pf_ch') {
    const screen = await buildPlatformChannelScreen(platformDb, ctx.from, env);
    await ctx.answer();
    return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: 'HTML' });
  }

  if (data === 'pf_ch_set') {
    ctx.userData.pf_set_channel = true;
    await ctx.answer();
    return ctx.editMessageText(
      [
        '📢 <b>ضبط قناة المنصة الإجبارية الموحدة</b>',
        '━━━━━━━━━━━━━━━━━━',
        'أرسل معرّف قناة المطور الرسمية (وبشكل اختياري اسمها ورابطها مفصولاً بـ <code>|</code>):',
        '',
        '<code>@medbot_official | قناة منصة MEDBOT الرسمية | https://t.me/medbot_official</code>',
        '',
        'أو أرسل فقط معرّف القناة مثل: <code>@medbot_official</code>',
      ].join('\n'),
      {
        reply_markup: kb([[btn('❌ إلغاء', 'pf_ch')]]),
        parse_mode: 'HTML',
      },
    );
  }

  if (data === 'pf_ch_toggle') {
    const current = await getPlatformChannelConfig(platformDb, env);
    if (!current.channelId) {
      await ctx.answer();
      return ctx.editMessageText('⚠️ يرجى ضبط معرّف القناة أولاً قبل التفعيل.', {
        reply_markup: kb([[btn('⚙️ ضبط القناة الآن', 'pf_ch_set'), btn('⬅️ رجوع', 'pf_ch')]]),
        parse_mode: 'HTML',
      });
    }
    await setPlatformMandatoryChannel(platformDb, {
      channelId: current.channelId,
      channelUrl: current.channelUrl,
      channelTitle: current.channelTitle,
      enabled: !current.enabled,
      actorId: ctx.from.id,
    });
    const screen = await buildPlatformChannelScreen(platformDb, ctx.from, env);
    await ctx.answer();
    return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: 'HTML' });
  }

  if (data === 'pf_audit') {
    const screen = await buildPlatformAuditScreen(platformDb, ctx.from, env);
    await ctx.answer();
    return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: 'HTML' });
  }

  if (data.startsWith('pf_c:') || data.startsWith('pf_val:')) {
    const slug = data.split(':')[1];
    const screen = await buildPlatformCollegeDetail(platformDb, ctx.from, slug, env);
    await ctx.answer();
    return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: 'HTML' });
  }

  if (data.startsWith('pf_act:')) {
    const slug = data.split(':')[1];
    const res = await activateCollege(platformDb, env, slug, ctx.from.id, { force: true });
    const screen = await buildPlatformCollegeDetail(platformDb, ctx.from, slug, env);
    await ctx.answer();
    const banner = res.ok ? '✅ تم تفعيل بوت الكلية بنجاح!' : `⚠️ ${esc(res.error)}`;
    return ctx.editMessageText(`${banner}\n\n${screen.text}`, {
      reply_markup: screen.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (data.startsWith('pf_susp:')) {
    const slug = data.split(':')[1];
    const res = await suspendCollege(
      platformDb,
      env,
      slug,
      'موقوف مؤقتاً من قِبل إدارة المنصة المركزية',
      ctx.from.id,
    );
    const screen = await buildPlatformCollegeDetail(platformDb, ctx.from, slug, env);
    await ctx.answer();
    const banner = res.ok ? '⏸ تم إيقاف بوت الكلية مؤقتاً.' : `⚠️ ${esc(res.error)}`;
    return ctx.editMessageText(`${banner}\n\n${screen.text}`, {
      reply_markup: screen.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (data.startsWith('pf_mgr:')) {
    const slug = data.split(':')[1];
    ctx.userData.pf_set_mgr_college = slug;
    await ctx.answer();
    return ctx.editMessageText(
      `👤 <b>تعيين مدير الكلية (<code>${esc(slug)}</code>)</b>\n\n` +
        `أرسل الرقم التعريفي (Telegram ID) لمدير الكلية (ويمكنك إضافة المعرّف النصي بعد مسافة، مثل: <code>123456789 @dean_user</code>):`,
      {
        reply_markup: kb([[btn('❌ إلغاء', `pf_c:${slug}`)]]),
        parse_mode: 'HTML',
      },
    );
  }

  if (data.startsWith('pf_tok:')) {
    const slug = data.split(':')[1];
    ctx.userData.pf_set_tok_college = slug;
    await ctx.answer();
    return ctx.editMessageText(
      `🤖 <b>تعيين أو تحديث توكن بوت الكلية (<code>${esc(slug)}</code>)</b>\n\n` +
        `أرسل توكن البوت المستقل (من <code>@BotFather</code> أو عبر تفويض Telegram Managed Bots).\n` +
        `🛡 سيتم حذف رسالتك تلقائياً بعد قراءة التوكن وتشفيره بمعيار AES-256-GCM.`,
      {
        reply_markup: kb([[btn('❌ إلغاء', `pf_c:${slug}`)]]),
        parse_mode: 'HTML',
      },
    );
  }

  if (data.startsWith('pf_mode:')) {
    const slug = data.split(':')[1];
    const current = await getCollege(platformDb, slug, env);
    if (current) {
      const nextMode =
        current.managed_bot_mode === MANAGED_BOT_MODES.MANAGED_BOT
          ? MANAGED_BOT_MODES.PLATFORM_CREATED
          : MANAGED_BOT_MODES.MANAGED_BOT;
      await platformDb
        .prepare('UPDATE platform_colleges SET managed_bot_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE college_id = ?')
        .bind(nextMode, slug)
        .run()
        .catch(() => {});
    }
    const screen = await buildPlatformCollegeDetail(platformDb, ctx.from, slug, env);
    await ctx.answer();
    return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: 'HTML' });
  }

  if (data.startsWith('pf_wh:')) {
    const slug = data.split(':')[1];
    const college = await getCollege(platformDb, slug, env, { includeDecryptedToken: true });
    await ctx.answer();
    if (!college?.bot_token) {
      const screen = await buildPlatformCollegeDetail(platformDb, ctx.from, slug, env);
      return ctx.editMessageText(`⚠️ يرجى ضبط توكن البوت أولاً قبل تفعيل الـ Webhook.\n\n${screen.text}`, {
        reply_markup: screen.reply_markup,
        parse_mode: 'HTML',
      });
    }
    const baseUrl =
      env?.WEBHOOK_BASE_URL ||
      (requestUrl ? new URL(requestUrl).origin : 'https://medbot-js.workers.dev');
    const targetUrl =
      slug === 'default'
        ? `${baseUrl.replace(/\/+$/, '')}/telegram/webhook`
        : `${baseUrl.replace(/\/+$/, '')}/telegram/webhook/${slug}`;
    const wh = await configureCollegeBotWebhook(college.bot_token, targetUrl, college.webhook_secret, {
      collegeNameAr: college.name_ar,
    });
    if (wh.ok) {
      await platformDb
        .prepare('UPDATE platform_colleges SET webhook_url = ?, updated_at = CURRENT_TIMESTAMP WHERE college_id = ?')
        .bind(targetUrl, slug)
        .run()
        .catch(() => {});
    }
    const screen = await buildPlatformCollegeDetail(platformDb, ctx.from, slug, env);
    const notice = wh.ok
      ? `✅ تم ربط الـ Webhook بنجاح: <code>${esc(targetUrl)}</code>`
      : `⚠️ تعذر ربط الـ Webhook تلقائياً: <code>${esc(wh.error)}</code>`;
    return ctx.editMessageText(`${notice}\n\n${screen.text}`, {
      reply_markup: screen.reply_markup,
      parse_mode: 'HTML',
    });
  }

  if (data.startsWith('pf_del:')) {
    const slug = data.split(':')[1];
    const res = await decommissionCollege(platformDb, env, slug, ctx.from.id);
    const screen = await buildPlatformCollegesList(platformDb, ctx.from, env);
    await ctx.answer();
    const banner = res.ok ? `🗑 تم إلغاء تفعيل الكلية (${esc(slug)}).` : `⚠️ ${esc(res.error)}`;
    return ctx.editMessageText(`${banner}\n\n${screen.text}`, {
      reply_markup: screen.reply_markup,
      parse_mode: 'HTML',
    });
  }
}

export async function handlePlatformOwnerText(ctx, bot, env = {}, requestUrl = null) {
  const platformDb = env?.PLATFORM_DB || env?.DB || ctx.db;

  if (!isPlatformOwner(ctx.from?.id, env)) {
    return false;
  }

  if (ctx.userData?.pf_new_college) {
    ctx.userData.pf_new_college = false;
    const raw = String(ctx.text ?? '').trim();
    const parts = raw.includes('|')
      ? raw.split('|').map((s) => s.trim())
      : raw.split('\n').map((s) => s.trim()).filter(Boolean);

    const [slug, nameAr, mgrRaw, tokenRaw] = parts;
    if (!slug || !nameAr) {
      await ctx.reply(
        '⚠️ صيغة غير مكتملة. أرسل على الأقل: <code>slug | اسم الكلية | معرّف المدير</code>',
        { parse_mode: 'HTML' },
      );
      return true;
    }

    if (tokenRaw && ctx.message?.message_id && bot?.deleteMessage) {
      await bot.deleteMessage(ctx.chatId || ctx.from.id, ctx.message.message_id).catch(() => {});
    }

    const mgrId = mgrRaw ? Number.parseInt(mgrRaw.replace(/[^\d]/g, ''), 10) || null : null;
    try {
      const baseUrl =
        env?.WEBHOOK_BASE_URL || (requestUrl ? new URL(requestUrl).origin : null);
      const created = await createCollege(platformDb, env, {
        slug,
        nameAr,
        managerTelegramId: mgrId,
        botToken: tokenRaw || null,
        actorId: ctx.from.id,
        webhookBaseUrl: baseUrl,
      });
      const detail = await buildPlatformCollegeDetail(platformDb, ctx.from, created.college_id, env);
      await ctx.reply(
        `🎉 <b>تم إنشاء الكلية وعزل قاعدة بياناتها بنجاح!</b>\n\n${detail.text}`,
        { reply_markup: detail.reply_markup, parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.reply(`❌ تعذر إنشاء الكلية: <code>${esc(err?.message || err)}</code>`, {
        reply_markup: kb([[btn('⬅️ قائمة الكليات', 'pf_list')]]),
        parse_mode: 'HTML',
      });
    }
    return true;
  }

  if (ctx.userData?.pf_set_channel) {
    ctx.userData.pf_set_channel = false;
    const parts = String(ctx.text ?? '')
      .split('|')
      .map((s) => s.trim());
    const [channelId, channelTitle, channelUrl] = parts;
    if (!channelId) {
      await ctx.reply('⚠️ يرجى إرسال معرّف قناة صالح مثل <code>@medbot_official</code>.', {
        parse_mode: 'HTML',
      });
      return true;
    }
    await setPlatformMandatoryChannel(platformDb, {
      channelId,
      channelTitle: channelTitle || null,
      channelUrl: channelUrl || null,
      enabled: true,
      actorId: ctx.from.id,
    });
    const screen = await buildPlatformChannelScreen(platformDb, ctx.from, env);
    await ctx.reply(`✅ <b>تم تفعيل وتحديث قناة المنصة الإجبارية بنجاح!</b>\n\n${screen.text}`, {
      reply_markup: screen.reply_markup,
      parse_mode: 'HTML',
    });
    return true;
  }

  if (ctx.userData?.pf_set_mgr_college) {
    const slug = ctx.userData.pf_set_mgr_college;
    ctx.userData.pf_set_mgr_college = null;
    const tokens = String(ctx.text ?? '').trim().split(/\s+/);
    const mgrId = Number.parseInt(tokens[0], 10);
    const mgrUsername = tokens[1] ? tokens[1].replace(/^@/, '') : null;

    try {
      await updateCollegeManager(platformDb, env, slug, mgrId, mgrUsername, ctx.from.id);
      const detail = await buildPlatformCollegeDetail(platformDb, ctx.from, slug, env);
      await ctx.reply(`✅ تم تعيين مدير الكلية (<code>${mgrId}</code>) ومنحه صلاحية المالك في قاعدة بيانات الكلية.\n\n${detail.text}`, {
        reply_markup: detail.reply_markup,
        parse_mode: 'HTML',
      });
    } catch (err) {
      await ctx.reply(`❌ معرّف المدير غير صالح: <code>${esc(err?.message || err)}</code>`, {
        reply_markup: kb([[btn('⬅️ رجوع للكلية', `pf_c:${slug}`)]]),
        parse_mode: 'HTML',
      });
    }
    return true;
  }

  if (ctx.userData?.pf_set_tok_college) {
    const slug = ctx.userData.pf_set_tok_college;
    ctx.userData.pf_set_tok_college = null;
    const rawToken = String(ctx.text ?? '').trim();

    if (ctx.message?.message_id && bot?.deleteMessage) {
      await bot.deleteMessage(ctx.chatId || ctx.from.id, ctx.message.message_id).catch(() => {});
    }

    try {
      const baseUrl =
        env?.WEBHOOK_BASE_URL || (requestUrl ? new URL(requestUrl).origin : null);
      await setCollegeBotToken(platformDb, env, slug, rawToken, ctx.from.id, {
        webhookBaseUrl: baseUrl,
      });
      const detail = await buildPlatformCollegeDetail(platformDb, ctx.from, slug, env);
      await ctx.reply(
        `✅ <b>تم تشفير وحفظ توكن بوت الكلية بنجاح!</b>\n🗑 تم حذف رسالتك المحتوية على التوكن لحمايتك.\n\n${detail.text}`,
        {
          reply_markup: detail.reply_markup,
          parse_mode: 'HTML',
        },
      );
    } catch (err) {
      await ctx.reply(`❌ تعذر حفظ توكن البوت: <code>${esc(err?.message || err)}</code>`, {
        reply_markup: kb([[btn('⬅️ رجوع للكلية', `pf_c:${slug}`)]]),
        parse_mode: 'HTML',
      });
    }
    return true;
  }

  return false;
}
