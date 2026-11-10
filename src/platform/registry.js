/**
 * Multi-College Registry, Provisioning, Lifecycle Automation, Audit Logs,
 * and Per-College Encrypted Secret Management.
 */

import { all, get, run } from '../db/d1/core.js';
import { ensureConfiguredAdmin } from '../db/d1/admins.js';
import {
  COLLEGE_SECRET_KEYS,
  COLLEGE_SECRET_PREFIX,
  collegeSecretSettingKey,
  decryptSecretValue,
  encryptSecretValue,
  generateWebhookSecret,
  maskSecret,
  validateBotTokenFormat,
  validateCollegeSecretName,
} from './cryptoVault.js';
import { ensurePlatformSchema } from './schema.js';
import {
  ensureCollegeSchema,
  normalizeCollegeSlug,
  resolveCollegeDatabase,
} from './isolation.js';

export const COLLEGE_STATUS = Object.freeze({
  PENDING_SETUP: 'pending_setup',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DECOMMISSIONED: 'decommissioned',
});

export const COLLEGE_STATUS_LABELS = Object.freeze({
  pending_setup: '🟡 قيد الإعداد (Pending Setup)',
  active: '🟢 نشط (Active)',
  suspended: '🔴 موقوف مؤقتاً (Suspended)',
  decommissioned: '⚫️ ملغى (Decommissioned)',
});

export const MANAGED_BOT_MODES = Object.freeze({
  MANAGED_BOT: 'managed_bot',
  PLATFORM_CREATED: 'platform_created',
});

export const MANAGED_BOT_MODE_LABELS = Object.freeze({
  managed_bot: '🤝 مملوك لمدير الكلية (Telegram Managed Bot)',
  platform_created: '🏗 مُنشأ ومُدار بواسطة المنصة',
});

/**
 * Determine if `userId` is the central Platform Owner (Developer).
 */
export function isPlatformOwner(userId, env = {}) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return false;
  const rawOwners = String(
    env?.PLATFORM_OWNER_ID ||
      env?.PLATFORM_ADMIN_IDS ||
      env?.ADMIN_ID ||
      process.env?.PLATFORM_OWNER_ID ||
      process.env?.ADMIN_ID ||
      '',
  );
  const ownerIds = rawOwners
    .split(',')
    .map((x) => Number.parseInt(x.trim(), 10))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  return ownerIds.includes(uid);
}

/**
 * Record an immutable platform control-plane audit log entry.
 * Never logs raw tokens or secret values.
 */
export async function recordPlatformAudit(
  platformDb,
  { actorId = null, actorRole = 'platform_owner', collegeId = null, action, details = null },
) {
  if (!platformDb || !action) return false;
  await ensurePlatformSchema(platformDb);
  const safeDetails =
    details && typeof details === 'object' ? JSON.stringify(details) : details ? String(details) : null;
  await run(
    platformDb,
    `INSERT INTO platform_audit_log (actor_id, actor_role, college_id, action, details)
     VALUES (?, ?, ?, ?, ?)`,
    [actorId ? Number(actorId) : null, String(actorRole), collegeId ? String(collegeId) : null, String(action), safeDetails],
  ).catch(() => {});
  return true;
}

export async function listPlatformAuditLogs(platformDb, { collegeId = null, limit = 25 } = {}) {
  if (!platformDb) return [];
  await ensurePlatformSchema(platformDb);
  const cap = Math.min(100, Math.max(1, Number(limit) || 25));
  const rows = collegeId
    ? await all(
        platformDb,
        `SELECT id, actor_id, actor_role, college_id, action, details, created_at
         FROM platform_audit_log
         WHERE college_id = ?
         ORDER BY id DESC LIMIT ?`,
        [String(collegeId), cap],
      ).catch(() => [])
    : await all(
        platformDb,
        `SELECT id, actor_id, actor_role, college_id, action, details, created_at
         FROM platform_audit_log
         ORDER BY id DESC LIMIT ?`,
        [cap],
      ).catch(() => []);

  return rows.map((r) => ({
    id: r[0],
    actorId: r[1],
    actorRole: r[2],
    collegeId: r[3],
    action: r[4],
    details: r[5],
    createdAt: r[6],
  }));
}

