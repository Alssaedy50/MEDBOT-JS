import { all, get, run, batch, isIntegrityError } from './core.js';
import { buildBreadcrumbPaths } from './registry.js';
import {
  MAX_NEWS_BODY_LENGTH, MAX_NEWS_DOCTOR_LENGTH, MAX_NEWS_EVENT_LENGTH,
  MAX_NEWS_TITLE_LENGTH, NEWS_DELIVERY_SCOPES, NEWS_DELIVERY_STATUSES,
  NEWS_DELIVERY_STALE_SECONDS, NEWS_SOURCE_AUTO, NEWS_STATUSES,
  NEWS_SUB_SECTION, NEWS_SUB_TYPE, NEWS_TYPES, NEWS_VISIBILITIES,
  intOrNull, normalizeNewsType,
} from '../../constants.js';

const NEWS_COLUMNS =
  'id, news_type, title, body, sender_id, subject_folder_id, section_folder_id, folder_id, ' +
  'doctor, event_at, resource_id, visibility, status, delivery_scope, source, payload, ' +
  'created_at, published_at, archived_at';

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, '');
const rowToNews = (row) => row ? ({
  id: row[0], news_type: row[1], title: row[2], body: row[3], sender_id: row[4],
  subject_folder_id: row[5], section_folder_id: row[6], folder_id: row[7], doctor: row[8],
  event_at: row[9], resource_id: row[10], visibility: row[11], status: row[12],
  delivery_scope: row[13], source: row[14], payload: row[15], created_at: row[16],
  published_at: row[17], archived_at: row[18],
}) : null;

function bounded(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.max(1, Math.min(n, max));
}

export async function createNews(db, {
  newsType, title, body = null, senderId = null, subjectFolderId = null,
  sectionFolderId = null, doctor = null, eventAt = null, resourceId = null,
  visibility = 'all', status = 'draft', deliveryScope = 'all', source = 'manual', payload = null,
} = {}) {
  const canonicalType = normalizeNewsType(newsType);
  const cleanTitle = String(title ?? '').trim();
  const cleanBody = String(body ?? '').trim() || null;
  const cleanDoctor = String(doctor ?? '').trim() || null;
  const cleanEvent = String(eventAt ?? '').trim() || null;
  const subjectId = intOrNull(subjectFolderId);
  const sectionId = intOrNull(sectionFolderId);
  const resourceRefId = intOrNull(resourceId);
  const cleanSource = String(source ?? 'manual').trim() || 'manual';

  if (!NEWS_TYPES.includes(canonicalType) || !cleanTitle || cleanTitle.length > MAX_NEWS_TITLE_LENGTH) return null;
  if (cleanBody && cleanBody.length > MAX_NEWS_BODY_LENGTH) return null;
  if (cleanDoctor && cleanDoctor.length > MAX_NEWS_DOCTOR_LENGTH) return null;
  if (cleanEvent && cleanEvent.length > MAX_NEWS_EVENT_LENGTH) return null;
  if (!NEWS_VISIBILITIES.includes(visibility) || !NEWS_STATUSES.includes(status) || !NEWS_DELIVERY_SCOPES.includes(deliveryScope)) return null;

  for (const [id, sql] of [
    [subjectId, 'SELECT id FROM folders WHERE id=?'],
    [sectionId, 'SELECT id FROM folders WHERE id=?'],
    [resourceRefId, 'SELECT id FROM content WHERE id=?'],
  ]) {
    if (id !== null && !(await get(db, sql, [id]))) return null;
  }

  const anchor = sectionId ?? subjectId;
  try {
    const r = await run(db,
      'INSERT INTO news (news_type,title,body,sender_id,subject_folder_id,section_folder_id,folder_id,doctor,event_at,resource_id,visibility,status,delivery_scope,source,payload,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [canonicalType, cleanTitle, cleanBody, intOrNull(senderId), subjectId, sectionId, anchor,
        cleanDoctor, cleanEvent, resourceRefId, visibility, status, deliveryScope, cleanSource, payload,
        status === 'published' ? nowIso() : null],
    );
    return r.lastInsertRowid;
  } catch (error) {
    if (!isIntegrityError(error) || cleanSource !== NEWS_SOURCE_AUTO || resourceRefId === null) throw error;
    const row = await get(db,
      `SELECT ${NEWS_COLUMNS} FROM news WHERE resource_id=? AND source=? ORDER BY id ASC LIMIT 1`,
      [resourceRefId, NEWS_SOURCE_AUTO]);
    return row?.[0] ?? null;
  }
}

