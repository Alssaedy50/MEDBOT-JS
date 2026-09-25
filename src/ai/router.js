/**
 * AI routing: candidate discovery, health verification, cooldown/failover.
 *
 * The lifecycle is DISCOVERED -> probe -> VERIFIED -> active pool. Only VERIFIED
 * models are ever used to answer a student, so an unverified or broken model can
 * never be the one that replies.
 *
 * The verified pool is expensive to build (provider discovery plus health
 * probes, all network round-trips), so it is cached for a short TTL and the
 * previous pool keeps serving if a refresh fails.
 */

import { randomInt } from 'node:crypto';

import * as db from '../db/index.js';
import * as providers from './providers.js';
import { GroundingValidator } from './intent.js';
import { guardAnswer, hasRepetition } from './guard.js';
import { REPETITION_RETRY_INSTRUCTION, SYSTEM_PROMPT } from './prompts.js';

export const ACTIVE_POOL_SIZE = 12;
export const CANDIDATE_TTL_SECONDS = 300;

export const COOLDOWN_SECONDS = 60;
export const MAX_COOLDOWN_SECONDS = 900;

/** Per-model runtime health, keyed by `provider|model|endpoint`. */
const modelFailures = new Map();
const modelCooldownUntil = new Map();
const modelLastError = new Map();
const modelSuccessCount = new Map();

let candidateCache = null;
let candidateCacheAt = 0;

export function modelKey(item) {
  return `${item?.provider ?? ''}|${item?.model ?? ''}|${item?.endpoint ?? ''}`;
}

/** Test hook: forget all runtime health + the pool cache. */
export function resetRouterState() {
  modelFailures.clear();
  modelCooldownUntil.clear();
  modelLastError.clear();
  modelSuccessCount.clear();
  candidateCache = null;
  candidateCacheAt = 0;
}

export function isInCooldown(item) {
  const key = modelKey(item);
  const until = modelCooldownUntil.get(key) ?? 0;
  if (until <= Date.now() / 1000) {
    modelCooldownUntil.delete(key);
    return false;
  }
  return true;
}

export function markModelSuccess(item) {
  const key = modelKey(item);
  modelFailures.set(key, 0);
  modelLastError.delete(key);
  modelCooldownUntil.delete(key);
  modelSuccessCount.set(key, (modelSuccessCount.get(key) ?? 0) + 1);
}

/** Exponential backoff, capped: 60s, 120s, 240s, … up to 15 minutes. */
export function markModelFailure(item, errorCategory) {
  const key = modelKey(item);
  const failures = (modelFailures.get(key) ?? 0) + 1;
  modelFailures.set(key, failures);
  modelLastError.set(key, errorCategory);

  const cooldown = Math.min(
    COOLDOWN_SECONDS * 2 ** Math.max(0, failures - 1),
    MAX_COOLDOWN_SECONDS,
  );
  modelCooldownUntil.set(key, Date.now() / 1000 + cooldown);
}

/** Introspection for the runtime screen/tests. */
export function modelHealthSnapshot() {
  return {
    failures: Object.fromEntries(modelFailures),
    cooldowns: Object.fromEntries(modelCooldownUntil),
    lastError: Object.fromEntries(modelLastError),
    successes: Object.fromEntries(modelSuccessCount),
  };
}

// ---------------------------------------------------------------------------
// Candidate pipeline
// ---------------------------------------------------------------------------

function registryRowToProvider(row) {
  return {
    id: row[0],
    provider: row[1],
    model: row[2],
    endpoint: row[3],
    availability: row[4],
    auth_status: row.length > 5 ? row[5] : null,
    latency_ms: row.length > 6 ? row[6] : null,
    success_rate: row.length > 7 ? row[7] : null,
  };
}

/** Register candidates in the registry without promoting them. */
function ensureCandidateRegistryIds(candidates) {
  for (const item of candidates) {
    const { provider, model, endpoint } = item;
    if (!provider || !model || !endpoint) continue;

    try {
      const registryId = db.aiRegistryEnsure(
        provider,
        model,
        endpoint,
        'DISCOVERED',
        providers.hasKey(provider) ? 'valid' : null,
        'text_generation',
      );
      if (registryId) {
        item.id = registryId;
        item.availability = item.availability ?? 'DISCOVERED';
      }
    } catch {
      // Registry bookkeeping must never break the pipeline.
    }
  }
  return candidates;
}

async function recordSuccess(item, latencyMs) {
  markModelSuccess(item);
  const registryId = item.id;
  if (!registryId) return;
  try {
    db.aiRegistryMarkSuccess(registryId, latencyMs);
  } catch {
    // Best-effort.
  }
}

async function recordFailure(item, error) {
  const [availability, authStatus, errorCategory] = providers.classifyError(error);
  markModelFailure(item, errorCategory);

  const registryId = item.id;
  if (!registryId) return;
  try {
    db.aiRegistryMarkFailure(registryId, errorCategory, availability, authStatus);
  } catch {
    // Best-effort.
  }
}

