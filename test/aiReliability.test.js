/**
 * AI reliability & output-safety tests.
 *
 * Covers the reliability contract added on top of the existing AI policy:
 *   * robust medical intent detection (morphology + collocations, low false
 *     positives), not a tiny word list;
 *   * the medical pipeline (PubMed grounding, preserved metadata, no fabricated
 *     citations, non-fatal PubMed failure);
 *   * output safety (meta/reasoning leakage is repaired, regenerated once, or
 *     rejected — never forwarded);
 *   * provider failover still works.
 *
 * No live Telegram, PubMed, or paid AI provider is contacted: provider and
 * PubMed transports are injected/stubbed, exactly like the existing AI tests.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as ai from '../src/ai/index.js';
import * as intent from '../src/ai/intent.js';
import * as guard from '../src/ai/guard.js';
import * as router from '../src/ai/router.js';
import * as providers from '../src/ai/providers.js';
import * as medicalSources from '../src/medicalSources.js';
import * as prompts from '../src/ai/prompts.js';
import * as workflow from '../src/workflow.js';
import * as assistant from '../src/ui/assistant.js';
import { AI_DAILY_LIMIT } from '../src/constants.js';
import { cleanupDb, freshDb, messageCtx, FakeBot } from './helpers/harness.js';

let dbPath;
let registry;

before(() => {
  dbPath = freshDb('aiReliability');
  const year = db.addFolder(0, 'Second Year', 'general');
  const physiology = db.addFolder(year, 'PHYSIOLOGY', 'general');
  const contentId = db.addContent(physiology, 'GIT Physiology', 'fid-git', 'pdf');
  registry = { year, physiology, contentId };
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

/** Build a JSON Response-like object. */
function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/** Build a text Response-like object. */
function okText(body) {
  return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
}

/**
 * A provider transport stub that answers discovery, health probes and
 * generation without touching the network.
 *
 * `answer` is returned by every chat completion; `failModels` makes the named
 * models return an upstream error so failover can be observed.
 */
function providerFetch({ answer = 'A grounded answer.', failModels = [] } = {}) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, options });

    if (target.includes('/v1beta/models')) return okJson({ models: [] });
    if (target.includes('api.groq.com/openai/v1/models')) {
      return okJson({
        data: [
          { id: 'llama-3.3-70b-versatile' },
          { id: 'llama-3.1-8b-instant' },
        ],
      });
    }
    if (target.includes('openrouter.ai/api/v1/models')) return okJson({ data: [] });

    if (target.includes('api.groq.com/openai/v1/chat/completions')) {
      let model = '';
      try {
        model = JSON.parse(options.body)?.model ?? '';
      } catch {
        model = '';
      }
      if (failModels.includes(model)) {
        return { ok: false, status: 500, text: async () => 'upstream boom' };
      }
      return okJson({ choices: [{ message: { content: answer } }] });
    }

    if (target.includes(':generateContent')) {
      return okJson({ candidates: [{ content: { parts: [{ text: answer }] } }] });
    }

    return { ok: false, status: 404, text: async () => '' };
  };
  fn.calls = calls;
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

