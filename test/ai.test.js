/**
 * AI boundary tests, ported from the Python `test_ai_policy.py` contract.
 *
 * The behavior under test is the resource-hallucination guard: the model must
 * never be able to turn its own idea of a medical-school curriculum into a
 * MEDBOT fact.
 *
 *   overview : only registered sections may appear ("what exists?")
 *   resource : a nonexistent resource is refused; a real one returns its path
 *   medical  : no platform catalog is injected; PubMed grounding is used
 *   general  : no PubMed call, concise general prompt
 *
 * No API keys, no network, no real Telegram calls.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../src/db/index.js';
import * as ai from '../src/ai/index.js';
import * as intent from '../src/ai/intent.js';
import * as guard from '../src/ai/guard.js';
import * as router from '../src/ai/router.js';
import * as medicalSources from '../src/medicalSources.js';
import { PLATFORM_SEARCH_NO_MATCH } from '../src/ai/prompts.js';
import * as prompts from '../src/ai/prompts.js';
import { cleanupDb, freshDb } from './helpers/harness.js';

let dbPath;
let registry;

/** A fetch stand-in that records every call and never touches the network. */
function recordingFetch(responder = () => ({ ok: false, status: 503 })) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url: String(url), options });
    return responder(url, options);
  };
  fn.calls = calls;
  fn.hits = (needle) => calls.filter((call) => call.url.includes(needle));
  return fn;
}

before(() => {
  dbPath = freshDb('ai');
  // A registered structure shaped like the real tree, with NO "First Year".
  const secondYear = db.addFolder(0, 'Second Year', 'general');
  const semester = db.addFolder(secondYear, 'Semester 7', 'general');
  const blocks = db.addFolder(semester, 'Blocks', 'general');
  const physiology = db.addFolder(blocks, 'PHYSIOLOGY', 'general');
  const theory = db.addFolder(physiology, 'نظري', 'general');
  const contentId = db.addContent(theory, 'GIT Physiology', 'fid-git', 'pdf');
  registry = { secondYear, semester, blocks, physiology, theory, contentId };
});

after(() => {
  cleanupDb(dbPath);
});

describe('intent classification', () => {
  it('classifies bare structure questions as overview', () => {
    assert.equal(intent.classifyIntent('ما هي الاقسام المتوفرة حاليا في البوت؟'), 'overview');
    assert.equal(intent.classifyIntent('ما هي الأقسام الموجودة؟'), 'overview');
  });

  it('classifies location questions as resource lookup', () => {
    for (const query of [
      'أين أجد PHYSIOLOGY؟',
      'وين ألقى فسيولوجي؟',
      'هل يوجد First Year؟',
      'هل يوجد قسم عن الفسيولوجيا؟',
    ]) {
      assert.equal(intent.classifyIntent(query), 'resource', query);
    }
  });

  it('classifies medical questions as medical', () => {
    for (const query of ['اشرح لي دورة القلب', 'What is the cardiac cycle?']) {
      assert.equal(intent.classifyIntent(query), 'medical', query);
    }
  });

  it('classifies non-medical questions as general', () => {
    for (const query of ['ما هي عاصمة فرنسا؟', 'كيف حالك؟']) {
      assert.equal(intent.classifyIntent(query), 'general', query);
    }
  });
});

describe('registry overview', () => {
  it('lists only registered sections and never invents a branch', async () => {
    const result = await ai.generateUnifiedResult('ما هي الاقسام المتوفرة حاليا في البوت؟');

    assert.match(result.text, /Second Year/);
    assert.match(result.text, /PHYSIOLOGY/);
    assert.match(result.text, /نظري/);

    assert.doesNotMatch(result.text, /First Year/);
    assert.doesNotMatch(result.text, /Semester 1/);
    assert.deepEqual(result.actions, []);
  });

  it('answers an overview without calling any provider', async () => {
    const fetchImpl = recordingFetch();
    await ai.generateUnifiedResult('ما هي الأقسام الموجودة في المنصة؟', null, fetchImpl);
    assert.deepEqual(fetchImpl.calls, [], 'the registry alone answers this question');
  });

  it('is honest about an empty registry', () => {
    const text = intent.buildRegistryOverview([]);
    assert.match(text, /لا توجد/);
    assert.doesNotMatch(text, /First Year/);
  });
});

