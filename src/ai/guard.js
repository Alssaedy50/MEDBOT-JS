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
