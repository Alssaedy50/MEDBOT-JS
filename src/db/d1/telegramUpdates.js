/**
 * D1-backed Telegram webhook idempotency.
 *
 * A claim is atomic: the first request for an update_id gets the row, while
 * concurrent duplicates are rejected. Completion is separate so a transient
 * handler failure can be retried instead of losing the Telegram update.
 */

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export async function initTelegramWebhookStore(db) {
  if (!db || typeof db.exec !== 'function') {
    throw new TypeError('A Cloudflare D1 database binding is required');
  }
  await db.exec(
    `CREATE TABLE IF NOT EXISTS telegram_updates (update_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'processing', claimed_at INTEGER NOT NULL, completed_at INTEGER, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_telegram_updates_expires ON telegram_updates(expires_at);`
  );
}

export async function claimTelegramUpdate(db, updateId, {
  now = Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  const expiresAt = now + ttlSeconds * 1000;

  await db
    .prepare('DELETE FROM telegram_updates WHERE expires_at <= ?')
    .bind(now)
    .run();

  const result = await db
    .prepare(
      `INSERT INTO telegram_updates(update_id, status, claimed_at, expires_at)
       VALUES (?, 'processing', ?, ?)
       ON CONFLICT(update_id) DO UPDATE SET
         status = 'processing',
         claimed_at = excluded.claimed_at,
         expires_at = excluded.expires_at
       WHERE telegram_updates.status = 'failed' OR telegram_updates.expires_at <= excluded.claimed_at`,
    )
    .bind(updateId, now, expiresAt)
    .run();

  return Number(result?.meta?.changes ?? 0) === 1;
}

export async function completeTelegramUpdate(db, updateId, { now = Date.now() } = {}) {
  const result = await db
    .prepare(
      `UPDATE telegram_updates
       SET status = 'completed', completed_at = ?
       WHERE update_id = ? AND status = 'processing'`,
    )
    .bind(now, updateId)
    .run();
  return Number(result?.meta?.changes ?? 0) === 1;
}

export async function failTelegramUpdate(db, updateId) {
  const result = await db
    .prepare(
      `UPDATE telegram_updates
       SET status = 'failed'
       WHERE update_id = ? AND status = 'processing'`,
    )
    .bind(updateId)
    .run();
  return Number(result?.meta?.changes ?? 0) === 1;
}


/** Adapt the D1 functions to the generic webhook idempotency contract. */
export function createD1TelegramIdempotencyStore(db, options = {}) {
  return Object.freeze({
    claim: (updateId, ttlSeconds) =>
      claimTelegramUpdate(db, updateId, {
        ...options,
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      }),
    complete: (updateId) => completeTelegramUpdate(db, updateId, options),
    fail: (updateId) => failTelegramUpdate(db, updateId),
  });
}
