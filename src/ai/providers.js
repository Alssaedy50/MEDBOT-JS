/**
 * AI provider adapters.
 *
 * Three providers, two wire protocols:
 *   google_gemini -> Gemini `generateContent`
 *   groq          -> OpenAI-compatible `/chat/completions`
 *   openrouter    -> OpenAI-compatible `/chat/completions`
 *
 * Each adapter returns the answer text or throws; the router classifies the
 * thrown error and decides on failover/cooldown.
 */

import { MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from './prompts.js';

export const REQUEST_TIMEOUT_MS = 30000;
export const DISCOVERY_TIMEOUT_MS = 12000;

/** Provider -> environment variable holding its API key. */
export function keyFor(provider) {
  if (provider === 'google_gemini') return process.env.GEMINI_API_KEY?.trim() ?? '';
  if (provider === 'groq') return process.env.GROQ_API_KEY?.trim() ?? '';
  if (provider === 'openrouter') return process.env.OPENROUTER_API_KEY?.trim() ?? '';
  return '';
}

/** True when MEDBOT has a key for this provider. */
export function hasKey(provider) {
  return Boolean(keyFor(provider));
}

/**
 * A structured HTTP failure carrying the status and a response-body excerpt.
 *
 * The router classifies on `message`, so the excerpt is included there (matching
 * the Python behaviour of raising `RuntimeError("Gemini HTTP 429: ...")`).
 */
export class ProviderError extends Error {
  constructor(provider, status, body) {
    const excerpt = String(body ?? '').slice(0, 300);
    super(`${provider} HTTP ${status}: ${excerpt}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.body = excerpt;
  }
}

/** A 429 with Telegram/HTTP Retry-After semantics preserved for the router. */
export class RateLimitError extends ProviderError {
  constructor(provider, status, body, retryAfter = null) {
    super(provider, status, body);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

function geminiEndpoint(item) {
  if (item.endpoint) return item.endpoint;
  return (
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    `${item.model}:generateContent`
  );
}

function previousMessage(response) {
  return response.headers.get('retry-after');
}

async function throwForResponse(provider, response) {
  const body = await response.text().catch(() => '');
  if (response.status === 429) {
    throw new RateLimitError(provider, response.status, body, previousMessage(response));
  }
  throw new ProviderError(provider, response.status, body);
}

/** Gemini `generateContent`. Returns the concatenated text parts. */
export async function geminiRequest({ item, prompt, systemPrompt = SYSTEM_PROMPT, fetchImpl = fetch }) {
  const response = await fetchImpl(geminiEndpoint(item), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyFor('google_gemini') },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) await throwForResponse('Gemini', response);

  const data = await response.json().catch(() => null);
  const candidates = data?.candidates ?? [];
  const text = candidates.length
    ? (candidates[0]?.content?.parts ?? [])
        .filter((part) => part && typeof part === 'object')
        .map((part) => part.text ?? '')
        .join('')
        .trim()
    : '';

  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

/** OpenAI-compatible `/chat/completions` (Groq, OpenRouter). */
export async function openAiCompatibleRequest({
  item,
  prompt,
  systemPrompt = SYSTEM_PROMPT,
  fetchImpl = fetch,
}) {
  const provider = item.provider;
  const apiKey = keyFor(provider);
  if (!apiKey) throw new Error(`Unsupported OpenAI-compatible provider: ${provider}`);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://telegram.org';
    headers['X-Title'] = 'MEDBOT';
  }

  const response = await fetchImpl(item.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: item.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) await throwForResponse(provider, response);

  const data = await response.json().catch(() => null);
  let text;
  try {
    text = String(data.choices[0].message.content).trim();
  } catch {
    throw new Error(`${provider} returned an invalid response`);
  }

  if (!text) throw new Error(`${provider} returned an empty response`);
  return text;
}

/** Route to the right adapter for `item.provider`. */
export async function request({ item, prompt, systemPrompt = SYSTEM_PROMPT, fetchImpl = fetch }) {
  if (item.provider === 'google_gemini') {
    return geminiRequest({ item, prompt, systemPrompt, fetchImpl });
  }
  if (item.provider === 'groq' || item.provider === 'openrouter') {
    return openAiCompatibleRequest({ item, prompt, systemPrompt, fetchImpl });
  }
  throw new Error(`Unsupported AI provider: ${item.provider}`);
}

/**
 * Classify a provider failure into `[availability, authStatus, errorCategory]`.
 *
 * Order matters and mirrors the Python classifier: quota before auth before
 * rate-limit before timeout before network before generic upstream errors.
 */
export function classifyError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();

  if (
    message.includes('key limit exceeded') ||
    message.includes('total limit') ||
    message.includes('quota exceeded') ||
    message.includes('insufficient_quota')
  ) {
    return ['QUOTA_LIMITED', null, 'QUOTA_LIMITED'];
  }

  if (message.includes('api_key_invalid') || message.includes('invalid api key')) {
    return ['AUTH_FAILED', 'invalid', 'AUTH_FAILED'];
  }
  if (message.includes('401')) return ['AUTH_FAILED', 'invalid', 'AUTH_FAILED'];

  if (message.includes('429') || message.includes('rate')) {
    return ['RATE_LIMITED', null, 'RATE_LIMITED'];
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return ['TIMEOUT', null, 'TIMEOUT'];
  }

  if (
    message.includes('no address associated with hostname') ||
    message.includes('name or service not known') ||
    message.includes('temporary failure in name resolution') ||
    message.includes('nodename nor servname provided') ||
    message.includes('network is unreachable') ||
    message.includes('connection reset') ||
    message.includes('connecterror') ||
    message.includes('connecttimeout') ||
    message.includes('fetch failed')
  ) {
    return ['NETWORK_ERROR', null, 'NETWORK_ERROR'];
  }

  if (message.includes('403')) return ['AUTH_FAILED', 'forbidden', 'AUTH_FAILED'];
  if (message.includes('http ')) return ['UPSTREAM_ERROR', null, 'UPSTREAM_ERROR'];

  return ['UNAVAILABLE', null, 'UNAVAILABLE'];
}

// ---------------------------------------------------------------------------
// Provider discovery
// ---------------------------------------------------------------------------

const DISCOVERY_TTL_SECONDS = 900;
const discoveryCache = new Map();
const discoveryLastRun = new Map();

function cacheGet(provider) {
  const cached = discoveryCache.get(provider);
  const when = discoveryLastRun.get(provider) ?? 0;
  if (cached && Date.now() / 1000 - when < DISCOVERY_TTL_SECONDS) return cached;
  return null;
}

function cacheSet(provider, models) {
  discoveryCache.set(provider, models);
  discoveryLastRun.set(provider, Date.now() / 1000);
}

/** Test hook: drop the discovery caches. */
export function resetDiscoveryCache() {
  discoveryCache.clear();
  discoveryLastRun.clear();
}

/** Discover Gemini text-generation models exposed to the configured key. */
export async function discoverGeminiModels(fetchImpl = fetch) {
  if (!hasKey('google_gemini')) return [];

  const cached = cacheGet('google_gemini');
  if (cached) return cached;

  try {
    const response = await fetchImpl(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
      {
        headers: { 'x-goog-api-key': keyFor('google_gemini') },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      },
    );
    if (!response.ok) return [];

    const data = await response.json();
    const discovered = [];

    for (const model of data?.models ?? []) {
      const name = model?.name ?? '';
      const methods = model?.supportedGenerationMethods ?? [];
      if (!name || !methods.includes('generateContent')) continue;

      const modelId = name.split('/').pop();
      discovered.push({
        provider: 'google_gemini',
        model: modelId,
        endpoint:
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          `${modelId}:generateContent`,
      });
    }

    if (discovered.length) cacheSet('google_gemini', discovered);
    return discovered;
  } catch {
    return [];
  }
}

const GROQ_EXCLUDED_PREFIXES = [
  'whisper',
  'canopylabs/orpheus',
  'meta-llama/llama-prompt-guard',
];

export async function discoverGroqModels(fetchImpl = fetch) {
  if (!hasKey('groq')) return [];

  const cached = cacheGet('groq');
  if (cached) return cached;

  try {
    const response = await fetchImpl('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${keyFor('groq')}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return [];

    const data = await response.json();
    const discovered = [];

    for (const model of data?.data ?? []) {
      const modelId = model?.id ?? '';
      if (!modelId) continue;
      const lowered = modelId.toLowerCase();
      if (GROQ_EXCLUDED_PREFIXES.some((prefix) => lowered.startsWith(prefix))) continue;

      discovered.push({
        provider: 'groq',
        model: modelId,
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      });
    }

    if (discovered.length) cacheSet('groq', discovered);
    return discovered;
  } catch {
    return [];
  }
}

const OPENROUTER_EXCLUDED_TERMS = [
  'embedding',
  'whisper',
  'rerank',
  'moderation',
  'tts',
  'image',
  'vision',
  'audio',
  'transcribe',
  'speech',
];

/**
 * Discover OpenRouter models that are explicitly free.
 *
 * A model qualifies when it is text-capable, not an excluded modality, and
 * OpenRouter reports zero prompt/completion pricing OR the id uses `:free`.
 */
export async function discoverOpenrouterModels(fetchImpl = fetch) {
  if (!hasKey('openrouter')) return [];

  const cached = cacheGet('openrouter');
  if (cached) return cached;

  try {
    const response = await fetchImpl('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${keyFor('openrouter')}`,
        'HTTP-Referer': 'https://medbot.local',
        'X-Title': 'MEDBOT',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];

    const data = await response.json();
    const discovered = [];

    for (const model of data?.data ?? []) {
      const modelId = String(model?.id ?? '').trim();
      if (!modelId) continue;

      const lowered = modelId.toLowerCase();
      if (OPENROUTER_EXCLUDED_TERMS.some((term) => lowered.includes(term))) continue;

      const inputModalities = model?.architecture?.input_modalities ?? [];
      if (inputModalities.length && !inputModalities.includes('text')) continue;

      const pricing = model?.pricing ?? {};
      const promptPrice = pricing.prompt;
      const completionPrice = pricing.completion;
      const explicitlyFree = lowered.endsWith(':free');

      let pricingFree = false;
      try {
        pricingFree =
          promptPrice !== null &&
          promptPrice !== undefined &&
          completionPrice !== null &&
          completionPrice !== undefined &&
          Number.parseFloat(promptPrice) === 0.0 &&
          Number.parseFloat(completionPrice) === 0.0;
      } catch {
        pricingFree = false;
      }

      if (!(explicitlyFree || pricingFree)) continue;

      discovered.push({
        provider: 'openrouter',
        model: modelId,
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      });
    }

    if (discovered.length) cacheSet('openrouter', discovered);
    return discovered;
  } catch {
    return [];
  }
}

/**
 * Whether a discovered model is a suitable general text model for MEDBOT.
 *
 * Excludes every non-chat modality (tts/embedding/whisper/…); Gemini keeps only
 * `gemini-`/`gemma-` text models.
 */
export function isModelSuitableForMedbot(item) {
  const provider = item?.provider ?? '';
  const model = String(item?.model ?? '').toLowerCase();
  if (!model) return false;

  const excluded = [
    'tts', 'image', 'embedding', 'whisper', 'rerank', 'moderation',
    'content-safety', 'safety', 'prompt-guard', 'guard', 'classifier',
    'audio', 'transcribe', 'speech',
  ];
  if (excluded.some((term) => model.includes(term))) return false;

  if (provider === 'google_gemini') {
    return model.startsWith('gemini-') || model.startsWith('gemma-');
  }
  if (provider === 'groq' || provider === 'openrouter') return true;
  return false;
}
