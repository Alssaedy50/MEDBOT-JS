/**
 * MEDBOT deterministic, intent-aware resource search.
 *
 * The database is the single source of truth: this module only ever ranks rows
 * that are actually registered (folders, subjects/blocks, resource titles). It
 * never fabricates a resource, folder, or link.
 *
 * Matching is semantic-ish rather than exact-string:
 *   query -> normalize -> tokenize -> expand abbreviations/synonyms into
 *   canonical concepts -> score each registered record by (a) direct text
 *   match, (b) metadata match and (c) concept overlap.
 *
 * So "CBC" reaches "Complete Blood Count", "Blood Count", "Hematology" and
 * "Blood Tests" without any of those titles containing the literal token, while
 * an unrelated query still returns nothing.
 */

import * as db from './db/index.js';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize Arabic/English search text without destroying the original
 * database values.
 *
 * Arabic: remove tashkeel, normalize alef variants / ya / ta marbuta.
 * English: lowercase, NFKC normalize, collapse whitespace.
 */
export function normalizeText(value) {
  if (!value) return '';

  let text = String(value).normalize('NFKC').trim().toLowerCase();

  // Remove Arabic tashkeel.
  text = text.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');

  // Arabic normalization.
  text = text.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');

  // Separate punctuation (including the Arabic question mark U+061F) from words
  // so a trailing "؟" never glues to the token and hides it from the matchers.
  text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');

  // Collapse whitespace.
  text = text.replace(/\s+/g, ' ');

  return text.trim();
}

// ---------------------------------------------------------------------------
// Intent model: canonical concepts and their surface forms
// ---------------------------------------------------------------------------
// Each entry maps a canonical concept to the surface forms (English and Arabic)
// that should be treated as the same intent. Surface forms are normalized at
// import time and indexed both as whole phrases and as individual tokens, so
// "complete blood count", "CBC", "blood count" and "تحليل الدم" all resolve to
// the same concept.

const CONCEPT_SURFACES = {
  cbc: [
    'cbc', 'complete blood count', 'blood count', 'full blood count',
    'hemogram', 'hematology', 'haematology', 'hematology blood test',
    'blood test', 'blood tests', 'blood work',
    'تحليل الدم', 'تحاليل الدم', 'صورة الدم', 'فحص الدم', 'امراض الدم',
  ],
  hemoglobin: ['hb', 'hgb', 'hemoglobin', 'haemoglobin', 'هيموغلوبين', 'خضاب'],
  esr: [
    'esr', 'erythrocyte sedimentation rate', 'sedimentation rate',
    'سرعة ترسيب الدم', 'ترسيب الدم',
  ],
  crp: ['crp', 'c-reactive protein', 'c reactive protein', 'بروتين سي التفاعلي'],
  electrolytes: [
    'electrolytes', 'electrolyte', 'sodium', 'potassium',
    'املاح الدم', 'الكهارل', 'شوارد الدم',
  ],
  renal: [
    'renal', 'kidney', 'kidneys', 'renal function', 'creatinine', 'urea',
    'bun', 'gfr', 'الكلى', 'كلى', 'وظائف الكلى', 'كرياتينين',
  ],
  liver: [
    'liver', 'hepatic', 'liver function', 'lft', 'lfts', 'alt', 'ast',
    'bilirubin', 'الكبد', 'وظائف الكبد', 'بيليروبين',
  ],
  lipid: [
    'lipid', 'lipids', 'lipid profile', 'cholesterol', 'ldl', 'hdl',
    'triglycerides', 'دهون', 'الكوليسترول', 'دهنيات الدم',
  ],
  glucose: ['glucose', 'blood sugar', 'fbg', 'hba1c', 'سكر', 'سكري', 'سكر الدم', 'الجلوكوز'],
  thyroid: ['thyroid', 'tsh', 't3', 't4', 'thyroid function', 'الغده الدرقيه', 'درقيه'],
  urinalysis: ['urinalysis', 'urine analysis', 'urine test', 'تحليل البول', 'بول'],
  anatomy: ['anatomy', 'تشريح', 'علم التشريح', 'تشريحي', 'انتومي', 'اناتومي'],
  physiology: [
    'physiology', 'فسيولوجيا', 'فسيولوجي', 'فسيولوجى', 'علم وظائف الاعضاء',
    'وظائف الاعضاء', 'فسيو', 'فيسيولوجي', 'فزيولوجي',
  ],
  pathology: [
    'pathology', 'علم الامراض', 'باثولوجي', 'باثولوجيا', 'باثو', 'باتولوجي',
    'باتولوجى',
  ],
  pharmacology: [
    'pharmacology', 'pharma', 'drugs', 'drug', 'فارماكولوجي', 'فارماكولوجيا',
    'علم الادويه', 'الادويه', 'فارما', 'فارم', 'فارمسي',
  ],
  microbiology: [
    'microbiology', 'micro', 'بكتيريا', 'ميكروبيولوجي', 'علم الاحياء الدقيقه',
    'ميكرو', 'مكرو', 'ميكروب', 'ميكروبات',
  ],
  biochemistry: [
    'biochemistry', 'biochem', 'الكيمياء الحيويه', 'كيمياء حيويه', 'بايوكيم',
    'بايوكيمستري', 'بيوكيم',
  ],
  immunology: [
    'immunology', 'immune', 'immuno', 'مناعه', 'علم المناعه', 'ايميونولوجي',
    'ايمونولوجي',
  ],
  histology: [
    'histology', 'histo', 'هستو', 'هستولوجي', 'هستولوجيا', 'علم الانسجه',
    'الانسجه',
  ],
  mcq: [
    'mcq', 'mcqs', 'multiple choice', 'questions', 'question', 'اسئله',
    'امتحان', 'امتحانات', 'كويز',
  ],
  summary: ['summary', 'summaries', 'note', 'notes', 'ملخص', 'ملخصات'],
  lecture: ['lecture', 'lectures', 'محاضره', 'محاضرات', 'شرح'],
  book: ['book', 'books', 'textbook', 'كتاب', 'كتب', 'مرجع'],
  video: ['video', 'videos', 'فيديو', 'مقاطع'],
  audio: ['audio', 'record', 'recording', 'صوتيات', 'تسجيل'],
  block: ['block', 'blocks', 'بلوك', 'بلوكات', 'موديول', 'module'],
  subject: ['subject', 'course', 'ماده', 'مواد', 'مقرر'],
};

