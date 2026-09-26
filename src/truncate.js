/**
 * Safe text truncation for Telegram output.
 *
 * A hard `slice(0, n)` cuts wherever `n` lands, which in practice means a reply
 * can end mid-word ("contractile uni"), mid-term ("أسيتيل-Co"), mid-URL,
 * mid-PMID, or inside an HTML tag or entity. On a bilingual medical bot that is
 * not cosmetic: a truncated clinical term can read as a different term.
 *
 * This module truncates on the strongest boundary available, in order:
 *
 *   1. a sentence boundary ('.', '!', '?', '؟', '…') followed by whitespace/end;
 *   2. a word boundary (whitespace);
 *   3. a raw character fallback, used only when neither exists (e.g. one very
 *      long token) — and even then it backs out of any unclosed HTML tag so
 *      Telegram cannot receive malformed markup.
 *
 * A boundary is only accepted when it keeps enough of the text to be useful
 * (at least `minRatio` of the budget); otherwise the search falls back to the
 * next, weaker boundary. The result always ends with an ellipsis when the text
 * was actually shortened.
 */

export const ELLIPSIS = '…';

/** Sentence terminators across the scripts MEDBOT renders. */
const SENTENCE_END_RE = /[.!?؟…](?=\s|$)/g;

/** A boundary must keep at least this fraction of the budget to be preferred. */
const MIN_KEEP_RATIO = 0.5;

/**
 * Index just past the last sentence boundary within `candidate`, or -1.
 *
 * Trailing closing quotes/brackets after the terminator are kept so a sentence
 * ending in `.)` or `.»` does not lose its closer.
 */
function lastSentenceBoundary(candidate) {
  let best = -1;
  SENTENCE_END_RE.lastIndex = 0;
  let match;
  while ((match = SENTENCE_END_RE.exec(candidate)) !== null) {
    let end = match.index + 1;
    while (end < candidate.length && /[)\]}"'»]/.test(candidate[end])) end += 1;
    best = end;
  }
  return best;
}

/** Index just past the last whitespace within `candidate`, or -1. */
function lastWordBoundary(candidate) {
  for (let i = candidate.length - 1; i >= 0; i -= 1) {
    if (/\s/.test(candidate[i])) return i;
  }
  return -1;
}

/**
 * Pull the cut back out of an unclosed HTML tag or entity.
 *
 * `MEDBOT` escapes dynamic text, so a stray `<` is only ever an opening tag
 * whose `>` fell beyond the cut. Cutting inside it would deliver an unterminated
 * tag to Telegram, which rejects the whole message. The same applies to a
 * character entity (`&amp;`) cut before its `;`.
 */
function avoidOpenTag(candidate) {
  let end = candidate.length;

  const open = candidate.lastIndexOf('<');
  if (open !== -1 && candidate.lastIndexOf('>') <= open) end = open;

  const amp = candidate.lastIndexOf('&', end - 1);
  if (amp !== -1 && candidate.lastIndexOf(';', end - 1) < amp) end = amp;

  return end;
}

/**
 * Truncate `text` to at most `limit` characters without corrupting its ending.
 *
 * `limit` counts the returned string including the trailing ellipsis, so a
 * caller can pass Telegram's hard limit directly. Text already within the limit
 * is returned unchanged.
 */
export function safeTruncate(text, limit, { ellipsis = ELLIPSIS } = {}) {
  const value = String(text ?? '');
  const max = Number.parseInt(limit, 10);
  if (!Number.isFinite(max) || max <= 0) return '';
  if (value.length <= max) return value;
  // Too small for content plus an ellipsis: return the ellipsis alone rather
  // than exceeding the caller's hard limit.
  if (max <= ellipsis.length) return ellipsis.slice(0, max);

  const budget = max - ellipsis.length;
  const candidate = value.slice(0, budget);
  const minKeep = Math.ceil(budget * MIN_KEEP_RATIO);

  const sentence = lastSentenceBoundary(candidate);
  if (sentence >= minKeep) return `${candidate.slice(0, sentence).replace(/\s+$/, '')}${ellipsis}`;

  const word = lastWordBoundary(candidate);
  if (word >= minKeep) return `${candidate.slice(0, word).replace(/\s+$/, '')}${ellipsis}`;

  const safeEnd = Math.min(budget, avoidOpenTag(candidate));
  const fallback = candidate.slice(0, safeEnd).replace(/\s+$/, '');
  // Never return a shorter-than-useful stub when a character cut is all that is
  // available; keep the ellipsis so the reader still knows it was truncated.
  return fallback ? `${fallback}${ellipsis}` : ellipsis;
}
