/**
 * MEDBOT AI facade: the two explicit modes plus the legacy auto-router.
 *
 *  MODE 1 — Platform resource search (`generatePlatformSearchResult`).
 *    Registry facts + verified one-tap access. It may read the complete current
 *    catalog so it can resolve natural-language Arabic/English queries, but it
 *    may never produce a platform fact that is not a real registered row, and
 *    the backend builds every access button from verified ids. Its fast path
 *    (deterministic search) calls no model at all.
 *
 *  MODE 2 — AI chat (`generateAiChatResult`).
 *    Conversational knowledge, never the platform registry. A medical question
 *    gets an English academic answer plus a concise Arabic explanation and
 *    PubMed grounding; anything else is answered naturally and concisely, with
 *    no PubMed and no registry access. Actions are always empty.
 *
 * `generateUnifiedResult` is a thin auto-router kept for single-textbox/CLI
 * callers; the Telegram layer selects a mode explicitly.
 */

import * as db from '../db/index.js';
import * as searchEngine from '../searchEngine.js';
import * as medicalSources from '../medicalSources.js';
import {
  buildResultActions,
  classifyIntent,
  buildRegistryOverview,
  genuineRegistryMatches,
  searchSubjectTokens,
  INTENT_MEDICAL,
  INTENT_OVERVIEW,
  INTENT_RESOURCE,
  MEDICAL_CONCEPT_KEYS,
} from './intent.js';
import {
  CATALOG_MAX_CHARS,
  CHAT_NO_PROVIDER_ANSWER,
  GENERAL_ASSISTANT_PROMPT,
  MAX_RESULT_ACTIONS,
  PLATFORM_SEARCH_NO_MATCH,
  PLATFORM_SEARCH_PROMPT,
  UNIFIED_ASSISTANT_PROMPT,
} from './prompts.js';
import { getCandidates, providerFailover } from './router.js';

const NODE_LABELS = {
  book: '📚 كتاب', books: '📚 كتب', video: '🎥 فيديو', audio: '🎧 صوتي',
  mcq: '📝 MCQ', summary: '📑 ملخص', summaries: '📑 ملخصات', image: '🖼 صورة',
  photo: '🖼 صورة', document: '📄 مستند', doc: '📄 مستند', general: '📁 قسم',
};

const FILE_LABELS = {
  photo: '🖼 صورة', image: '🖼 صورة', video: '🎥 فيديو', audio: '🎧 صوتي',
  mcq: '📝 MCQ', quiz: '📝 MCQ', pdf: '📕 PDF', document: '📄 مستند',
};

/** Load the registry rows the AI layers reason over (real data only). */
export function loadRegistry() {
  const { folders, contents, paths } = db.getSearchableRecords();
  return [folders, contents, paths];
}