// Query words that carry no topical intent.
const STOPWORDS = new Set([
  'where', 'what', 'which', 'find', 'show', 'give', 'get', 'need', 'want',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'do', 'does', 'can', 'i', 'me', 'my', 'please', 'about', 'content',
  'contents', 'material', 'materials',
  'اين', 'وين', 'ما', 'ماذا', 'هل', 'عن', 'في', 'على', 'من', 'الى', 'اريد',
  'ابحث', 'اعطني', 'هات', 'محتوى', 'محتوي', 'مواد', 'عندي', 'عند', 'كيف',
  'اماكن', 'مكان',
]);

const WORD_TOKEN_RE = /[a-z0-9\u0600-\u06FF]+/g;

const SURFACE_INDEX = new Map();
const TOKEN_INDEX = new Map();

function buildIndexes() {
  const phraseMap = new Map();
  const tokenMap = new Map();

  for (const [concept, surfaces] of Object.entries(CONCEPT_SURFACES)) {
    for (const surface of surfaces) {
      const norm = normalizeText(surface);
      if (!norm) continue;

      if (!phraseMap.has(norm)) phraseMap.set(norm, []);
      phraseMap.get(norm).push(concept);

      for (const token of norm.match(WORD_TOKEN_RE) ?? []) {
        if (STOPWORDS.has(token) || token.length < 2) continue;
        if (!tokenMap.has(token)) tokenMap.set(token, []);
        tokenMap.get(token).push(concept);
      }
    }
  }

  for (const [mapping, store] of [
    [phraseMap, SURFACE_INDEX],
    [tokenMap, TOKEN_INDEX],
  ]) {
    for (const [key, values] of mapping) {
      // Preserve a deterministic order, drop duplicates.
      store.set(key, [...new Set(values)]);
    }
  }
}

buildIndexes();

/**
 * Drop a leading Arabic definite article, keeping the root otherwise.
 *
 * `ال` is part of some roots (e.g. "التهاب"), so this is only used as an
 * additional lookup candidate, never as a replacement for the token itself.
 */
function stripArticle(token) {
  if (token.startsWith('ال') && token.length > 3) return token.slice(2);
  return token;
}

