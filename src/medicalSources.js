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
    let title = escapeMarkdownLinkText(source.title || 'PubMed record');
    if (title.length > 90) title = `${title.slice(0, 90).replace(/\s+$/, '')}…`;
    lines.push(`• [${title}](${source.url}) · PMID: ${source.pmid}`);
  }

  return lines.join('\n');
}

/**
 * Append the footer unless the model already cited a source itself.
 *
 * Avoids duplicating a citation block the model produced on its own.
 */
export function ensureSourcesFooter(answer, footer) {
  const cleaned = String(answer ?? '').replace(/\s+$/, '');
  if (!footer) return cleaned;

  const lowered = cleaned.toLowerCase();
  if (lowered.includes('pubmed') || lowered.includes('pmid')) return cleaned;

  return `${cleaned}${footer}`;
}
