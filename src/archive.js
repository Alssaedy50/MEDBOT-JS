/**
 * Emergency Resource Archive — the standalone Telegram mirror.
 *
 * MEDBOT's registry is the single source of truth. This subsystem keeps a
 * *read-only copy* of every registered resource in a separate Telegram channel,
 * so students can still reach the material when the bot itself is down.
 *
 * Guarantees held here:
 *
 *  * Publication is idempotent. `archive_sync.content_fingerprint` is UNIQUE and
 *    the DB transition is authoritative: a resource already published (or
 *    mid-retry) is never posted twice, even across restarts.
 *  * The mirror never mutates the registry. This module only reads `content`/
 *    `folders`; it writes only to `archive_sync`.
 *  * A failure on one resource never blocks the others. The error is recorded
 *    on that row and the loop continues.
 *  * A missing channel configuration disables the subsystem cleanly: enabling it
 *    later simply picks up from the existing rows.
 */

import * as db from './db/index.js';

export function archiveEnabled() {
  return Boolean(process.env.ARCHIVE_ENABLED === '1' || process.env.ARCHIVE_ENABLED === 'true');
}

export function archiveChannelId() {
  if (process.env.ARCHIVE_CHANNEL_ID) {
    return process.env.ARCHIVE_CHANNEL_ID;
  }
  return process.env.ARCHIVE_CHAT_ID ?? '';
}

export function archiveTopicId() {
  return process.env.ARCHIVE_TOPIC_ID ?? '';
}

/** Introspection for the runtime/admin screens. */
export function runtimeStatus() {
  const providers = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'].filter(
    (key) => Boolean(process.env[key]?.trim()),
  );

  return {
    enabled: archiveEnabled(),
    channelConfigured: Boolean(archiveChannelId()),
    topicConfigured: Boolean(archiveTopicId()),
    aiProviders: providers.length ? providers.join(', ') : 'لا يوجد',
  };
}

/**
 * A stable identity for a resource's archived form.
 *
 * Derived from the real registry values (content id + file id), so it cannot
 * change when an admin renames the resource — a rename must not republish it.
 */
export function contentFingerprint(contentId, fileId) {
  return `content:${contentId}:${fileId}`;
}

/**
 * Archive one resource into the mirror channel.
 *
 * Returns `[published, detail]` where `published` is true only when this call
 * performed the publish transition (false when it was already published or the
 * send failed).
 */
export async function publishResource(bot, snapshot) {
  if (!snapshot) return [false, 'missing'];
  if (!archiveEnabled() || !archiveChannelId() || !bot?.sendDocument) {
    return [false, 'disabled'];
  }

  const [contentId, folderId, title, fileId, fileType, path] = snapshot;
  const fingerprint = contentFingerprint(contentId, fileId);

  // Register the candidate without clobbering an existing publication.
  db.upsertArchivePending(fingerprint, { folderId, contentId });

  // Already published -> nothing to do (idempotent, and no second post).
  const existing = db.getArchiveSync(fingerprint);
  if (existing && existing[7] === 'published') return [false, 'already'];

  const caption =
    `📄 <b>${escapeHtml(title)}</b>\n` +
    `📍 ${escapeHtml(path)}\n` +
    `📎 ${escapeHtml(fileType)}\n\n` +
    `🗄 نسخة من أرشيف منصة MEDBOT — للوصول عند تعطّل المنصة.`;

  const options = { caption, parse_mode: 'HTML' };
  const topicId = archiveTopicId();
  if (topicId) options.message_thread_id = Number.parseInt(topicId, 10) || undefined;

  try {
    let sent;
    if (fileType === 'photo' && bot.sendPhoto) {
      sent = await bot.sendPhoto(archiveChannelId(), fileId, options);
    } else if (fileType === 'video' && bot.sendVideo) {
      sent = await bot.sendVideo(archiveChannelId(), fileId, options);
    } else if (fileType === 'audio' && bot.sendAudio) {
      sent = await bot.sendAudio(archiveChannelId(), fileId, options);
    } else {
      sent = await bot.sendDocument(archiveChannelId(), fileId, options);
    }

    const messageId = sent?.message_id ?? null;
    const transitioned = db.markArchivePublished(fingerprint, archiveChannelId(), messageId);
    return [transitioned, messageId ? String(messageId) : 'sent'];
  } catch (error) {
    db.markArchiveFailed(fingerprint, error.message ?? String(error));
    return [false, 'failed'];
  }
}

/**
 * Check every registered resource against the mirror (bounded, resumable).
 *
 * Already-published resources are skipped, so a resync is cheap and cannot
 * create duplicates. Returns `{registered, published, failed}`.
 */
export async function syncAllResources(bot) {
  let snapshots = [];
  try {
    snapshots = db.getAllResourceSnapshots();
  } catch {
    snapshots = [];
  }

  const summary = { registered: snapshots.length, published: 0, failed: 0 };

  for (const snapshot of snapshots) {
    let result;
    try {
      result = await publishResource(bot, snapshot);
    } catch {
      summary.failed += 1;
      continue;
    }
    const [published, detail] = result;
    if (published) summary.published += 1;
    else if (detail === 'failed') summary.failed += 1;
  }

  return summary;
}

/** Register (but do not publish) a newly added resource. */
export function registerResource(contentId) {
  try {
    const snapshot = db.getResourceSnapshot(contentId);
    if (!snapshot) return false;
    const fingerprint = contentFingerprint(snapshot[0], snapshot[3]);
    db.upsertArchivePending(fingerprint, { folderId: snapshot[1], contentId: snapshot[0] });
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