export async function getNews(db, newsId) {
  const row = await get(db, `SELECT ${NEWS_COLUMNS} FROM news WHERE id=?`, [intOrNull(newsId)]);
  return rowToNews(row);
}

export async function getNewsDetail(db, newsId) {
  const news = await getNews(db, newsId);
  if (!news) return null;
  const folderIds = new Set([news.subject_folder_id, news.section_folder_id, news.folder_id].filter(Boolean));
  const paths = folderIds.size ? await buildBreadcrumbPaths(db, folderIds) : {};
  const names = {};
  for (const id of folderIds) {
    const row = await get(db, 'SELECT name FROM folders WHERE id=?', [id]);
    if (row) names[id] = row[0];
  }
  news.subject_name = names[news.subject_folder_id] ?? null;
  news.section_name = names[news.section_folder_id] ?? null;
  news.folder_path = news.folder_id ? paths[news.folder_id] ?? null : null;
  news.resource_title = null; news.resource_folder_id = null; news.resource_present = false;
  if (news.resource_id) {
    const row = await get(db, 'SELECT title,folder_id FROM content WHERE id=?', [news.resource_id]);
    if (row) { news.resource_title = row[0]; news.resource_folder_id = row[1]; news.resource_present = true; }
  }
  return news;
}

function newsListQuery({ status = 'published', newsType = null, sectionFolderId = null, resourceId = null, includeArchived = false, limit = 20, offset = 0, order = 'newest' } = {}) {
  const clauses = []; const params = [];
  if (status && status !== 'all') { clauses.push('status=?'); params.push(status); }
  else if (!includeArchived) clauses.push("status!='archived'");
  if (newsType) { clauses.push('news_type=?'); params.push(normalizeNewsType(newsType)); }
  if (sectionFolderId !== null && sectionFolderId !== undefined) {
    const id = intOrNull(sectionFolderId); clauses.push('(section_folder_id=? OR folder_id=?)'); params.push(id, id);
  }
  if (resourceId !== null && resourceId !== undefined) { clauses.push('resource_id=?'); params.push(intOrNull(resourceId)); }
  const direction = String(order).toLowerCase() === 'oldest' ? 'ASC' : 'DESC';
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, direction,
    limit: bounded(limit, 20, 200), offset: Math.max(0, Number.parseInt(offset, 10) || 0) };
}

export async function listNews(db, options = {}) {
  const q = newsListQuery(options);
  const rows = await all(db, `SELECT ${NEWS_COLUMNS} FROM news ${q.where} ORDER BY COALESCE(published_at,created_at) ${q.direction}, id ${q.direction} LIMIT ? OFFSET ?`, [...q.params, q.limit, q.offset]);
  return rows.map(rowToNews);
}

export async function countNews(db, { status = 'published', newsType = null, includeArchived = false } = {}) {
  const clauses = []; const params = [];
  if (status && status !== 'all') { clauses.push('status=?'); params.push(status); }
  else if (!includeArchived) clauses.push("status!='archived'");
  if (newsType) { clauses.push('news_type=?'); params.push(normalizeNewsType(newsType)); }
  const row = await get(db, `SELECT COUNT(*) FROM news ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`, params);
  return Number(row?.[0] ?? 0);
}

