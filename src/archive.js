/**
 * Emergency Resource Archive (نسخة وصول احتياطية).
 *
 * A standalone Telegram channel mirrors every registered resource so students
 * can still reach the material if MEDBOT itself is down. It is a
 * disaster-recovery access layer, never the source of truth:
 *
 *     MEDBOT registry (source of truth) -> archive sync -> archive channel
 *
 * Rules held here:
 *
 *  * The channel is configured only through the environment
 *    (`MEDBOT_ARCHIVE_CHANNEL` / `ARCHIVE_CHANNEL_ID`); nothing is hardcoded and
 *    no channel id is assumed. When it is unset the feature is simply off.
 *  * Publication is idempotent: the dedupe key is the resource's own content
 *    identity (title + file_type + file_id), so a restart or retry can never
 *    create a second post.
 *  * A failed publication never fails the MEDBOT resource it mirrors; it is
 *    recorded as `failed` and can be retried through the admin resync.
 *  * Deleting a resource in MEDBOT never deletes the archived copy.
 *  * The post's path is read from the registry (`getResourceSnapshot`), never
 *    invented.
 */

import { createHash } from 'node:crypto';

import * as db from './db/index.js';
import { logFailure } from './log.js';
import { safeTruncate } from './truncate.js';

/** Environment variables that may carry the archive channel. */
export const ARCHIVE_CHANNEL_ENV_VARS = ['MEDBOT_ARCHIVE_CHANNEL', 'ARCHIVE_CHANNEL_ID'];

/** Cap a single resync pass so one admin tap cannot stall the loop. */
export const MAX_RESYNC_PER_RUN = 200;

/** Telegram caption limit is 1024 chars; keep the header short. */
export const MAX_CAPTION = 1000;

export const ARCHIVE_HEADER = '🗄 <b>MEDBOT Emergency Resource Archive</b>';

// Fingerprints currently mid-publish. The idempotency check and the pending
// upsert are synchronous, but the channel send is awaited, so two overlapping
// callers (an upload and a background resync) could both pass the check before
// either send completes. This set closes that window.
const inFlight = new Set();

// ---------------------------------------------------------------------------
// Configuration (environment only — never hardcoded)
// ---------------------------------------------------------------------------

/**
 * The configured archive channel id/username, or `''` when unset.
 *
 * Accepts either a numeric id (`-1001234567890`) or an `@username`. The value is
 * read from the environment on every call so the host can set it without a code
 * change.
 */
export function resolveChannel() {
  for (const name of ARCHIVE_CHANNEL_ENV_VARS) {
    const raw = String(process.env[name] ?? '').trim();
    if (raw) return normalizeChannelValue(raw);
  }
  return '';
}

export function isConfigured() {
  return Boolean(resolveChannel());
}

function intOrNull(value) {
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/**
 * Canonicalise the configured channel value.
 *
 * A host operator pastes this value into a dashboard, so the raw string
 * routinely carries a stray pair of quotes, a `https://t.me/...` link or a
 * space inside a numeric id. Those are the value *as typed*, not a different
 * channel, so they are normalised away. A value that is already correct is
 * returned unchanged.
 */
export function normalizeChannelValue(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
    value = value.slice(1, -1).trim();
  }

  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i.exec(value);
  if (link) value = link[1].split(/[/?#]/)[0].trim();

  // A numeric id pasted with grouping spaces ("-100 1234 5678") is still an id.
  if (/^[-+]?[\d\s]+$/.test(value)) value = value.replace(/\s+/g, '');

  // A bare public username is accepted and made explicit.
  if (
    value &&
    !value.startsWith('@') &&
    !/^[-+]?\d+$/.test(value) &&
    /^[A-Za-z0-9_]{4,}$/.test(value)
  ) {
    value = `@${value}`;
  }

  return value;
}

/**
 * Classify a normalised channel value.
 *
 * Returns `{ valid, kind }` where kind is `numeric` | `username` | `unknown`.
 * A numeric id must be negative: Telegram channel/supergroup ids are `-100…`,
 * and a positive number is a user id, not a channel.
 */
export function validateChannelValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return { valid: false, kind: 'unknown', reason: 'empty' };
  if (text.startsWith('@')) {
    return /^@[A-Za-z0-9_]{4,31}$/.test(text)
      ? { valid: true, kind: 'username' }
      : { valid: false, kind: 'username', reason: 'malformed_username' };
  }
  if (/^-\d+$/.test(text)) return { valid: true, kind: 'numeric' };
  if (/^\d+$/.test(text)) return { valid: false, kind: 'numeric', reason: 'positive_id' };
  return { valid: false, kind: 'unknown', reason: 'unrecognised' };
}

/**
 * Channel value in the form Telegram's send* methods want: a numeric id is sent
 * as an integer, an `@username` stays a string.
 */
export function channelForSend() {
  const raw = resolveChannel();
  if (!raw) return null;
  if (raw.startsWith('@')) return raw;
  const numeric = intOrNull(raw);
  return numeric !== null ? numeric : raw;
}

/** Introspection for the runtime/admin screens. */
export function runtimeStatus() {
  const providers = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'].filter((key) =>
    Boolean(String(process.env[key] ?? '').trim()),
  );

  const channel = resolveChannel();
  const validation = validateChannelValue(channel);

  return {
    enabled: isConfigured(),
    channel,
    channelConfigured: isConfigured(),
    // A value can be present yet invalid (a positive id, a malformed username).
    // Reporting only "configured" made the runtime screen say "enabled" while the
    // archive screen said "invalid value" for the same state, so the validation
    // verdict is surfaced here too.
    channelValid: validation.valid,
    channelKind: validation.kind,
    aiProviders: providers.length ? providers.join(', ') : 'لا يوجد',
  };
}