/** Lightweight health probe for a discovered model. */
async function probeModel(item, fetchImpl) {
  const probePrompt = 'أجب بكلمة واحدة: ما هو تعريف الحمى؟';

  try {
    const started = Date.now();
    const answer = await providers.request({ item, prompt: probePrompt, fetchImpl });
    const latencyMs = Math.round(Date.now() - started);

    if (!answer.trim()) throw new Error('EMPTY_MODEL_RESPONSE');

    if (item.id) {
      try {
        db.aiRegistryMarkSuccess(item.id, latencyMs);
      } catch {
        // Best-effort.
      }
    }

    item.availability = 'VERIFIED';
    item.latency_ms = latencyMs;
    item.success_rate = 1.0;
    markModelSuccess(item);
    return true;
  } catch (error) {
    await recordFailure(item, error);
    return false;
  }
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Build the request pool using VERIFIED models only, preserving provider
 * diversity before filling remaining slots randomly.
 */
export function buildActivePool(candidates) {
  const verified = (candidates ?? []).filter(
    (item) =>
      item.availability === 'VERIFIED' &&
      item.provider &&
      item.model &&
      item.endpoint &&
      !isInCooldown(item) &&
      !(item.provider === 'openrouter' && !String(item.model).toLowerCase().endsWith(':free')),
  );

  if (!verified.length) return [];

  const maxPool = ACTIVE_POOL_SIZE;
  const minPerProvider = 2;

  const groups = new Map();
  for (const item of verified) {
    if (!groups.has(item.provider)) groups.set(item.provider, []);
    groups.get(item.provider).push(item);
  }
  for (const [provider, items] of groups) groups.set(provider, shuffle(items));

  const pool = [];
  const seen = new Set();
  const add = (item) => {
    const key = modelKey(item);
    if (seen.has(key) || pool.length >= maxPool) return;
    seen.add(key);
    pool.push(item);
  };

  for (const provider of shuffle([...groups.keys()])) {
    for (const item of groups.get(provider).slice(0, minPerProvider)) {
      if (pool.length >= maxPool) break;
      add(item);
    }
  }

  const remaining = [];
  for (const items of groups.values()) remaining.push(...items.slice(minPerProvider));
  for (const item of shuffle(remaining)) {
    if (pool.length >= maxPool) break;
    add(item);
  }

  return pool;
}

/**
 * Probe a small rotating sample of DISCOVERED models, preserving provider
 * diversity.
 *
 * Probing only the first two discovered models globally could spend the whole
 * budget on one provider; this selects up to two per provider under a hard
 * global cap, prioritising models never tested or tested least recently.
 */
export async function refreshDiscoveredModels(candidates, fetchImpl = fetch) {
  const discovered = (candidates ?? []).filter(
    (item) => item.availability === 'DISCOVERED' && !isInCooldown(item) && item.provider,
  );
  if (!discovered.length) return candidates;

  let lastTestById = {};
  try {
    lastTestById = Object.fromEntries(
      db
        .aiRegistryGetAll()
        .map((row) => [row[0], row.length > 11 ? row[11] : null]),
    );
  } catch {
    lastTestById = {};
  }

  const groups = new Map();
  for (const item of discovered) {
    if (!groups.has(item.provider)) groups.set(item.provider, []);
    groups.get(item.provider).push(item);
  }
  for (const items of groups.values()) {
    items.sort((a, b) => {
      const aTest = lastTestById[a.id] ?? null;
      const bTest = lastTestById[b.id] ?? null;
      const aTested = aTest !== null ? 1 : 0;
      const bTested = bTest !== null ? 1 : 0;
      if (aTested !== bTested) return aTested - bTested;
      return String(aTest ?? '').localeCompare(String(bTest ?? ''));
    });
  }

  const MAX_PROBES_PER_PROVIDER = 2;
  const MAX_TOTAL_PROBES = 6;

  const providerNames = shuffle([...groups.keys()]);
  const selected = [];

  for (const provider of providerNames) {
    if (selected.length >= MAX_TOTAL_PROBES) break;
    const items = groups.get(provider);
    if (items.length) selected.push(items[0]);
  }
  for (const provider of providerNames) {
    if (selected.length >= MAX_TOTAL_PROBES) break;
    const items = groups.get(provider);
    if (items.length >= MAX_PROBES_PER_PROVIDER) selected.push(items[1]);
  }

  await Promise.allSettled(selected.map((item) => probeModel(item, fetchImpl)));
  return candidates;
}

/** Discover, register, verify, then build the active pool (uncached). */
export async function buildCandidatesUncached(fetchImpl = fetch) {
  const candidates = [];

  // A. Fresh provider discovery (independent providers run concurrently).
  try {
    const [gemini, groq, openrouter] = await Promise.allSettled([
      providers.discoverGeminiModels(fetchImpl),
      providers.discoverGroqModels(fetchImpl),
      providers.discoverOpenrouterModels(fetchImpl),
    ]);

    for (const result of [gemini, groq, openrouter]) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value) {
        if (providers.isModelSuitableForMedbot(item)) {
          item.availability = item.availability ?? 'DISCOVERED';
          candidates.push(item);
        }
      }
    }
  } catch {
    // A discovery failure just leaves the persisted registry to serve.
  }

  // B. Merge persisted registry health.
  try {
    const seen = new Set(candidates.map(modelKey));

    for (const row of db.aiRegistryGetHealthy()) {
      const item = registryRowToProvider(row);
      if (!item.provider || !item.model) continue;
      if (!providers.hasKey(item.provider)) continue;
      if (!providers.isModelSuitableForMedbot(item)) continue;

      // OpenRouter registry rows do not persist pricing metadata, so only
      // explicit `:free` models may survive from persisted data.
      if (item.provider === 'openrouter' && !String(item.model).toLowerCase().endsWith(':free')) {
        continue;
      }

      const identity = modelKey(item);
      if (seen.has(identity)) {
        const existing = candidates.find((candidate) => modelKey(candidate) === identity);
        if (existing) Object.assign(existing, item);
        continue;
      }

      seen.add(identity);
      candidates.push(item);
    }
  } catch {
    // The registry is optional for the pipeline.
  }

  // C. Register without promoting.
  ensureCandidateRegistryIds(candidates);

  // D. Probe a small rotating sample.
  await refreshDiscoveredModels(candidates, fetchImpl);

  // E. Only VERIFIED models enter the pool.
  const verified = candidates.filter(
    (item) =>
      item.availability === 'VERIFIED' &&
      providers.hasKey(item.provider) &&
      !isInCooldown(item),
  );

  return buildActivePool(verified);
}

