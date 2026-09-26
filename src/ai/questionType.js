/**
 * Deterministic question-type classification.
 *
 * A medical question is not answered the same way at every depth: a bare
 * "what is the sarcomere?" wants a definition, "explain beta oxidation" wants a
 * sequential mechanism, "compare type 1 and type 2 diabetes" wants a structured
 * contrast. Deciding this with a model would add latency, cost a request, and be
 * non-deterministic for obvious questions — so it is decided here, locally, from
 * the question's own surface shape.
 *
 * The classifier is deliberately conservative: it only commits to a specific
 * type on an unambiguous cue, and otherwise falls back to COMPLEX, which allows
 * the deepest structured answer rather than truncating a question it could not
 * read.
 *
 * No network, no database, no model call.
 */

import * as searchEngine from '../searchEngine.js';

export const QUESTION_TYPES = Object.freeze({
  DEFINITION: 'DEFINITION',
  MECHANISM: 'MECHANISM',
  PATHOPHYSIOLOGY: 'PATHOPHYSIOLOGY',
  CLINICAL: 'CLINICAL',
  DIAGNOSIS: 'DIAGNOSIS',
  TREATMENT: 'TREATMENT',
  COMPARISON: 'COMPARISON',
  EXAM_QUESTION: 'EXAM_QUESTION',
  COMPLEX: 'COMPLEX',
});

export const ALL_QUESTION_TYPES = Object.freeze(Object.values(QUESTION_TYPES));

/**
 * Question-type cue patterns, evaluated in priority order.
 *
 * Priority matters: "explain the mechanism of DKA" contains both an "explain"
 * cue (definitional) and a "mechanism" cue; the mechanism reading is the useful
 * one, so MECHANISM is tested before DEFINITION.
 *
 * Arabic cues are matched WITHOUT `\b`: the word boundary is defined on ASCII
 * `\w`, so it never fires between Arabic letters and would silently disable
 * every Arabic pattern.
 */
