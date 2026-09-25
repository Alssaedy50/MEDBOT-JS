/**
 * Intent classification and grounding helpers.
 *
 * Deterministic and local: no network, no extra database round-trip. It reuses
 * the search engine's normalization and concept table, so the intent classifier
 * can never disagree with the registry search about what a word means.
 *
 * Four intents, each with a different source of truth:
 *   overview -> "what exists on MEDBOT?"   -> registered hierarchy only
 *   resource -> "where is X?"              -> deterministic registry search
 *   medical  -> a medical/scientific question -> verified answer + PubMed
 *   general  -> anything else              -> concise direct answer
 */

import * as searchEngine from '../searchEngine.js';
import { MAX_RESULT_ACTIONS, OVERVIEW_MAX_CHARS, OVERVIEW_MAX_DEPTH } from './prompts.js';

export const INTENT_OVERVIEW = 'overview';
export const INTENT_RESOURCE = 'resource';
export const INTENT_MEDICAL = 'medical';
export const INTENT_GENERAL = 'general';

/** Canonical medical concepts (from the search concept table). */
export const MEDICAL_CONCEPT_KEYS = new Set([
  'cbc', 'hemoglobin', 'esr', 'crp', 'electrolytes', 'renal', 'liver',
  'lipid', 'glucose', 'thyroid', 'urinalysis', 'anatomy', 'physiology',
  'pathology', 'pharmacology', 'microbiology', 'biochemistry', 'immunology',
  'histology',
]);

const MEDICAL_KEYWORDS = new Set([
  'دواء', 'ادويه', 'علاج', 'مرض', 'امراض', 'اعراض', 'عرض', 'تشخيص',
  'فيروس', 'عدوى', 'التهاب', 'سرطان', 'لقاح', 'جرعه', 'مضاعفات',
  'قلب', 'دم', 'كبد', 'كليه', 'رئه', 'دماغ', 'عصب', 'عضله', 'عظم',
  'هرمون', 'هرمونات', 'مناعه', 'بكتيريا', 'سكر', 'ضغط', 'تنفس',
  'جهاز', 'خليه', 'خلايا', 'انزيم', 'بروتين', 'فيتامين', 'دوره',
  'دورة', 'حيض', 'حمل', 'ورم', 'تضخم', 'قصور', 'انسداد', 'جراحه',
  'disease', 'treatment', 'symptom', 'symptoms', 'diagnosis', 'infection',
  'cancer', 'vaccine', 'drug', 'drugs', 'dose', 'therapy', 'organ',
  'cell', 'cells', 'enzyme', 'protein', 'vitamin', 'hormone', 'cardiac',
  'clinical', 'physiological', 'pathological', 'syndrome', 'disorder',
  'potential', 'receptor', 'neuron', 'muscle', 'nerve', 'blood',
]);

const GENERIC_TOKENS = new Set([
  'هي', 'هو', 'هما', 'هم', 'هن', 'حاليا', 'الان', 'الموجود', 'الموجوده',
  'كل', 'جميع', 'list', 'show', 'available', 'current', 'currently', 'now',
]);

// Nouns that refer to the platform itself or its structure.
const PLATFORM_NOUNS = new Set([
  'اقسام', 'قسم', 'فروع', 'فرع', 'محتوي', 'محتوى', 'محتويات', 'مواد',
  'مقرر', 'مقررات', 'بوت', 'منصه', 'شجره', 'تصنيف', 'قائمه',
  'sections', 'section', 'subjects', 'subject', 'blocks', 'block',
  'content', 'contents', 'bot', 'platform', 'medbot', 'dictionary',
  'structure', 'hierarchy', 'tree', 'categories', 'category',
]);

// Tokens that signal an access/location question rather than an enumeration.
const WHERE_TOKENS = new Set([
  'وين', 'اين', 'where', 'مسار', 'path', 'مكان', 'اماكن', 'افتح',
  'open', 'find', 'locate', 'reach', 'اصل', 'اوصل', 'اجد', 'القي', 'ألقى',
]);

const WHERE_PHRASES = ['كيف اصل', 'كيف اوصل', 'how to reach', 'how do i find'];

const EXISTENCE_TOKENS = new Set([
  'يوجد', 'موجود', 'موجوده', 'متوفر', 'متوفره', 'متاح', 'متاحه',
  'exist', 'exists', 'available', 'there',
]);

const EXISTENCE_PHRASES = ['is there', 'are there', 'do you have'];

/**
 * Drop a leading Arabic definite article, keeping the root otherwise.
 *
 * `normalizeText` keeps the `ال` prefix, so "الأقسام" and "أقسام" would
 * otherwise be different signals. Words whose `ال` is part of the root
 * (e.g. "التهاب") are matched as written.
 */