/**
 * The cached active pool.
 *
 * Cached for `CANDIDATE_TTL_SECONDS`; on an empty build the previous pool keeps
 * serving (and an empty result is never cached), so the next request can retry.
 */
export async function getCandidates(fetchImpl = fetch) {
  const now = Date.now() / 1000;
  if (candidateCache && now - candidateCacheAt < CANDIDATE_TTL_SECONDS) {
    return [...candidateCache];
  }

  const pool = await buildCandidatesUncached(fetchImpl);

  if (pool.length) {
    candidateCache = pool;
    candidateCacheAt = Date.now() / 1000;
  } else if (!candidateCache) {
    candidateCacheAt = 0;
  }

  return [...(pool.length ? pool : candidateCache ?? [])];
}

/** Warm the discovery/probe cache once at startup (best-effort). */
export async function warmAiPool() {
  try {
    await getCandidates();
  } catch {
    // Startup warm-up must never break serving.
  }
}

/**
 * Send one grounded prompt through the pool with failover.
 *
 * Returns the answer, or '' when every provider failed. Keeps usage/health
 * bookkeeping in one place so each intent shares the same provider contract.
 * A repetition that survives the local repair triggers at most one regeneration
 * for that candidate.
 */
export async function providerFailover({
  groundedPrompt,
  systemPrompt,
  candidates,
  userId = null,
  sourcesFooter = '',
  fetchImpl = fetch,
}) {
  const validator = new GroundingValidator();

  for (const item of candidates ?? []) {
    try {
      const started = Date.now();
      let answer = await providers.request({
        item,
        prompt: groundedPrompt,
        systemPrompt,
        fetchImpl,
      });

      if (!validator.allows(answer)) throw new Error('Validator rejected empty answer');

      answer = guardAnswer(answer);

      if (hasRepetition(answer)) {
        try {
          const retry = await providers.request({
            item,
            prompt: `${groundedPrompt}${REPETITION_RETRY_INSTRUCTION}`,
            systemPrompt,
            fetchImpl,
          });
          if (validator.allows(retry)) {
            const guarded = guardAnswer(retry);
            if (!hasRepetition(guarded)) answer = guarded;
          }
        } catch {
          // A failed regeneration keeps the repaired original.
        }
      }

      const latencyMs = Math.round(Date.now() - started);

      if (item.id) {
        try {
          db.aiUsageRecord(item.id, { userId, latencyMs, success: true });
        } catch {
          // Observability must never break a generation.
        }
      }
      await recordSuccess(item, latencyMs);

      // The application, not the model, owns the final citation footer.
      answer = ensureFooter(answer, sourcesFooter);
      return answer;
    } catch (error) {
      await recordFailure(item, error);

      if (item.id) {
        try {
          const [, , errorCategory] = providers.classifyError(error);
          db.aiUsageRecord(item.id, { userId, success: false, errorCategory });
        } catch {
          // Observability must never break a generation.
        }
      }
    }
  }

  return '';
}

function ensureFooter(answer, footer) {
  const cleaned = String(answer ?? '').replace(/\s+$/, '');
  if (!footer) return cleaned;
  const lowered = cleaned.toLowerCase();
  if (lowered.includes('pubmed') || lowered.includes('pmid')) return cleaned;
  return `${cleaned}${footer}`;
}

// Re-exported so the facade and tests share one prompt constant.
export { SYSTEM_PROMPT };