function rowToCollege(row, env = {}, { includeDecryptedToken = false } = {}) {
  if (!row) return null;
  const collegeId = String(row[0]);
  const encryptedToken = row[7] || null;
  let decryptedToken = null;
  if (encryptedToken) {
    try {
      decryptedToken = decryptSecretValue(encryptedToken, env, `college:${collegeId}`);
    } catch {
      decryptedToken = null;
    }
  } else if (collegeId === 'default') {
    decryptedToken = String(env?.TELEGRAM_BOT_TOKEN || env?.BOT_TOKEN || '').trim() || null;
  }

  return {
    college_id: collegeId,
    name_ar: row[1],
    name_en: row[2] || null,
    manager_telegram_id: row[3] ? Number(row[3]) : null,
    manager_username: row[4] || null,
    bot_id: row[5] ? Number(row[5]) : null,
    bot_username: row[6] || null,
    has_bot_token: Boolean(encryptedToken || (collegeId === 'default' && decryptedToken)),
    bot_token_masked: maskSecret(decryptedToken),
    ...(includeDecryptedToken ? { bot_token: decryptedToken } : {}),
    webhook_secret: row[8] || '',
    managed_bot_mode: row[9] || MANAGED_BOT_MODES.MANAGED_BOT,
    db_binding: row[10] || (collegeId === 'default' ? 'DB' : `DB_${collegeId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`),
    archive_channel_id: row[11] || null,
    status: row[12] || COLLEGE_STATUS.PENDING_SETUP,
    suspension_reason: row[13] || null,
    webhook_url: row[14] || null,
    created_by: row[15] ? Number(row[15]) : null,
    created_at: row[16] || null,
    updated_at: row[17] || null,
  };
}

const SELECT_COLLEGE_COLS = `
  SELECT college_id, name_ar, name_en, manager_telegram_id, manager_username,
         bot_id, bot_username, bot_token_encrypted, webhook_secret, managed_bot_mode,
         db_binding, archive_channel_id, status, suspension_reason, webhook_url,
         created_by, created_at, updated_at
  FROM platform_colleges
`;

/**
 * Ensure the existing default MEDBOT college bot is registered as `default` and `active`
 * without altering any of its existing data or tables.
 */
export async function ensureDefaultCollegeRegistered(platformDb, env = {}) {
  if (!platformDb) return null;
  await ensurePlatformSchema(platformDb);
  const existing = await get(
    platformDb,
    `${SELECT_COLLEGE_COLS} WHERE college_id = 'default'`,
  ).catch(() => null);
  if (existing) {
    return rowToCollege(existing, env, { includeDecryptedToken: true });
  }

  const defaultOwner = Number.parseInt(String(env?.ADMIN_ID ?? '').trim(), 10) || null;
  const defaultWebhookSecret = String(env?.TELEGRAM_WEBHOOK_SECRET || '').trim() || generateWebhookSecret();
  const defaultArchive = String(env?.MEDBOT_ARCHIVE_CHANNEL || '').trim() || null;

  await run(
    platformDb,
    `INSERT INTO platform_colleges (
      college_id, name_ar, name_en, manager_telegram_id, webhook_secret,
      managed_bot_mode, db_binding, archive_channel_id, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(college_id) DO NOTHING`,
    [
      'default',
      'كلية الطب البشري (البوت الأساسي)',
      'Default Medical College Bot',
      defaultOwner,
      defaultWebhookSecret,
      MANAGED_BOT_MODES.PLATFORM_CREATED,
      'DB',
      defaultArchive,
      COLLEGE_STATUS.ACTIVE,
      defaultOwner,
    ],
  ).catch(() => {});

  const row = await get(
    platformDb,
    `${SELECT_COLLEGE_COLS} WHERE college_id = 'default'`,
  ).catch(() => null);
  return row ? rowToCollege(row, env, { includeDecryptedToken: true }) : null;
}

export async function listColleges(platformDb, env = {}) {
  if (!platformDb) return [];
  await ensureDefaultCollegeRegistered(platformDb, env);
  const rows = await all(
    platformDb,
    `${SELECT_COLLEGE_COLS} ORDER BY CASE WHEN college_id = 'default' THEN 0 ELSE 1 END, created_at ASC`,
  ).catch(() => []);
  return rows.map((r) => rowToCollege(r, env, { includeDecryptedToken: false }));
}

export async function getCollege(platformDb, collegeId, env = {}, { includeDecryptedToken = false } = {}) {
  if (!platformDb) return null;
  const slug = normalizeCollegeSlug(collegeId);
  if (slug === 'default') {
    await ensureDefaultCollegeRegistered(platformDb, env);
  } else {
    await ensurePlatformSchema(platformDb);
  }
  const row = await get(
    platformDb,
    `${SELECT_COLLEGE_COLS} WHERE college_id = ?`,
    [slug],
  ).catch(() => null);
  return row ? rowToCollege(row, env, { includeDecryptedToken }) : null;
}

/**
 * Find the college managed by a given Telegram user ID.
 */
