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

// Whole-word clinical/diagnostic vocabulary. Deliberately excludes words that
// are ambiguous outside medicine ("organ", "cell", "potential", "blood", …):
// those are covered by the stem rules or the co-occurrence rules below, which
// keeps "organs of government" or "cell phone" out of the medical path.
const MEDICAL_KEYWORDS = new Set([
  'دواء', 'ادويه', 'علاج', 'مرض', 'امراض', 'اعراض', 'عرض', 'تشخيص',
  'فيروس', 'عدوى', 'التهاب', 'سرطان', 'لقاح', 'جرعه', 'مضاعفات',
  'قلب', 'دم', 'كبد', 'كليه', 'رئه', 'دماغ', 'عصب', 'عضله', 'عظم',
  'هرمون', 'هرمونات', 'مناعه', 'بكتيريا', 'سكر', 'ضغط', 'تنفس',
  'جهاز', 'خليه', 'خلايا', 'انزيم', 'بروتين', 'فيتامين', 'دوره',
  'دورة', 'حيض', 'حمل', 'ورم', 'تضخم', 'قصور', 'انسداد', 'جراحه',
  'fever', 'sore', 'throat', 'cough', 'pain', 'rash', 'nausea', 'vomiting',
  'disease', 'treatment', 'symptom', 'symptoms', 'diagnosis', 'infection',
  'cancer', 'vaccine', 'drug', 'drugs', 'dose', 'therapy',
  'clinical', 'physiological', 'pathological', 'syndrome', 'disorder',
  'receptor', 'neuron', 'muscle', 'nerve',
  'heart', 'lung', 'lungs', 'kidney', 'kidneys', 'liver', 'brain', 'bone',
  'skin', 'stomach', 'intestine', 'pancreas', 'spleen', 'bladder', 'artery',
  'vein', 'arteries', 'veins', 'embryo', 'fetus', 'placenta',
  'urine', 'urea', 'creatinine', 'bilirubin', 'sodium', 'potassium', 'calcium',
  'albumin', 'electrolyte', 'electrolytes', 'thyroid', 'hormone', 'hormones',
  'glucose', 'cholesterol', 'triglycerides', 'hemoglobin', 'haemoglobin',
  'cbc', 'hb', 'hgb', 'esr', 'crp', 'tsh', 'bun', 'gfr', 'ldl', 'hdl',
  'hba1c', 'fbg', 'alt', 'ast', 'lft', 'lfts', 'ecg', 'ekg', 'wbc', 'rbc',
]);

// Unambiguous multi-word collocations whose individual tokens are ambiguous
// outside medicine ("action potential", "blood pressure", "stem cell"). Matched
// against the normalized text, so a phrase counts even when no single token does.
const MEDICAL_PHRASES = [
  'action potential', 'resting membrane potential', 'membrane potential',
  'blood pressure', 'blood vessel', 'blood vessels', 'blood flow',
  'blood cell', 'blood cells', 'red blood cell', 'white blood cell',
  'cell membrane', 'cell cycle', 'cell division', 'stem cell', 'stem cells',
  'heart rate', 'cardiac cycle', 'cardiac output', 'glomerular filtration',
  'myocardial infarction', 'diabetes mellitus', 'nervous system',
  'immune system', 'skeletal muscle', 'smooth muscle', 'beta oxidation',
  'oxidative phosphorylation', 'krebs cycle', 'citric acid cycle',
  'electron transport chain', 'sodium potassium pump', 'gene expression',
  'dna replication', 'protein synthesis', 'nerve impulse', 'spinal cord',
  'endocrine system', 'digestive system', 'respiratory system',
];