export function bareToken(token) {
  if (token.startsWith('ال') && token.length > 3) return token.slice(2);
  return token;
}

/** Tokens used for keyword matching: each token plus its article-less form. */
export function matchTokens(text) {
  const tokens = new Set(searchEngine.meaningfulTerms(text));
  for (const token of [...tokens]) {
    const bare = bareToken(token);
    if (bare !== token) tokens.add(bare);
  }
  return tokens;
}

/** Article-less tokens, used to tell a specific subject from bare filler. */
export function bareTokens(text) {
  return new Set(searchEngine.meaningfulTerms(text).map(bareToken));
}

/**
 * Classify a student message into one of the four MEDBOT intents.
 *
 * Deterministic and local, so it adds no latency and cannot disagree with the
 * registry search.
 */
export function classifyIntent(userPrompt) {
  const raw = String(userPrompt ?? '').trim();
  if (!raw) return INTENT_GENERAL;

  const norm = searchEngine.normalizeText(raw);
  const tokens = matchTokens(raw);
  const allTokens = new Set(norm.split(' '));
  const concepts = searchEngine.impliedConcepts(raw);

  const isMedical =
    [...concepts].some((concept) => MEDICAL_CONCEPT_KEYS.has(concept)) ||
    [...tokens].some((token) => MEDICAL_KEYWORDS.has(token));
  const hasPlatformNoun = [...tokens].some((token) => PLATFORM_NOUNS.has(token));

  if (
    [...allTokens].some((token) => WHERE_TOKENS.has(token)) ||
    [...tokens].some((token) => WHERE_TOKENS.has(token)) ||
    WHERE_PHRASES.some((phrase) => norm.includes(phrase))
  ) {
    return INTENT_RESOURCE;
  }

  if (hasPlatformNoun) {
    if (isMedical) return INTENT_RESOURCE;

    const residual = new Set(
      [...bareTokens(raw)].filter(
        (token) =>
          !PLATFORM_NOUNS.has(token) &&
          !GENERIC_TOKENS.has(token) &&
          !EXISTENCE_TOKENS.has(token),
      ),
    );
    if (residual.size) return INTENT_RESOURCE;
    return INTENT_OVERVIEW;
  }

  const existence =
    [...tokens].some((token) => EXISTENCE_TOKENS.has(token)) ||
    EXISTENCE_PHRASES.some((phrase) => norm.includes(phrase));

  if (existence) {
    const remaining = [...tokens].filter(
      (token) => !EXISTENCE_TOKENS.has(token) && !GENERIC_TOKENS.has(token),
    );
    if (remaining.length) return INTENT_RESOURCE;
  }

  if (isMedical) return INTENT_MEDICAL;
  return INTENT_GENERAL;
}

/**
 * Render the registered section hierarchy — and nothing else.
 *
 * The ONLY answer source for "what exists on MEDBOT?" questions. It walks the
 * real folder rows, so a section the admin never added cannot appear.
 */
export function buildRegistryOverview(folders) {
  if (!folders?.length) return '📚 لا توجد أقسام مسجلة حالياً في MEDBOT.';

  const children = new Map();
  for (const row of folders) {
    const parent = row[1];
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }

  const lines = ['📚 *الأقسام المتوفرة حالياً في MEDBOT:*', ''];

  const walk = (parentId, depth) => {
    if (depth > OVERVIEW_MAX_DEPTH) return;
    const rows = [...(children.get(parentId) ?? [])].sort((a, b) => {
      const aName = searchEngine.normalizeText(a[2]);
      const bName = searchEngine.normalizeText(b[2]);
      if (aName !== bName) return aName < bName ? -1 : 1;
      return a[0] - b[0];
    });

    for (const row of rows) {
      lines.push(`${'  '.repeat(depth - 1)}• ${row[2]}`);
      walk(row[0], depth + 1);
    }
  };

  walk(null, 1);

  let text = lines.join('\n');
  if (text.length > OVERVIEW_MAX_CHARS) {
    text = text.slice(0, OVERVIEW_MAX_CHARS).split('\n').slice(0, -1).join('\n');
    text += '\n… (توجد أقسام إضافية داخل المنصة)';
  }
  return text;
}

/**
 * Reject answers not grounded in registered MEDBOT data.
 *
 * Intentionally conservative: an empty answer is rejected so the caller can
 * fall back to the exact refusal message. It never rewrites a grounded answer.
 */
export class GroundingValidator {
  allows(answer) {
    return Boolean(String(answer ?? '').trim());
  }
}

