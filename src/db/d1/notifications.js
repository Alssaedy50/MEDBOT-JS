import { get, run } from './core.js';

function limit(value, fallback = 20, max = 200) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.max(1, Math.min(n, max));
}

export async function recordNotification(db, senderId, title, body, audience = 'all', recipients = 0, delivered = 0) {
  const cleanBody = String(body ?? '').trim();
  if (!cleanBody) return null;
  const r = await run(
    db,
    'INSERT INTO notifications (sender_id,title,body,audience,recipients,delivered) VALUES (?,?,?,?,?,?)',
    [senderId, String(title ?? '').trim() || null, cleanBody, audience, Number.parseInt(recipients, 10) || 0, Number.parseInt(delivered, 10) || 0],
  );
  return r.lastInsertRowid;
}

export async function getNotifications(db, count = 20) {
  const safe = limit(count);
  return (await import('./core.js')).all(
    db,
    'SELECT id,sender_id,title,body,audience,recipients,delivered,created_at FROM notifications ORDER BY id DESC LIMIT ?',
    [safe],
  );
}

export async function getNotificationsCount(db) {
  const row = await get(db, 'SELECT COUNT(*) FROM notifications');
  return Number(row?.[0] ?? 0);
}