/** A PubMed esearch/efetch stub returning one real-shaped record. */
function pubmedFetch() {
  const calls = [];
  const fn = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('esearch.fcgi')) {
      return okJson({ esearchresult: { idlist: ['12345678'] } });
    }
    if (target.includes('efetch.fcgi')) {
      return okText(
        '<PubmedArticleSet><PubmedArticle><MedlineCitation>' +
          '<PMID Version="1">12345678</PMID>' +
          '<Article><ArticleTitle>Osteosarcoma: a review</ArticleTitle>' +
          '<Abstract><AbstractText>A malignant bone tumour.</AbstractText>' +
          '</Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>',
      );
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// 1-6: intent classification
// ---------------------------------------------------------------------------
describe('medical intent detection', () => {
  it('classifies the required medical questions as MEDICAL', () => {
    const cases = [
      'Osteosarcoma',
      'What is osteosarcoma?',
      'Hypertension',
      'Diabetes mellitus',
      'β-oxidation',
      'beta oxidation',
      'Sarcomere',
      'Action potential',
      'Glomerular filtration',
      'Myocardial infarction',
      'A patient with fever and sore throat',
    ];
    for (const query of cases) {
      assert.equal(intent.classifyIntent(query), intent.INTENT_MEDICAL, query);
      assert.equal(ai.isMedicalQuestion(query), true, query);
    }
  });

  it('keeps clearly non-medical questions as GENERAL', () => {
    const cases = [
      'ما هي عاصمة فرنسا؟',
      'كيف حالك؟',
      'Who won the world cup?',
      'how does a car engine work',
      'cell phone plans are expensive',
      'organs of government',
      'the potential for growth is high',
    ];
    for (const query of cases) {
      assert.equal(intent.classifyIntent(query), intent.INTENT_GENERAL, query);
      assert.equal(ai.isMedicalQuestion(query), false, query);
    }
  });

  it('uses morphology and collocations rather than a tiny word list', () => {
    // Suffix/prefix morphology reaches words never enumerated explicitly.
    for (const query of ['nephritis', 'hepatomegaly', 'osteoporosis', 'anemia']) {
      assert.equal(intent.classifyIntent(query), intent.INTENT_MEDICAL, query);
    }
    // A collocation whose tokens are individually ambiguous.
    assert.equal(intent.classifyIntent('blood pressure'), intent.INTENT_MEDICAL);
    // An ambiguous term still needs study framing.
    assert.equal(intent.classifyIntent('explain cell division'), intent.INTENT_MEDICAL);
    assert.equal(intent.classifyIntent('cell phone plans are expensive'), intent.INTENT_GENERAL);
  });
});

// ---------------------------------------------------------------------------
// 10-13: output safety
// ---------------------------------------------------------------------------
describe('output safety: meta / reasoning leakage', () => {
  it('flags the required leakage markers', () => {
    for (const marker of [
      'Internal Monologue',
      'Draft 1',
      'Final Answer Construction',
      'Refining based on constraints',
      'system prompt',
      'developer instructions',
      'tool instructions',
      'chain of thought',
    ]) {
      assert.equal(guard.containsMetaLeak(`Some text\n${marker}: hidden`), true, marker);
    }
  });

  it('recovers a clean final section when one is delimited', () => {
    const leaked =
      'Internal Monologue: the user wants a definition.\n' +
      'Draft 1: maybe it is a bone tumour.\n' +
      'Refining based on constraints: keep it short.\n' +
      'Final Answer: Osteosarcoma is a malignant bone tumour.';
    const result = guard.sanitizeModelAnswer(leaked);
    assert.equal(result.leaked, true);
    assert.equal(result.recovered, true);
    assert.equal(result.text, 'Osteosarcoma is a malignant bone tumour.');
    assert.equal(guard.containsMetaLeak(result.text), false);
  });

  it('rejects an unrecoverable leak instead of forwarding it', () => {
    for (const leaked of [
      'Internal Monologue: I am thinking about the answer.',
      'Draft 1\nSome content\nDraft 2\nMore content',
      'system prompt: you are a medical assistant',
      'Final Answer Construction: assembling the response',
    ]) {
      const result = guard.sanitizeModelAnswer(leaked);
      assert.equal(result.leaked, true, leaked);
      assert.equal(result.text, '', 'the malformed output is never returned');
    }
  });

  it('passes a clean final answer through unchanged', () => {
    const clean =
      '🩺 Osteosarcoma\n\n' +
      'English — Academic\n' +
      'Osteosarcoma is a malignant bone tumour arising from primitive bone-forming cells.\n\n' +
      'العربية — شرح مختصر\n' +
      'ورم خبيث ينشأ من الخلايا المكوّنة للعظم.';
    const result = guard.sanitizeModelAnswer(clean);
    assert.equal(result.leaked, false);
    assert.equal(result.text, clean);
  });

  it('never asks the model to reveal its reasoning', () => {
    assert.doesNotMatch(prompts.FINAL_ANSWER_ONLY_INSTRUCTION, /اكشف|reveal|show your/i);
    assert.match(prompts.FINAL_ANSWER_ONLY_INSTRUCTION, /الإجابة النهائية فقط/);
  });
});

// ---------------------------------------------------------------------------
// 14: provider failover + meta-leak rejection through the real router
// ---------------------------------------------------------------------------
describe('provider failover and output sanitization in the router', () => {
  const bad = { provider: 'groq', model: 'llama-3.3-70b-versatile', endpoint: 'https://api.groq.com/openai/v1/chat/completions' };
  const good = { provider: 'groq', model: 'llama-3.1-8b-instant', endpoint: 'https://api.groq.com/openai/v1/chat/completions' };

  it('fails over to the next candidate when a provider errors', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const fetchImpl = providerFetch({ answer: 'Working answer.', failModels: ['llama-3.3-70b-versatile'] });

    const answer = await router.providerFailover({
      groundedPrompt: 'question',
      systemPrompt: 'system',
      candidates: [bad, good],
      fetchImpl,
    });

    assert.equal(answer, 'Working answer.');
    // The failing model was tried and then the healthy one.
    assert.ok(fetchImpl.calls.length >= 2);
  });

  it('never forwards a provider that leaks internal reasoning', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const leaking = providerFetch({ answer: 'Internal Monologue: thinking...' });
    const answer = await router.providerFailover({
      groundedPrompt: 'question',
      systemPrompt: 'system',
      candidates: [bad],
      fetchImpl: leaking,
    });
    assert.equal(answer, '', 'a leaking provider yields no answer');
  });

  it('recovers the final answer when the model delimits it', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const fetchImpl = providerFetch({
      answer: 'Draft 1: rough.\nFinal Answer: The clean, final answer.',
    });
    const answer = await router.providerFailover({
      groundedPrompt: 'question',
      systemPrompt: 'system',
      candidates: [bad],
      fetchImpl,
    });
    assert.equal(answer, 'The clean, final answer.');
  });

  it('regenerates once with a strict instruction when leakage has no final section', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const answers = ['Analysis: thinking hard.', 'The final clean answer.'];
    let call = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes('chat/completions')) {
        const content = answers[Math.min(call, answers.length - 1)];
        call += 1;
        return okJson({ choices: [{ message: { content } }] });
      }
      return { ok: false, status: 404, text: async () => '' };
    };

    const answer = await router.providerFailover({
      groundedPrompt: 'question',
      systemPrompt: 'system',
      candidates: [bad],
      fetchImpl,
    });
    assert.equal(answer, 'The final clean answer.');
    assert.equal(call, 2, 'exactly one clean regeneration was attempted');
  });

  it('re-probes a persisted AVAILABLE model on a pool rebuild (restart resilience)', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const stub = providerFetch({ answer: 'OK' });

    const first = await router.getCandidates(stub);
    assert.ok(first.length > 0);

    // A rebuild must not treat the persisted AVAILABLE row as already verified:
    // it is a fresh DISCOVERED candidate and has to be probed again.
    router.resetRouterState();
    const second = await router.getCandidates(stub);
    assert.equal(
      second.length,
      first.length,
      'the pool survives a rebuild instead of emptying',
    );
    for (const item of second) assert.equal(item.availability, 'VERIFIED');
  });

  it('orders the verified pool without adding or dropping candidates', () => {
    const pool = [
      { provider: 'groq', model: 'llama-3.3-70b-versatile', endpoint: 'e', latency_ms: 900 },
      { provider: 'groq', model: 'llama-3.1-8b-instant', endpoint: 'e', latency_ms: 120 },
    ];
    const simple = router.orderCandidatesForQuestion(pool, { complex: false });
    const complex = router.orderCandidatesForQuestion(pool, { complex: true });
    assert.equal(simple.length, 2);
    assert.equal(complex.length, 2);
    assert.equal(simple[0].model, 'llama-3.1-8b-instant', 'simple questions take the fastest');
    assert.equal(complex[0].model, 'llama-3.3-70b-versatile', 'complex questions take the stronger');
  });
});

