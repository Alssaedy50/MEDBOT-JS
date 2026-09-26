/**
 * Telegram presentation primitives.
 *
 * The Python MEDBOT used `python-telegram-bot`'s `InlineKeyboardButton` /
 * `InlineKeyboardMarkup` and `telegram.constants.ParseMode`. This module keeps
 * the same ergonomics (`btn`, `keyboard`) on top of plain objects that Telegraf
 * (and the test harness) understand, so every UI module builds markup the same
 * way and the tests can inspect it without a network.
 */

/** Parse modes recognised by Telegram; kept as an enum for call-site parity. */
export const ParseMode = Object.freeze({
  HTML: 'HTML',
  MARKDOWN: 'Markdown',
  MARKDOWN_V2: 'MarkdownV2',
});

/**
 * One inline keyboard button.
 *
 * `callbackData` produces a callback button; `extra.url` produces a URL button.
 */
export function btn(text, callbackData = null, extra = {}) {
  const button = { text: String(text ?? '') };
  if (callbackData !== null && callbackData !== undefined) {
    button.callback_data = String(callbackData);
  }
  if (extra.url) button.url = extra.url;
  return button;
}

/** Wrap a list of button rows into a markup object. */
export function keyboard(rows) {
  return { inline_keyboard: Array.isArray(rows) ? rows : [] };
}

/**
 * Pack a flat list of buttons into rows of at most `columns`.
 *
 * A long single-column list (settings, filters, archive actions) forces the
 * reader to scroll a wall of full-width buttons. Packing short buttons two per
 * row halves that scroll while keeping each label readable.
 *
 * Guardrails, because a compact keyboard is worthless if it is unreadable:
 *
 *  * a button whose text is longer than `maxLabelLength` gets its own row, so a
 *    long label is never squeezed into a half-width cell;
 *  * a `fullWidth` predicate (e.g. home / cancel / destructive) also forces its
 *    own row, so navigation and destructive actions stay visually distinct;
 *  * a single trailing button is left on its own row rather than paired with an
 *    unrelated one.
 */
export function chunkButtons(buttons, columns = 2, options = {}) {
  const { maxLabelLength = 24, fullWidth = null } = options;
  const width = Math.max(1, Number.parseInt(columns, 10) || 1);
  const list = Array.isArray(buttons) ? buttons.filter(Boolean) : [];

  const rows = [];
  let current = [];
  const flush = () => {
    if (current.length) rows.push(current);
    current = [];
  };

  for (const button of list) {
    const label = String(button?.text ?? '');
    const wide = label.length > maxLabelLength || (fullWidth ? fullWidth(button) : false);
    if (wide) {
      flush();
      rows.push([button]);
      continue;
    }
    current.push(button);
    if (current.length >= width) flush();
  }
  flush();

  return rows;
}

/** Convenience: build a markup from a list of `[label, callback]` tuples. */
export function keyboardFrom(tuples) {
  return keyboard(tuples.map(([label, callback]) => [btn(label, callback)]));
}

/**
 * Coerce any `reply_markup` value into a valid Bot API object, or `undefined`.
 *
 * Telegram rejects a call whose `reply_markup` is present but is not a JSON
 * object with `"Bad Request: object expected as reply markup"`. Two shapes
 * reach the transport and must be handled here:
 *
 *   * a bare row array of inline rows — wrapped into `{ inline_keyboard }`;
 *   * a `null`/`undefined` value — dropped entirely, because a serialized
 *     `null` is exactly what Telegram refuses.
 *
 * An already-shaped object is passed through untouched, so this is safe to call
 * on every outgoing payload.
 */
export function normalizeReplyMarkup(markup) {
  if (markup === null || markup === undefined) return undefined;
  if (Array.isArray(markup)) return keyboard(markup);
  if (typeof markup !== 'object') return undefined;
  return markup;
}

export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Strip a leading '@' from a handle, returning '' for empty input. */
export function tidyHandle(value) {
  return String(value ?? '')
    .trim()
    .replace(/^@/, '')
    .trim();
}

function parseIntOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Parse `prefix:a:b` into `[prefix, int|null, int|null]`.
 *
 * Used by every multi-argument callback; malformed input yields nulls rather
 * than throwing, so a stale button can never crash a handler.
 */
export function threeParts(data) {
  const parts = String(data ?? '').split(':');
  return [
    parts[0],
    parts.length > 1 ? parseIntOrNull(parts[1]) : null,
    parts.length > 2 ? parseIntOrNull(parts[2]) : null,
  ];
}

/** Parse the trailing integer of `prefix:<id>`; null when malformed. */
export function tailInt(data) {
  const parts = String(data ?? '').split(':');
  if (parts.length < 2) return null;
  return parseIntOrNull(parts[1]);
}

/** Stable icon for a MEDBOT folder/node type. */
export function resourceIcon(nodeType) {
  const value = String(nodeType ?? '').trim().toLowerCase();
  return (
    {
      book: '📚',
      books: '📚',
      video: '🎥',
      audio: '🎧',
      mcq: '📝',
      summary: '📑',
      summaries: '📑',
      image: '🖼',
      photo: '🖼',
      document: '📄',
      doc: '📄',
      general: '📁',
    }[value] ?? '📁'
  );
}

/** Telegram-friendly icon for a registered resource's file type. */
export function contentIcon(fileType) {
  const value = String(fileType ?? '').trim().toLowerCase();
  if (['photo', 'image', 'jpg', 'jpeg', 'png', 'webp'].includes(value)) return '🖼';
  if (['video', 'mp4', 'mkv', 'mov'].includes(value)) return '🎥';
  if (['audio', 'mp3', 'm4a', 'wav'].includes(value)) return '🎧';
  if (['mcq', 'quiz'].includes(value)) return '📝';
  if (value === 'pdf') return '📕';
  return '📄';
}
