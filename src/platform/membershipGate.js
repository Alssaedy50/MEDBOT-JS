/**
 * Centralized Mandatory Platform Channel Membership Verification Gate.
 *
 * Enforces that every user across every college bot is a member of the
 * developer's central platform channel before using any college bot feature.
 *
 * Uses a centralized verifier (Platform Bot token or College Bot fallback)
 * backed by a D1 membership cache (`platform_channel_memberships`) to stay
 * well within Cloudflare Worker free-tier subrequest limits.
 */

import { get, run } from '../db/d1/core.js';
import { ensurePlatformSchema } from './schema.js';
import { isPlatformOwner, recordPlatformAudit } from './registry.js';

const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for verified members
const ALLOWED_STATUSES = new Set(['creator', 'administrator', 'member']);

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function deriveChannelInviteUrl(channelId, explicitUrl = null) {
  const cleanUrl = String(explicitUrl ?? '').trim();
  if (/^https?:\/\/t\.me\//i.test(cleanUrl)) return cleanUrl;
  const raw = String(channelId ?? '').trim();
  if (raw.startsWith('@') && raw.length > 1) {
    return `https://t.me/${raw.slice(1)}`;
  }
  if (/^[a-zA-Z][a-zA-Z0-9_]{3,}$/.test(raw)) {
    return `https://t.me/${raw}`;
  }
  return cleanUrl || null;
}

/**
 * Retrieve the central mandatory platform channel configuration.
 */
export async function getPlatformChannelConfig(platformDb, env = {}) {
  let dbChannelId = null;
  let dbChannelUrl = null;
  let dbChannelTitle = null;
  let dbEnabled = null;

  if (platformDb && typeof platformDb.prepare === 'function') {
    await ensurePlatformSchema(platformDb);
    const idRow = await get(
      platformDb,
      "SELECT value FROM platform_settings WHERE key = 'mandatory_channel_id'",
    ).catch(() => null);
    const urlRow = await get(
      platformDb,
      "SELECT value FROM platform_settings WHERE key = 'mandatory_channel_url'",
    ).catch(() => null);
    const titleRow = await get(
      platformDb,
      "SELECT value FROM platform_settings WHERE key = 'mandatory_channel_title'",
    ).catch(() => null);
    const enabledRow = await get(
      platformDb,
      "SELECT value FROM platform_settings WHERE key = 'mandatory_membership_enabled'",
    ).catch(() => null);

    if (idRow?.[0] !== undefined) dbChannelId = String(idRow[0]).trim();
    if (urlRow?.[0] !== undefined) dbChannelUrl = String(urlRow[0]).trim();
    if (titleRow?.[0] !== undefined) dbChannelTitle = String(titleRow[0]).trim();
    if (enabledRow?.[0] !== undefined) dbEnabled = String(enabledRow[0]).trim();
  }

  const channelId =
    dbChannelId !== null
      ? dbChannelId
      : String(env?.PLATFORM_CHANNEL_ID || process.env?.PLATFORM_CHANNEL_ID || '').trim();
  const channelUrl = deriveChannelInviteUrl(
    channelId,
    dbChannelUrl || env?.PLATFORM_CHANNEL_URL || process.env?.PLATFORM_CHANNEL_URL || '',
  );
  const channelTitle =
    dbChannelTitle ||
    String(env?.PLATFORM_CHANNEL_TITLE || 'القناة الرسمية للمنصة الأكاديمية').trim();
  const enabled =
    Boolean(channelId) &&
    (dbEnabled === null
      ? String(env?.PLATFORM_MEMBERSHIP_ENABLED ?? '1') !== '0'
      : dbEnabled !== '0' && dbEnabled.toLowerCase() !== 'false');

  return {
    enabled,
    channelId: channelId || null,
    channelUrl,
    channelTitle,
  };
}

/**
 * Configure or update the developer's mandatory platform channel.
 */
export async function setPlatformMandatoryChannel(
  platformDb,
  { channelId, channelUrl = null, channelTitle = null, enabled = true, actorId = null } = {},
) {
  if (!platformDb) throw new Error('platform_db_required');
  await ensurePlatformSchema(platformDb);

  const rawId = String(channelId ?? '').trim();
  let normalizedId = rawId;
  if (/^https?:\/\/t\.me\/([a-zA-Z0-9_]+)/i.test(rawId)) {
    const m = rawId.match(/^https?:\/\/t\.me\/([a-zA-Z0-9_]+)/i);
    if (m && !m[1].startsWith('+')) {
      normalizedId = `@${m[1]}`;
    }
  } else if (normalizedId && !normalizedId.startsWith('@') && !normalizedId.startsWith('-100')) {
    if (/^[a-zA-Z][a-zA-Z0-9_]{3,}$/.test(normalizedId)) {
      normalizedId = `@${normalizedId}`;
    }
  }

  const resolvedUrl = deriveChannelInviteUrl(normalizedId, channelUrl);
  const resolvedTitle = String(channelTitle || 'القناة الرسمية للمنصة الأكاديمية').trim();
  const enabledStr = enabled && Boolean(normalizedId) ? '1' : '0';

  const entries = [
    ['mandatory_channel_id', normalizedId],
    ['mandatory_channel_url', resolvedUrl || ''],
    ['mandatory_channel_title', resolvedTitle],
    ['mandatory_membership_enabled', enabledStr],
  ];

  for (const [key, val] of entries) {
    await run(
      platformDb,
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [key, val],
    );
  }

  // Clear cached non-member statuses when channel changes
  await run(platformDb, 'DELETE FROM platform_channel_memberships WHERE is_member = 0').catch(() => {});

  await recordPlatformAudit(platformDb, {
    actorId,
    actorRole: 'platform_owner',
    action: 'platform.mandatory_channel_set',
    details: {
      channel_id: normalizedId,
      channel_url: resolvedUrl,
      enabled: enabledStr === '1',
    },
  });

  return getPlatformChannelConfig(platformDb, {});
}

export function buildMandatoryMembershipPrompt(config = {}) {
  const title = esc(config.channelTitle || 'القناة الرسمية للمنصة');
  const chHandle = config.channelId?.startsWith('@') ? ` (${esc(config.channelId)})` : '';
  const text = [
    '🔒 <b>الاشتراك الإجباري في القناة المركزية للمنصة</b>',
    '━━━━━━━━━━━━━━━━━━',
    `لاستخدام بوتات الكليات والاستفادة من المحاضرات والموارد والمساعد الذكي، يجب أولاً الاشتراك في قناة المطور الرسمية:`,
    '',
    `📢 <b>${title}${chHandle}</b>`,
    '',
    '1️⃣ اضغط على زر <b>«📢 اشترك في قناة المنصة»</b> أدناه وانضم للقناة.',
    '2️⃣ بعد الانضمام، اضغط على <b>«✅ اشتركت الآن — تحقّق من العضوية»</b> لفتح البوت فوراً.',
  ].join('\n');

  const rows = [];
  if (config.channelUrl) {
    rows.push([{ text: `📢 اشترك في ${config.channelTitle || 'قناة المنصة'}`, url: config.channelUrl }]);
  }
  rows.push([{ text: '✅ اشتركت الآن — تحقّق من العضوية', callback_data: 'verify_platform_sub' }]);

  return {
    text,
    reply_markup: { inline_keyboard: rows },
  };
}

function isMemberStatusAllowed(chatMember) {
  if (!chatMember || typeof chatMember !== 'object') return false;
  const status = String(chatMember.status ?? '').toLowerCase();
  if (ALLOWED_STATUSES.has(status)) return true;
  if (status === 'restricted' && chatMember.is_member === true) return true;
  return false;
}

async function queryTelegramChatMember({ channelId, userId, env = {}, collegeBot = null, fetchImpl = globalThis.fetch }) {
  // 1. Prefer custom verifier hook if injected in env (e.g. unit/integration tests)
  if (typeof env?.verifyChannelMember === 'function') {
    return env.verifyChannelMember(channelId, userId);
  }

  // 2. If a central PLATFORM_BOT_TOKEN is configured and fetch is available, query via the central bot
  const platformToken = String(env?.PLATFORM_BOT_TOKEN ?? '').trim();
  if (platformToken && typeof fetchImpl === 'function') {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${platformToken}/getChatMember`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: channelId, user_id: Number(userId) }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok && body?.result) {
        return body.result;
      }
    } catch {
      // Fall through to collegeBot
    }
  }

  // 3. Fallback to collegeBot.getChatMember
  if (collegeBot && typeof collegeBot.getChatMember === 'function') {
    return collegeBot.getChatMember(channelId, Number(userId));
  }

  // 4. Direct HTTP call with BOT_TOKEN / TELEGRAM_BOT_TOKEN if available
  const fallbackToken = String(env?.TELEGRAM_BOT_TOKEN || env?.BOT_TOKEN || '').trim();
  if (fallbackToken && typeof fetchImpl === 'function') {
    const res = await fetchImpl(`https://api.telegram.org/bot${fallbackToken}/getChatMember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, user_id: Number(userId) }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok && body?.result) {
      return body.result;
    }
  }

  throw new Error('chat_member_verification_unavailable');
}