/** Deterministic registry search, returning only real rows. */
export function searchMedbot(query) {
  try {
    const response = searchEngine.searchLibrarySummary(query, 10);
    if (!response || typeof response !== 'object') return [];
    const results = response.results;
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

/**
 * Render the full registered tree into a compact, bounded text catalog.
 *
 * Only registered data is rendered — nothing is invented — and the result is
 * bounded by `CATALOG_MAX_CHARS` so a huge library cannot blow the prompt size.
 */
export function buildPlatformCatalog(folders, contents, paths) {
  const lines = [];

  for (const row of folders) {
    const [folderId, , name, nodeType] = row;
    const path = paths[folderId] || 'الرئيسية 🏠';
    const kind = NODE_LABELS[String(nodeType ?? '').toLowerCase()] ?? '📁 قسم';
    const suffix = row.length > 4 && row[4] ? ' (يستقبل مساهمات)' : '';
    lines.push(`- [${kind}] ${name} | المسار: ${path}${suffix}`);
  }

  for (const row of contents) {
    const [, folderId, title, fileType] = row;
    const path = paths[folderId] || 'الرئيسية 🏠';
    const kind = FILE_LABELS[String(fileType ?? '').toLowerCase()] ?? '📄 مورد';
    lines.push(`- [${kind}] ${title} | داخل: ${path}`);
  }

  if (!lines.length) return 'قاعدة البيانات لا تحتوي أي أقسام أو موارد مسجلة بعد.';

  let catalog = lines.join('\n');
  if (catalog.length > CATALOG_MAX_CHARS) {
    catalog = catalog.slice(0, CATALOG_MAX_CHARS).split('\n').slice(0, -1).join('\n');
    catalog += '\n… (تم اختصار دليل المنصة لطوله)';
  }
  return catalog;
}

/** Render the full catalog as search-shaped rows (real ids/names/paths). */
export function catalogRowsAsResults(folders, contents, paths) {
  const results = [];

  for (const row of folders) {
    const [folderId, , name, nodeType] = row;
    const contentCount = contents.filter((content) => content[1] === folderId).length;
    results.push({
      type: 'FOLDER',
      result_type: contentCount ? 'FOLDER' : 'EMPTY_FOLDER',
      id: folderId,
      folder_id: folderId,
      title: name,
      name,
      path: paths[folderId] || 'الرئيسية 🏠',
      content_count: contentCount,
      node_type: nodeType,
    });
  }

  for (const row of contents) {
    const [contentId, folderId, title, fileType] = row;
    results.push({
      type: 'CONTENT',
      result_type: 'CONTENT',
      id: contentId,
      content_id: contentId,
      folder_id: folderId,
      title,
      name: title,
      path: paths[folderId] || 'الرئيسية 🏠',
      file_type: fileType,
    });
  }

  return results;
}

/**
 * Keep only catalog rows the model's answer can be verified against.
 *
 * The model's text is a *claim*; a row becomes reachable only when confirmed
 * from the registry itself. Iterating the REAL catalog rows means an invented
 * entity can never be produced — the model can only *select* a row that already
 * exists.
 */
export function verifyCatalogAnswer(answer, folders, contents, paths) {
  const rows = catalogRowsAsResults(folders, contents, paths);
  const normalizedAnswer = searchEngine.normalizeText(answer);

  const verified = [];
  for (const item of rows) {
    const title = searchEngine.normalizeText(item.title ?? item.name ?? '');
    if (title && normalizedAnswer.includes(title)) verified.push(item);
  }
  return verified.slice(0, MAX_RESULT_ACTIONS);
}

/**
 * Query the full catalog with the model, keeping only verifiable hits.
 *
 * Runs only after the deterministic pass found nothing. If no provider is
 * reachable, or the model names nothing that maps back to a registered row, the
 * result is empty and the caller answers with the honest no-match message.
 */
export async function catalogFallbackMatches(userPrompt, fetchImpl = fetch) {
  const [folders, contents, paths] = loadRegistry();
  if (!folders.length && !contents.length) return [];

  const subject = searchSubjectTokens(userPrompt);
  if (!subject.size) return [];

  const candidates = await getCandidates(fetchImpl);
  if (!candidates.length) return [];

  const catalog = buildPlatformCatalog(folders, contents, paths);
  const groundedPrompt =
    'دليل المنصة (المصدر الوحيد المسموح لمعرفة ما هو مسجّل):\n' +
    `${catalog}\n\n` +
    `طلب الطالب:\n${userPrompt}\n\n` +
    'اذكر فقط الموارد/الأقسام المطابقة لطلب الطالب من الدليل أعلاه، مع ' +
    'مسار كل منها. لا تذكر أي شيء غير موجود في الدليل.';

  const answer = await providerFailover({
    groundedPrompt,
    systemPrompt: PLATFORM_SEARCH_PROMPT,
    candidates,
    userId: null,
    label: 'Platform search',
    fetchImpl,
  });

  if (!answer) return [];
  return verifyCatalogAnswer(answer, folders, contents, paths);
}

/**
 * Deterministic registry search followed by a verified catalog fallback.
 *
 * Returns only real search-engine result rows.
 */
export async function platformSearchResults(userPrompt, fetchImpl = fetch) {
  const results = searchMedbot(userPrompt);
  const matches = genuineRegistryMatches(userPrompt, results);
  if (matches.length) return matches;
  return catalogFallbackMatches(userPrompt, fetchImpl);
}

function platformSearchLine(item) {
  const isFolder = item.result_type === 'FOLDER' || item.result_type === 'EMPTY_FOLDER';
  const icon = isFolder ? '📂' : '📄';
  const title = item.title || item.name || 'بدون عنوان';
  const path = item.path || 'الرئيسية 🏠';
  const label = isFolder ? 'المسار' : 'داخل';
  return `${icon} *${title}*\n   ${label}: ${path}`;
}

/** Short, discovery-oriented answer rendered only from verified rows. */
export function buildPlatformSearchAnswer(results) {
  if (!results?.length) return PLATFORM_SEARCH_NO_MATCH;

  if (results.length === 1) {
    return `وجدت لك مورداً مرتبطاً بطلبك:\n\n${platformSearchLine(results[0])}`;
  }

  const lines = ['وجدت عدة موارد مرتبطة بطلبك:', ''];
  for (const item of results.slice(0, MAX_RESULT_ACTIONS)) {
    lines.push(platformSearchLine(item));
  }
  return lines.join('\n');
}

/**
 * MODE 1: find and reach real MEDBOT resources.
 *
 * Pipeline (never invents a platform entity):
 *   query -> local intent/concept resolution
 *         -> deterministic registry search (fast path, no model)
 *         -> [fallback] full-catalog read + verified-id matching
 *         -> short answer + one-tap buttons from VERIFIED registry ids
 */
export async function generatePlatformSearchResult(userPrompt, userId = null, fetchImpl = fetch) {
  const prompt = String(userPrompt ?? '').trim();
  if (!prompt) return { text: '⚠️ يرجى كتابة ما تبحث عنه.', actions: [] };

  // A bare enumeration is answered from the registered hierarchy alone.
  if (classifyIntent(prompt) === INTENT_OVERVIEW) {
    const [folders] = loadRegistry();
    return { text: buildRegistryOverview(folders), actions: [] };
  }

  const matches = await platformSearchResults(prompt, fetchImpl);
  if (!matches.length) return { text: PLATFORM_SEARCH_NO_MATCH, actions: [] };

  return { text: buildPlatformSearchAnswer(matches), actions: buildResultActions(matches) };
}

/**
 * Whether an AI-Chat message is a medical/scientific question.
 *
 * A question like "اشرح لي دورة القلب" names a concept that is both a
 * registered directory and a medical topic; in AI Chat the first person is
 * medical, so any recognized medical concept counts.
 */
export function isMedicalQuestion(userPrompt, intent) {
  if (intent === INTENT_MEDICAL) return true;
  const concepts = searchEngine.impliedConcepts(userPrompt);
  for (const concept of concepts) {
    if (MEDICAL_CONCEPT_KEYS.has(concept)) return true;
  }
  return false;
}

/**
 * MODE 2: conversational AI, separate from platform navigation.
 *
 * Actions are always empty: chat never produces platform navigation, so it can
 * never expose platform structure or invent a resource.
 */
export async function generateAiChatResult(userPrompt, userId = null, fetchImpl = fetch) {
  const prompt = String(userPrompt ?? '').trim();
  if (!prompt) return { text: '⚠️ يرجى كتابة سؤال واضح.', actions: [] };

  const intent = classifyIntent(prompt);

  if (!isMedicalQuestion(prompt, intent)) {
    const candidates = await getCandidates(fetchImpl);
    if (!candidates.length) return { text: CHAT_NO_PROVIDER_ANSWER, actions: [] };

    const answer = await providerFailover({
      groundedPrompt: `سؤال الطالب:\n${prompt}`,
      systemPrompt: GENERAL_ASSISTANT_PROMPT,
      candidates,
      userId,
      label: 'General assistant',
      fetchImpl,
    });

    if (!answer) return { text: CHAT_NO_PROVIDER_ANSWER, actions: [] };
    return { text: answer, actions: [] };
  }

  // A medical question: PubMed grounding + the bilingual answer contract.
  // Deliberately no registry search: AI Chat must not surface MEDBOT structure.
  const [candidatesResult, sourcesResult] = await Promise.allSettled([
    getCandidates(fetchImpl),
    medicalSources.searchPubmed(prompt, 3),
  ]);

  const candidates = candidatesResult.status === 'fulfilled' ? candidatesResult.value : [];
  const sources = sourcesResult.status === 'fulfilled' ? sourcesResult.value : [];

  if (!candidates.length) return { text: CHAT_NO_PROVIDER_ANSWER, actions: [] };

  const sourceContext =
    sources.length && medicalSources.buildSourceContext(sources)
      ? medicalSources.buildSourceContext(sources)
      : 'لا توجد مصادر PubMed متاحة لهذا السؤال؛ إن لم تكن متأكداً فاذكر ذلك.';

  const groundedPrompt =
    'مصادر طبية موثّقة (NCBI PubMed) — استخدمها كمصدر وحيد لأي ادّعاء مصدر:\n' +
    `${sourceContext}\n\n` +
    `سؤال الطالب:\n${prompt}`;

  const answer = await providerFailover({
    groundedPrompt,
    systemPrompt: UNIFIED_ASSISTANT_PROMPT,
    candidates,
    userId,
    label: 'Medical assistant',
    sourcesFooter: medicalSources.buildSourcesFooter(sources),
    fetchImpl,
  });

  if (!answer) return { text: CHAT_NO_PROVIDER_ANSWER, actions: [] };
  return { text: answer, actions: [] };
}

/**
 * Backward-compatible auto-routing entry point (legacy/CLI callers only).
 *
 * overview | resource -> MODE 1 platform resource search
 * medical  | general  -> MODE 2 AI chat
 */
export async function generateUnifiedResult(userPrompt, userId = null, fetchImpl = fetch) {
  const prompt = String(userPrompt ?? '').trim();
  if (!prompt) return { text: '⚠️ يرجى كتابة سؤال واضح.', actions: [] };

  const intent = classifyIntent(prompt);
  if (intent === INTENT_OVERVIEW || intent === INTENT_RESOURCE) {
    return generatePlatformSearchResult(prompt, userId, fetchImpl);
  }
  return generateAiChatResult(prompt, userId, fetchImpl);
}

/** Backward-compatible text-only wrapper. */
export async function generateUnifiedResponse(userPrompt, userId = null, fetchImpl = fetch) {
  const result = await generateUnifiedResult(userPrompt, userId, fetchImpl);
  return result.text;
}
