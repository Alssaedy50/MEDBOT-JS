/**
 * The single news presentation contract.
 *
 * The News Center detail, the admin preview and the private Telegram delivery
 * all describe the same news row to a human, so they must not each invent their
 * own layout. This leaf module owns that layout; the two surfaces call in here.
 *
 * It is deliberately dependency-light (constants only) so both `src/ui/news.js`
 * and `src/newsDelivery.js` can import it without creating a cycle.
 *
 * Facts, not metadata:
 *
 *  * `event_at` is the *editorial* time the author typed (exam/lecture date) and
 *    is shown, once, as 📅 الموعد.
 *  * `published_at`/`created_at` are technical publish bookkeeping. They are
 *    never rendered as if they were the news time, so the reader cannot mistake
 *    a publish stamp for the event it describes.
 *  * Only fields that exist are rendered: no invented doctor, no empty time
 *    line, and the body/registry context is never dropped.
 */

import { NEWS_TYPE_ICONS, NEWS_TYPE_LABELS } from './constants.js';
import { safeTruncate } from './truncate.js';

/** Escape the three characters Telegram HTML mode treats specially. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Stable icon for a news kind. */
export function newsTypeIcon(newsType) {
  return NEWS_TYPE_ICONS[newsType] ?? '📰';
}

/** Human label for a news kind (falls back to the icon, never empty). */
export function newsTypeLabel(newsType) {
  return NEWS_TYPE_LABELS[newsType] ?? NEWS_TYPE_ICONS[newsType] ?? '📰';
}

/**
 * The canonical body lines for one resolved news row.
 *
 * Order: title → type → real registry context → body → doctor → event → linked
 * resource. Every optional line appears only when the author supplied it.
 *
 * `maxBodyLength` truncates the body for the private-delivery message, which
 * points the reader at the News Center for the full text.
 */
export function newsBodyLines(news, { maxBodyLength = null } = {}) {
  if (!news) return [];

  const lines = [
    `${newsTypeIcon(news.news_type)} <b>${esc(news.title)}</b>`,
    `🏷 ${esc(newsTypeLabel(news.news_type))}`,
  ];

  if (news.subject_name) lines.push(`🧪 المادة: ${esc(news.subject_name)}`);
  if (news.section_name) lines.push(`🗂 القسم: ${esc(news.section_name)}`);
  if (news.folder_path) lines.push(`📍 ${esc(news.folder_path)}`);

  const body = String(news.body ?? '').trim();
  if (body) {
    const shown = maxBodyLength ? safeTruncate(body, maxBodyLength) : body;
    lines.push('', `📝 ${esc(shown)}`);
  }

  if (news.doctor) lines.push(`👨‍⚕️ الدكتور: ${esc(news.doctor)}`);
  if (news.event_at) lines.push(`📅 الموعد: ${esc(news.event_at)}`);

  if (news.resource_present && news.resource_title) {
    lines.push('', `📄 ${esc(news.resource_title)}`);
  }

  return lines;
}