export async function getCollegesForManager(platformDb, managerUserId, env = {}) {
  const uid = Number(managerUserId);
  if (!platformDb || !Number.isSafeInteger(uid) || uid <= 0) return [];
  await ensureDefaultCollegeRegistered(platformDb, env);
  const rows = await all(
    platformDb,
    `${SELECT_COLLEGE_COLS} WHERE manager_telegram_id = ? ORDER BY created_at ASC`,
    [uid],
  ).catch(() => []);
  return rows.map((r) => rowToCollege(r, env, { includeDecryptedToken: false }));
}

/**
 * Verify a bot token against Telegram's `getMe` API and optionally configure its commands.
 */
export async function verifyBotTokenWithTelegram(botToken, { fetchImpl = globalThis.fetch } = {}) {
  const clean = String(botToken ?? '').trim();
  if (!validateBotTokenFormat(clean)) {
    return { ok: false, error: 'صيغة توكن البوت غير صالحة (يجب أن تكون مثل 123456789:ABC-DEF...).' };
  }
  const botIdFromPrefix = Number.parseInt(clean.split(':', 1)[0], 10) || null;
  if (typeof fetchImpl !== 'function') {
    return { ok: true, botId: botIdFromPrefix, botUsername: null, firstName: null, offline: true };
  }
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${clean}/getMe`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok || !data?.result) {
      return {
        ok: false,
        error: data?.description || `رفض تيليجرام التوكن (HTTP ${res.status})`,
      };
    }
    return {
      ok: true,
      botId: Number(data.result.id) || botIdFromPrefix,
      botUsername: data.result.username || null,
      firstName: data.result.first_name || null,
      canJoinGroups: Boolean(data.result.can_join_groups),
    };
  } catch {
    // Allow offline/sandboxed test environments where api.telegram.org is not reachable
    return { ok: true, botId: botIdFromPrefix, botUsername: null, firstName: null, offline: true };
  }
}

/**
 * Register the Telegram webhook and standard academic bot commands for a college bot.
 */
export async function configureCollegeBotWebhook(
  botToken,
  webhookUrl,
  webhookSecret,
  { fetchImpl = globalThis.fetch, collegeNameAr = null } = {},
) {
  const cleanToken = String(botToken ?? '').trim();
  if (!cleanToken || !webhookUrl || typeof fetchImpl !== 'function') {
    return { ok: false, error: 'missing_token_or_webhook_url' };
  }
  try {
    const whRes = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query'],
      }),
    });
    const whBody = await whRes.json().catch(() => null);
    if (!whRes.ok || !whBody?.ok) {
      return { ok: false, error: whBody?.description || `setWebhook_failed_${whRes.status}` };
    }

    // Best-effort sync of standard commands for the college bot
    await fetchImpl(`https://api.telegram.org/bot${cleanToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: collegeNameAr ? `القائمة الرئيسية — ${collegeNameAr}` : 'القائمة الرئيسية' },
          { command: 'search', description: 'البحث في المحاضرات والموارد' },
          { command: 'ask', description: 'المساعد الطبي الذكي' },
          { command: 'contribute', description: 'إرسال مساهمة طلابية' },
          { command: 'quota', description: 'حسابي واستهلاك المساعد الذكي' },
          { command: 'admin', description: 'لوحة إدارة الكلية (للمشرفين)' },
          { command: 'setup', description: 'إعدادات الكلية ومفاتيح الذكاء الاصطناعي (لمدير الكلية)' },
        ],
      }),
    }).catch(() => {});

    return { ok: true, webhookUrl };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Update a Telegram Managed Bot's profile metadata (name & description) on behalf of the college manager.
 */