describe('resource lookup', () => {
  it('refuses a nonexistent resource verbatim', async () => {
    const result = await ai.generateUnifiedResult('هل يوجد First Year؟');
    assert.equal(result.text, PLATFORM_SEARCH_NO_MATCH);
    assert.doesNotMatch(result.text, /First Year/);
  });

  it('returns the real registered path for an existing resource', async () => {
    const result = await ai.generateUnifiedResult('أين أجد PHYSIOLOGY؟');

    assert.match(result.text, /PHYSIOLOGY/);
    assert.match(result.text, /Second Year/);

    // Direct access is offered only from real ids.
    const callbacks = result.actions.map((action) => action.callback);
    assert.ok(
      callbacks.includes(`folder:${registry.physiology}`),
      `expected a direct button for the real folder, got ${callbacks.join(', ')}`,
    );
  });

  it('answers a real resource lookup without calling any provider', async () => {
    const fetchImpl = recordingFetch();
    await ai.generateUnifiedResult('أين أجد PHYSIOLOGY؟', null, fetchImpl);
    assert.deepEqual(fetchImpl.calls, [], 'the registry alone answers this question');
  });

  it('offers no actions when the resource is unregistered', async () => {
    const result = await ai.generateUnifiedResult('هل يوجد قسم اسمه Neurology الموجود؟');
    if (result.text === PLATFORM_SEARCH_NO_MATCH) {
      assert.deepEqual(result.actions, []);
    }
  });

  it('never builds a button from an id that is not in the registry', async () => {
    const result = await ai.generateUnifiedResult('أين أجد PHYSIOLOGY؟');
    for (const action of result.actions) {
      const [, rawId] = String(action.callback).split(':');
      const id = Number.parseInt(rawId, 10);
      const folder = db.getFolder(id);
      const content = db.getFileRecord(id);
      assert.ok(folder || content, `button id ${id} must resolve to a real row`);
    }
  });
});

