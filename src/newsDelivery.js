/**
 * Private News delivery (توصيل الأخبار) for MEDBOT.
 *
 * The transport between a published news row and the students who asked for it.
 * It is a *service* module: no callback namespace, no user-facing menu.
 * `src/ui/news.js` owns the surfaces and calls in here when an admin publishes
 * (or retries) an item.
 *
 * Design rules held here:
 *
 *  * Subscriptions decide *private delivery only*. The News Center still lists
 *    every published item to everyone; an unread item stays unread until the
 *    student opens it, so reaching a Telegram inbox never flips its read state.
 *  * Delivery is best-effort / **at-least-once** in the crash window. The
 *    database guarantees a caller never queues two reservations for one
 *    (news, user) and that a `sent` row is terminal, but it cannot see the gap
 *    between "Telegram accepted the message" and "we recorded sent". A crash in
 *    that window leaves a recoverable `sending` row and the item may be
 *    delivered again after restart. There is no external exactly-once
 *    guarantee, by design.
 *  * Failure is isolated. One blocked chat never aborts the batch and never
 *    rolls back the publish: the row is recorded `failed` (with its error) and
 *    can be retried, while everyone else still receives the item.
 *  * Rate-limited and non-blocking. Sends run in bounded batches with a small
 *    delay between them and honour Telegram `RetryAfter`; a small audience is
 *    delivered inline (so the publish reply is accurate) and a large one is
 *    handed to a tracked async task, so the polling loop is never stalled.
 *  * Grounded in the real registry. The private message carries the item's real
 *    section/resource references and only offers a button for one that still
 *    exists — exactly like the News Center detail view.
 */

import * as db from './db/index.js';
import { newsBodyLines } from './newsFormat.js';
import { logFailure } from './log.js';
import { btn } from './telegram/ui.js';

// Recipients up to this count are delivered inline so the admin's publish reply
// can state a truthful result. Beyond it the work is handed to a background
// task to keep the polling loop responsive.
export const INLINE_DELIVERY_LIMIT = 50;

// Rate limiting. Sends are grouped into batches; the loop yields between
// batches (never after the last) so the polling loop stays responsive while
// Telegram's per-chat/burst limits are respected.
export const DELIVERY_BATCH_SIZE = 25;
export const DELIVERY_BATCH_DELAY = 1.0; // seconds between batches

// A retry resends only `pending`/`failed` rows — never a `sent` one, and never
// more than this many per run (keeps a single call bounded).
export const MAX_RETRY_PER_RUN = 500;

// Telegram 429 handling: wait what it asks, but never longer than this cap, and
// re-attempt each recipient at most this many times before recording `failed`.
export const DELIVERY_RETRY_AFTER_CAP = 60.0; // seconds
export const DELIVERY_MAX_SEND_RETRIES = 2;

// Startup recovery is bounded so guests are served first and a big backlog is
// worked through over several passes rather than one thundering herd.
export const RECOVERY_MAX_NEWS = 50;

// Indirection so tests can observe/replace the wait without real sleeping.
let sleepImpl = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Test hook: replace the sleep used between batches / on RetryAfter. */
export function setSleep(fn) {
  sleepImpl = fn;
}

