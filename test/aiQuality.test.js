/**
 * AI Quality V2 tests.
 *
 * Covers the deterministic question-type system, the per-type answer-depth
 * contract, the PubMed relevance filter, source integrity (no inline
 * PMID/DOI/URL, no self-authored source block) and safe truncation of both
 * English and Arabic output.
 *
 * No live Telegram, PubMed or AI provider is contacted: the provider and PubMed
 * transports are stubbed, exactly like the existing AI tests.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as ai from '../src/ai/index.js';
import * as router from '../src/ai/router.js';
import * as providers from '../src/ai/providers.js';
import * as medicalSources from '../src/medicalSources.js';
import { classifyQuestionType, QUESTION_TYPES } from '../src/ai/questionType.js';
import { safeTruncate } from '../src/truncate.js';
import { cleanupDb, freshDb } from './helpers/harness.js';

let dbPath;

before(() => {
  dbPath = freshDb('ai-quality');
});

after(() => {
  cleanupDb(dbPath);
});

beforeEach(() => {
  router.resetRouterState();
  providers.resetDiscoveryCache();
  medicalSources.resetPubmedCache();
  ai.resetGenericAnswerCache();
});

afterEach(() => {
  delete process.env.GROQ_API_KEY;
});

function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function okText(body) {
  return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
}

/** A provider transport stub that answers discovery, probes and generation. */
function providerFetch({ answer = 'A grounded answer.', records = [] } = {}) {
  const fn = async (url) => {
    const target = String(url);
    if (target.includes('/v1beta/models')) return okJson({ models: [] });
    if (target.includes('api.groq.com/openai/v1/models')) {
      return okJson({ data: [{ id: 'llama-3.3-70b-versatile' }] });
    }
    if (target.includes('openrouter.ai/api/v1/models')) return okJson({ data: [] });
    if (target.includes('esearch.fcgi')) {
      return okJson({ esearchresult: { idlist: records.map((r) => r.pmid) } });
    }
    if (target.includes('efetch.fcgi')) {
      const xml =
        '<PubmedArticleSet>' +
        records
          .map(
            (r) =>
              '<PubmedArticle><MedlineCitation>' +
              `<PMID Version="1">${r.pmid}</PMID>` +
              `<Article><ArticleTitle>${r.title}</ArticleTitle>` +
              `<Abstract><AbstractText>${r.abstract ?? ''}</AbstractText></Abstract>` +
              '</Article></MedlineCitation></PubmedArticle>',
          )
          .join('') +
        '</PubmedArticleSet>';
      return okText(xml);
    }
    if (target.includes('chat/completions') || target.includes(':generateContent')) {
      return okJson({ choices: [{ message: { content: answer } }] });
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  return fn;
}

/** Install a global fetch stub for `searchPubmed`, restoring it afterwards. */
function withGlobalFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = original;
    });
}