export async function updateNews(db, newsId, fields = {}) {
  const allowed = new Set(['title','body','news_type','subject_folder_id','section_folder_id','doctor','event_at','resource_id','visibility','delivery_scope','source','payload']);
  const updates = {};
  for (const [key, value] of Object.entries(fields)) if (allowed.has(key)) updates[key] = value;
  const id = intOrNull(newsId); if (id === null || !Object.keys(updates).length) return false;
  if ('news_type' in updates) { updates.news_type = normalizeNewsType(updates.news_type); if (!NEWS_TYPES.includes(updates.news_type)) return false; }
  if ('visibility' in updates && !NEWS_VISIBILITIES.includes(updates.visibility)) return false;
  if ('delivery_scope' in updates && !NEWS_DELIVERY_SCOPES.includes(updates.delivery_scope)) return false;
  if ('title' in updates) { updates.title = String(updates.title ?? '').trim(); if (!updates.title || updates.title.length > MAX_NEWS_TITLE_LENGTH) return false; }
  if ('body' in updates) { updates.body = String(updates.body ?? '').trim() || null; if (updates.body && updates.body.length > MAX_NEWS_BODY_LENGTH) return false; }
  if ('doctor' in updates) { updates.doctor = String(updates.doctor ?? '').trim() || null; if (updates.doctor && updates.doctor.length > MAX_NEWS_DOCTOR_LENGTH) return false; }
  if ('event_at' in updates) { updates.event_at = String(updates.event_at ?? '').trim() || null; if (updates.event_at && updates.event_at.length > MAX_NEWS_EVENT_LENGTH) return false; }

  for (const [column, table] of [['subject_folder_id','folders'],['section_folder_id','folders'],['resource_id','content']]) {
    if (!(column in updates) || updates[column] === null || updates[column] === '') continue;
    const value = intOrNull(updates[column]); if (value === null || !(await get(db, `SELECT id FROM ${table} WHERE id=?`, [value]))) return false;
    updates[column] = value;
  }
  if ('section_folder_id' in updates) updates.folder_id = updates.section_folder_id;
  else if ('subject_folder_id' in updates) {
    const current = await get(db, 'SELECT section_folder_id FROM news WHERE id=?', [id]);
    if (!(current?.[0])) updates.folder_id = updates.subject_folder_id;
  }
  const assignments = Object.keys(updates).map((key) => `${key}=?`).join(', ');
  return (await run(db, `UPDATE news SET ${assignments} WHERE id=?`, [...Object.values(updates), id])).changes > 0;
}

