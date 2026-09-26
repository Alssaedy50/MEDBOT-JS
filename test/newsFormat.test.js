/**
 * The single news presentation contract (`src/newsFormat.js`).
 *
 * The News Center detail, the admin preview and the private delivery message
 * all render the same row. These tests pin the exact facts and ordering so the
 * three surfaces cannot drift, and — the rule the audit was written for — that a
 * technical publish stamp is never shown as if it were the news time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { newsBodyLines, esc, newsTypeLabel, newsTypeIcon } from '../src/newsFormat.js';

/** A resolved news row with only the fields a case needs. */
function news(overrides = {}) {
  return {
    id: 1,
    news_type: 'notify',
    title: 'عنوان الخبر',
    body: 'نص الخبر',
    doctor: null,
    event_at: null,
    subject_name: null,
    section_name: null,
    folder_path: null,
    resource_present: false,
    resource_title: null,
    ...overrides,
  };
}

const text = (row) => newsBodyLines(row).join('\n');

describe('news format: the rendered facts', () => {
  it('1. renders title + type + body only', () => {
    const rendered = text(news());
    assert.match(rendered, /🚨 <b>عنوان الخبر<\/b>/);
    assert.match(rendered, /🏷/);
    assert.match(rendered, /📝 نص الخبر/);
    assert.doesNotMatch(rendered, /👨‍⚕️/, 'no doctor line without a doctor');
    assert.doesNotMatch(rendered, /📅/, 'no event line without an event');
  });

  it('2. adds the doctor line when a doctor is set', () => {
    const rendered = text(news({ doctor: 'د. أحمد' }));
    assert.match(rendered, /👨‍⚕️ الدكتور: د\. أحمد/);
  });

  it('3. adds the event line when an event time is set', () => {
    const rendered = text(news({ event_at: 'الأحد 10:00' }));
    assert.match(rendered, /📅 الموعد: الأحد 10:00/);
  });

  it('4. shows doctor and event together, each once', () => {
    const rendered = text(news({ doctor: 'د. أحمد', event_at: 'الأحد 10:00' }));
    assert.equal(rendered.match(/👨‍⚕️/g).length, 1);
    assert.equal(rendered.match(/📅/g).length, 1);
  });

  it('5. never shows the technical publish stamp as the news time', () => {
    const rendered = text(
      news({
        published_at: '2026-01-10T09:00:00',
        created_at: '2026-01-09T09:00:00',
        event_at: 'الأحد 10:00',
      }),
    );
    assert.doesNotMatch(rendered, /2026-01-10T09:00:00/, 'published_at is metadata, not news time');
    assert.doesNotMatch(rendered, /2026-01-09T09:00:00/, 'created_at is metadata, not news time');
    // The real event time still appears, exactly once.
    assert.equal(rendered.match(/📅/g).length, 1);
  });

  it('does not render a time line at all when event_at is absent', () => {
    const rendered = text(news({ published_at: '2026-01-10T09:00:00' }));
    assert.doesNotMatch(rendered, /📅|🕒/, 'no time line without an authored event time');
  });

  it('6. escapes HTML special characters in every field', () => {
    const rendered = text(
      news({
        title: 'A <b>&</b> B',
        body: '<script>alert(1)</script>',
        doctor: 'Dr. <X>',
        event_at: '10:00 <sharp>',
        subject_name: 'Subject <1>',
        section_name: 'Section & Co',
      }),
    );
    assert.doesNotMatch(rendered, /<script>/, 'raw markup never survives');
    assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(rendered, /A &lt;b&gt;&amp;&lt;\/b&gt; B/);
    assert.match(rendered, /Dr\. &lt;X&gt;/);
    assert.match(rendered, /10:00 &lt;sharp&gt;/);
    assert.match(rendered, /Subject &lt;1&gt;/);
    assert.match(rendered, /Section &amp; Co/);
  });

  it('keeps the real section/subject/resource context', () => {
    const rendered = text(
      news({
        news_type: 'section',
        subject_name: 'الفسيولوجيا',
        section_name: 'القلب',
        resource_present: true,
        resource_title: 'محاضرة القلب',
      }),
    );
    assert.match(rendered, /🧪 المادة: الفسيولوجيا/);
    assert.match(rendered, /🗂 القسم: القلب/);
    assert.match(rendered, /📄 محاضرة القلب/);
  });

  it('truncates the body only when asked (the private-delivery inbox case)', () => {
    const long = 'ا'.repeat(700);
    const full = newsBodyLines(news({ body: long })).join('\n');
    const clipped = newsBodyLines(news({ body: long }), { maxBodyLength: 600 }).join('\n');
    assert.ok(full.length > clipped.length);
    assert.ok(clipped.length < full.length);
  });

  it('exposes the kind icon and label without an empty fallback', () => {
    assert.equal(newsTypeIcon('notify'), '🚨');
    assert.equal(newsTypeIcon('section'), '📚');
    assert.equal(newsTypeLabel('section'), '📚 أخبار الأقسام');
    assert.equal(newsTypeLabel('unknown-kind'), '📰', 'never renders an empty label');
    assert.equal(esc('a<b>&c'), 'a&lt;b&gt;&amp;c');
  });
});