// ---------------------------------------------------------------------------
// 1-6: question-type system
// ---------------------------------------------------------------------------
describe('deterministic question-type classification', () => {
  it('classifies the required English questions without a model call', () => {
    const cases = [
      ['What is the sarcomere?', QUESTION_TYPES.DEFINITION],
      ['What is osteosarcoma?', QUESTION_TYPES.DEFINITION],
      ['Explain beta oxidation', QUESTION_TYPES.MECHANISM],
      ['Explain insulin mechanism', QUESTION_TYPES.MECHANISM],
      ['Compare type 1 and type 2 diabetes', QUESTION_TYPES.COMPARISON],
      ['Explain DKA pathophysiology', QUESTION_TYPES.PATHOPHYSIOLOGY],
      ['What is the clinical presentation of DKA?', QUESTION_TYPES.CLINICAL],
      ['How do you diagnose diabetes?', QUESTION_TYPES.DIAGNOSIS],
      ['What is the treatment for hypertension?', QUESTION_TYPES.TREATMENT],
      ['Most likely diagnosis?', QUESTION_TYPES.EXAM_QUESTION],
      ['Discuss the cardiac cycle in depth', QUESTION_TYPES.COMPLEX],
    ];
    for (const [query, expected] of cases) {
      assert.equal(classifyQuestionType(query), expected, query);
    }
  });

  it('classifies Arabic questions too (word boundaries do not apply to Arabic)', () => {
    const cases = [
      ['ما هو الساركومير؟', QUESTION_TYPES.DEFINITION],
      ['قارن بين النوع الأول والثاني من السكري', QUESTION_TYPES.COMPARISON],
      ['اشرح آلية الأنسولين', QUESTION_TYPES.MECHANISM],
      ['فسر الفيزيولوجيا المرضية للحامض الكيتوني', QUESTION_TYPES.PATHOPHYSIOLOGY],
    ];
    for (const [query, expected] of cases) {
      assert.equal(classifyQuestionType(query), expected, query);
    }
  });

  it('prefers the mechanism reading when a question carries several cues', () => {
    // "explain the mechanism of DKA" has both an explain cue and a mechanism cue.
    assert.equal(
      classifyQuestionType('explain the mechanism of DKA'),
      QUESTION_TYPES.MECHANISM,
    );
  });

  it('falls back to COMPLEX rather than guessing', () => {
    assert.equal(classifyQuestionType(''), QUESTION_TYPES.COMPLEX);
    assert.equal(classifyQuestionType('the mitochondria'), QUESTION_TYPES.COMPLEX);
  });

  it('gives a definition question a definition depth contract that forbids drift', () => {
    const prompt = ai.buildMedicalGroundedPrompt('What is the sarcomere?', []);
    assert.match(prompt, /نمط السؤال: DEFINITION/);
    // The contract must narrow the answer away from unrequested research/genetics.
    assert.match(prompt, /لا تذكر الأمراض أو الوراثة أو الأبحاث أو العلاج/);
  });

  it('gives a mechanism question a sequential cause → process → result contract', () => {
    const prompt = ai.buildMedicalGroundedPrompt('Explain beta oxidation', []);
    assert.match(prompt, /نمط السؤال: MECHANISM/);
    assert.match(prompt, /السبب ← العملية ← النتيجة/);
  });

  it('gives a comparison question a structured side-by-side contract', () => {
    const prompt = ai.buildMedicalGroundedPrompt('Compare type 1 and type 2 diabetes', []);
    assert.match(prompt, /نمط السؤال: COMPARISON/);
    assert.match(prompt, /مقارنة منظمة وجهاً لوجه/);
  });

  it('gives a pathophysiology question the normal → disturbance → mechanism order', () => {
    const prompt = ai.buildMedicalGroundedPrompt('Explain DKA pathophysiology', []);
    assert.match(prompt, /نمط السؤال: PATHOPHYSIOLOGY/);
    assert.match(prompt, /الفسيولوجيا الطبيعية ← الاضطراب ← الآلية ← المظاهر/);
  });

  it('adds the no-diagnosis caution only for a personal clinical question', () => {
    const personal = ai.buildMedicalGroundedPrompt('I have chest pain, what is it?', []);
    const study = ai.buildMedicalGroundedPrompt('What is the sarcomere?', []);
    assert.match(personal, /حالة شخصية/);
    assert.doesNotMatch(study, /حالة شخصية/);
  });
});

