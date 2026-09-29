/** Async D1 AI registry + usage observability. */
import { all, get, run } from './core.js';

const REGISTRY_COLUMNS = 'id,provider,model,endpoint,availability,auth_status,latency_ms,success_rate,capabilities,last_success,last_failure,last_test,notes,error_category,timeout_behavior,rate_limit_behavior';
const safeDays = (days) => Math.max(1, Math.min(Number.parseInt(days, 10) || 1, 365));
const safeLimit = (limit, fallback = 10) => Math.max(1, Math.min(Number.parseInt(limit, 10) || fallback, 100));

export async function aiRegistryEnsure(db, provider, model, endpoint, availability = 'AVAILABLE', authStatus = null, capabilities = 'text_generation') {
  if (!String(provider ?? '').trim() || !String(model ?? '').trim() || !String(endpoint ?? '').trim()) return null;
  await run(db, 'INSERT INTO ai_registry (provider,model,endpoint,availability,auth_status,capabilities) VALUES (?,?,?,?,?,?) ON CONFLICT(provider,model,endpoint) DO NOTHING', [provider, model, endpoint, availability, authStatus, capabilities]);
  const row = await get(db, 'SELECT id FROM ai_registry WHERE provider=? AND model=? AND endpoint=? LIMIT 1', [provider, model, endpoint]);
  return row?.[0] ?? null;
}

export async function aiRegistryGetAll(db) { return all(db, 'SELECT ' + REGISTRY_COLUMNS + ' FROM ai_registry ORDER BY id ASC'); }

export async function aiRegistryGetHealthy(db) {
  return all(db, "SELECT id,provider,model,endpoint,availability,auth_status,latency_ms,success_rate,capabilities FROM ai_registry WHERE availability='AVAILABLE' ORDER BY success_rate DESC,latency_ms ASC");
}

export async function aiRegistryAdd(db, { provider, model = null, endpoint = null, availability = null, authStatus = null, latencyMs = null, successRate = null, capabilities = null, notes = null } = {}) {
  if (!String(provider ?? '').trim()) return null;
  const result = await run(db, 'INSERT INTO ai_registry (provider,model,endpoint,availability,auth_status,latency_ms,success_rate,capabilities,notes) VALUES (?,?,?,?,?,?,?,?,?)', [provider, model, endpoint, availability, authStatus, latencyMs, successRate, capabilities, notes]);
  return result.lastInsertRowid;
}

const ALLOWED_UPDATE_FIELDS = new Set(['provider','model','endpoint','availability','auth_status','latency_ms','success_rate','capabilities','notes']);
export async function aiRegistryUpdate(db, id, fields = {}) {
  const safeId = Number.parseInt(id, 10);
  if (!Number.isInteger(safeId)) return false;
  const updates = Object.entries(fields).filter(([key]) => ALLOWED_UPDATE_FIELDS.has(key));
  if (!updates.length) return false;
  const assignments = updates.map(([key]) => key + '=?').join(',');
  const result = await run(db, 'UPDATE ai_registry SET ' + assignments + ' WHERE id=?', [...updates.map(([, value]) => value), safeId]);
  return result.changes > 0;
}

export async function aiRegistryMarkSuccess(db, id, latencyMs = null) {
  const result = await run(db, 'UPDATE ai_registry SET availability=?,auth_status=?,latency_ms=?,success_rate=COALESCE(success_rate,1.0),last_success=CURRENT_TIMESTAMP,last_test=CURRENT_TIMESTAMP WHERE id=?', ['AVAILABLE','AUTHENTICATED',latencyMs,id]);
  return result.changes > 0;
}

export async function aiRegistryMarkFailure(db, id, errorCategory = null, availability = null, authStatus = null) {
  const result = await run(db, 'UPDATE ai_registry SET last_failure=CURRENT_TIMESTAMP,last_test=CURRENT_TIMESTAMP,error_category=COALESCE(?,error_category),availability=COALESCE(?,availability),auth_status=COALESCE(?,auth_status) WHERE id=?', [errorCategory, availability, authStatus, id]);
  return result.changes > 0;
}

export async function aiUsageRecord(db, registryId, { userId = null, latencyMs = null, success = false, errorCategory = null } = {}) {
  try { await run(db, 'INSERT INTO ai_model_usage (registry_id,user_id,latency_ms,success,error_category) VALUES (?,?,?,?,?)', [registryId,userId,latencyMs,success ? 1 : 0,errorCategory]); return true; } catch { return false; }
}

export async function aiUsageStats(db, days = 1) {
  return all(db, "SELECT r.id,r.provider,r.model,r.availability,COUNT(u.id) AS total_requests,COALESCE(SUM(u.success),0) AS successful_requests,COUNT(DISTINCT u.user_id) AS unique_students,ROUND(AVG(u.latency_ms),1) AS avg_latency_ms,MAX(u.created_at) AS last_used FROM ai_registry r LEFT JOIN ai_model_usage u ON u.registry_id=r.id AND u.created_at >= datetime('now',?) GROUP BY r.id,r.provider,r.model,r.availability ORDER BY unique_students DESC,total_requests DESC,avg_latency_ms ASC", ['-' + safeDays(days) + ' days']);
}

export async function aiUsageTopStudents(db, days = 1, limit = 10) {
  return all(db, "SELECT user_id,COUNT(*) AS total_requests,SUM(success) AS successful_requests,ROUND(AVG(latency_ms),1) AS avg_latency_ms FROM ai_model_usage WHERE user_id IS NOT NULL AND created_at >= datetime('now',?) GROUP BY user_id ORDER BY total_requests DESC LIMIT ?", ['-' + safeDays(days) + ' days', safeLimit(limit)]);
}