// ---------------------------------------------------------------------------
// Health diagnostics
// ---------------------------------------------------------------------------
// "Is the archive configured?" is not the same question as "can the bot
// actually post to it?". A wrong id, a private channel the bot was never added
// to, and a channel where the bot is a plain member all look identical to a
// binary configured/unconfigured flag — and all three silently fail at send
// time. `getArchiveHealth` answers the real question so the admin screen can
// state the true reason instead of a generic "غير مهيأ".

/** The canonical archive health states. */
export const ARCHIVE_HEALTH = Object.freeze({
  NOT_CONFIGURED: 'ARCHIVE_NOT_CONFIGURED',
  INVALID_CHANNEL: 'ARCHIVE_INVALID_CHANNEL',
  UNREACHABLE: 'ARCHIVE_UNREACHABLE',
  PERMISSION_DENIED: 'ARCHIVE_PERMISSION_DENIED',
  READY: 'ARCHIVE_READY',
  // Configuration is valid but Telegram could not be consulted (no transport,
  // e.g. a diagnostic run without a bot). Never reported as READY, because
  // reachability is unproven.
  UNVERIFIED: 'ARCHIVE_UNVERIFIED',
});

/** User-safe Arabic explanation for a health state (never a secret). */
export function healthMessage(state) {
  switch (state) {
    case ARCHIVE_HEALTH.NOT_CONFIGURED:
      return 'لم يُضبط متغير القناة. حدّد MEDBOT_ARCHIVE_CHANNEL لتفعيل الأرشيف.';
    case ARCHIVE_HEALTH.INVALID_CHANNEL:
      return 'قيمة القناة غير صالحة. استخدم معرّفاً رقمياً سالباً مثل -100… أو @username.';
    case ARCHIVE_HEALTH.UNREACHABLE:
      return 'تعذّر الوصول إلى القناة. تحقق من المعرّف وأن البوت مضاف إلى القناة.';
    case ARCHIVE_HEALTH.PERMISSION_DENIED:
      return 'البوت ليس مشرفاً في القناة أو لا يملك صلاحية النشر.';
    case ARCHIVE_HEALTH.READY:
      return 'الأرشيف جاهز والبوت قادر على النشر.';
    case ARCHIVE_HEALTH.UNVERIFIED:
      return 'الإعداد صالح لكن لم يتم التحقق من الوصول عبر Telegram.';
    default:
      return 'حالة غير معروفة.';
  }
}

function healthResult(state, extra = {}) {
  return {
    state,
    ok: state === ARCHIVE_HEALTH.READY,
    message: healthMessage(state),
    ...extra,
  };
}