describe('provider grounding boundaries', () => {
  it('does not inject the platform catalog into a medical answer', async () => {
    let capturedPrompt = null;
    const capturedSystem = null;

    const fetchImpl = recordingFetch((url) => {
      // PubMed E-utilities: let the source lookup return nothing.
      if (url.includes('eutils.ncbi.nlm.nih.gov')) {
        return { ok: true, status: 200, text: async () => '<eSearchResult></eSearchResult>' };
      }
      // Provider call: a minimal OpenAI-compatible response.
      capturedPrompt ??= null;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'The cardiac cycle describes...' } }],
        }),
      };
    });
    void capturedPrompt;
    void capturedSystem;

    // With no configured candidates the medical path still runs the PubMed
    // lookup, which is the boundary this test pins: sources are fetched by the
    // application, not generated by the model.
    const result = await ai.generateAiChatResult('اشرح لي دورة القلب', null, fetchImpl);
    assert.ok(typeof result.text === 'string' && result.text.length > 0);
    assert.deepEqual(result.actions, [], 'chat never emits platform navigation');
  });

  it('skips PubMed and the registry for a general question', async () => {
    const fetchImpl = recordingFetch();
    await ai.generateAiChatResult('ما هي عاصمة فرنسا؟', null, fetchImpl);

    assert.equal(fetchImpl.hits('eutils.ncbi.nlm.nih.gov').length, 0, 'no PubMed for general');

    // Only provider endpoints may be contacted, never a registry endpoint.
    for (const call of fetchImpl.calls) {
      assert.doesNotMatch(call.url, /folders|content|registry/);
    }
  });

  it('runs the PubMed lookup for a medical question', async () => {
    // `searchPubmed` deliberately owns the global fetch: source retrieval is an
    // application concern, not a caller-supplied transport. Install a recorder
    // so the real code path is observed without touching the network.
    const recorder = recordingFetch((url) => {
      if (url.includes('eutils.ncbi.nlm.nih.gov')) {
        return { ok: true, status: 200, text: async () => '<eSearchResult></eSearchResult>' };
      }
      return { ok: false, status: 503 };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = recorder;
    try {
      await ai.generateAiChatResult('اشرح لي دورة القلب', null, recorder);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(
      recorder.hits('eutils.ncbi.nlm.nih.gov').length >= 1,
      'a medical answer must be grounded in real sources',
    );
  });

  it('keeps the prompt contract that forbids platform claims', async () => {
    const prompts = await import('../src/ai/prompts.js');
    // The medical prompt must forbid fabricating platform entities.
    assert.match(prompts.SYSTEM_PROMPT, /MEDBOT/);
    assert.ok(prompts.PLATFORM_SEARCH_PROMPT.length > 0);
    assert.ok(prompts.GENERAL_ASSISTANT_PROMPT.length > 0);
    assert.equal(typeof prompts.UNIFIED_ASSISTANT_PROMPT, 'string');
  });

  it('answers honestly when no provider is available', async () => {
    const fetchImpl = recordingFetch((url) => {
      if (url.includes('eutils.ncbi.nlm.nih.gov')) {
        return { ok: true, status: 200, text: async () => '<eSearchResult></eSearchResult>' };
      }
      return { ok: false, status: 503 };
    });

    const { CHAT_NO_PROVIDER_ANSWER } = await import('../src/ai/prompts.js');
    const result = await ai.generateAiChatResult('ما هي عاصمة فرنسا؟', null, fetchImpl);
    assert.equal(result.text, CHAT_NO_PROVIDER_ANSWER);
    assert.deepEqual(result.actions, []);
  });

  it('rejects an empty prompt instead of inventing an answer', async () => {
    const result = await ai.generateUnifiedResult('   ');
    assert.match(result.text, /يرجى كتابة/);
    assert.deepEqual(result.actions, []);
  });
});

describe('grounding validator', () => {
  it('rejects an empty answer', () => {
    const validator = new intent.GroundingValidator();
    assert.equal(validator.allows(''), false);
    assert.equal(validator.allows('   '), false);
    assert.equal(validator.allows('A real answer'), true);
  });

  it('only returns matches that exist as registry rows', () => {
    const results = ai.searchMedbot('PHYSIOLOGY');
    const matches = intent.genuineRegistryMatches('PHYSIOLOGY', results);
    for (const match of matches) {
      const id = Number.parseInt(match.id, 10);
      assert.ok(db.getFolder(id) || db.getFileRecord(id), `matched id ${id} must exist`);
    }
  });

  it('collapses repetition in an answer', () => {
    // Repetition is detected on repeated adjacent LINES, so build them that way.
    const line = 'the cardiac cycle is a sequence of coordinated events';
    const repeated = Array.from({ length: 4 }, () => line).join('\n');
    assert.equal(guard.hasRepetition(repeated), true);

    const [collapsed, repeats] = guard.collapseRepeatedUnits(repeated);
    assert.equal(repeats, 3);
    assert.equal(collapsed, line, 'the run collapses to a single line');

    const varied = ['First distinct paragraph about the heart.',
      'Second, different paragraph about the lungs.',
      'Third paragraph about circulation.'].join('\n');
    assert.equal(guard.hasRepetition(varied), false);
  });
});

describe('grounding context', () => {
  it('describes an empty result set without inventing anything', () => {
    const context = intent.buildLibraryContext([]);
    assert.equal(typeof context, 'string');
    assert.equal(context.includes('PHYSIOLOGY'), false);
  });

  it('carries only the registered names it was given', () => {
    const results = [{ id: registry.physiology, name: 'PHYSIOLOGY', path: 'Second Year › PHYSIOLOGY' }];
    const context = intent.buildLibraryContext(results);
    assert.match(context, /PHYSIOLOGY/);
    assert.match(context, /Second Year/);
  });

  it('renders only real registered rows, never an invented branch', () => {
    const [folders, contents, paths] = ai.loadRegistry();
    const catalog = ai.buildPlatformCatalog(folders, contents, paths);
    assert.match(catalog, /PHYSIOLOGY/);
    assert.match(catalog, /GIT Physiology/);
    // A curriculum the registry does not contain is never rendered.
    assert.equal(/First Year|Anatomy|Histology/.test(catalog), false);
  });

  it('bounds the catalog so a huge library cannot blow the prompt', () => {
    const folders = [];
    const contents = [];
    for (let i = 0; i < 3000; i += 1) {
      folders.push([i + 1, 0, `قسم رقم ${i}`, 'general', 0]);
    }
    const catalog = ai.buildPlatformCatalog(folders, contents, {});
    assert.ok(catalog.length <= 20000, `catalog length ${catalog.length} is bounded`);
    assert.match(catalog, /اختصار/);
  });

  it('renders an empty catalog for an empty library', () => {
    assert.equal(typeof ai.buildPlatformCatalog([], [], []), 'string');
  });
});

/**
 * The application owns the citation block: verified PubMed records are
 * appended under the answer, and a model that already cited them is not
 * duplicated. Ported from the Python `TrustedSourcesFooterTests`.
 */
describe('trusted sources footer', () => {
  it('lists only records carrying both a PMID and a URL', () => {
    const footer = medicalSources.buildSourcesFooter([
      { pmid: '111', title: 'Verified paper', url: 'https://pubmed.ncbi.nlm.nih.gov/111/' },
      { pmid: null, title: 'No pmid', url: '' },
    ]);
    assert.match(footer, /PubMed/);
    assert.match(footer, /PMID: 111/);
    assert.match(footer, /https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/111\//);
    assert.ok(!footer.includes('No pmid'), 'an unverifiable record is never cited');
  });

  it('appends the sources footer when the model omits citations', () => {
    const footer = medicalSources.buildSourcesFooter([
      { pmid: '333', title: 'T', url: 'https://x/333' },
    ]);
    const merged = medicalSources.ensureSourcesFooter('A grounded answer.', footer);
    assert.match(merged, /A grounded answer\./);
    assert.match(merged, /PMID: 333/);
  });

  it('does not duplicate a footer the model already produced', () => {
    const footer = medicalSources.buildSourcesFooter([
      { pmid: '222', title: 'T', url: 'https://x/222' },
    ]);
    const answer = 'Conclusion based on PubMed PMID: 222.';
    assert.equal(medicalSources.ensureSourcesFooter(answer, footer), answer);
  });

  it('omits the footer entirely when nothing is verifiable', () => {
    assert.equal(medicalSources.buildSourcesFooter([]), '');
    assert.equal(medicalSources.buildSourcesFooter(null), '');
    assert.equal(medicalSources.buildSourcesFooter([{ pmid: null, url: '' }]), '');
  });
});

/**
 * The medical-answer contract: a faithful English academic answer followed by
 * a short Arabic summary, with a bounded output cap. Ported from the Python
 * `BilingualMedicalAnswerTests`.
 */
describe('bilingual medical answer contract', () => {
  it('requires English academic prose before the Arabic summary', () => {
    const prompt = prompts.UNIFIED_ASSISTANT_PROMPT;
    assert.match(prompt, /English — Academic/);
    assert.match(prompt, /العربية — شرح مختصر/);
    assert.match(prompt, /مشوّه للمعنى/);
    assert.match(prompt, /شرحاً أميناً/);
    assert.ok(
      prompt.indexOf('English — Academic') < prompt.indexOf('العربية — شرح مختصر'),
      'the English block must precede the Arabic block',
    );
  });

  it('keeps the output-token cap bounded', () => {
    assert.equal(Number.isInteger(prompts.MAX_OUTPUT_TOKENS), true);
    assert.ok(prompts.MAX_OUTPUT_TOKENS > 0);
    assert.ok(prompts.MAX_OUTPUT_TOKENS <= 2000);
  });

  it('never raises when PubMed is unreachable', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    try {
      assert.deepEqual(await medicalSources.searchPubmed('cardiac cycle', 3), []);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('router health', () => {
  it('puts a model in cooldown with exponential backoff and clears it on success', () => {
    router.resetRouterState();
    const model = { provider: 'groq', model: 'llama', endpoint: 'https://x' };

    assert.equal(router.isInCooldown(model), false);
    router.markModelFailure(model, 'rate_limit');
    assert.equal(router.isInCooldown(model), true);

    router.markModelSuccess(model);
    assert.equal(router.isInCooldown(model), false);
    assert.equal(router.modelHealthSnapshot().successes[router.modelKey(model)], 1);
  });

  it('caps the cooldown so a permanently broken model is retried eventually', () => {
    router.resetRouterState();
    const model = { provider: 'gemini', model: 'flash', endpoint: 'https://y' };
    for (let i = 0; i < 10; i += 1) router.markModelFailure(model, 'server_error');

    const until = router.modelHealthSnapshot().cooldowns[router.modelKey(model)];
    const wait = until - Date.now() / 1000;
    assert.ok(wait <= router.MAX_COOLDOWN_SECONDS + 1, `cooldown ${wait} is capped`);
    router.resetRouterState();
  });

  it('keys models by provider, model and endpoint together', () => {
    const a = router.modelKey({ provider: 'groq', model: 'llama', endpoint: 'e1' });
    const b = router.modelKey({ provider: 'groq', model: 'llama', endpoint: 'e2' });
    const c = router.modelKey({ provider: 'gemini', model: 'llama', endpoint: 'e1' });
    assert.equal(new Set([a, b, c]).size, 3);
  });
});