/** Return canonical concepts implied by a piece of text. */
function lookupConcepts(text) {
  const norm = normalizeText(text);
  if (!norm) return new Set();

  const concepts = new Set();

  const direct = SURFACE_INDEX.get(norm);
  if (direct) for (const concept of direct) concepts.add(concept);

  for (const token of norm.match(WORD_TOKEN_RE) ?? []) {
    if (STOPWORDS.has(token) || token.length < 2) continue;

    // Only whole-token matches are indexed, which avoids substring false
    // positives (e.g. "k" inside "kidney"). A leading Arabic definite article
    // is also tried, so "الفسيولوجيا" reaches the indexed surface "فسيولوجيا".
    for (const candidate of [token, stripArticle(token)]) {
      const tokenConcepts = TOKEN_INDEX.get(candidate);
      if (tokenConcepts) for (const concept of tokenConcepts) concepts.add(concept);
    }
  }

  return concepts;
}

/**
 * Public wrapper over the synonym/abbreviation concept lookup.
 *
 * Lets the AI layer classify intent (medical vs platform) using the same
 * deterministic concept table the search uses, so the two never disagree.
 */
export function impliedConcepts(text) {
  return lookupConcepts(text);
}

/**
 * Public wrapper over the intent-carrying token extraction.
 *
 * Returns the normalized tokens that actually carry topical meaning, so the AI
 * layer can tell whether a navigation question names a specific subject.
 */
export function meaningfulTerms(text) {
  return queryTerms(normalizeText(text));
}

function queryTerms(queryNorm) {
  return (queryNorm.match(WORD_TOKEN_RE) ?? []).filter(
    (token) => token.length >= 2 && !STOPWORDS.has(token),
  );
}

// ---------------------------------------------------------------------------
// Record scoring
// ---------------------------------------------------------------------------

// Rank buckets, lower is better.
const RANK_EXACT = 0;
const RANK_PREFIX = 1;
const RANK_TEXT = 2;
const RANK_METADATA = 3;
const RANK_CONCEPT = 4;

/**
 * Return a rank for one record, or null when it is unrelated.
 *
 * `primaryText` is the searchable name/title; `secondaryText` holds
 * description/keywords/ancestor-path text; `kindTokens` are the record's own
 * type/node keywords.
 */
function scoreRecord(
  queryNorm,
  queryTermsList,
  queryConcepts,
  primaryText,
  secondaryText,
  kindTokens,
) {
  const primaryNorm = normalizeText(primaryText);
  const secondaryNorm = normalizeText(secondaryText);

  // 1. Direct textual match on the primary name/title.
  if (primaryNorm && primaryNorm === queryNorm) return RANK_EXACT;
  if (primaryNorm && queryNorm && primaryNorm.startsWith(queryNorm)) return RANK_PREFIX;
  if (primaryNorm && queryNorm && primaryNorm.includes(queryNorm)) return RANK_TEXT;

  // 2. All meaningful query tokens present in the primary title.
  if (queryTermsList.length && queryTermsList.every((term) => primaryNorm.includes(term))) {
    return RANK_PREFIX;
  }

  // 3. Metadata: description/keywords/path.
  if (queryNorm && secondaryNorm.includes(queryNorm)) return RANK_METADATA;
  if (queryTermsList.some((term) => secondaryNorm.includes(term))) return RANK_METADATA;

  // 4. Intent/concept overlap (abbreviations & synonyms).
  const recordText = `${primaryNorm} ${secondaryNorm}`;
  const recordConcepts = lookupConcepts(recordText);

  if (queryConcepts.size) {
    for (const concept of queryConcepts) {
      if (recordConcepts.has(concept) || kindTokens.has(concept)) return RANK_CONCEPT;
    }
  }

  // 5. Partial-token overlap: at least one reasonably specific token appears as
  //    a whole word in the record text. Keeps recall sane without matching
  //    unrelated rows.
  if (queryTermsList.length) {
    const recordWords = new Set(recordText.match(WORD_TOKEN_RE) ?? []);
    if (queryTermsList.some((term) => recordWords.has(term))) return RANK_CONCEPT;
  }

  return null;
}

/**
 * Intent-aware search over registered folders and resources.
 *
 * Search scope: folder/subject/block names, resource titles, registered
 * descriptions/keywords, and abbreviation/synonym concepts.
 *
 * Ranking: exact -> prefix -> text -> metadata -> concept.
 * Result types: FOLDER, EMPTY_FOLDER, CONTENT.
 */