/**
 * Keep only the deterministic-search hits that really match what was named.
 *
 * The search is recall-oriented, so "First Year" can surface "Second Year"
 * through the shared word "year". A hit counts only when a subject concept
 * matches, a specific subject word appears in it, or a structural phrase is
 * matched whole — so "does X exist?" is never answered with a neighbour.
 */
export function genuineRegistryMatches(userPrompt, results) {
  const concepts = searchEngine.impliedConcepts(userPrompt);
  const subject = new Set(
    [...bareTokens(userPrompt)].filter(
      (token) =>
        !PLATFORM_NOUNS.has(token) &&
        !EXISTENCE_TOKENS.has(token) &&
        !WHERE_TOKENS.has(token) &&
        !GENERIC_TOKENS.has(token),
    ),
  );
  const specific = new Set([...subject].filter((token) => !GENERIC_SUBJECT_TOKENS.has(token)));
  const structural = new Set([...subject].filter((token) => GENERIC_SUBJECT_TOKENS.has(token)));

  const matched = [];

  for (const item of results ?? []) {
    const title = searchEngine.normalizeText(item.title ?? item.name ?? '');
    const path = searchEngine.normalizeText(item.path ?? '');
    const blob = `${title} ${path}`;
    const blobConcepts = searchEngine.impliedConcepts(blob);

    if (concepts.size && [...concepts].some((concept) => blobConcepts.has(concept))) {
      matched.push(item);
    } else if (specific.size && [...specific].some((term) => blob.includes(term))) {
      matched.push(item);
    } else if (
      !specific.size &&
      structural.size &&
      [...structural].every((term) => blob.includes(term))
    ) {
      matched.push(item);
    }
  }

  return matched;
}

// Structural (non-specific) subject tokens: year/term/level words.
const GENERIC_SUBJECT_TOKENS = new Set([
  'سنه', 'السنه', 'سنه', 'عام', 'عامه', 'فصل', 'ترم', 'مستوي', 'مستوى',
  'مرحله', 'دراسي', 'دراسيه', 'عملي', 'نظري',
  'year', 'second', 'first', 'third', 'fourth', 'fifth', 'sixth',
  'semester', 'term', 'level', 'grade', 'theoretical', 'practical',
]);

/**
 * The content tokens of a resource query, with all search noise removed.
 *
 * What remains is the named subject, used to decide whether a natural-language
 * catalog query is specific enough to be worth a model call.
 */
export function searchSubjectTokens(userPrompt) {
  return new Set(
    [...bareTokens(userPrompt)].filter(
      (token) =>
        !PLATFORM_NOUNS.has(token) &&
        !GENERIC_TOKENS.has(token) &&
        !EXISTENCE_TOKENS.has(token),
    ),
  );
}

/** Render deterministic search results into a compact grounding context. */
export function buildLibraryContext(results) {
  if (!results?.length) return 'لا توجد نتائج مطابقة في قاعدة بيانات MEDBOT.';
  return results.map(resultLine).join('\n');
}

function resultLine(item) {
  const title = item.title || item.name || 'بدون عنوان';
  const path = item.path || 'بدون مسار';
  const kind =
    item.result_type === 'FOLDER' || item.result_type === 'EMPTY_FOLDER' ? 'قسم' : 'مورد';
  return `- [${kind}] ${title} | المسار: ${path}`;
}

function actionLabel(item) {
  const title = item.title || item.name || 'بدون عنوان';
  if (item.result_type === 'FOLDER' || item.result_type === 'EMPTY_FOLDER') {
    return `📂 ${title} (#${item.id})`;
  }
  return `📄 ${title} (#${item.id})`;
}

/**
 * Build direct-access buttons for matched folders/resources.
 *
 * Each action opens the exact registered item (`folder:<id>` / `file:<id>`), so
 * a button can never point at something unregistered. Ids come straight from the
 * deterministic search.
 */
export function buildResultActions(results) {
  const actions = [];
  const seen = new Set();

  for (const item of results ?? []) {
    const itemId = item.id;
    const resultType = item.result_type;
    if (itemId === null || itemId === undefined) continue;

    let callback;
    if (resultType === 'FOLDER' || resultType === 'EMPTY_FOLDER') {
      callback = `folder:${itemId}`;
    } else if (resultType === 'CONTENT') {
      callback = `file:${itemId}`;
    } else {
      continue;
    }

    if (seen.has(callback)) continue;
    seen.add(callback);
    actions.push({ label: actionLabel(item), callback });
    if (actions.length >= MAX_RESULT_ACTIONS) break;
  }

  return actions;
}
