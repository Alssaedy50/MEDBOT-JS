/**
 * D1-backed user domain functions.
 *
 * This module mirrors the stable SQLite user contract while using D1's
 * asynchronous API. It is intentionally dependency-injected: the Worker owns
 * the D1 binding and passes it here.
 */
import { get, run, batch } from './core.js';
import { AI_DAILY_LIMIT, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '../../constants.js';

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export async function registerUser(db, userId, username = null, fullName = null) {
  await batch(db, [
    {
      sql: 'INSERT OR IGNORE INTO users (user_id, username, full_name) VALUES (?, ?, ?)',
      params: [userId, username, fullName],
    },
    {
      sql: 'UPDATE users SET username = ?, full_name = ? WHERE user_id = ?',
      params: [username, fullName, userId],
    },
  ]);
}

export async function getUserLanguage(db, userId) {
  try {
    const row = await get(db, 'SELECT language FROM users WHERE user_id = ?', [userId]);
    return row && SUPPORTED_LANGUAGES.includes(row[0]) ? row[0] : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export async function setUserLanguage(db, userId, language) {
  if (!SUPPORTED_LANGUAGES.includes(language)) return false;
  try {
    return (await run(db, 'UPDATE users SET language = ? WHERE user_id = ?', [
      language,
      userId,
    ])).changes > 0;
  } catch {
    return false;
  }
}

export async function getAllUserIds(db) {
  const rows = await (await import('./core.js')).all(db, 'SELECT user_id FROM users');
  return rows.map((row) => row[0]);
}

export async function getAllUserLanguages(db) {
  const rows = await (await import('./core.js')).all(db, 'SELECT user_id, language FROM users');
  const result = {};
  for (const [userId, language] of rows) {
    result[userId] = SUPPORTED_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
  }
  return result;
}

/**
 * Atomically consume one daily allowance without a read/modify/write race.
 *
 * The conditional UPSERT is one D1 statement, so concurrent Worker requests
 * cannot both pass the same quota check.
 */
export async function checkAndIncrementQuota(db, userId, maxLimit = AI_DAILY_LIMIT) {
  const usageDate = todayUtc();
  const result = await run(
    db,
    'INSERT INTO daily_ai_usage (user_id, usage_date, request_count) VALUES (?, ?, 1) ' +
      'ON CONFLICT(user_id, usage_date) DO UPDATE SET request_count = request_count + 1 ' +
      'WHERE request_count < ?',
    [userId, usageDate, maxLimit],
  );

  if (result.changes === 0) return [false, 0];
  const row = await get(
    db,
    'SELECT request_count FROM daily_ai_usage WHERE user_id = ? AND usage_date = ?',
    [userId, usageDate],
  );
  const count = Number(row?.[0] ?? 0);
  return [true, Math.max(0, maxLimit - count)];
}

export async function getRemainingQuota(db, userId, maxLimit = AI_DAILY_LIMIT) {
  const row = await get(
    db,
    'SELECT request_count FROM daily_ai_usage WHERE user_id = ? AND usage_date = ?',
    [userId, todayUtc()],
  );
  return Math.max(0, maxLimit - Number(row?.[0] ?? 0));
}
