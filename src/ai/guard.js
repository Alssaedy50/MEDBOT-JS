/**
 * Local output guard (anti-repetition).
 *
 * A model can degenerate and emit the same line, paragraph or table row many
 * times. This pass is purely local — no network, no database — and it NEVER
 * caps the answer length: a legitimately long, varied reply passes untouched.
 * It only collapses a unit that is substantial
 * (>= REPETITION_MIN_UNIT_CHARS) and clearly duplicated
 * (>= REPETITION_MIN_REPEATS adjacent times).
 *
 * The caller may regenerate once when a repetition signature survives this
 * repair (see `ai/router.js`), so there is no loop.
 */

import { REPETITION_MIN_REPEATS, REPETITION_MIN_UNIT_CHARS } from './prompts.js';
import { normalizeText } from '../searchEngine.js';

const WORD_RE = /[A-Za-z0-9\u0600-\u06FF]+/g;

/**
 * A stable key for a line/paragraph, normalized for comparison.
 *
 * Case, surrounding whitespace, punctuation and Arabic diacritics are ignored
 * so `* Item` and `- item.` count as the same unit.
 */
export function unitSignature(unit) {
  const normalized = normalizeText(unit ?? '');
  return (normalized.match(WORD_RE) ?? []).join(' ');
}

function isTableLine(line) {
  const stripped = String(line ?? '').trim();
  if (
    stripped.startsWith('|') ||
    stripped.startsWith('+-') ||
    stripped.startsWith('|:') ||
    (stripped.match(/\|/g) ?? []).length >= 2
  ) {
    return true;
  }
  return false;
}

/**
 * Collapse runs of >= REPETITION_MIN_REPEATS identical adjacent lines.
 *
 * Returns `[cleanedText, repeatsFound]`. A long, varied answer is unchanged.
 */
export function collapseRepeatedUnits(text) {
  if (!text) return [text, 0];

  const lines = String(text).split('\n');
  const collapsed = [];
  let repeats = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const signature = unitSignature(line);

    if (
      signature &&
      line.trim().length >= REPETITION_MIN_UNIT_CHARS &&
      !isTableLine(line)
    ) {
      let run = 1;
      while (
        index + run < lines.length &&
        unitSignature(lines[index + run]) === signature
      ) {
        run += 1;
      }

      if (run >= REPETITION_MIN_REPEATS) {
        repeats += run - 1;
        collapsed.push(line);
        index += run;
        continue;
      }
    }

    collapsed.push(line);
    index += 1;
  }

  return [collapsed.join('\n'), repeats];
}

/**
 * True when an obvious repetition survives the local repair.
 *
 * Used to decide whether a single regeneration is worth attempting: the answer
 * still contains a line/paragraph repeated at least `REPETITION_MIN_REPEATS`
 * times, or consecutive identical paragraphs.
 */
export function hasRepetition(text) {
  if (!text) return false;

  const [, repeats] = collapseRepeatedUnits(text);
  if (repeats > 0) return true;

  // Paragraph-level check: consecutive identical multi-line blocks.
  const paragraphs = String(text)
    .split(/\n\s*\n/)
    .map((part) => unitSignature(part))
    .filter((part) => part.length >= REPETITION_MIN_UNIT_CHARS);

  let run = 1;
  for (let i = 1; i < paragraphs.length; i += 1) {
    if (paragraphs[i] === paragraphs[i - 1]) {
      run += 1;
      if (run >= REPETITION_MIN_REPEATS) return true;
    } else {
      run = 1;
    }
  }

  return false;
}

/**
 * Apply the local anti-repetition repair to a model answer.
 *
 * Never caps length; returns the (possibly collapsed) answer.
 */
export function guardAnswer(text) {
  const [cleaned] = collapseRepeatedUnits(String(text ?? '').trim());
  return cleaned;
}

// ---------------------------------------------------------------------------
// Output safety: meta / reasoning leakage
// ---------------------------------------------------------------------------
// A model can narrate its own process ("Internal Monologue", "Draft 1",
// "Refining based on constraints", "Final Answer Construction") or echo the
// system/developer/tool instructions. A student must only ever receive the final
// answer, so this pass detects that leakage before delivery. It never tries to
// expose or reconstruct hidden chain-of-thought: it either recovers the clearly
// delimited final-answer section, or reports the answer as unusable so the
// caller can regenerate or fall back.

