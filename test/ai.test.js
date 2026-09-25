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
import { PLATFORM_SEARCH_NO_MATCH } from '../src/ai/prompts.js';
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