/**
 * Centralized verification of a user's membership in the developer's mandatory platform channel.
 */
export async function verifyUserPlatformMembership({
  platformDb,
  userId,
  env = {},
  collegeBot = null,
  forceRefresh = false,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    return { allowed: true, reason: 'system_update' };
  }

  // Platform Owner (Developer) is always allowed
  if (isPlatformOwner(uid, env)) {
    return { allowed: true, reason: 'platform_owner_exempt' };
  }

  const config = await getPlatformChannelConfig(platformDb, env);
  if (!config.enabled || !config.channelId) {
    return { allowed: true, reason: 'mandatory_channel_disabled' };
  }

  const currentTs = now();

  // Check D1 membership cache unless forced refresh (`verify_platform_sub` button click)
  if (!forceRefresh && platformDb && typeof platformDb.prepare === 'function') {
    const cached = await get(
      platformDb,
      `SELECT status, is_member, expires_at
       FROM platform_channel_memberships
       WHERE channel_id = ? AND user_id = ?`,
      [config.channelId, uid],
    ).catch(() => null);

    if (cached && Number(cached[1]) === 1 && Number(cached[2]) > currentTs) {
      return {
        allowed: true,
        cached: true,
        status: String(cached[0]),
        config,
      };
    }
  }

  try {
    const member = await queryTelegramChatMember({
      channelId: config.channelId,
      userId: uid,
      env,
      collegeBot,
      fetchImpl,
    });
    const allowed = isMemberStatusAllowed(member);
    const status = String(member?.status || (allowed ? 'member' : 'left'));

    if (platformDb && typeof platformDb.prepare === 'function') {
      const expiresAt = allowed ? currentTs + MEMBERSHIP_CACHE_TTL_MS : currentTs;
      await run(
        platformDb,
        `INSERT INTO platform_channel_memberships (channel_id, user_id, status, is_member, checked_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, user_id) DO UPDATE SET
           status = excluded.status,
           is_member = excluded.is_member,
           checked_at = excluded.checked_at,
           expires_at = excluded.expires_at`,
        [config.channelId, uid, status, allowed ? 1 : 0, currentTs, expiresAt],
      ).catch(() => {});
    }

    if (allowed) {
      return { allowed: true, cached: false, status, config };
    }
  } catch {
    // If Telegram API rejects getChatMember (e.g., user not found in channel), treat as non-member
  }

  const prompt = buildMandatoryMembershipPrompt(config);
  return {
    allowed: false,
    cached: false,
    config,
    text: prompt.text,
    reply_markup: prompt.reply_markup,
  };
}