export function searchLibrary(keyword, limit = 15) {
  const query = normalizeText(keyword);
  if (!query) return [];

  const queryTermsList = queryTerms(query);
  const queryConcepts = lookupConcepts(keyword);
  if (!queryTermsList.length && !queryConcepts.size) return [];

  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 15, 50));

  return db.withDb((conn) => {
    const folders = conn
      .prepare(
        'SELECT id, parent_id, name, node_type, description, keywords FROM folders ORDER BY id ASC',
      )
      .all();
    const contents = conn
      .prepare(
        'SELECT id, folder_id, title, file_type, description, keywords FROM content ORDER BY id DESC',
      )
      .all();

    // Folder content counts, computed once.
    const contentCounts = new Map();
    for (const row of contents) {
      contentCounts.set(row[1], (contentCounts.get(row[1]) ?? 0) + 1);
    }

    // Ancestor path text per folder, resolved once (no N+1 queries).
    const folderById = new Map(folders.map((row) => [row[0], row]));
    const pathCache = new Map();

    const folderPath = (folderId) => {
      if (pathCache.has(folderId)) return pathCache.get(folderId);

      const chain = [];
      const visited = new Set();
      let current = folderId;

      while (current && !visited.has(current)) {
        visited.add(current);
        const row = folderById.get(current);
        if (!row) break;
        chain.push(row[2]);
        current = row[1];
      }

      chain.push('الرئيسية 🏠');
      chain.reverse();
      const path = chain.join(' ⬅️ ');
      pathCache.set(folderId, path);
      return path;
    };

    const results = [];

    // ---- Folders -----------------------------------------------------
    for (const [folderId, , name, nodeType, description, keywords] of folders) {
      const ancestorText = folderPath(folderId);
      const secondary = [description, keywords, ancestorText].filter(Boolean).join(' ');
      const kindTokens = new Set(nodeType ? [nodeType] : []);

      const rank = scoreRecord(
        query,
        queryTermsList,
        queryConcepts,
        name,
        secondary,
        kindTokens,
      );
      if (rank === null) continue;

      const contentCount = contentCounts.get(folderId) ?? 0;

      results.push({
        type: 'FOLDER',
        result_type: contentCount ? 'FOLDER' : 'EMPTY_FOLDER',
        id: folderId,
        folder_id: folderId,
        title: name,
        name,
        path: ancestorText,
        content_count: contentCount,
        node_type: nodeType,
        rank,
        match_field: 'folder_name',
      });
    }

    // ---- Content -----------------------------------------------------
    for (const [contentId, folderId, title, fileType, description, keywords] of contents) {
      const folderRow = folderById.get(folderId);
      const folderName = folderRow ? folderRow[2] : '';

      const secondary = [description, keywords, folderName, folderPath(folderId)]
        .filter(Boolean)
        .join(' ');
      const kindTokens = new Set(fileType ? [fileType] : []);

      const rank = scoreRecord(
        query,
        queryTermsList,
        queryConcepts,
        title,
        secondary,
        kindTokens,
      );
      if (rank === null) continue;

      results.push({
        type: 'CONTENT',
        result_type: 'CONTENT',
        id: contentId,
        content_id: contentId,
        folder_id: folderId,
        title,
        name: title,
        path: folderPath(folderId),
        content_count: contentCounts.get(folderId) ?? 0,
        file_type: fileType,
        rank,
        match_field: 'content_title',
      });
    }

    // Deterministic ordering: rank -> folders before content -> title -> id.
    results.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const aIsFolder = a.result_type === 'FOLDER' || a.result_type === 'EMPTY_FOLDER';
      const bIsFolder = b.result_type === 'FOLDER' || b.result_type === 'EMPTY_FOLDER';
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      const aTitle = normalizeText(a.title);
      const bTitle = normalizeText(b.title);
      if (aTitle !== bTitle) return aTitle < bTitle ? -1 : 1;
      return a.id - b.id;
    });

    return results.slice(0, safeLimit);
  });
}

/** Stable API for Telegram/AI layers. */
export function searchLibrarySummary(keyword, limit = 15) {
  const results = searchLibrary(keyword, limit);
  return {
    query: keyword,
    normalized_query: normalizeText(keyword),
    result_count: results.length,
    results,
  };
}
