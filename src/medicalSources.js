/**
 * Verified medical source retrieval (NCBI PubMed).
 *
 * MEDBOT never trusts the model to produce a citation: sources are fetched
 * first and handed to the model as the ONLY permitted basis for a source claim.
 * The application — not the model — owns the final citation line.
 *
 * Retrieval is best-effort: a PubMed outage returns an empty list and the
 * assistant answers cautiously instead of inventing a reference.
 */

import { safeTruncate } from './truncate.js';

const NCBI_ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const NCBI_EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const SOURCE_TIMEOUT_MS = 12000;

// Identical normalized queries repeat across students; caching the records is
// academically safe (the result is a fixed PubMed lookup, not advice).
const PUBMED_CACHE_TTL_MS = 15 * 60 * 1000;
const PUBMED_CACHE_MAX = 200;
const pubmedCache = new Map();

/** Test hook: drop the PubMed result cache. */
export function resetPubmedCache() {
  pubmedCache.clear();
}

function pubmedCacheGet(key) {
  const entry = pubmedCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > PUBMED_CACHE_TTL_MS) {
    pubmedCache.delete(key);
    return null;
  }
  return entry.records;
}

function pubmedCacheSet(key, records) {
  if (pubmedCache.size >= PUBMED_CACHE_MAX) {
    const oldest = pubmedCache.keys().next().value;
    pubmedCache.delete(oldest);
  }
  pubmedCache.set(key, { at: Date.now(), records });
}

const STOP_WORDS = new Set([
  'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'of', 'to', 'in',
  'on', 'for', 'and', 'or', 'how', 'why', 'when', 'where', 'which', 'who',
  'does', 'do', 'can', 'could', 'would', 'should', 'explain', 'define',
  'definition', 'please', 'tell', 'me', 'about',
]);

/** Unescape HTML entities and strip tags/whitespace from an XML fragment. */
function cleanText(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn a natural-language question into a focused PubMed query.
 *
 * "What is the cardiac cycle?" becomes `"cardiac" AND "cycle"`, so the search
 * targets the topic rather than the question grammar.
 */
export function buildFocusedQuery(query) {
  const normalized = String(query ?? '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const terms = normalized
    .split(' ')
    .filter((part) => part.length >= 3 && !STOP_WORDS.has(part.toLowerCase()));

  if (terms.length) {
    return terms.slice(0, 8).map((term) => `"${term}"`).join(' AND ');
  }
  return normalized;
}

/**
 * Fetch up to `limit` real PubMed records.
 *
 * Returns `[{pmid, title, abstract, url}]`. Never throws: a network/parse
 * failure yields an empty list.
 */
export async function searchPubmed(query, limit = 3) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return [];

  const focused = buildFocusedQuery(trimmed);
  const cacheKey = `${limit}|${focused}`;
  const cached = pubmedCacheGet(cacheKey);
  if (cached) return cached;

  let xml;
  try {

    const searchResponse = await fetch(
      `${NCBI_ESEARCH}?${new URLSearchParams({
        db: 'pubmed',
        term: focused,
        retmode: 'json',
        retmax: String(Math.max(limit * 3, 9)),
        sort: 'relevance',
      })}`,
      { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) },
    );
    if (!searchResponse.ok) return [];

    const data = await searchResponse.json();
    const ids = data?.esearchresult?.idlist ?? [];
    if (!ids.length) return [];

    const fetchResponse = await fetch(
      `${NCBI_EFETCH}?${new URLSearchParams({
        db: 'pubmed',
        id: ids.join(','),
        retmode: 'xml',
      })}`,
      { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) },
    );
    if (!fetchResponse.ok) return [];

    xml = await fetchResponse.text();
  } catch {
    return [];
  }

  const records = [];
  const articleRe = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;

  for (const match of xml.matchAll(articleRe)) {
    const article = match[1];

    const pmidMatch = article.match(/<PMID[^>]*>([\s\S]*?)<\/PMID>/);
    const titleMatch = article.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    if (!pmidMatch || !titleMatch) continue;

    const abstractParts = [...article.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)]
      .map((part) => part[1]);

    const pmid = cleanText(pmidMatch[1]);
    const title = cleanText(titleMatch[1]);
    const abstract = cleanText(abstractParts.join(' '));

    records.push({
      pmid,
      title,
      abstract,
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '',
    });
  }

  const result = records.slice(0, limit);
  if (result.length) pubmedCacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch records and keep only the ones genuinely about the asked topic.
 *
 * PubMed's relevance ranking is recall-oriented: a β-oxidation query can return
 * papers on food-lipid oxidation or drug oxidation, which are real records but
 * not answers to the student's question. Attaching one would put a misleading
 * citation under an otherwise correct answer, so this is the retrieval entry
 * point the medical path uses: it fetches broadly, then applies the topic filter
 * and returns only survivors.
 */
