/**
 * Notifications compatibility layer.
 *
 * MEDBOT has two broadcast paths that both reach a student's Telegram inbox:
 *
 *   1. Admin broadcast (🔔 الإشعارات) — a plain announcement to every
 *      registered user, logged in the `notifications` table.
 *   2. News private delivery (📰 News)      — subscriptions drive per-item
 *      delivery, tracked in `news_deliveries`.
 *
 * They stay separate databases with separate semantics, but they share the same
 * transport constraints (Telegram rate limits, blocked chats, restart
 * recovery). This module is the single place that knows those constraints, so
 * adding a broadcast path does not mean re-implementing rate limiting.
 *
 * Delivery is best-effort: one blocked chat never aborts the run, and the
 * partial result is recorded so the admin sees a truthful count.
 */

import * as db from './db/index.js';

/** Chats per batch between yields. */
export const BROADCAST_BATCH_SIZE = 25;
/** Seconds between batches. */
export const BROADCAST_BATCH_DELAY = 1.0;

let sleepImpl = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Test hook: replace the inter-batch sleep. */
export function setSleep(fn) {
  sleepImpl = fn;
}

export function resetSleep() {
  sleepImpl = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Broadcast `body` to every registered user, logging the outcome.
 *
 * Returns `{recipients, delivered}`. The message records the delivered count, so
 * the admin's view of an announcement matches what actually reached students.
 */
export async function broadcast(bot, body, senderId = null, title = null) {
  const text = String(body ?? '').trim();
  if (!text) return { recipients: 0, delivered: 0 };

  let userIds = [];
  try {
    userIds = db.getAllUserIds();
  } catch {
    userIds = [];
  }

  let delivered = 0;

  if (bot?.sendMessage) {
    for (let index = 0; index < userIds.length; index += BROADCAST_BATCH_SIZE) {
      const batch = userIds.slice(index, index + BROADCAST_BATCH_SIZE);

      for (const userId of batch) {
        try {
          await bot.sendMessage(userId, `🔔 <b>${escapeHtml(title ?? 'إشعار من إدارة المنصة')}</b>\n\n${escapeHtml(text)}`, {
            parse_mode: 'HTML',
          });
          delivered += 1;
        } catch {
          // A blocked chat or a transient error must not stop the broadcast.
        }
      }

      if (index + BROADCAST_BATCH_SIZE < userIds.length) {
        await sleepImpl(BROADCAST_BATCH_DELAY);
      }
    }
  }

  try {
    db.recordNotification(senderId, title, text, 'all', userIds.length, delivered);
  } catch {
    // Logging the broadcast must not fail the broadcast itself.
  }

  return { recipients: userIds.length, delivered };
}

/**
 * Broadcast to the admins holding `permission` (a targeted announcement).
 *
 * Reuses the same transport rules so admin-targeted notices are rate-limited
 * identically.
 */
export async function broadcastToAdmins(bot, permission, body) {
  const text = String(body ?? '').trim();
  if (!text) return { recipients: 0, delivered: 0 };

  let recipients = [];
  try {
    recipients = db.getAdminsWithPermission(permission);
  } catch {
    recipients = [];
  }

  let delivered = 0;
  if (bot?.sendMessage) {
    for (const [adminId] of recipients) {
      try {
        await bot.sendMessage(adminId, text, { parse_mode: 'HTML' });
        delivered += 1;
      } catch {
        // One unreachable admin never stops the rest.
      }
    }
  }

  return { recipients: recipients.length, delivered };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
