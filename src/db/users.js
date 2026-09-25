/**
 * Users, language preference and the daily AI allowance.
 */

import { get, run, withDb, withTransaction } from './core.js';
import { AI_DAILY_LIMIT, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '../constants.js';

/** Register or refresh a user row. Idempotent (INSERT OR IGNORE + UPDATE). */
export function registerUser(userId, username = null, fullName = null) {
  withDb((db) => {
    run(
      db,
      'INSERT OR IGNORE INTO users (user_id, username, full_name) VALUES (?, ?, ?)',
      [userId, username, fullName],
    );
    run(db, 'UPDATE users SET username = ?, full_name = ? WHERE user_id = ?', [
      username,
      fullName,
      userId,
    ]);
  });
}

/** Resolve a user's stored language, defaulting to Arabic. */
export function getUserLanguage(userId) {
  try {
    const row = withDb((db) =>
      get(db, 'SELECT language FROM users WHERE user_id = ?', [userId]),
    );
    if (row && SUPPORTED_LANGUAGES.includes(row[0])) return row[0];
  } catch {
    return DEFAULT_LANGUAGE;
  }
  return DEFAULT_LANGUAGE;
}

/** Persist a user's language preference. Unknown languages are rejected. */
export function setUserLanguage(userId, language) {
  if (!SUPPORTED_LANGUAGES.includes(language)) return false;
  try {
    return withDb(
      (db) =>
        run(db, 'UPDATE users SET language = ? WHERE user_id = ?', [
          language,
          Number.parseInt(userId, 10),
        ]).changes > 0,
    );
  } catch {
    return false;
  }
}

/** Every registered user id. */
export function getAllUserIds() {
  return withDb((db) =>
    db
      .prepare('SELECT user_id FROM users')
      .all()
      .map((row) => row[0]),
  );
}

/** Map user_id -> language for every user (default when unset). */
export function getAllUserLanguages() {
  const rows = withDb((db) =>
    db.prepare('SELECT user_id, language FROM users').all(),
  );
  const result = {};
  for (const [userId, language] of rows) {
    result[userId] = SUPPORTED_LANGUAGES.includes(language)
      ? language
      : DEFAULT_LANGUAGE;
  }
  return result;
}

function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Atomically consume one daily AI request.
 *
 * `BEGIN IMMEDIATE` serialises concurrent quota updates so two requests cannot
 * both read the same old count and exceed `maxLimit`.
 */
export function checkAndIncrementQuota(userId, maxLimit = AI_DAILY_LIMIT) {
  return withTransaction((db) => {
    const usageDate = today();
    const row = get(
      db,
      'SELECT request_count FROM daily_ai_usage WHERE user_id = ? AND usage_date = ?',
      [userId, usageDate],
    );
    const currentCount = row ? row[0] : 0;

    if (currentCount >= maxLimit) return [false, 0];

    const newCount = currentCount + 1;
    run(
      db,
      'INSERT INTO daily_ai_usage (user_id, usage_date, request_count) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user_id, usage_date) DO UPDATE SET request_count = excluded.request_count',
      [userId, usageDate, newCount],
    );

    return [true, maxLimit - newCount];
  });
}

/** Remaining AI requests for today (never negative). */
export function getRemainingQuota(userId, maxLimit = AI_DAILY_LIMIT) {
  return withDb((db) => {
    const row = get(
      db,
      'SELECT request_count FROM daily_ai_usage WHERE user_id = ? AND usage_date = ?',
      [userId, today()],
    );
    const currentCount = row ? row[0] : 0;
    return Math.max(0, maxLimit - currentCount);
  });
}