export async function searchRelevantPubmed(query, limit = 3) {
  const fetched = await searchPubmed(query, Math.max(limit, 6));
  return filterRelevantRecords(query, fetched).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Topic relevance filter
// ---------------------------------------------------------------------------
// PubMed is SUPPORTING EVIDENCE, not the answer. A record is attached only when
// it is demonstrably about the student's topic. Generic token overlap is
// deliberately not enough: "oxidation" alone would admit food- and drug-
// oxidation papers for a β-oxidation question, which is exactly the failure this
// filter exists to prevent.

const RELEVANCE_STOP_WORDS = new Set([
  'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'of', 'to', 'in',
  'on', 'for', 'and', 'or', 'how', 'why', 'when', 'where', 'which', 'who',
  'does', 'do', 'can', 'could', 'would', 'should', 'explain', 'define',
  'definition', 'please', 'tell', 'me', 'about', 'describe', 'mechanism',
  'pathophysiology', 'physiology', 'compare', 'difference', 'differences',
  'treatment', 'diagnosis', 'clinical', 'function', 'structure',
]);

/** ASCII-strip + lowercase + split into content words (length >= 3). */
export function relevanceTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/β/g, 'beta')
    // Hyphens join a term rather than separating two ("β-oxidation" is one
    // concept, not "beta" + "oxidation"); the split must not lose that.
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length >= 3 && !RELEVANCE_STOP_WORDS.has(token));
}