// ---------------------------------------------------------------------------
// 7-9, 15: medical pipeline + PubMed
// ---------------------------------------------------------------------------
describe('medical answer pipeline', () => {
  it('runs the PubMed lookup on the medical path (and not on the general path)', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const pubmed = pubmedFetch();

    await withGlobalFetch(pubmed, async () => {
      await ai.generateAiChatResult('What is osteosarcoma?', null, providerFetch());
    });
    assert.ok(pubmed.calls.some((url) => url.includes('esearch.fcgi')), 'medical path queries PubMed');

    const pubmed2 = pubmedFetch();
    await withGlobalFetch(pubmed2, async () => {
      await ai.generateAiChatResult('ما هي عاصمة فرنسا؟', null, providerFetch());
    });
    assert.equal(pubmed2.calls.length, 0, 'general path never queries PubMed');
  });

  it('preserves real PubMed metadata through parsing and rendering', async () => {
    await withGlobalFetch(pubmedFetch(), async () => {
      const sources = await medicalSources.searchPubmed('osteosarcoma', 3);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].pmid, '12345678');
      assert.equal(sources[0].title, 'Osteosarcoma: a review');
      assert.equal(sources[0].abstract, 'A malignant bone tumour.');
      assert.equal(sources[0].url, 'https://pubmed.ncbi.nlm.nih.gov/12345678/');

      const context = medicalSources.buildSourceContext(sources);
      assert.match(context, /PMID: 12345678/);
      assert.match(context, /Osteosarcoma: a review/);

      const footer = medicalSources.buildSourcesFooter(sources);
      assert.match(footer, /PMID: 12345678/);
      assert.match(footer, /https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12345678\//);
    });
  });

  it('never fabricates a citation when no PubMed result exists', async () => {
    // Empty PubMed result: no footer, and the answer is untouched.
    const emptyFetch = async () => okJson({ esearchresult: { idlist: [] } });
    await withGlobalFetch(emptyFetch, async () => {
      const sources = await medicalSources.searchPubmed('nothing-here', 3);
      assert.deepEqual(sources, []);
    });

    assert.equal(medicalSources.buildSourcesFooter([]), '');
    const answer = 'An academic answer without a source line.';
    assert.equal(medicalSources.ensureSourcesFooter(answer, ''), answer);
  });

  it('does not crash when PubMed is unreachable', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const down = async () => {
      throw new Error('network down');
    };

    const result = await withGlobalFetch(down, () =>
      ai.generateAiChatResult('What is osteosarcoma?', null, providerFetch({ answer: 'Grounded academic answer.' })),
    );

    assert.equal(typeof result.text, 'string');
    assert.ok(result.text.length > 0, 'the assistant still answers');
    assert.deepEqual(result.actions, []);
  });
});