// Latin/Greek morphology. A large share of medical English is built from a
// closed set of stems and suffixes ("osteosarcoma", "hypertension",
// "myocardial", "nephritis", "β-oxidation"), so matching these is far broader
// than a word list while staying precise. Stem prefixes match at a word start;
// suffixes match at a word end.
const MEDICAL_STEM_PREFIXES = [
  'cardi', 'myocard', 'myo', 'neuro', 'nephro', 'hepato', 'hepat', 'gastro',
  'enter', 'derma', 'dermato', 'osteo', 'arthro', 'arthr', 'myel', 'haemo',
  'hemo', 'hemato', 'lymph', 'cyt', 'cyto', 'histo', 'patho', 'physio',
  'pharma', 'microbio', 'immuno', 'onc', 'carcin', 'sarcom', 'adeno', 'lip',
  'glyc', 'gluc', 'proteo', 'enzym', 'thromb', 'vascul', 'angio', 'bronch',
  'pulmon', 'ren', 'ureter', 'cyst', 'ovari', 'uter', 'endocrin', 'thyroid',
  'adren', 'insulin', 'diabet', 'hyper', 'hypo', 'tachy', 'brady', 'anemi',
  'ischem', 'infarct', 'necro', 'septic', 'tox', 'antibio', 'analges',
  'anesth', 'epidemi', 'etiol', 'prognos', 'metabol', 'respirat', 'circulat',
  'skelet', 'muscul', 'neur', 'gland', 'hormon', 'vitamin', 'alveol',
  'glomerul', 'nephron', 'mitochond', 'ribosom', 'chromosom', 'genom',
  'allele', 'antigen', 'antibod', 'vaccin', 'bacteri', 'viral', 'fungal',
  'parasit', 'neoplas', 'metasta', 'biopsy', 'serolog', 'hematolog',
];

const MEDICAL_SUFFIXES = [
  'itis', 'osis', 'emia', 'aemia', 'uria', 'pathy', 'pathy', 'ology',
  'ologist', 'oma', 'oma', 'genic', 'trophic', 'trophy', 'plasia', 'plasm',
  'cyte', 'philia', 'penia', 'megaly', 'ectomy', 'ostomy', 'otomy', 'oscopy',
  'rrhea', 'rrheal', 'rrhagia', 'stenosis', 'sclerosis', 'dysplasia',
  'algia', 'dynia', 'toxic', 'toxin', 'edema', 'emesis', 'stasis', 'lysis',
  'genesis', 'genous', 'gram', 'graphy', 'meter', 'metry', 'scope', 'therapy',
  'trophic', 'static', 'kinetic',
];

// Words whose Latin form is genuinely ambiguous with non-medical usage; they
// only count as medical alongside another medical signal.
const AMBIGUOUS_MEDICAL_WORDS = new Set([
  'cell', 'cells', 'organ', 'organs', 'potential', 'blood', 'tissue', 'tissues',
  'culture', 'cultures', 'resistance', 'stress', 'dose', 'doses', 'shock',
  'transplant', 'screening', 'lesion', 'lesions', 'graft', 'culture',
]);