/**
 * Full archive health: configuration, Telegram reachability, bot membership and
 * the post permission.
 *
 * Never throws: every Telegram call is isolated, so a health check can never
 * block or fail MEDBOT itself. Pass a bot transport to get the Telegram-verified
 * answer; without one the result is configuration-only (`UNVERIFIED`).
 */
export async function getArchiveHealth(bot = null) {
  const channel = resolveChannel();
  const configured = Boolean(channel);

  if (!configured) {
    return healthResult(ARCHIVE_HEALTH.NOT_CONFIGURED, {
      channel: '',
      configured: false,
      valid: false,
      verified: false,
      botStatus: null,
      canPost: false,
    });
  }

  const validation = validateChannelValue(channel);
  if (!validation.valid) {
    return healthResult(ARCHIVE_HEALTH.INVALID_CHANNEL, {
      channel,
      configured: true,
      valid: false,
      verified: false,
      botStatus: null,
      canPost: false,
      reason: validation.reason,
    });
  }

  const target = channelForSend();
  const base = { channel, configured: true, valid: true, target };

  if (!bot || typeof bot.getChat !== 'function') {
    return healthResult(ARCHIVE_HEALTH.UNVERIFIED, {
      ...base,
      verified: false,
      botStatus: null,
      canPost: false,
    });
  }

  let chat;
  try {
    chat = await bot.getChat(target);
  } catch (error) {
    logFailure('archive health getChat', error);
    return healthResult(ARCHIVE_HEALTH.UNREACHABLE, {
      ...base,
      verified: true,
      botStatus: null,
      canPost: false,
    });
  }

  let botId = null;
  try {
    const me = typeof bot.getMe === 'function' ? await bot.getMe() : null;
    botId = me?.id ?? null;
  } catch {
    botId = null;
  }

  if (botId === null || typeof bot.getChatMember !== 'function') {
    // We reached the channel but cannot prove membership/post rights.
    return healthResult(ARCHIVE_HEALTH.UNVERIFIED, {
      ...base,
      verified: true,
      chatType: chat?.type ?? null,
      botStatus: null,
      canPost: false,
    });
  }

  let member;
  try {
    member = await bot.getChatMember(target, botId);
  } catch (error) {
    logFailure('archive health getChatMember', error);
    return healthResult(ARCHIVE_HEALTH.PERMISSION_DENIED, {
      ...base,
      verified: true,
      chatType: chat?.type ?? null,
      botStatus: null,
      canPost: false,
    });
  }

  const status = String(member?.status ?? '').toLowerCase();
  const canPost =
    status === 'creator' || (status === 'administrator' && member?.can_post_messages !== false);

  if (!canPost) {
    return healthResult(ARCHIVE_HEALTH.PERMISSION_DENIED, {
      ...base,
      verified: true,
      chatType: chat?.type ?? null,
      botStatus: status || null,
      canPost: false,
    });
  }

  return healthResult(ARCHIVE_HEALTH.READY, {
    ...base,
    verified: true,
    chatType: chat?.type ?? null,
    botStatus: status || null,
    canPost: true,
  });
}

// ---------------------------------------------------------------------------
// Fingerprint / caption (identity of a resource, never invented)
// ---------------------------------------------------------------------------

/**
 * Stable dedupe key for a resource, independent of folder location.
 *
 * Built from the resource's own registered fields (title + file_type + file_id).
 * Moving or renaming its folder does not change the key, so the archive can
 * never grow a second copy of the same material.
 */