/** Test hook: restore the real sleep. */
export function resetSleep() {
  sleepImpl = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// Background tasks are kept referenced until done (otherwise the loop may
// garbage-collect a running task) and expose a drain hook for tests.
const backgroundTasks = new Set();

// The single recovery worker. `startRecovery` is idempotent: a second startup
// call never spawns a competing worker.
let recoveryTask = null;

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A short label for *why* a user is being reached (delivery log). */
export function deliveryKind(news) {
  if (news.news_type === 'section' && news.section_folder_id) {
    return `section:${news.section_folder_id}`;
  }
  return news.news_type || 'notify';
}

/**
 * The private Telegram message body for one news item.
 *
 * Reuses the shared news layout (`newsFormat`) so the private message and the
 * News Center detail show the same facts in the same order — including the
 * author's 📅 event time and never a technical publish stamp. The body is
 * truncated for the inbox, and the footer points at the News Center where the
 * item stays unread until opened.
 */
export function buildDeliveryText(news) {
  const lines = ['📰 <b>خبر جديد</b>', '', ...newsBodyLines(news, { maxBodyLength: 600 })];
  lines.push('', 'افتحه من 📰 مركز الأخبار للاطلاع الكامل.');
  return lines.join('\n');
}

/**
 * Keyboard for the private message: open-in-center plus real access.
 *
 * Only a reference that still exists in the registry yields a direct button, so
 * a removed resource/section degrades to the News Center entry rather than a
 * dead link. A linked resource is offered first; the section is always offered
 * when it still exists.
 */
export function buildDeliveryMarkup(news) {
  const rows = [[btn('📰 عرض في مركز الأخبار', `news_open:${news.id}`)]];

  if (news.resource_present && news.resource_id) {
    rows.push([btn('📂 عرض المورد', `file:${news.resource_id}`)]);
  }
  if (news.folder_id) {
    rows.push([btn('🗂 فتح القسم', `folder:${news.folder_id}`)]);
  }

  return { inline_keyboard: rows };
}

/**
 * Resolve the recipients for `newsId` and reserve their delivery rows.
 *
 * Returns `{news, reserved}`. A non-published row, an unknown id or an item
 * with no subscribers yields an empty list — publishing must never depend on
 * there being an audience.
 */
export function planDelivery(newsId) {
  let news;
  try {
    news = db.getNewsDetail(newsId);
  } catch {
    return { news: null, reserved: [] };
  }

  if (!news || news.status !== 'published') return { news, reserved: [] };

  let recipients;
  try {
    recipients = db.resolveNewsRecipients(news.news_type, news.section_folder_id);
  } catch {
    return { news, reserved: [] };
  }
  if (!recipients.length) return { news, reserved: [] };

  try {
    const reserved = db.reserveNewsDeliveries(newsId, recipients, deliveryKind(news));
    return { news, reserved };
  } catch {
    return { news, reserved: [] };
  }
}

/** Seconds Telegram asked us to wait, capped and never negative. */
export function retryAfterSeconds(error) {
  let value = error?.retry_after ?? error?.retryAfter;
  if (value === null || value === undefined) return DELIVERY_RETRY_AFTER_CAP;
  if (typeof value === 'object' && typeof value.total_seconds === 'function') {
    value = value.total_seconds();
  }
  const seconds = Number.parseFloat(value);
  if (Number.isNaN(seconds)) return DELIVERY_RETRY_AFTER_CAP;
  return Math.max(0, Math.min(seconds, DELIVERY_RETRY_AFTER_CAP));
}

function isRetryAfter(error) {
  if (!error) return false;
  if (error.retry_after !== undefined || error.retryAfter !== undefined) return true;
  return /retry after|429|too many requests/i.test(String(error.message ?? ''));
}

/**
 * Send to one recipient; return `"sent" | "failed" | "skipped"`.
 *
 * Claims the row (`sending`) before the Telegram call so a crash mid-send is
 * recoverable. A `RetryAfter` is honoured (capped) and retried a bounded number
 * of times; any other error records `failed` and moves on.
 */
export async function sendOne(bot, news, userId, text, markup) {
  let claimed;
  try {
    claimed = db.claimNewsDelivery(news.id, userId);
  } catch (error) {
    logFailure(`news delivery claim (news=${news.id}, user=${userId})`, error);
    return 'failed';
  }

  // Already `sent`/`skipped` — never resend a terminal delivery.
  if (!claimed) return 'skipped';

  for (let attempt = 0; attempt <= DELIVERY_MAX_SEND_RETRIES; attempt += 1) {
    try {
      const sent = await bot.sendMessage(userId, text, {
        parse_mode: 'HTML',
        reply_markup: markup,
      });
      db.markNewsDelivery(news.id, userId, 'sent', {
        channelMessageId: sent?.message_id ?? null,
      });
      return 'sent';
    } catch (error) {
      if (isRetryAfter(error)) {
        const wait = retryAfterSeconds(error);
        if (attempt >= DELIVERY_MAX_SEND_RETRIES) break;
        await sleepImpl(wait);
        continue;
      }
      try {
        db.markNewsDelivery(news.id, userId, 'failed', { error: String(error.message ?? error) });
      } catch (recordError) {
        logFailure(`news delivery record failure (news=${news.id}, user=${userId})`, recordError);
      }
      logFailure(`news delivery send (news=${news.id}, user=${userId})`, error);
      return 'failed';
    }
  }

  try {
    db.markNewsDelivery(news.id, userId, 'failed', { error: 'RetryAfter exhausted' });
  } catch (recordError) {
    logFailure(`news delivery record retry-exhausted (news=${news.id}, user=${userId})`, recordError);
  }
  return 'failed';
}

/**
 * Send one batch, isolating every per-recipient failure.
 *
 * Returns `{sent, failed, skipped}`. A failure is recorded (`failed` + error)
 * and the loop continues, so a single blocked chat never stops the rest of the
 * audience.
 */
export async function sendBatch(bot, news, userIds) {
  const result = { sent: 0, failed: 0, skipped: 0 };
  const text = buildDeliveryText(news);
  const rows = buildDeliveryMarkup(news);
  const markup = rows.inline_keyboard.length ? rows : null;

  for (const userId of userIds) {
    const outcome = await sendOne(bot, news, userId, text, markup);
    result[outcome] += 1;
  }

  return result;
}

/**
 * Deliver `newsId` to `userIds` (or its reserved pending rows).
 *
 * Batched and rate-limited: the loop waits `DELIVERY_BATCH_DELAY` between
 * batches (never after the last) so the polling loop keeps running while
 * Telegram's limits are respected. Every recipient's outcome is persisted.
 * Returns `{sent, failed, skipped, total}`. Never throws into the caller.
 */
export async function deliver(bot, newsId, userIds = null, throttle = true) {
  const empty = { sent: 0, failed: 0, skipped: 0, total: 0 };

  let news;
  try {
    news = db.getNewsDetail(newsId);
  } catch {
    return empty;
  }
  if (!news || news.status !== 'published') return empty;

  let targets = userIds;
  if (targets === null || targets === undefined) {
    try {
      targets = db.getPendingNewsDeliveries(newsId);
    } catch {
      return empty;
    }
  }

  targets = [...new Set(targets ?? [])];
  const totals = { sent: 0, failed: 0, skipped: 0, total: targets.length };

  const chunks = [];
  for (let i = 0; i < targets.length; i += DELIVERY_BATCH_SIZE) {
    chunks.push(targets.slice(i, i + DELIVERY_BATCH_SIZE));
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const outcome = await sendBatch(bot, news, chunks[index]);
    totals.sent += outcome.sent;
    totals.failed += outcome.failed;
    totals.skipped += outcome.skipped;
    if (throttle && index < chunks.length - 1) {
      await sleepImpl(DELIVERY_BATCH_DELAY);
    }
  }

  return totals;
}

function track(task) {
  backgroundTasks.add(task);
  task.finally(() => backgroundTasks.delete(task));
}

/**
 * Deliver a freshly published item to its subscribers.
 *
 * Small audiences are delivered inline (`waitSmall`) so the caller can report a
 * real count; large ones are scheduled as a background task so the polling loop
 * is not blocked. Either way the outcome is persisted and a failure never
 * propagates into the publish itself.
 */
export async function enqueuePublishDelivery(bot, newsId, waitSmall = true) {
  const { reserved } = planDelivery(newsId);
  if (!reserved.length) return { sent: 0, failed: 0, skipped: 0, total: 0 };

  if (waitSmall && reserved.length <= INLINE_DELIVERY_LIMIT) {
    return deliver(bot, newsId, reserved);
  }

  const task = deliver(bot, newsId, reserved);
  track(task);
  return {
    sent: 0,
    failed: 0,
    skipped: 0,
    total: reserved.length,
    background: true,
  };
}

/**
 * Retry the pending/failed deliveries of one item (bounded).
 *
 * Already-sent recipients are never contacted again, so a retry cannot
 * duplicate a delivery.
 */
export async function retryFailed(bot, newsId) {
  let recipients;
  try {
    recipients = db.getPendingNewsDeliveries(newsId);
  } catch {
    return { sent: 0, failed: 0, skipped: 0, total: 0 };
  }

  recipients = recipients.slice(0, MAX_RETRY_PER_RUN);
  if (!recipients.length) return { sent: 0, failed: 0, skipped: 0, total: 0 };
  return deliver(bot, newsId, recipients);
}

/**
 * Finish deliveries left unfinished by a crash/restart (bounded pass).
 *
 *  * resets crashed `sending` claims (Telegram accepted, process died before
 *    the DB write) back to `pending`;
 *  * walks the oldest published items that still have `pending`/`failed` rows,
 *    up to `RECOVERY_MAX_NEWS` per pass, through the same rate-limited engine.
 *
 * `resetAllSending` is for the startup path: a freshly started process has no
 * in-flight send, so every `sending` row it finds is orphaned and is reset
 * immediately. `sent`/`skipped` rows are never selected, so recovery cannot
 * resend a completed delivery. Best-effort: failures are logged, never raised.
 */
export async function recoverPendingDeliveries(bot, resetAllSending = false) {
  const summary = { reset: 0, news: 0, sent: 0, failed: 0, skipped: 0 };

  try {
    summary.reset = db.resetStaleNewsDeliveries(resetAllSending ? 0 : null);
  } catch {
    // Keep going: an unresettable claim must not block the rest of recovery.
  }

  let newsIds;
  try {
    newsIds = db.listRecoverableNewsIds(RECOVERY_MAX_NEWS);
  } catch {
    return summary;
  }

  for (const newsId of newsIds) {
    let outcome;
    try {
      outcome = await deliver(bot, newsId);
    } catch {
      continue;
    }
    if (outcome.total) {
      summary.news += 1;
      summary.sent += outcome.sent;
      summary.failed += outcome.failed;
      summary.skipped += outcome.skipped;
    }
  }

  return summary;
}

/**
 * Start the delivery-recovery worker once (non-blocking, idempotent).
 *
 * Returns true when a worker was started, false when one is already running.
 * Never blocks startup.
 */
export function startRecovery(bot) {
  if (recoveryTask !== null && !recoveryTask.done) return false;

  recoveryTask = (async () => {
    try {
      await recoverPendingDeliveries(bot, true);
    } catch {
      // A crashed recovery worker must never take the process down.
    }
  })();
  track(recoveryTask);
  return true;
}

/** Await any outstanding background deliveries (test/teardown hook). */
export async function drainBackground(timeoutMs = 10000) {
  const tasks = [...backgroundTasks].filter((task) => !task.done);
  if (!tasks.length) return;

  await Promise.race([
    Promise.allSettled(tasks),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Test hook: forget the recovery worker between test cases. */
export function resetRecoveryState() {
  recoveryTask = null;
  backgroundTasks.clear();
}