export async function publishNews(db, newsId) {
  return (await run(db, "UPDATE news SET status='published',published_at=COALESCE(published_at,?),archived_at=NULL WHERE id=?", [nowIso(), intOrNull(newsId)])).changes > 0;
}
export async function archiveNews(db, newsId) {
  return (await run(db, "UPDATE news SET status='archived',archived_at=? WHERE id=?", [nowIso(), intOrNull(newsId)])).changes > 0;
}
export async function restoreNews(db, newsId) {
  return (await run(db, "UPDATE news SET status='draft',archived_at=NULL WHERE id=?", [intOrNull(newsId)])).changes > 0;
}
export async function deleteNews(db, newsId) {
  return (await run(db, 'DELETE FROM news WHERE id=?', [intOrNull(newsId)])).changes > 0;
}
export async function markNewsRead(db, userId, newsId) {
  try { return (await run(db, 'INSERT OR IGNORE INTO news_reads (user_id,news_id) VALUES (?,?)', [intOrNull(userId), intOrNull(newsId)])).changes > 0; }
  catch { return false; }
}
export async function isNewsRead(db, userId, newsId) {
  return Boolean(await get(db, 'SELECT 1 FROM news_reads WHERE user_id=? AND news_id=?', [intOrNull(userId), intOrNull(newsId)]));
}
export async function getUnreadNewsCount(db, userId) {
  const row = await get(db, `SELECT COUNT(*) FROM news n WHERE n.status='published' AND NOT EXISTS (SELECT 1 FROM news_reads r WHERE r.news_id=n.id AND r.user_id=?)`, [intOrNull(userId)]);
  return Number(row?.[0] ?? 0);
}
export async function getReadNewsIds(db, userId, newsIds = []) {
  const ids = newsIds.map(intOrNull).filter((id) => id !== null); if (!ids.length) return new Set();
  const rows = await all(db, `SELECT news_id FROM news_reads WHERE user_id=? AND news_id IN (${ids.map(() => '?').join(',')})`, [intOrNull(userId), ...ids]);
  return new Set(rows.map((r) => r[0]));
}
export async function markAllNewsRead(db, userId) {
  const rows = await all(db, "SELECT id FROM news WHERE status='published'", []);
  let created = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50).map((r) => ({ sql: 'INSERT OR IGNORE INTO news_reads (user_id,news_id) VALUES (?,?)', params: [intOrNull(userId), r[0]] }));
    const results = await batch(db, chunk); created += results.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0);
  }
  return created;
}
export async function getNewsSubscriptions(db, userId) {
  return (await all(db, 'SELECT topic_kind,topic_value FROM news_subscriptions WHERE user_id=? ORDER BY topic_kind,topic_value', [intOrNull(userId)])).map((r) => [r[0], r[1]]);
}
export async function getNewsCountsByType(db) {
  const rows = await all(db, "SELECT news_type,COUNT(*) FROM news WHERE status='published' GROUP BY news_type", []);
  return Object.fromEntries(rows.map((r) => [r[0], Number(r[1])]));
}
export async function addNewsSubscription(db, userId, topicKind, topicValue) {
  const kind = String(topicKind ?? '').trim(); if (![NEWS_SUB_TYPE, NEWS_SUB_SECTION].includes(kind)) return false;
  let value = String(topicValue ?? '').trim(); if (!value) return false;
  if (kind === NEWS_SUB_TYPE) { value = normalizeNewsType(value); if (!NEWS_TYPES.includes(value)) return false; }
  else { const folderId = intOrNull(value); if (folderId === null || !(await get(db, 'SELECT id FROM folders WHERE id=?', [folderId]))) return false; value = String(folderId); }
  try { await run(db, 'INSERT OR IGNORE INTO news_subscriptions (user_id,topic_kind,topic_value) VALUES (?,?,?)', [intOrNull(userId), kind, value]); return true; } catch { return false; }
}
export async function removeNewsSubscription(db, userId, topicKind, topicValue) {
  return (await run(db, 'DELETE FROM news_subscriptions WHERE user_id=? AND topic_kind=? AND topic_value=?', [intOrNull(userId), String(topicKind), String(topicValue)])).changes > 0;
}
export async function getNewsSubscriptionsMap(db, userIds = null) {
  let rows;
  if (userIds === null || userIds === undefined) rows = await all(db, 'SELECT user_id,topic_kind,topic_value FROM news_subscriptions', []);
  else { const ids = userIds.map(intOrNull).filter((id) => id !== null); if (!ids.length) return {}; rows = await all(db, `SELECT user_id,topic_kind,topic_value FROM news_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`, ids); }
  const mapping = {};
  for (const [uid, kind, value] of rows) (mapping[uid] ??= []).push([kind, value]);
  return mapping;
}
export async function resolveNewsRecipients(db, newsType, sectionFolderId = null) {
  const kind = normalizeNewsType(newsType); if (!NEWS_TYPES.includes(kind)) return [];
  const clauses = ['(topic_kind=? AND topic_value=?)']; const params = [NEWS_SUB_TYPE, kind];
  if (kind === 'section' && sectionFolderId !== null && sectionFolderId !== undefined) { const id = intOrNull(sectionFolderId); if (id !== null) { clauses.push('(topic_kind=? AND topic_value=?)'); params.push(NEWS_SUB_SECTION, String(id)); } }
  const rows = await all(db, `SELECT DISTINCT user_id FROM news_subscriptions WHERE ${clauses.join(' OR ')} ORDER BY user_id`, params);
  return rows.map((r) => r[0]);
}
export async function reserveNewsDeliveries(db, newsId, userIds, kind = null) {
  const id = intOrNull(newsId); if (id === null) return [];
  const valid = [...new Set((userIds ?? []).map(intOrNull).filter((x) => x !== null))]; const reserved = [];
  for (let i = 0; i < valid.length; i += 50) {
    const chunk = valid.slice(i, i + 50).map((uid) => ({ sql: "INSERT OR IGNORE INTO news_deliveries (news_id,user_id,status,kind) VALUES (? ,?,'pending',?)", params: [id, uid, kind] }));
    const results = await batch(db, chunk);
    results.forEach((r, j) => { if (Number(r.meta?.changes ?? 0) > 0) reserved.push(chunk[j].params[1]); });
  }
  return reserved;
}
export async function getPendingNewsDeliveries(db, newsId, retryFailed = true) {
  const id = intOrNull(newsId); if (id === null) return [];
  const statuses = retryFailed ? ['pending','failed'] : ['pending'];
  const rows = await all(db, 'SELECT user_id FROM news_deliveries WHERE news_id=? AND status IN (?,?) ORDER BY user_id', [id, statuses[0], statuses[1] ?? statuses[0]]);
  return rows.map((r) => r[0]);
}
export async function claimNewsDelivery(db, newsId, userId) {
  const id = intOrNull(newsId), uid = intOrNull(userId); if (id === null || uid === null) return false;
  return (await run(db, "INSERT INTO news_deliveries (news_id,user_id,status) VALUES (?,?,'sending') ON CONFLICT(news_id,user_id) DO UPDATE SET status='sending',updated_at=CURRENT_TIMESTAMP WHERE news_deliveries.status IN ('pending','failed','sending')", [id, uid])).changes > 0;
}
export async function markNewsDelivery(db, newsId, userId, status, { error = null, channelMessageId = null, countAttempt = true } = {}) {
  const id = intOrNull(newsId), uid = intOrNull(userId); if (id === null || uid === null || !NEWS_DELIVERY_STATUSES.includes(status)) return false;
  const cleanError = error === null ? null : String(error).slice(0, 500); const bump = countAttempt ? 1 : 0;
  const row = await get(db, 'SELECT status FROM news_deliveries WHERE news_id=? AND user_id=?', [id, uid]);
  if (!row) { await run(db, 'INSERT INTO news_deliveries (news_id,user_id,status,attempts,error,channel_message_id,updated_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)', [id,uid,status,bump,cleanError,channelMessageId]); return true; }
  if (row[0] === 'sent') return true;
  await run(db, 'UPDATE news_deliveries SET status=?,attempts=attempts+?,error=?,channel_message_id=COALESCE(?,channel_message_id),updated_at=CURRENT_TIMESTAMP WHERE news_id=? AND user_id=?', [status,bump,cleanError,channelMessageId,id,uid]);
  return true;
}
export async function resetStaleNewsDeliveries(db, olderThanSeconds = null) {
  let threshold = olderThanSeconds == null ? NEWS_DELIVERY_STALE_SECONDS : Number.parseInt(olderThanSeconds, 10);
  if (Number.isNaN(threshold)) threshold = NEWS_DELIVERY_STALE_SECONDS; threshold = Math.max(0, threshold);
  return (await run(db, "UPDATE news_deliveries SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE status='sending' AND updated_at<=datetime('now',?)", [`-${threshold} seconds`])).changes;
}
export async function listRecoverableNewsIds(db, limit = 50) {
  const safe = bounded(limit, 50, 500);
  const rows = await all(db, "SELECT DISTINCT d.news_id,MIN(d.updated_at) AS oldest FROM news_deliveries d JOIN news n ON n.id=d.news_id WHERE d.status IN ('pending','failed') AND n.status='published' GROUP BY d.news_id ORDER BY oldest ASC LIMIT ?", [safe]);
  return rows.map((r) => r[0]);
}
export async function getNewsDeliveryCounts(db, newsId) {
  const id = intOrNull(newsId); if (id === null) return {};
  const rows = await all(db, 'SELECT status,COUNT(*) FROM news_deliveries WHERE news_id=? GROUP BY status', [id]);
  return Object.fromEntries(rows.map((r) => [r[0], Number(r[1])]));
}
export async function getNewsDeliveries(db, newsId, status = null, limit = 50) {
  const id = intOrNull(newsId); if (id === null) return [];
  const safe = bounded(limit, 50, 200); const validStatus = NEWS_DELIVERY_STATUSES.includes(status);
  const rows = await all(db, `SELECT user_id,status,kind,attempts,error,updated_at FROM news_deliveries WHERE news_id=?${validStatus ? ' AND status=?' : ''} ORDER BY updated_at DESC,user_id ASC LIMIT ?`, validStatus ? [id,status,safe] : [id,safe]);
  return rows.map((r) => ({ user_id:r[0],status:r[1],kind:r[2],attempts:r[3],error:r[4],updated_at:r[5] }));
}
export async function getResourceNewsForContent(db, contentId) {
  const id = intOrNull(contentId); if (id === null) return null;
  const row = await get(db, `SELECT ${NEWS_COLUMNS} FROM news WHERE resource_id=? AND source=? ORDER BY id ASC LIMIT 1`, [id, NEWS_SOURCE_AUTO]);
  return rowToNews(row);
}
export async function createResourceNewsForContent(db, contentId, senderId = null, status = 'draft') {
  const id = intOrNull(contentId); if (id === null) return null;
  const existing = await getResourceNewsForContent(db, id); if (existing) return existing.id;
  const row = await get(db, 'SELECT id,folder_id,title FROM content WHERE id=?', [id]); if (!row) return null;
  return createNews(db, { newsType:'section', title:row[2] || 'مورد جديد', senderId, sectionFolderId:row[1], resourceId:id, status, source:NEWS_SOURCE_AUTO });
}