// Phrases that are unambiguously process/meta narration wherever they appear.
const META_PHRASES = [
  'internal monologue',
  'final answer construction',
  'refining based on constraints',
  'chain of thought',
  'chain-of-thought',
  'thought process',
  'scratchpad',
  'system prompt',
  'system instruction',
  'developer instruction',
  'tool instruction',
  'provider prompt',
  'hidden instruction',
  'prompt instruction',
  'debug trace',
  'internal reasoning',
  'internal notes',
  'my reasoning',
  'let me think',
];

// A line that *labels* a section as process output, e.g. "Analysis:", "**Draft 2**",
// "Reasoning —", "Internal Monologue:". Anchored to a heading shape so ordinary
// prose that merely contains the word "analysis" is untouched.
const META_HEADING_RE = new RegExp(
  '(^|\\n)\\s*(?:[*_#>\\-\\s]*)(?:' +
    'internal monologue|draft\\s*\\d+|final answer construction|' +
    'refining based on constraints|reasoning|analysis|chain[- ]of[- ]thought|' +
    'thought process|self[- ]correction|scratchpad|system prompt|' +
    'system instructions?|developer instructions?|tool instructions?|' +
    'provider (?:prompt|instructions?)|hidden instructions?|prompt instructions?|' +
    'debug(?:ging)? (?:trace|output|info|details)|internal (?:notes?|reasoning|thoughts?)' +
    ')\\s*(?:[*_#]*)\\s*[:\\-–—]',
  'i',
);

// XML/JSON-ish process tags some providers emit.
const META_TAG_RE = /<\s*\/?\s*(analysis|reasoning|thinking|thought|scratchpad|internal)\s*>/i;

// A bare "Draft N" anywhere in the text.
const DRAFT_RE = /\bdraft\s*\d+\b/i;

/** True when the text contains an obvious meta/reasoning leakage marker. */
export function containsMetaLeak(text) {
  const value = String(text ?? '');
  if (!value.trim()) return false;
  if (DRAFT_RE.test(value)) return true;
  if (META_TAG_RE.test(value)) return true;
  if (META_HEADING_RE.test(value)) return true;

  const lowered = value.toLowerCase();
  return META_PHRASES.some((phrase) => lowered.includes(phrase));
}

// Markers that delimit an explicit final-answer section. When a leaking answer
// still carries one, the clean text after the LAST marker is recoverable.
const FINAL_SECTION_MARKERS = [
  /\bfinal answer\s*[:\-–—]/gi,
  /الإجابة\s*(?:النهائية|الصحيحة)\s*[:\-–—]/g,
  /\bfinal\s+response\s*[:\-–—]/gi,
  /\bالإجابة\s*[:\-–—]/g,
];

/**
 * Extract the text after the last explicit final-answer marker, if any.
 *
 * Returns '' when there is no such marker or the extracted block is empty.
 */
export function extractFinalSection(text) {
  const value = String(text ?? '');
  let bestIndex = -1;
  let bestLength = 0;

  for (const pattern of FINAL_SECTION_MARKERS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      if (match.index >= bestIndex) {
        bestIndex = match.index;
        bestLength = match[0].length;
      }
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
    }
  }

  if (bestIndex < 0) return '';
  return value.slice(bestIndex + bestLength).trim();
}

/**
 * Validate and sanitize a model answer before it can reach a student.
 *
 * Returns `{ text, leaked, recovered }`:
 *   leaked=false            -> `text` is the clean answer, unchanged
 *   leaked=true, recovered  -> a clean final-answer section was recovered
 *   leaked=true, recovered=false -> `text` is '' and the answer must not be sent
 *
 * Never exposes or reconstructs hidden reasoning.
 */
export function sanitizeModelAnswer(text) {
  const value = String(text ?? '').trim();
  if (!containsMetaLeak(value)) return { text: value, leaked: false, recovered: false };

  const candidate = extractFinalSection(value);
  if (candidate && !containsMetaLeak(candidate)) {
    return { text: candidate, leaked: true, recovered: true };
  }

  return { text: '', leaked: true, recovered: false };
}