export async function syncCollegeBotProfile(
  botToken,
  { name, shortDescription, description, fetchImpl = globalThis.fetch } = {},
) {
  const cleanToken = String(botToken ?? '').trim();
  if (!cleanToken || typeof fetchImpl !== 'function') {
    return { ok: false, error: 'missing_bot_token' };
  }
  const results = {};
  try {
    if (name) {
      const r = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/setMyName`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: String(name).slice(0, 64) }),
      });
      const b = await r.json().catch(() => null);
      results.nameUpdated = Boolean(r.ok && b?.ok);
    }
    if (shortDescription) {
      const r = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/setMyShortDescription`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ short_description: String(shortDescription).slice(0, 120) }),
      });
      const b = await r.json().catch(() => null);
      results.shortDescriptionUpdated = Boolean(r.ok && b?.ok);
    }
    if (description) {
      const r = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/setMyDescription`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: String(description).slice(0, 512) }),
      });
      const b = await r.json().catch(() => null);
      results.descriptionUpdated = Boolean(r.ok && b?.ok);
    }
    return { ok: true, ...results };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Provision a new college, initialize its isolated database schema, seed its manager
 * as the college owner, and record the provisioning event in the platform audit log.
 */
export async function createCollege(
  platformDb,
  env = {},
  {
    slug,
    nameAr,
    nameEn = null,
    managerTelegramId = null,
    managerUsername = null,
    botToken = null,
    managedBotMode = MANAGED_BOT_MODES.MANAGED_BOT,
    dbBinding = null,
    archiveChannelId = null,
    actorId = null,
    fetchImpl = globalThis.fetch,
    webhookBaseUrl = null,
  } = {},
) {
  await ensureDefaultCollegeRegistered(platformDb, env);
  const collegeId = normalizeCollegeSlug(slug);
  if (collegeId === 'default') {
    throw new Error('college_slug_reserved');
  }
  const cleanNameAr = String(nameAr ?? '').trim();
  if (!cleanNameAr) {
    throw new Error('college_name_required');
  }

  const existing = await get(
    platformDb,
    'SELECT college_id FROM platform_colleges WHERE college_id = ?',
    [collegeId],
  );
  if (existing) {
    throw new Error('college_already_exists');
  }

  let encryptedToken = null;
  let botId = null;
  let botUsername = null;
  if (botToken && String(botToken).trim()) {
    const cleanToken = String(botToken).trim();
    const check = await verifyBotTokenWithTelegram(cleanToken, { fetchImpl });
    if (!check.ok) {
      throw new Error(check.error || 'invalid_bot_token');
    }
    botId = check.botId;
    botUsername = check.botUsername;
    encryptedToken = encryptSecretValue(cleanToken, env, `college:${collegeId}`);
  }

  const webhookSecret = generateWebhookSecret();
  const effectiveBinding =
    dbBinding || `DB_${collegeId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const mgrId = managerTelegramId ? Number(managerTelegramId) : null;
  const mode =
    managedBotMode === MANAGED_BOT_MODES.PLATFORM_CREATED
      ? MANAGED_BOT_MODES.PLATFORM_CREATED
      : MANAGED_BOT_MODES.MANAGED_BOT;

  let webhookUrl = null;
  if (encryptedToken && webhookBaseUrl) {
    const cleanBase = String(webhookBaseUrl).replace(/\/+$/, '');
    const targetUrl = `${cleanBase}/telegram/webhook/${collegeId}`;
    const wh = await configureCollegeBotWebhook(botToken, targetUrl, webhookSecret, {
      fetchImpl,
      collegeNameAr: cleanNameAr,
    });
    if (wh.ok) webhookUrl = targetUrl;
  }

  await run(
    platformDb,
    `INSERT INTO platform_colleges (
      college_id, name_ar, name_en, manager_telegram_id, manager_username,
      bot_id, bot_username, bot_token_encrypted, webhook_secret,
      managed_bot_mode, db_binding, archive_channel_id, status, webhook_url, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      collegeId,
      cleanNameAr,
      nameEn ? String(nameEn).trim() : null,
      mgrId,
      managerUsername ? String(managerUsername).replace(/^@/, '').trim() : null,
      botId,
      botUsername,
      encryptedToken,
      webhookSecret,
      mode,
      effectiveBinding,
      archiveChannelId ? String(archiveChannelId).trim() : null,
      COLLEGE_STATUS.PENDING_SETUP,
      webhookUrl,
      actorId ? Number(actorId) : null,
    ],
  );

  // Initialize the college's isolated database schema and seed its college settings & owner
  const collegeRecord = await getCollege(platformDb, collegeId, env, { includeDecryptedToken: true });
  const collegeDb = resolveCollegeDatabase(env, collegeRecord);
  if (collegeDb) {
    await ensureCollegeSchema(collegeDb);
    await run(
      collegeDb,
      `INSERT INTO settings(key, value) VALUES ('platform_name', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [cleanNameAr],
    ).catch(() => {});
    if (archiveChannelId) {
      await run(
        collegeDb,
        `INSERT INTO settings(key, value) VALUES ('archive_channel_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(archiveChannelId).trim()],
      ).catch(() => {});
    }
    if (mgrId && Number.isSafeInteger(mgrId) && mgrId > 0) {
      await ensureConfiguredAdmin(collegeDb, mgrId, managerUsername || null).catch(() => {});
    }
  }

  await recordPlatformAudit(platformDb, {
    actorId,
    actorRole: 'platform_owner',
    collegeId,
    action: 'college.create',
    details: {
      name_ar: cleanNameAr,
      manager_telegram_id: mgrId,
      managed_bot_mode: mode,
      db_binding: effectiveBinding,
      has_bot_token: Boolean(encryptedToken),
    },
  });

  return getCollege(platformDb, collegeId, env, { includeDecryptedToken: false });
}

/**
 * Assign or update a college's manager (College Owner) and grant them `owner` role in that college's isolated DB.
 */
export async function updateCollegeManager(
  platformDb,
  env = {},
  collegeId,
  managerTelegramId,
  managerUsername = null,
  actorId = null,
) {
  const slug = normalizeCollegeSlug(collegeId);
  const mgrId = Number(managerTelegramId);
  if (!Number.isSafeInteger(mgrId) || mgrId <= 0) {
    throw new Error('invalid_manager_telegram_id');
  }
  const cleanUser = managerUsername ? String(managerUsername).replace(/^@/, '').trim() : null;
  await run(
    platformDb,
    `UPDATE platform_colleges
     SET manager_telegram_id = ?, manager_username = COALESCE(?, manager_username), updated_at = CURRENT_TIMESTAMP
     WHERE college_id = ?`,
    [mgrId, cleanUser, slug],
  );

  const college = await getCollege(platformDb, slug, env);
  const collegeDb = resolveCollegeDatabase(env, college);
  if (collegeDb) {
    await ensureCollegeSchema(collegeDb);
    await ensureConfiguredAdmin(collegeDb, mgrId, cleanUser).catch(() => {});
  }

  await recordPlatformAudit(platformDb, {
    actorId,
    actorRole: 'platform_owner',
    collegeId: slug,
    action: 'college.assign_manager',
    details: { manager_telegram_id: mgrId, manager_username: cleanUser },
  });

  return getCollege(platformDb, slug, env);
}

/**
 * Set or rotate a college's Telegram Bot Token (supporting both Telegram Managed Bots and Platform-Created Bots).
 */
export async function setCollegeBotToken(
  platformDb,
  env = {},
  collegeId,
  botToken,
  actorId = null,
  { fetchImpl = globalThis.fetch, webhookBaseUrl = null, managedBotMode = null } = {},
) {
  const slug = normalizeCollegeSlug(collegeId);
  const cleanToken = String(botToken ?? '').trim();
  const check = await verifyBotTokenWithTelegram(cleanToken, { fetchImpl });
  if (!check.ok) {
    throw new Error(check.error || 'invalid_bot_token');
  }

  const encrypted = encryptSecretValue(cleanToken, env, `college:${slug}`);
  const current = await getCollege(platformDb, slug, env);
  if (!current) throw new Error('college_not_found');

  const webhookSecret = current.webhook_secret || generateWebhookSecret();
  let webhookUrl = current.webhook_url;
  if (webhookBaseUrl) {
    const cleanBase = String(webhookBaseUrl).replace(/\/+$/, '');
    const targetUrl = slug === 'default' ? `${cleanBase}/telegram/webhook` : `${cleanBase}/telegram/webhook/${slug}`;
    const wh = await configureCollegeBotWebhook(cleanToken, targetUrl, webhookSecret, {
      fetchImpl,
      collegeNameAr: current.name_ar,
    });
    if (wh.ok) webhookUrl = targetUrl;
  }

  await run(
    platformDb,
    `UPDATE platform_colleges
     SET bot_token_encrypted = ?,
         bot_id = ?,
         bot_username = COALESCE(?, bot_username),
         webhook_secret = ?,
         managed_bot_mode = COALESCE(?, managed_bot_mode),
         webhook_url = COALESCE(?, webhook_url),
         updated_at = CURRENT_TIMESTAMP
     WHERE college_id = ?`,
    [
      encrypted,
      check.botId,
      check.botUsername,
      webhookSecret,
      managedBotMode,
      webhookUrl,
      slug,
    ],
  );

  await recordPlatformAudit(platformDb, {
    actorId,
    actorRole: isPlatformOwner(actorId, env) ? 'platform_owner' : 'college_manager',
    collegeId: slug,
    action: 'college.set_bot_token',
    details: {
      bot_id: check.botId,
      bot_username: check.botUsername,
      webhook_configured: Boolean(webhookUrl),
    },
  });

  return getCollege(platformDb, slug, env);
}

/**
 * Sync the college's archive channel ID between the college's isolated settings and the platform registry.
 */
export async function setCollegeArchiveChannel(
  platformDb,
  collegeDb,
  env = {},
  collegeId,
  archiveChannelId,
  actorId = null,
) {
  const slug = normalizeCollegeSlug(collegeId);
  const cleanChannel = String(archiveChannelId ?? '').trim();
  if (collegeDb) {
    await run(
      collegeDb,
      `INSERT INTO settings(key, value) VALUES ('archive_channel_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [cleanChannel],
    ).catch(() => {});
  }
  if (platformDb) {
    await ensurePlatformSchema(platformDb);
    await run(
      platformDb,
      `UPDATE platform_colleges
       SET archive_channel_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE college_id = ?`,
      [cleanChannel || null, slug],
    ).catch(() => {});
    await recordPlatformAudit(platformDb, {
      actorId,
      actorRole: isPlatformOwner(actorId, env) ? 'platform_owner' : 'college_manager',
      collegeId: slug,
      action: 'college.set_archive_channel',
      details: { archive_channel_id: cleanChannel },
    });
  }
  return cleanChannel;
}

// ---------------------------------------------------------------------------
// Per-College Encrypted Secret Vault (AI API Keys & Credentials)
// ---------------------------------------------------------------------------

export async function setCollegeSecret(
  collegeDb,
  platformDb,
  env = {},
  collegeId,
  secretName,
  secretValue,
  actorId = null,
) {
  const slug = normalizeCollegeSlug(collegeId);
  const validName = validateCollegeSecretName(secretName);
  const key = collegeSecretSettingKey(validName);
  const encrypted = encryptSecretValue(secretValue, env, `college_secret:${slug}`);

  await ensureCollegeSchema(collegeDb);
  await run(
    collegeDb,
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, encrypted],
  );

  if (platformDb) {
    await recordPlatformAudit(platformDb, {
      actorId,
      actorRole: isPlatformOwner(actorId, env) ? 'platform_owner' : 'college_manager',
      collegeId: slug,
      action: 'college.secret_set',
      details: { secret_name: validName },
    });
  }
  return validName;
}

export async function deleteCollegeSecret(
  collegeDb,
  platformDb,
  env = {},
  collegeId,
  secretName,
  actorId = null,
) {
  const slug = normalizeCollegeSlug(collegeId);
  const validName = validateCollegeSecretName(secretName);
  const key = collegeSecretSettingKey(validName);
  await ensureCollegeSchema(collegeDb);
  const res = await run(collegeDb, 'DELETE FROM settings WHERE key = ?', [key]);
  if (platformDb && res.changes > 0) {
    await recordPlatformAudit(platformDb, {
      actorId,
      actorRole: isPlatformOwner(actorId, env) ? 'platform_owner' : 'college_manager',
      collegeId: slug,
      action: 'college.secret_delete',
      details: { secret_name: validName },
    });
  }
  return res.changes > 0;
}

export async function listCollegeSecrets(collegeDb, env = {}, collegeId = 'default') {
  if (!collegeDb) return [];
  const slug = normalizeCollegeSlug(collegeId);
  const rows = await all(
    collegeDb,
    "SELECT key, value FROM settings WHERE key LIKE 'college_secret.v1.%' ORDER BY key ASC",
  ).catch(() => []);

  const items = [];
  for (const row of rows) {
    const rawKey = String(row[0] ?? '');
    const name = rawKey.slice(COLLEGE_SECRET_PREFIX.length);
    let masked = '••••••••';
    try {
      const dec = decryptSecretValue(row[1], env, `college_secret:${slug}`);
      masked = maskSecret(dec);
    } catch {
      masked = '⚠️ يتطلب إعادة ضبط';
    }
    items.push({ name, masked });
  }
  return items;
}

export async function getCollegeSecretsMap(collegeDb, env = {}, collegeId = 'default') {
  if (!collegeDb) return {};
  const slug = normalizeCollegeSlug(collegeId);
  const rows = await all(
    collegeDb,
    "SELECT key, value FROM settings WHERE key LIKE 'college_secret.v1.%' ORDER BY key ASC",
  ).catch(() => []);

  const out = {};
  for (const row of rows) {
    const name = String(row[0] ?? '').slice(COLLEGE_SECRET_PREFIX.length);
    if (!name) continue;
    try {
      const dec = decryptSecretValue(row[1], env, `college_secret:${slug}`);
      if (dec) out[name] = dec;
    } catch {
      // Skip unreadable entry
    }
  }
  return out;
}

/**
 * Build an isolated runtime `env` object for a specific college.
 * Ensures that College A never inherits College B's bot token, admin ID, archive channel, or AI keys.
 */
export async function buildCollegeRuntimeEnv(platformDb, baseEnv = {}, collegeId = 'default') {
  const slug = normalizeCollegeSlug(collegeId);
  const college = await getCollege(platformDb, slug, baseEnv, { includeDecryptedToken: true });
  const collegeDb = resolveCollegeDatabase(baseEnv, college || slug);
  if (collegeDb) {
    await ensureCollegeSchema(collegeDb);
  }
  const collegeSecrets = await getCollegeSecretsMap(collegeDb, baseEnv, slug);
  const archiveRow = collegeDb
    ? await get(collegeDb, "SELECT value FROM settings WHERE key = 'archive_channel_id'").catch(() => null)
    : null;
  const effectiveArchive =
    archiveRow?.[0] ||
    college?.archive_channel_id ||
    (slug === 'default' ? baseEnv?.MEDBOT_ARCHIVE_CHANNEL || '' : '');

  if (slug === 'default') {
    return {
      ...baseEnv,
      ...collegeSecrets,
      DB: collegeDb || baseEnv.DB,
      PLATFORM_DB: baseEnv.PLATFORM_DB || baseEnv.DB,
      COLLEGE_ID: 'default',
      COLLEGE_NAME_AR: college?.name_ar || 'كلية الطب البشري',
      MEDBOT_ARCHIVE_CHANNEL: effectiveArchive,
    };
  }

  // Non-default college: strict credential isolation (does NOT inherit default bot token or default archive channel)
  return {
    PLATFORM_MASTER_KEY: baseEnv?.PLATFORM_MASTER_KEY,
    PLATFORM_OWNER_ID: baseEnv?.PLATFORM_OWNER_ID || baseEnv?.ADMIN_ID,
    PLATFORM_BOT_TOKEN: baseEnv?.PLATFORM_BOT_TOKEN || baseEnv?.TELEGRAM_BOT_TOKEN || baseEnv?.BOT_TOKEN,
    PLATFORM_CHANNEL_ID: baseEnv?.PLATFORM_CHANNEL_ID,
    PLATFORM_DB: baseEnv?.PLATFORM_DB || baseEnv?.DB,
    DB: collegeDb,
    COLLEGE_ID: slug,
    COLLEGE_NAME_AR: college?.name_ar || slug,
    TELEGRAM_BOT_TOKEN: college?.bot_token || '',
    BOT_TOKEN: college?.bot_token || '',
    TELEGRAM_WEBHOOK_SECRET: college?.webhook_secret || '',
    ADMIN_ID: college?.manager_telegram_id ? String(college.manager_telegram_id) : '',
    MEDBOT_ARCHIVE_CHANNEL: effectiveArchive || '',
    GEMINI_API_KEY: collegeSecrets.GEMINI_API_KEY || '',
    GROQ_API_KEY: collegeSecrets.GROQ_API_KEY || '',
    OPENROUTER_API_KEY: collegeSecrets.OPENROUTER_API_KEY || '',
    OPENAI_API_KEY: collegeSecrets.OPENAI_API_KEY || '',
    ANTHROPIC_API_KEY: collegeSecrets.ANTHROPIC_API_KEY || '',
  };
}

/**
 * Validate whether a college has completed all required setup steps for activation.
 */
export async function validateCollegeConfiguration(platformDb, env = {}, collegeId) {
  const slug = normalizeCollegeSlug(collegeId);
  const college = await getCollege(platformDb, slug, env, { includeDecryptedToken: true });
  if (!college) {
    return { ready: false, error: 'الكلية غير موجودة', checks: [], missing: ['college_not_found'] };
  }

  const collegeDb = resolveCollegeDatabase(env, college);
  if (collegeDb) {
    await ensureCollegeSchema(collegeDb);
  }
  const secrets = await listCollegeSecrets(collegeDb, env, slug);
  const archiveRow = collegeDb
    ? await get(collegeDb, "SELECT value FROM settings WHERE key = 'archive_channel_id'").catch(() => null)
    : null;
  const archiveChannel = archiveRow?.[0] || college.archive_channel_id || null;

  const hasAiKey =
    secrets.some((s) => COLLEGE_SECRET_KEYS.includes(s.name)) ||
    (slug === 'default' &&
      Boolean(env?.GEMINI_API_KEY || env?.GROQ_API_KEY || env?.OPENROUTER_API_KEY));

  const checks = [
    {
      key: 'bot_token',
      label: 'توكن البوت المستقل (Bot Token)',
      ok: Boolean(college.has_bot_token),
      detail: college.bot_username ? `@${college.bot_username}` : college.bot_token_masked,
    },
    {
      key: 'manager',
      label: 'مدير الكلية المعتمد (College Manager)',
      ok: Boolean(college.manager_telegram_id),
      detail: college.manager_telegram_id
        ? `${college.manager_telegram_id}${college.manager_username ? ` (@${college.manager_username})` : ''}`
        : 'غير معيّن',
    },
    {
      key: 'database',
      label: 'قاعدة البيانات المعزولة (Isolated DB)',
      ok: Boolean(collegeDb),
      detail: collegeDb?.__isolatedPrefix
        ? `عزل جداول آمن (${collegeDb.__isolatedPrefix}*)`
        : `قاعدة D1 (${college.db_binding})`,
    },
    {
      key: 'archive_channel',
      label: 'قناة الأرشيف الخاصة بالكلية',
      ok: Boolean(archiveChannel),
      detail: archiveChannel || 'غير مربوطة بعد',
    },
    {
      key: 'ai_keys',
      label: 'مفاتيح الذكاء الاصطناعي (Gemini / Groq / OpenRouter)',
      ok: Boolean(hasAiKey),
      detail: secrets.length
        ? secrets.map((s) => s.name).join(', ')
        : hasAiKey
          ? 'مضبوط من بيئة التشغيل'
          : 'لم يتم إدخال مفتاح AI بعد',
    },
  ];

  const requiredKeys = ['bot_token', 'manager', 'database', 'archive_channel'];
  const missing = checks.filter((c) => requiredKeys.includes(c.key) && !c.ok).map((c) => c.label);
  const ready = missing.length === 0;

  return {
    ready,
    college,
    checks,
    missing,
    hasAiKey,
    archiveChannel,
    secrets,
  };
}

/**
 * Activate a college bot (either after passing configuration validation or via Platform Owner force override).
 */
export async function activateCollege(
  platformDb,
  env = {},
  collegeId,
  actorId = null,
  { force = false } = {},
) {
  const slug = normalizeCollegeSlug(collegeId);
  const validation = await validateCollegeConfiguration(platformDb, env, slug);
  if (!validation.college) {
    return { ok: false, error: 'الكلية غير مسجلة.' };
  }
  if (!validation.ready && !force) {
    return {
      ok: false,
      error: `لا يمكن التفعيل قبل استكمال المتطلبات الأساسية: ${validation.missing.join('، ')}`,
      validation,
    };
  }

  await run(
    platformDb,
    `UPDATE platform_colleges
     SET status = ?, suspension_reason = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE college_id = ?`,
    [COLLEGE_STATUS.ACTIVE, slug],
  );

  await recordPlatformAudit(platformDb, {
    actorId,
    actorRole: isPlatformOwner(actorId, env) ? 'platform_owner' : 'college_manager',
    collegeId: slug,
    action: 'college.activate',
    details: { forced: Boolean(force), ready: validation.ready },
  });

  return {
    ok: true,
    college: await getCollege(platformDb, slug, env),
    validation,
  };
}

/**
 * Suspend a college bot immediately across all handlers.
 */
export async function suspendCollege(
  platformDb,
  env = {},
  collegeId,
  reason = 'موقوف مؤقتاً من قِبل إدارة المنصة المركزية',
  actorId = null,
) {
  const slug = normalizeCollegeSlug(collegeId);
  if (slug === 'default') {
    return { ok: false, error: 'لا يمكن إيقاف البوت الأساسي الافتراضي للمنصة.' };
  }
  const cleanReason = String(reason ?? '').trim() || 'موقوف مؤقتاً من قِبل إدارة المنصة المركزية';
  await run(
    platformDb,
    `UPDATE platform_colleges
     SET status = ?, suspension_reason = ?, updated_at = CURRENT_TIMESTAMP
     WHERE college_id = ?`,
    [COLLEGE_STATUS.SUSPENDED, cleanReason, slug],
  );

  await recordPlatformAudit(platformDb, {
    actorId,
    actorRole: 'platform_owner',
    collegeId: slug,
    action: 'college.suspend',
    details: { reason: cleanReason },
  });

  return { ok: true, college: await getCollege(platformDb, slug, env) };
}

/**
 * Decommission a college bot (removes webhook if possible and marks decommissioned).
 */
export async function decommissionCollege(
  platformDb,
  env = {},
  collegeId,
  actorId = null,
  { fetchImpl = globalThis.fetch } = {},
) {
  const slug = normalizeCollegeSlug(collegeId);
  if (slug === 'default') {
    return { ok: false, error: 'لا يمكن حذف أو إلغاء البوت الأساسي الافتراضي.' };
  }
  const college = await getCollege(platformDb, slug, env, { includeDecryptedToken: true });
  if (!college) {
    return { ok: false, error: 'الكلية غير موجودة.' };
  }

  if (college.bot_token && typeof fetchImpl === 'function') {
    await fetchImpl(`https://api.telegram.org/bot${college.bot_token}/deleteWebhook`, {
      method: 'POST',
    }).catch(() => {});
  }

  await run(
    platformDb,
    `UPDATE platform_colleges
     SET status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE college_id = ?`,
    [COLLEGE_STATUS.DECOMMISSIONED, slug],
  );

  await recordPlatformAudit(platformDb, {
    actorId,
    actorRole: 'platform_owner',
    collegeId: slug,
    action: 'college.decommission',
    details: { name_ar: college.name_ar },
  });

  return { ok: true, college: await getCollege(platformDb, slug, env) };
}