const TYPE_RULES = [
  {
    type: QUESTION_TYPES.COMPARISON,
    patterns: [
      /\bcompare\b/, /\bcontrast\b/, /\bdifference(?:s)?\b/, /\bdifferential\b/,
      /\bvs\.?\b/, /\bversus\b/, /\bdistinguish\b/,
      /قارن/, /الفرق/, /مقارنه/, /مقارنة/,
    ],
  },
  {
    type: QUESTION_TYPES.PATHOPHYSIOLOGY,
    patterns: [
      /\bpathophysiolog(?:y|ic|ical)\b/, /\bpathogenesis\b/, /\bpathogenic mechanism\b/,
      /المرضيه/, /مرضيه/, /مسببات المرض/, /اليه المرض/, /آليه المرض/,
    ],
  },
  {
    type: QUESTION_TYPES.EXAM_QUESTION,
    patterns: [
      /\bmcq\b/, /\bmultiple choice\b/, /\bboard question\b/, /\bexam question\b/,
      /\bhigh[- ]yield\b/, /\bmost likely\b/, /\bwhich of the following\b/,
      /سؤال امتحان/, /اختيار من متعدد/, /الاكثر احتمالا/, /الأكثر احتمالا/,
    ],
  },
  {
    type: QUESTION_TYPES.DIAGNOSIS,
    patterns: [
      /\bdiagnos(?:is|e|tic|tics)\b/, /\bhow (?:do|would|can) (?:you|we|i) (?:diagnose|investigate)\b/,
      /\binvestigations?\b/, /\bworkup\b/, /\btest(?:s)? (?:for|to confirm)\b/,
      /تشخيص/, /الفحوصات/, /كيف نشخص/, /كيف يتم التشخيص/,
    ],
  },
  {
    type: QUESTION_TYPES.TREATMENT,
    patterns: [
      /\btreat(?:ment|ments|ing)?\b/, /\bmanagement\b/, /\btherap(?:y|ies)\b/,
      /\bhow (?:do|would|can) (?:you|we|i) (?:treat|manage)\b/,
      /علاج/, /معالجه/, /معالجة/, /إداره/, /اداره/,
    ],
  },
  {
    type: QUESTION_TYPES.CLINICAL,
    patterns: [
      /\bclinical(?:ly)?\b/, /\bpatient\b/, /\bpresentation\b/, /\bsigns and symptoms\b/,
      /\bmanifestations?\b/, /\bsymptom(?:s)?\b/,
      /سريري/, /المريض/, /الاعراض/, /الأعراض/,
    ],
  },
  {
    type: QUESTION_TYPES.COMPLEX,
    patterns: [
      /\bdiscuss\b/, /\belaborate\b/, /\banaly[sz]e\b/, /\bevaluate\b/,
      /\bin depth\b/, /\bin detail\b/, /\bcomprehensive\b/, /\bdetailed\b/,
      /بالتفصيل/, /تفصيل/, /ناقش/, /حلل/, /في العمق/,
    ],
  },
  {
    type: QUESTION_TYPES.MECHANISM,
    patterns: [
      /\bmechanism(?:s)?\b/, /\bhow does\b/, /\bhow do\b/, /\bhow is\b/, /\bhow are\b/,
      /\bstep[- ]by[- ]step\b/, /\bsteps?\b/, /\bstages?\b/, /\bpathway\b/,
      /\bprocess of\b/, /\bcascade\b/, /\bcycle\b/,
      /\bexplain\b/, /\bdescribe the process\b/,
      /اليه/, /آليه/, /كيف يعمل/, /كيف تعمل/, /خطوات/, /مراحل/, /المسار/, /فسر/, /اشرح/,
    ],
  },
  {
    type: QUESTION_TYPES.DEFINITION,
    patterns: [
      /^\s*(?:what is|what are|what's)\b/, /^\s*(?:define|definition of)\b/,
      /^ما (?:هو|هي|هى)/, /^ما معنى/, /^عرف/, /^عرّف/, /^تعريف/,
    ],
  },
];

/** Whether the text names a personal clinical situation (never a study answer). */
const PERSONAL_CLINICAL_RE = new RegExp(
  [
    '\\b(?:i|we|my|me|our)\\s+(?:have|had|am|feel|felt|take|took|get|got|notice|noticed|suffer)\\b',
    '\\b(?:should|shall)\\s+i\\b',
    '\\bdo\\s+i\\s+(?:need|have)\\b',
    // Arabic cues are matched without `\b` (see the note above the type rules).
    'أعاني',
    'عندي\\s+(?:ألم|الم|أعراض|اعراض)',
    'طفلي',
    'والدتي',
    'والدي',
  ].join('|'),
);

/**
 * Classify a student question into one question type.
 *
 * Returns one of `QUESTION_TYPES`. A question that matches no specific cue is
 * COMPLEX, which permits the deepest structured answer; the caller may treat
 * COMPLEX as "no special depth instruction".
 */
export function classifyQuestionType(userPrompt) {
  const raw = String(userPrompt ?? '').trim();
  if (!raw) return QUESTION_TYPES.COMPLEX;

  // The normalizer strips punctuation and lowercases, so cues can be matched
  // against a canonical form without worrying about "؟" or trailing periods.
  const normalized = searchEngine.normalizeText(raw).replace(/β/g, 'beta');

  for (const rule of TYPE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) return rule.type;
  }

  return QUESTION_TYPES.COMPLEX;
}

/**
 * Whether the question is a personal clinical situation rather than a study
 * question. Personal questions get a cautious, non-diagnostic depth contract.
 */
export function isPersonalClinicalQuestion(userPrompt) {
  return PERSONAL_CLINICAL_RE.test(searchEngine.normalizeText(userPrompt));
}

/**
 * The depth contract for one question type.
 *
 * Each entry is a short instruction appended to the system prompt. The rules are
 * written to *narrow* the answer — a definition must not drift into genetics,
 * immunotherapy, or research findings — because that drift is the failure this
 * contract exists to prevent.
 */