// ---------------------------------------------------------------------------
// 7: PubMed relevance filter
// ---------------------------------------------------------------------------
describe('PubMed relevance filter', () => {
  const unrelated = [
    { pmid: '1', title: 'Food lipid oxidation and flavor stability', abstract: 'Oxidation of food lipids during storage.' },
    { pmid: '2', title: 'Drug oxidation by cytochrome P450 enzymes', abstract: 'Hepatic drug oxidation pathways.' },
  ];
  const related = [
    { pmid: '3', title: 'Mitochondrial fatty acid beta oxidation in humans', abstract: 'Fatty acid metabolism and energy production.' },
  ];

  it('rejects unrelated oxidation papers for a β-oxidation question', () => {
    for (const record of unrelated) {
      assert.equal(medicalSources.isRecordRelevant('β-oxidation', record), false, record.title);
    }
    for (const record of related) {
      assert.equal(medicalSources.isRecordRelevant('β-oxidation', record), true, record.title);
    }
  });

  it('prefers sarcomere papers and rejects cardiomyopathy for a sarcomere question', () => {
    assert.equal(
      medicalSources.isRecordRelevant('sarcomere', {
        title: 'Sarcomere structure and contraction in striated muscle',
        abstract: 'The sarcomere is the basic contractile unit.',
      }),
      true,
    );
    assert.equal(
      medicalSources.isRecordRelevant('sarcomere', {
        title: 'Cardiomyopathy genetics: a review',
        abstract: 'Genetic causes of cardiomyopathy.',
      }),
      false,
    );
  });

  it('keeps only genuinely relevant records through searchRelevantPubmed', async () => {
    const records = [...unrelated, ...related];
    await withGlobalFetch(providerFetch({ records }), async () => {
      const sources = await medicalSources.searchRelevantPubmed('β-oxidation', 3);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].pmid, '3');
    });
  });

  it('returns nothing when no record is genuinely relevant (never populates a source)', async () => {
    await withGlobalFetch(providerFetch({ records: unrelated }), async () => {
      const sources = await medicalSources.searchRelevantPubmed('β-oxidation', 3);
      assert.deepEqual(sources, []);
    });
  });
});

// ---------------------------------------------------------------------------
// 8-9, 11-12: source integrity and footer
// ---------------------------------------------------------------------------
describe('source integrity', () => {
  it('strips an inline PMID the model invented', () => {
    const cleaned = medicalSources.stripSourceIdentifiers(
      'The sarcomere is the contractile unit. See PMID 12345678 for details.',
    );
    assert.doesNotMatch(cleaned, /PMID/);
    assert.doesNotMatch(cleaned, /12345678/);
    assert.match(cleaned, /The sarcomere is the contractile unit\./);
  });

  it('strips an inline DOI, a PubMed URL and a self-authored source section', () => {
    const cleaned = medicalSources.stripSourceIdentifiers(
      'Osteosarcoma is a bone tumour.\n' +
        'See doi: 10.1000/xyz123 and https://pubmed.ncbi.nlm.nih.gov/999/.\n\n' +
        'Sources:\n• A fabricated paper — PMID 999',
    );
    assert.doesNotMatch(cleaned, /doi\s*:/i);
    assert.doesNotMatch(cleaned, /pubmed\.ncbi/i);
    assert.doesNotMatch(cleaned, /PMID/);
    assert.doesNotMatch(cleaned, /^Sources:/m);
    assert.match(cleaned, /Osteosarcoma is a bone tumour\./);
  });

  it('keeps the educational body intact when stripping identifiers', () => {
    const body =
      '🩺 Sarcomere\n\nEnglish — Academic\n' +
      'The sarcomere extends from one Z disc to the next.\n\n' +
      'العربية — شرح مختصر\nالوحدة التقلصية الأساسية للعضلة المخططة.';
    assert.equal(medicalSources.stripSourceIdentifiers(body), body);
  });

  it('renders the no-relevant-source note instead of an unrelated citation', () => {
    const note = ai.buildMedicalSourcesFooter([]);
    assert.match(note, /No directly relevant PubMed source found/);
  });

  it('builds the footer only from verified records and appends it once', () => {
    const footer = ai.buildMedicalSourcesFooter([
      { pmid: '42', title: 'A real paper', url: 'https://pubmed.ncbi.nlm.nih.gov/42/' },
    ]);
    assert.match(footer, /PMID: 42/);
    assert.match(footer, /pubmed\.ncbi\.nlm\.nih\.gov\/42\//);
    const once = medicalSources.ensureSourcesFooter('Body.', footer);
    assert.equal(medicalSources.ensureSourcesFooter(once, footer), once);
  });
});

// ---------------------------------------------------------------------------
// 8-12 end to end: the delivered answer
// ---------------------------------------------------------------------------
describe('medical answer delivery (V2)', () => {
  it('delivers a definition answer with no inline PMID/DOI and no leakage', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const answer =
      '🩺 Sarcomere\n\nEnglish — Academic\n' +
      'The sarcomere is the basic contractile unit of striated muscle. PMID 12345678.\n\n' +
      'العربية — شرح مختصر\nالوحدة التقلصية الأساسية.';

    const result = await withGlobalFetch(
      providerFetch({ answer, records: [] }),
      () => ai.generateAiChatResult('What is the sarcomere?', null, providerFetch({ answer })),
    );

    assert.match(result.text, /contractile unit of striated muscle/);
    assert.doesNotMatch(result.text, /PMID\s*\d/i);
    assert.doesNotMatch(result.text, /doi\s*:/i);
    assert.doesNotMatch(result.text, /Internal Monologue|Draft|Analysis/i);
    // No relevant source survived, so the footer says so honestly.
    assert.match(result.text, /No directly relevant PubMed source found/);
  });

  it('never forwards a leaking provider answer through the real router', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const leaking = providerFetch({ answer: 'Internal Monologue: let me think about the sarcomere.' });
    const answer = await router.providerFailover({
      groundedPrompt: 'What is the sarcomere?',
      systemPrompt: 'system',
      candidates: [
        { provider: 'groq', model: 'llama-3.3-70b-versatile', endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
      ],
      fetchImpl: leaking,
    });
    assert.equal(answer, '');
  });

  it('strips an inline citation produced by the provider before delivery', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const withCitation = providerFetch({
      answer: 'The sarcomere is the contractile unit. PMID 55555555. doi: 10.1000/xyz',
    });
    const answer = await router.providerFailover({
      groundedPrompt: 'What is the sarcomere?',
      systemPrompt: 'system',
      candidates: [
        { provider: 'groq', model: 'llama-3.3-70b-versatile', endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
      ],
      fetchImpl: withCitation,
    });
    assert.doesNotMatch(answer, /PMID\s*\d/i);
    assert.doesNotMatch(answer, /doi\s*:/i);
    assert.match(answer, /contractile unit/);
  });
});