// Educational/explanatory framing that turns a bare ambiguous term into a
// study question ("explain cell division", "ما هو الجهاز العصبي").
const MEDICAL_STUDY_VERBS = new Set([
  'explain', 'describe', 'define', 'definition', 'mechanism', 'pathogenesis',
  'pathophysiology', 'physiology', 'anatomy', 'histology', 'etiology',
  'aetiology', 'symptoms', 'signs', 'treatment', 'management', 'diagnosis',
  'function', 'functions', 'role', 'structure', 'classification', 'types',
  'causes', 'complications', 'prognosis', 'prevention', 'difference',
  'compare', 'summarize', 'summary', 'overview', 'pathway', 'cycle',
  'process', 'effect', 'effects', 'regulation', 'control',
  'اشرح', 'فسر', 'عرّف', 'عرف', 'تعريف', 'وظيفه', 'وظائف', 'تركيب',
  'مكونات', 'انواع', 'اسباب', 'اعراض', 'علامات', 'علاج', 'تشخيص',
  'مضاعفات', 'وقايه', 'فرق', 'مقارنه', 'ملخص', 'مسار', 'دوره', 'دورة',
  'عمليه', 'تاثير', 'تنظيم', 'تصنيف', 'اليه', 'آليه', 'مراحل',
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

/** Latin/Greek morphology match for one English token. */
function hasMedicalMorphology(token) {
  if (!token || token.length < 5 || !/^[a-z]+$/.test(token)) return false;
  if (MEDICAL_SUFFIXES.some((suffix) => token.endsWith(suffix))) return true;
  return MEDICAL_STEM_PREFIXES.some(
    (prefix) => token.startsWith(prefix) && token.length >= prefix.length + 2,
  );
}

/**
 * Strong medical signal: a canonical concept, a whole clinical word, or
 * unambiguous Latin/Greek morphology.
 */
function hasStrongMedicalSignal(tokens, normalizedText) {
  if (normalizedText && MEDICAL_PHRASES.some((phrase) => normalizedText.includes(phrase))) {
    return true;
  }
  for (const token of tokens) {
    if (MEDICAL_KEYWORDS.has(token)) return true;
    if (hasMedicalMorphology(token)) return true;
  }
  return false;
}

// Surface tokens the concept table shares with everyday language ("blood work"
// -> cbc, "blood sugar" -> glucose). The search table is recall-oriented, so
// these are stripped before the concept lookup: "how does a car engine work"
// must not become medical because of the bare token "work".
const NON_SPECIFIC_CONCEPT_TOKENS = new Set([
  'work', 'works', 'test', 'tests', 'count', 'counts', 'blood', 'sugar',
  'alt', 'ast', 'number', 'numbers', 'level', 'levels', 'result', 'results',
  'report', 'reports', 'panel', 'value', 'values', 'high', 'low', 'normal',
]);

/**
 * True when the query resolves to a canonical medical concept through a token
 * that is specific enough to mean medicine.
 */
function hasMedicalConcept(normalizedText) {
  const specific = normalizedText
    .split(' ')
    .filter((token) => token && !NON_SPECIFIC_CONCEPT_TOKENS.has(token))
    .join(' ');
  if (!specific) return false;
  return [...searchEngine.impliedConcepts(specific)].some((concept) =>
    MEDICAL_CONCEPT_KEYS.has(concept),
  );
}

/**
 * Whether a message is a medical/scientific question.
 *
 * Combines independent signals so classification is robust rather than a word
 * list: canonical concepts, unambiguous clinical vocabulary, Latin/Greek
 * morphology, and multi-word collocations — plus a guarded rule that lets an
 * ambiguous term count only with an educational framing word.
 *
 * `normalizedText` must already have Greek letters spelled out.
 */
export function isMedicalText(rawText, normalizedText, tokens) {
  if (hasStrongMedicalSignal(tokens, normalizedText)) return true;
  if (hasMedicalConcept(normalizedText)) return true;

  // An ambiguous term (cell/organ/potential/blood/…) needs a study-framing word
  // to count, so "explain cell division" is medical but "cell phone plans" is not.
  return hasAmbiguousMedicalSignal(tokens) && hasStudyFraming(matchTokens(rawText));
}

/**
 * Weak signal: an ambiguous term (cell/organ/potential/blood/…). Only counts
 * alongside another medical signal or an educational framing word, so
 * "cell phone plans" and "organs of government" stay general.
 */
function hasAmbiguousMedicalSignal(tokens) {
  return [...tokens].some((token) => AMBIGUOUS_MEDICAL_WORDS.has(token));
}

function hasStudyFraming(tokens) {
  return [...tokens].some((token) => MEDICAL_STUDY_VERBS.has(token));
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

  // Spell out Greek letters so "β-oxidation" is read the same as "beta oxidation".
  const norm = searchEngine.normalizeText(raw).replace(/β/g, 'beta');
  const tokens = matchTokens(raw);
  const allTokens = new Set(norm.split(' '));

  const isMedical = isMedicalText(raw, norm, tokens);
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
