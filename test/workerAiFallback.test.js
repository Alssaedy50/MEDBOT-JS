/**
 * Worker AI timeout + provider-fallback contract.
 *
 * The Worker path must reach a working provider before the request gives up:
 * Gemini is preferred, but a fast failure or a timeout has to fall through to
 * Groq and then OpenRouter, and a slow provider must never hold the request to
 * the end. No live Telegram, PubMed, or AI provider is contacted: the provider
 * transport is injected through the global `fetch`, and PubMed is pointed at a
 * stub that returns no records.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { answerWorkerAi } from '../src/telegram/workerAi.js';
import * as providers from '../src/ai/providers.js';
import * as medicalSources from '../src/medicalSources.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

const ENV = {
  GEMINI_API_KEY: 'gemini-key',
  GROQ_API_KEY: 'groq-key',
  OPENROUTER_API_KEY: 'openrouter-key',
};

/** A D1 binding stub that answers every query the Worker AI path issues. */
function fakeDb() {
  const rowsFor = async (sql) => {
    if (sql.includes('FROM users')) return [['ar']];
    if (sql.includes('FROM daily_ai_usage')) return [[1]];
    if (sql.includes("availability='AVAILABLE'")) return [];
    if (sql.includes('SELECT id FROM ai_registry')) return [[7]];
    return [];
  };
  return {
    prepare(sql) {
      const make = () => ({
        run: async () => ({ meta: { changes: 1, last_row_id: 7 } }),
        raw: () => rowsFor(sql),
        first: async () => (await rowsFor(sql))[0] ?? null,
        all: async () => ({ results: await rowsFor(sql) }),
      });
      const statement = make();
      statement.bind = () => make();
      return statement;
    },
    batch: async (items) => items.map(() => ({ meta: { changes: 1 } })),
  };
}

function jsonOk(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function httpError(status, body) {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

/** A generation response that never settles until the request is aborted. */
function hang(options = {}) {
  return new Promise((_resolve, reject) => {
    const signal = options.signal;
    if (!signal) return;
    if (signal.aborted) return reject(new Error('provider_timeout'));
    signal.addEventListener('abort', () => reject(new Error('provider_timeout')), { once: true });
  });
}

const DISCOVERY = {
  gemini: jsonOk({
    models: [{ name: `models/${GEMINI_MODEL}`, supportedGenerationMethods: ['generateContent'] }],
  }),
  groq: jsonOk({ data: [{ id: GROQ_MODEL }] }),
  openrouter: jsonOk({
    data: [
      {
        id: OPENROUTER_MODEL,
        architecture: { input_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0' },
      },
    ],
  }),
};

/**
 * Build a `fetch` stub for the three providers.
 *
 * `generation` selects each provider's behaviour: `ok`, `fail` (a fast 401), or
 * `hang` (a slow provider that must be abandoned). Every generation call is
 * recorded so fallback order can be asserted.
 */
function providerFetch(generation = {}) {
  const calls = [];
  const behaviour = (provider) => generation[provider] ?? 'ok';

  const fn = async (url, options = {}) => {
    // PubMed is best-effort grounding: answer "no records" so the test never
    // depends on a live source and no spurious provider call is recorded.
    if (url.includes('eutils.ncbi.nlm.nih.gov')) return jsonOk({ esearchresult: { idlist: [] } });
    if (url.includes('/models?')) return DISCOVERY.gemini;
    if (url.includes('api.groq.com/openai/v1/models')) return DISCOVERY.groq;
    if (url.includes('openrouter.ai/api/v1/models')) return DISCOVERY.openrouter;

    const provider = url.includes('generativelanguage') ? 'gemini'
      : url.includes('api.groq.com') ? 'groq'
        : 'openrouter';
    calls.push(provider);

    if (behaviour(provider) === 'hang') return hang(options);
    if (behaviour(provider) === 'fail') {
      return provider === 'gemini'
        ? httpError(401, 'API key not valid. Please pass a valid API key.')
        : httpError(401, `Invalid API key for ${provider}`);
    }
    if (provider === 'gemini') return jsonOk({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }] });
    return jsonOk({ choices: [{ message: { content: `${provider} answer` } }] });
  };

  fn.calls = calls;
  return fn;
}

function resetState() {
  providers.resetDiscoveryCache();
  medicalSources.resetPubmedCache();
}

test('Gemini success uses Gemini and never falls through', async () => {
  resetState();
  const fetchImpl = providerFetch();
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await answerWorkerAi(fakeDb(), { id: 100 }, 'ما هو تعريف الحمى؟', { ...ENV });
    assert.match(result.text, /gemini answer/);
    assert.deepEqual(fetchImpl.calls, ['gemini']);
    assert.equal(typeof result.remaining, 'number');
  } finally {
    globalThis.fetch = original;
  }
});