const DEPTH_CONTRACTS = {
  [QUESTION_TYPES.DEFINITION]: `نمط السؤال: DEFINITION (تعريف).
- ابدأ بتعريف مباشر في جملة واحدة، ثم الوظيفة/البنية الأساسية فقط.
- لا تذكر الأمراض أو الوراثة أو الأبحاث أو العلاج إلا إذا طلبها السؤال صراحةً.
- لا تذكر علاجاً أو تشخيصاً أو دراسات؛ ابقَ على التعريف الأساسي.
- اجعل الفقرة الإنجليزية قصيرة (3-6 جمل).`,

  [QUESTION_TYPES.MECHANISM]: `نمط السؤال: MECHANISM (آلية).
- اشرح الآلية خطوة بخطوة وبالترتيب: السبب ← العملية ← النتيجة.
- استخدم ترقيماً أو نقاطاً مرتبة عندما تكون الآلية متسلسلة.
- لا تُدخل أمراضاً أو علاجاً غير مطلوب.`,

  [QUESTION_TYPES.PATHOPHYSIOLOGY]: `نمط السؤال: PATHOPHYSIOLOGY (آلية مرضية).
- اتبع الترتيب: الفسيولوجيا الطبيعية ← الاضطراب ← الآلية ← المظاهر.
- اجعل كل مرحلة واضحة ومختصرة، دون تفاصيل علاجية غير مطلوبة.`,

  [QUESTION_TYPES.CLINICAL]: `نمط السؤال: CLINICAL (سريري).
- قدّم معلومات سريرية منظمة (العلامات، الأعراض، السياق) بأسلوب تعليمي.
- لا تقدّم تشخيصاً شخصياً ولا تعليمات علاجية غير آمنة.
- اذكر عند الحاجة فقط أن الأمر لا يغني عن تقييم الطبيب.`,

  [QUESTION_TYPES.DIAGNOSIS]: `نمط السؤال: DIAGNOSIS (تشخيص).
- أجب عمّا سُئل عنه في التشخيص فقط، دون توسّع في العلاج أو مواضيع أخرى.
- اجعل النقاط عملية ومحددة (الفحوصات/المعايير) بإيجاز.`,

  [QUESTION_TYPES.TREATMENT]: `نمط السؤال: TREATMENT (علاج).
- أجب عمّا سُئل عنه في العلاج فقط، دون توسّع في التشخيص أو الفسيولوجيا.
- اجعل الإجابة تعليمية عامة، ولا تصف علاجاً شخصياً.`,

  [QUESTION_TYPES.COMPARISON]: `نمط السؤال: COMPARISON (مقارنة).
- قدّم مقارنة منظمة وجهاً لوجه بين العناصر المطلوبة.
- ركّز على الفروق المهمة للامتحان: أوجه التشابه ثم الفروق الجوهرية.`,

  [QUESTION_TYPES.EXAM_QUESTION]: `نمط السؤال: EXAM_QUESTION (سؤال امتحاني).
- قدّم المعلومات عالية الأهمية للامتحان بشكل مركّز ومنظم.
- اذكر الفروق والتنبيهات الشائعة التي تُسأل عنها عادةً.`,

  [QUESTION_TYPES.COMPLEX]: `نمط السؤال: COMPLEX (شرح موسّع).
- يمكنك تقديم شرح منظم أعمق، لكن ابقَ على الموضوع المطلوب فقط.`,
};

/** The depth contract instruction for a question type (COMPLEX default). */
export function depthContractFor(questionType) {
  return DEPTH_CONTRACTS[questionType] ?? DEPTH_CONTRACTS[QUESTION_TYPES.COMPLEX];
}

export function isDefinitionQuestion(userPrompt) {
  return classifyQuestionType(userPrompt) === QUESTION_TYPES.DEFINITION;
}