// ---------------------------------------------------------------------------
// 16-17: existing Telegram workflow + resource mode
// ---------------------------------------------------------------------------
describe('existing assistant surfaces remain intact', () => {
  it('keeps the Telegram assistant text workflow working', async () => {
    const bot = new FakeBot();
    const student = 9801;
    db.registerUser(student, 'student', 'Student');

    const ctx = messageCtx(bot, student, 'ما هي عاصمة فرنسا؟');
    workflow.begin(ctx, assistant.ASSISTANT_WORKFLOW);
    ctx.userData.ai_mode = 'chat';

    const before = db.getRemainingQuota(student, AI_DAILY_LIMIT);

    // No provider keys and no reachable transport: the workflow still consumes
    // the allowance, replies, and re-arms instead of dead-ending.
    const down = async () => {
      throw new Error('offline');
    };
    await withGlobalFetch(down, () => assistant.handleAssistantText(ctx));

    const texts = bot.messagesTo(student);
    assert.ok(texts.some((text) => text.includes('المعالجة')), 'a processing reply was sent');
    assert.ok(texts.length >= 2, 'the student received an answer or a safe unavailability note');
    assert.equal(
      db.getRemainingQuota(student, AI_DAILY_LIMIT),
      before - 1,
      'the allowance is still consumed before generation',
    );
    assert.equal(workflow.owns(ctx, assistant.ASSISTANT_WORKFLOW), true, 'the mode is re-armed');
  });

  it('keeps search-only / resource mode deterministic and registry-scoped', async () => {
    const result = await ai.generatePlatformSearchResult('أين أجد PHYSIOLOGY؟');
    assert.match(result.text, /PHYSIOLOGY/);
    const callbacks = result.actions.map((action) => action.callback);
    assert.ok(callbacks.includes(`folder:${registry.physiology}`));
  });
});