test('Gemini fast 401 falls back to Groq', async () => {
  resetState();
  const fetchImpl = providerFetch({ gemini: 'fail' });
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await answerWorkerAi(fakeDb(), { id: 101 }, 'ما هو تعريف الحمى؟', { ...ENV });
    assert.match(result.text, /groq answer/);
    assert.deepEqual(fetchImpl.calls, ['gemini', 'groq']);
  } finally {
    globalThis.fetch = original;
  }
});

test('Gemini timeout does not hold the request and falls back to Groq', async () => {
  resetState();
  const fetchImpl = providerFetch({ gemini: 'hang' });
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const started = Date.now();
  try {
    const result = await answerWorkerAi(
      fakeDb(),
      { id: 102 },
      'ما هو تعريف الحمى؟',
      { ...ENV, WORKER_AI_ATTEMPT_TIMEOUT_MS: 150, WORKER_AI_OVERALL_TIMEOUT_MS: 5000 },
    );
    const elapsed = Date.now() - started;
    assert.match(result.text, /groq answer/);
    assert.deepEqual(fetchImpl.calls, ['gemini', 'groq']);
    assert.ok(elapsed >= 150, `expected the Gemini attempt to be bounded, got ${elapsed}ms`);
    assert.ok(elapsed < 3000, `request should not wait for the slow provider, got ${elapsed}ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test('Gemini and Groq failures fall through to OpenRouter in order', async () => {
  resetState();
  const fetchImpl = providerFetch({ gemini: 'fail', groq: 'fail' });
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await answerWorkerAi(fakeDb(), { id: 103 }, 'ما هو تعريف الحمى؟', { ...ENV });
    assert.match(result.text, /openrouter answer/);
    assert.deepEqual(fetchImpl.calls, ['gemini', 'groq', 'openrouter']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a successful fallback returns a normal answer', async () => {
  resetState();
  const fetchImpl = providerFetch({ gemini: 'hang', groq: 'hang' });
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await answerWorkerAi(
      fakeDb(),
      { id: 104 },
      'ما هو تعريف الحمى؟',
      { ...ENV, WORKER_AI_ATTEMPT_TIMEOUT_MS: 150, WORKER_AI_OVERALL_TIMEOUT_MS: 5000 },
    );
    assert.equal(typeof result.text, 'string');
    assert.match(result.text, /openrouter answer/);
    assert.equal(typeof result.remaining, 'number');
  } finally {
    globalThis.fetch = original;
  }
});

test('the overall request timeout bounds the whole loop and returns gracefully', async () => {
  resetState();
  const fetchImpl = providerFetch({ gemini: 'hang', groq: 'hang', openrouter: 'hang' });
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const started = Date.now();
  try {
    const result = await answerWorkerAi(
      fakeDb(),
      { id: 105 },
      'ما هو تعريف الحمى؟',
      { ...ENV, WORKER_AI_ATTEMPT_TIMEOUT_MS: 100, WORKER_AI_OVERALL_TIMEOUT_MS: 350 },
    );
    const elapsed = Date.now() - started;
    assert.match(result.text, /مزودي الذكاء الاصطناعي|AI providers failed/);
    assert.ok(elapsed < 3000, `overall timeout should bound the request, got ${elapsed}ms`);
    assert.ok(fetchImpl.calls.length <= 4, `expected the loop to stop, got ${fetchImpl.calls.length} attempts`);
  } finally {
    globalThis.fetch = original;
  }
});