export function contentFingerprint(snapshot) {
  const [, , title, fileId, fileType] = snapshot;
  const raw = [
    String(title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
    String(fileType ?? '')
      .trim()
      .toLowerCase(),
    String(fileId ?? '').trim(),
  ].join('|');
  return `content:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}

export function folderFingerprint(folderId) {
  return `folder:${folderId}`;
}

/** Human-readable, searchable post text for a resource. */
export function buildCaption(snapshot) {
  const [, , title, , fileType, path] = snapshot;

  const lines = [ARCHIVE_HEADER, '', `📄 <b>${esc(title)}</b>`, `🧭 <b>المسار:</b> ${esc(path)}`];

  const kind = String(fileType ?? '').trim();
  if (kind) lines.push(`🏷 <b>النوع:</b> <code>${esc(kind)}</code>`);

  return safeTruncate(lines.join('\n'), MAX_CAPTION);
}

export function buildFolderCaption(folderName, path) {
  const lines = [
    ARCHIVE_HEADER,
    '',
    `📁 <b>${esc(folderName)}</b>`,
    `🧭 <b>المسار:</b> ${esc(path)}`,
  ];
  return safeTruncate(lines.join('\n'), MAX_CAPTION);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function esc(value) {
  return escapeHtml(value);
}

// ---------------------------------------------------------------------------
// Telegram dispatch (bot acts as a channel administrator)
// ---------------------------------------------------------------------------

/** Send the resource itself, as the media type it was registered with. */
async function sendResourcePost(bot, channel, snapshot) {
  const [, , , fileId, fileType] = snapshot;
  const caption = buildCaption(snapshot);
  const kind = String(fileType ?? '').toLowerCase();

  if (['photo', 'image', 'jpg', 'jpeg', 'png', 'webp'].includes(kind)) {
    return bot.sendPhoto(channel, fileId, { caption, parse_mode: 'HTML' });
  }
  if (['audio', 'mp3', 'm4a', 'wav', 'voice'].includes(kind)) {
    return bot.sendAudio(channel, fileId, { caption, parse_mode: 'HTML' });
  }
  if (['video', 'mp4', 'mkv', 'mov'].includes(kind)) {
    return bot.sendVideo(channel, fileId, { caption, parse_mode: 'HTML' });
  }
  return bot.sendDocument(channel, fileId, { caption, parse_mode: 'HTML' });
}

/**
 * Post a section header once, so the channel mirrors the hierarchy.
 *
 * A header is only ever posted once per folder (tracked in `archive_sync`).
 * Failure is isolated: it never affects the resource being mirrored.
 */
export async function publishFolderHeader(bot, folder, path) {
  if (!isConfigured() || !folder) return null;

  const folderId = folder[0];
  const name = folder.length > 2 ? folder[2] : folder[1];
  const fingerprint = folderFingerprint(folderId);

  let existing = null;
  try {
    existing = db.getArchiveSync(fingerprint);
  } catch {
    existing = null;
  }

  if (existing && existing[7] === 'published') return null;

  try {
    db.upsertArchivePending(fingerprint, {
      folderId,
      contentId: null,
      objectType: 'folder',
    });
  } catch {
    // A missing pending row is not fatal; the send below can still succeed.
  }

  const channel = channelForSend();
  try {
    const sent = await bot.sendMessage(channel, buildFolderCaption(name, path), {
      parse_mode: 'HTML',
    });
    db.markArchivePublished(fingerprint, channel, sent?.message_id ?? null);
    return sent;
  } catch (error) {
    logFailure('archive folder header publish', error);
    try {
      db.markArchiveFailed(fingerprint, error.message ?? String(error));
    } catch {
      // Recording the failure is best-effort.
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Publication (idempotent, non-fatal)
// ---------------------------------------------------------------------------

function lockFor(fingerprint) {
  // A second caller for the same fingerprint would duplicate the post, so it is
  // reported as skipped: the in-flight call already owns the publish.
  return { claimed: inFlight.has(fingerprint) };
}

/**
 * Mirror one registered resource to the archive channel.
 *
 * Returns `{status, fingerprint, message_id, error}` where status is one of
 * `published` | `skipped` | `failed`. This function never throws: a mirror
 * problem must never block or fail the MEDBOT resource it reflects.
 */
export async function publishResource(bot, contentId, withHeader = false) {
  const result = { status: 'skipped', fingerprint: null, message_id: null, error: null };

  if (!isConfigured()) return result;

  let snapshot = null;
  try {
    snapshot = db.getResourceSnapshot(contentId);
  } catch {
    snapshot = null;
  }

  if (!snapshot) return result;

  const fingerprint = contentFingerprint(snapshot);
  result.fingerprint = fingerprint;

  if (lockFor(fingerprint).claimed) return result;
  inFlight.add(fingerprint);
  try {
    let existing = null;
    try {
      existing = db.getArchiveSync(fingerprint);
    } catch {
      existing = null;
    }

    // Already mirrored: never post the same resource twice.
    if (existing && existing[7] === 'published') {
      result.status = 'published';
      result.message_id = existing[6];
      return result;
    }

    try {
      db.upsertArchivePending(fingerprint, {
        folderId: snapshot[1],
        contentId: snapshot[0],
      });
    } catch {
      // Registration failure is non-fatal; the send is still attempted.
    }

    if (withHeader) {
      try {
        const folder = db.getFolder(snapshot[1]);
        if (folder) await publishFolderHeader(bot, folder, snapshot[5]);
      } catch {
        // A missing header never blocks the resource post.
      }
    }

    const channel = channelForSend();

    try {
      const sent = await sendResourcePost(bot, channel, snapshot);
      const messageId = sent?.message_id ?? null;
      db.markArchivePublished(fingerprint, channel, messageId);
      result.status = 'published';
      result.message_id = messageId;
      return result;
    } catch (error) {
      result.status = 'failed';
      result.error = error.message ?? String(error);
      logFailure(`archive publish content=${contentId}`, error);
      try {
        db.markArchiveFailed(fingerprint, result.error);
      } catch {
        // Recording the failure is best-effort.
      }
      return result;
    }
  } finally {
    inFlight.delete(fingerprint);
  }
}

/**
 * Re-mirror existing resources without ever creating duplicates.
 *
 * Walks the real registry in hierarchy order. Resources already published are
 * skipped unless `includePublished` is set.
 */
export async function resync(
  bot,
  { includePublished = false, limit = MAX_RESYNC_PER_RUN } = {},
) {
  const stats = { published: 0, failed: 0, skipped: 0, total: 0 };

  if (!isConfigured()) return stats;

  let snapshots = [];
  try {
    snapshots = db.getAllResourceSnapshots();
  } catch {
    return stats;
  }

  snapshots = snapshots.slice(0, Math.max(0, Number.parseInt(limit, 10) || 0));
  stats.total = snapshots.length;

  const seenFolders = new Set();

  for (const snapshot of snapshots) {
    const fingerprint = contentFingerprint(snapshot);

    let existing = null;
    try {
      existing = db.getArchiveSync(fingerprint);
    } catch {
      existing = null;
    }

    if (existing && existing[7] === 'published' && !includePublished) {
      stats.skipped += 1;
      seenFolders.add(snapshot[1]);
      continue;
    }

    // Emit the section header the first time we touch a folder in this pass.
    if (!seenFolders.has(snapshot[1])) {
      seenFolders.add(snapshot[1]);
      try {
        const folder = db.getFolder(snapshot[1]);
        if (folder) await publishFolderHeader(bot, folder, snapshot[5]);
      } catch {
        // Header emission is best-effort.
      }
    }

    const outcome = await publishResource(bot, snapshot[0]);
    if (outcome.status === 'published') stats.published += 1;
    else if (outcome.status === 'failed') stats.failed += 1;
    else stats.skipped += 1;
  }

  return stats;
}

/**
 * Retry only the rows recorded as failed. Idempotent.
 *
 * A row whose resource can no longer be read from the registry is left
 * untouched (it cannot be reconstructed), so this never invents content.
 */
export async function retryFailed(bot, limit = MAX_RESYNC_PER_RUN) {
  const stats = { published: 0, failed: 0, skipped: 0, total: 0 };

  if (!isConfigured()) return stats;

  let rows = [];
  try {
    rows = db.getArchiveSyncRows('failed', limit);
  } catch {
    return stats;
  }

  stats.total = rows.length;

  for (const row of rows) {
    const contentIds = String(row[4] ?? '')
      .split(',')
      .filter((part) => part.trim());
    if (!contentIds.length) {
      stats.skipped += 1;
      continue;
    }

    const outcome = await publishResource(bot, intOrNull(contentIds[0]));
    if (outcome.status === 'published') stats.published += 1;
    else if (outcome.status === 'failed') stats.failed += 1;
    else stats.skipped += 1;
  }

  return stats;
}

/**
 * Register a newly added resource as a mirror candidate, without publishing.
 *
 * Kept for parity with the Python `register_resource`; normal uploads call
 * `publishResource` directly.
 */
export function registerResource(contentId) {
  try {
    const snapshot = db.getResourceSnapshot(contentId);
    if (!snapshot) return false;
    const fingerprint = contentFingerprint(snapshot);
    db.upsertArchivePending(fingerprint, { folderId: snapshot[1], contentId: snapshot[0] });
    return true;
  } catch {
    return false;
  }
}
