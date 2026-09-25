/**
 * Resolving a typed @username or numeric Telegram ID to a known bot user.
 *
 * Lookup is against the bot's real user registry (the `users` row written the
 * first time the account interacted with MEDBOT), not against a requirement
 * that the person press /start again. A user who has ever used the bot is
 * therefore recognised by their stored @username or their Telegram ID.
 */

import { get, run, withDb } from './core.js';
import { isOwner } from './admins.js';

/**
 * Returns `[userId, fullName, storedUsername]` when found, else `[null, '', '']`.
 *
 * Never creates a user row: this is a read.
 */
export function resolveUserByIdentifier(identifier) {
  const cleaned = String(identifier ?? '')
    .trim()
    .replace(/^@/, '')
    .trim();
  if (!cleaned) return [null, '', ''];

  return withDb((db) => {
    if (/^\d+$/.test(cleaned)) {
      const tidy = Number.parseInt(cleaned, 10);
      const row = get(
        db,
        'SELECT user_id, full_name, username FROM users WHERE user_id = ?',
        [tidy],
      );
      if (row) return [row[0], row[1] || '', row[2] || ''];
      // Still a valid numeric id even if the row is absent: Telegram can
      // resolve it, so the caller may add it directly.
      return [tidy, '', ''];
    }

    // Prefer the dedicated username column (case-insensitive).
    let row = get(
      db,
      'SELECT user_id, full_name, username FROM users WHERE username = ? COLLATE NOCASE',
      [cleaned],
    );

    if (!row) {
      // A few very old rows only ever stored a display name; match it as a last
      // resort so an existing user is still found.
      row = get(
        db,
        'SELECT user_id, full_name, username FROM users WHERE full_name = ? COLLATE NOCASE',
        [cleaned],
      );
    }

    if (!row) {
      // Fall back to an already-registered admin carrying this handle.
      const adminRow = get(
        db,
        'SELECT telegram_id, username FROM admins WHERE username = ? COLLATE NOCASE',
        [cleaned],
      );
      if (adminRow) return [adminRow[0], '', adminRow[1] || ''];
      return [null, '', ''];
    }

    return [row[0], row[1] || '', row[2] || ''];
  });
}

/**
 * Add a sub-admin by @username or numeric Telegram ID.
 *
 * Resolves the identifier through the real user registry, refuses to touch the
 * owner (a replace would reset the owner's role/perms), and returns
 * `[ok, message]`.
 */
export function addSubAdminByAny(identifier) {
  const raw = String(identifier ?? '').trim();
  const cleaned = raw.replace(/^@/, '').trim();
  if (!cleaned) return [false, '⚠️ أرسل @username أو Telegram ID صالح.'];

  const [userId, , storedUsername] = resolveUserByIdentifier(cleaned);
  if (userId === null) {
    return [
      false,
      `⚠️ لا يوجد حساب «@${cleaned}» في بيانات البوت.\n` +
        'تأكد من اسم المستخدم (بدون @ يمكن)، أو أرسل الـ Telegram ID الرقمي للحساب.',
    ];
  }

  try {
    if (isOwner(userId)) {
      return [false, 'ℹ️ هذا الحساب هو المالك بالفعل؛ لا حاجة لإضافته كمشرف.'];
    }

    // The `users` registry is the source of truth for the handle; the admins
    // row keeps a copy for display. No user row is created here.
    let displayName = (storedUsername || '').replace(/^@/, '');
    if (!displayName && !/^\d+$/.test(cleaned)) displayName = cleaned;

    withDb((db) =>
      run(db, 'INSERT OR REPLACE INTO admins (telegram_id, username) VALUES (?, ?)', [
        userId,
        displayName,
      ]),
    );
    const nice = displayName && !/^\d+$/.test(displayName) ? ` (@${displayName})` : '';
    return [true, `تمت إضافة المشرف بنجاح (ID: ${userId})${nice}`];
  } catch (error) {
    return [false, `خطأ أثناء الإضافة: ${error.message}`];
  }
}