// ---------------------------------------------------------------------------
// End-to-end: Telegram text -> workflow -> intent -> provider -> guard ->
// formatter -> Telegram response. The user must see only the final answer.
// ---------------------------------------------------------------------------
describe('end-to-end assistant flow', () => {
  /** One stub serving discovery, probes, generation and PubMed. */
  function endToEndFetch({ answer }) {
    const fn = async (url) => {
      const target = String(url);
      if (target.includes('api.groq.com/openai/v1/models')) {
        return okJson({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      }
      if (target.includes('/v1beta/models') || target.includes('openrouter.ai/api/v1/models')) {
        return okJson({ models: [], data: [] });
      }
      if (target.includes('esearch.fcgi')) return okJson({ esearchresult: { idlist: [] } });
      if (target.includes('efetch.fcgi')) return okText('<PubmedArticleSet></PubmedArticleSet>');
      if (target.includes('chat/completions') || target.includes(':generateContent')) {
        return okJson({ choices: [{ message: { content: answer } }] });
      }
      return { ok: false, status: 404, text: async () => '' };
    };
    return fn;
  }

  it('delivers only the final answer for a medical question, with no meta text', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const bot = new FakeBot();
    const student = 9850;
    db.registerUser(student, 'student', 'Student');

    const ctx = messageCtx(bot, student, 'What is osteosarcoma?');
    workflow.begin(ctx, assistant.ASSISTANT_WORKFLOW);
    ctx.userData.ai_mode = 'chat';

    const cleanAnswer =
      '🩺 Osteosarcoma\n\n' +
      'English — Academic\n' +
      'Osteosarcoma is a malignant bone tumour of primitive bone-forming cells.\n\n' +
      'العربية — شرح مختصر\n' +
      'ورم خبيث ينشأ من الخلايا المكوّنة للعظم.';

    await withGlobalFetch(endToEndFetch({ answer: cleanAnswer }), () =>
      assistant.handleAssistantText(ctx),
    );

    const final = bot.messagesTo(student).at(-1) ?? '';
    assert.match(final, /Osteosarcoma is a malignant bone tumour/);
    assert.match(final, /العربية — شرح مختصر/);
    for (const marker of ['Internal Monologue', 'Draft', 'Analysis', 'Reasoning', 'system prompt']) {
      assert.doesNotMatch(final, new RegExp(marker, 'i'), `${marker} must not reach the user`);
    }
  });

  it('never forwards a leaking provider answer to Telegram', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const bot = new FakeBot();
    const student = 9851;
    db.registerUser(student, 'student2', 'Student2');

    const ctx = messageCtx(bot, student, 'What is osteosarcoma?');
    workflow.begin(ctx, assistant.ASSISTANT_WORKFLOW);
    ctx.userData.ai_mode = 'chat';

    const leaking = 'Internal Monologue: let me reason about osteosarcoma.';
    await withGlobalFetch(endToEndFetch({ answer: leaking }), () =>
      assistant.handleAssistantText(ctx),
    );

    const final = bot.messagesTo(student).at(-1) ?? '';
    assert.doesNotMatch(final, /Internal Monologue/i, 'the leak is never delivered');
    assert.match(final, /تعذر الوصول|غير متاح|يرجى المحاولة/, 'a safe fallback is delivered instead');
  });
});

// ---------------------------------------------------------------------------
// 18: RBAC untouched
// ---------------------------------------------------------------------------
describe('RBAC remains unchanged', () => {
  it('still resolves the role presets through the existing constants', () => {
    // A light guard: the reliability work must not touch authorization. The
    // full contract lives in test/rbac.test.js and still runs in `npm test`.
    assert.equal(db.ROLE_PERMISSION_PRESETS.owner.can_admins, true);
    assert.equal(db.ROLE_PERMISSION_PRESETS.reviewer.can_folders, false);
    assert.equal(db.ROLE_PERMISSION_PRESETS.admin.can_admins, false);
  });
});