/** Fold simple English plurals so "filaments" matches "filament". */
function foldToken(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** The query's content tokens, plural-folded and de-duplicated. */
export function topicTokens(query) {
  return new Set(relevanceTokens(query).map(foldToken));
}

/**
 * Whether a record is genuinely about the query's topic.
 *
 * Scored from the title and abstract. A record survives when it covers enough
 * distinct topic tokens, or — for a single-term topic — when that distinctive
 * term appears in the title.
 *
 * The single-term exception is deliberately narrow. "β-oxidation" is two terms
 * (`beta`, `oxidation`), and a food- or drug-oxidation paper covers only the
 * generic half of it; letting a long word in the title stand in for the whole
 * topic is exactly how an unrelated paper gets attached. So a multi-term topic
 * must reach the coverage threshold — "mitochondrial beta oxidation" needs the
 * `beta` qualifier, not just "oxidation".
 */
export function isRecordRelevant(query, record) {
  const topic = topicTokens(query);
  if (!topic.size) return false;

  const titleText = String(record?.title ?? '').toLowerCase().replace(/β/g, 'beta');
  const abstractText = String(record?.abstract ?? '').toLowerCase().replace(/β/g, 'beta');

  const titleHits = new Set();
  const anyHits = new Set();
  for (const token of topic) {
    const folded = foldToken(token);
    if (titleText.includes(token) || titleText.includes(folded)) titleHits.add(token);
    if (
      abstractText.includes(token) ||
      abstractText.includes(folded) ||
      titleHits.has(token)
    ) {
      anyHits.add(token);
    }
  }

  const coverage = anyHits.size / topic.size;
  if (coverage >= 0.6) return true;

  // A single distinctive multi-syllable term in the title is on its own
  // convincing: "Sarcomere structure and contraction" is about sarcomeres even
  // if the abstract never repeats the word.
  if (topic.size === 1) {
    for (const token of topic) {
      if (token.length >= 7 && titleHits.has(token)) return true;
    }
  }

  return false;
}

/** Keep only the records that pass the relevance filter, preserving order. */
export function filterRelevantRecords(query, records) {
  return (records ?? []).filter((record) => isRecordRelevant(query, record));
}


/**
 * Render the fetched records into the grounding context block.
 *
 * Only real records are rendered, so the model's source section is anchored to
 * verifiable PubMed data.
 */
export function buildSourceContext(sources) {
  const usable = (sources ?? []).filter((source) => source?.title);
  if (!usable.length) return '';

  return usable
    .map((source) => {
      const parts = [`Title: ${source.title}`];
      if (source.pmid) parts.push(`PMID: ${source.pmid}`);
      if (source.abstract) parts.push(`Abstract: ${source.abstract.slice(0, 700)}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

/** Escape `[`/`]` so a title cannot break a Markdown link. */
export function escapeMarkdownLinkText(value) {
  return String(value ?? '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .trim();
}

// ---------------------------------------------------------------------------
// Source integrity: the model never authors a citation
// ---------------------------------------------------------------------------
// The application owns the source footer. A model may still emit an inline
// "PMID 12345678", a DOI, a PubMed URL or its own "Sources" section — sometimes
// hallucinated. Those are stripped from the educational body before delivery;
// the only citation a student ever sees is the footer built from verified
// records. This is a removal pass, never a reconstruction: nothing is invented.

/** Inline PubMed / DOI URLs, e.g. `https://pubmed.ncbi.nlm.nih.gov/123/`. */
const INLINE_SOURCE_URL_RE =
  /https?:\/\/(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed|doi\.org)\/[^\s)\]"'<>]*/gi;

/** Inline identifiers: `PMID: 123`, `PMID 123`, `PMCID 456`. */
const INLINE_PMID_RE = /\b(?:PMCID|PMID)\s*[:#]?\s*\d{4,}/gi;

/** Inline DOI values: `doi: 10.1000/xyz`. */
const INLINE_DOI_RE = /\bdoi\s*[:#]?\s*10\.\d{4,9}\/[^\s,;)\]"'<>]*/gi;

/** A line that introduces a citation/source block. */
const SOURCE_HEADING_RE =
  /^(?:[*_#>•\-–—\s]|\p{Extended_Pictographic})*(?:sources?\b|references?\b|bibliography\b|المصادر|مصادر|المراجع|مراجع)[^\n]*$/iu;

const SOURCE_LABEL_RE = /^(?:[*_#>\-\s]|\p{Extended_Pictographic})*(?:source\s*[:\-–—]|المصدر\s*[:\-–—])/iu;

function isSourceHeadingLine(line) {
  const value = String(line ?? '').trim();
  if (!value || value.length > 120) return false;
  return SOURCE_HEADING_RE.test(value) || SOURCE_LABEL_RE.test(value);
}

/**
 * Remove a trailing citation/source section the model authored itself.
 *
 * Only a *trailing* block is removed, and only when it is short enough to be a
 * citation list rather than the answer body, so a legitimate use of the word
 * "references" inside prose is untouched.
 */
export function stripTrailingSourceSection(text) {
  const value = String(text ?? '');
  if (!value.trim()) return value;

  const lines = value.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    if (isSourceHeadingLine(lines[i])) {
      const tail = lines.slice(i).join('\n');
      if (tail.length > 800) return value;
      return lines.slice(0, i).join('\n').replace(/\s+$/, '');
    }
  }
  return value;
}

/**
 * Strip every accidental source identifier from generated body text.
 *
 * Safe by construction: it only removes URL/identifier shapes and a trailing
 * citation block, leaving the educational content intact. Returns the cleaned
 * text; never fabricates anything.
 */
export function stripSourceIdentifiers(text) {
  let value = String(text ?? '');
  if (!value.trim()) return value;

  value = stripTrailingSourceSection(value);
  value = value.replace(INLINE_SOURCE_URL_RE, '');
  value = value.replace(INLINE_PMID_RE, '');
  value = value.replace(INLINE_DOI_RE, '');

  // Tidy the artefacts a removal leaves behind: dangling separators, doubled
  // spaces and empty lines, so the answer does not end in " — " or "()" or
  // "unit.." (a stripped identifier leaving its surrounding periods adjacent).
  value = value
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,.;:])/g, '$1')
        .replace(/\.\.(?!\.)/g, '.')
        .replace(/\s*[·—–-]\s*$/g, '')
        .replace(/\(\s*\)/g, '')
        .replace(/[ \t]+$/g, ''),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');

  return value;
}

/** Footer line shown when no genuinely relevant PubMed record survived. */
export const NO_RELEVANT_SOURCE_NOTE =
  '\n\n—\n🔬 *Sources — مصادر موثوقة (NCBI PubMed):*\n' +
  '• No directly relevant PubMed source found.';

/**
 * Render a compact "trusted sources" footer with verifiable links.
 *
 * Only records carrying both a PMID and a URL are shown, so the footer can
 * never contain an unverifiable citation.
 */
export function buildSourcesFooter(sources) {
  const usable = (sources ?? []).filter((source) => source?.url && source?.pmid);
  if (!usable.length) return '';

  const lines = ['', '—', '🔬 *Sources — مصادر موثوقة (NCBI PubMed):*'];

  for (const source of usable.slice(0, 3)) {
    const title = safeTruncate(escapeMarkdownLinkText(source.title || 'PubMed record'), 90);
    lines.push(`• [${title}](${source.url}) · PMID: ${source.pmid}`);
  }

  return lines.join('\n');
}

/** The heading of the application-owned source footer. */
export const SOURCES_FOOTER_MARKER = '🔬 *Sources — مصادر موثوقة (NCBI PubMed):*';

/**
 * Append the application-owned source footer.
 *
 * The model never authors a citation: any inline PMID/DOI/URL and any trailing
 * source block it produced has already been stripped from the body, so a
 * residual mention of "PubMed" is prose rather than a citation and must not
 * suppress the verified footer. Duplication is prevented by detecting this
 * footer's own heading, not by guessing at the body's wording.
 */
export function ensureSourcesFooter(answer, footer) {
  const cleaned = String(answer ?? '').replace(/\s+$/, '');
  if (!footer) return cleaned;
  if (cleaned.includes(SOURCES_FOOTER_MARKER)) return cleaned;

  return `${cleaned}${footer}`;
}