// ---------------------------------------------------------------------------
// 13-14: safe truncation
// ---------------------------------------------------------------------------
describe('safe truncation', () => {
  /** The kept prefix must end at a word or sentence boundary in the source. */
  function assertBoundary(source, out) {
    assert.ok(out.endsWith('…'), `expected an ellipsis: ${out}`);
    const kept = out.slice(0, -1).replace(/\s+$/, '');
    assert.ok(source.startsWith(kept), 'the output must be a prefix of the source');
    const next = source[kept.length];
    if (next !== undefined) {
      assert.match(next, /[\s.!?؟…)»]/, `cut inside a word: "...${out}"`);
    }
  }

  it('never ends mid-word for English text', () => {
    const source = 'The contractile unit of striated muscle is called the sarcomere';
    const out = safeTruncate(source, 20);
    assert.ok(out.length <= 20);
    assert.doesNotMatch(out, /contractile uni…$/, 'must not cut inside "unit"');
    assertBoundary(source, out);
  });

  it('never ends mid-word or mid-term for Arabic text', () => {
    const source = 'يبدأ التحلل من أسيتيل-كو A ثم يدخل الدورة ويستمر في الميتوكوندريا';
    const out = safeTruncate(source, 26);
    assert.ok(out.length <= 26);
    assert.doesNotMatch(out, /أسيتيل-Co…$/, 'must not cut inside the term');
    assertBoundary(source, out);
  });

  it('prefers a sentence boundary when one is available', () => {
    const source = 'The sarcomere is the unit. It extends from one Z disc to the next.';
    const out = safeTruncate(source, 30);
    assert.equal(out, 'The sarcomere is the unit.…');
  });

  it('never leaves an unclosed HTML tag or entity', () => {
    const out = safeTruncate('<b>الوحدة التقلصية</b> هي الساركومير وتمتد بين القرصين', 12);
    assert.ok(out.length <= 12);
    assert.equal((out.match(/</g) ?? []).length, (out.match(/>/g) ?? []).length);
  });

  it('returns short text unchanged and handles a degenerate limit', () => {
    assert.equal(safeTruncate('short', 50), 'short');
    assert.equal(safeTruncate('anything', 0), '');
    assert.equal(safeTruncate('', 10), '');
  });
});
