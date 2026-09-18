/**
 * Offline/browser-safe mechanical scoring; no inference, dependencies, or I/O.
 *
 * scoreCase(corpus.cases[0], {
 *   id: "C01", text: "...", warnings: [], engine: "harper", elapsedMs: 12,
 * });
 * summarize(corpus.cases, results); // One final result per ID per run.
 *
 * Result: { id, text, warnings: string[], engine, elapsedMs?,
 *           outcome?: "produced" | "rejected" | "error", error?: string,
 *           rejectionReason?: string }.
 * outcome defaults to "error" when error is present, otherwise "produced".
 * For rejected/error outcomes, text may be absent/null or the retained input;
 * it is NOT scored as an accepted rewrite. Label a guarded fallback explicitly
 * as rejected rather than disguising it as a successful unchanged result.
 * Omitted cases become "missing". Warnings never imply rejection on their own.
 * Additional raw/retry fields are ignored: this scorer cannot observe retries,
 * token counts, model downloads, cache state, memory, or cold/warm timing.
 *
 * References are exact code-unit matches, with no trimming/case/Unicode/line
 * ending normalization. A nonmatch is not a grammar or semantic failure.
 * Literal/span checks are evidence, not semantic equivalence tests. Even an
 * exact-reference edit needs manual meaning review. Source annotations also
 * require independent manual review as described in grammar-corpus.json.
 */

const CATEGORIES = new Set(["correct", "annotated-error", "protected-fact-adversarial"]);
const SPLITS = new Set(["development", "heldout"]);
const OUTCOMES = new Set(["produced", "rejected", "error"]);
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

function requireCondition(condition, message) {
  if (!condition) throw new TypeError(message);
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values, label) {
  requireCondition(
    Array.isArray(values) && values.length > 0 && values.every(isText)
      && new Set(values).size === values.length,
    `${label} must be a nonempty array of distinct nonblank strings.`,
  );
}

function countLiteral(text, value) {
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = text.indexOf(value, offset);
    if (index < 0) return count;
    const end = index + value.length;
    const before = Array.from(text.slice(0, index)).at(-1) ?? "";
    const after = Array.from(text.slice(end)).at(0) ?? "";
    const first = Array.from(value).at(0);
    const last = Array.from(value).at(-1);
    const wordStart = WORD_CHARACTER.test(first) && WORD_CHARACTER.test(before);
    const wordEnd = WORD_CHARACTER.test(last) && WORD_CHARACTER.test(after);
    const numericStart = /^[\p{Sc}]?\d/u.test(value) && /[+\-−.\d]/u.test(before);
    const numericEnd = /\d$/u.test(value) && /^\.\d/u.test(text.slice(end));
    if (!wordStart && !wordEnd && !numericStart && !numericEnd) count += 1;
    offset = end;
  }
}

function countUrl(text, value) {
  // Sentence punctuation is not part of the URL token in this corpus. URL
  // facts themselves never end with these ambiguous punctuation characters.
  const tokens = text.match(/https?:\/\/[^\s<>"'`]+/gu) ?? [];
  return tokens.filter((token) => token.replace(/[.,;:!?)\]}]+$/u, "") === value).length;
}

function paragraphBreaks(text) {
  return (text.match(/\r?\n[ \t]*(?:\r?\n)+/gu) ?? []).length;
}

function factCount(text, fact) {
  if (fact.kind === "paragraph-breaks") return paragraphBreaks(text);
  if (fact.kind === "url") return countUrl(text, fact.value);
  return countLiteral(text, fact.value);
}

function validateCase(testCase) {
  requireCondition(testCase && typeof testCase === "object", "A case object is required.");
  const label = `Case ${testCase.id ?? "(without ID)"}`;
  requireCondition(isText(testCase.id), `${label}: id is required.`);
  requireCondition(CATEGORIES.has(testCase.category), `${label}: invalid category.`);
  requireCondition(SPLITS.has(testCase.split), `${label}: invalid split.`);
  requireCondition(isText(testCase.input), `${label}: input must be nonblank.`);
  requireCondition(typeof testCase.expectedNoop === "boolean", `${label}: expectedNoop must be boolean.`);
  uniqueStrings(testCase.acceptableOutputs, `${label}: acceptableOutputs`);
  requireCondition(Array.isArray(testCase.errors), `${label}: errors must be an array.`);
  requireCondition(Array.isArray(testCase.protectedFacts), `${label}: protectedFacts must be an array.`);
  requireCondition(isText(testCase.reviewNotes), `${label}: reviewNotes are required.`);
  const errorIds = new Set();
  for (const error of testCase.errors) {
    requireCondition(
      error && isText(error.id) && !errorIds.has(error.id) && isText(error.kind),
      `${label}: annotation IDs must be distinct and kind must be specified.`,
    );
    errorIds.add(error.id);
    requireCondition(
      isText(error.original) && countLiteral(testCase.input, error.original) > 0,
      `${label}: annotation ${error.id} must identify an original input span.`,
    );
    uniqueStrings(error.corrections, `${label}: annotation ${error.id} corrections`);
    requireCondition(
      !error.corrections.includes(error.original),
      `${label}: an unchanged error span cannot be a correction.`,
    );
    for (const reference of testCase.acceptableOutputs) {
      requireCondition(
        error.corrections.some((correction) => countLiteral(reference, correction) > 0)
          && countLiteral(reference, error.original) === 0,
        `${label}: reference does not resolve annotation ${error.id}.`,
      );
    }
  }
  if (testCase.expectedNoop) {
    requireCondition(
      testCase.errors.length === 0 && testCase.acceptableOutputs.includes(testCase.input),
      `${label}: a safe no-op requires no annotated errors and an unchanged reference.`,
    );
  } else {
    requireCondition(
      testCase.errors.length > 0 && !testCase.acceptableOutputs.includes(testCase.input),
      `${label}: a correction case needs annotations and cannot accept unchanged input.`,
    );
  }
  requireCondition(
    testCase.category !== "correct" || testCase.expectedNoop,
    `${label}: correct-category cases must allow a no-op.`,
  );
  requireCondition(
    testCase.category !== "annotated-error" || testCase.errors.length > 0,
    `${label}: annotated-error cases need annotations.`,
  );
  const factIds = new Set();
  for (const fact of testCase.protectedFacts) {
    requireCondition(
      fact && isText(fact.id) && !factIds.has(fact.id),
      `${label}: protected fact IDs must be distinct.`,
    );
    factIds.add(fact.id);
    requireCondition(
      ["literal", "url", "paragraph-breaks", "meaning"].includes(fact.kind),
      `${label}: invalid protected fact kind.`,
    );
    if (fact.kind === "meaning") {
      requireCondition(isText(fact.description), `${label}: meaning facts need a description.`);
      continue;
    }
    requireCondition(
      Number.isInteger(fact.count) && fact.count >= 0
        && (fact.kind === "paragraph-breaks" || (fact.count > 0 && isText(fact.value))),
      `${label}: literal/URL facts need a value and positive count; paragraph counts are nonnegative.`,
    );
    if (fact.kind === "url") {
      requireCondition(
        /^https?:\/\/[^\s<>"'`]+$/u.test(fact.value) && !/[.,;:!?)\]}]$/u.test(fact.value),
        `${label}: URL facts must be unambiguous complete URL tokens.`,
      );
    }
    requireCondition(
      factCount(testCase.input, fact) === fact.count,
      `${label}: protected fact ${fact.id} count does not match the source.`,
    );
    requireCondition(
      testCase.acceptableOutputs.every((reference) => factCount(reference, fact) === fact.count),
      `${label}: a reference changes protected fact ${fact.id}.`,
    );
  }
}

function validateResult(testCase, result) {
  requireCondition(result && typeof result === "object", `Result ${testCase.id} must be an object.`);
  requireCondition(result.id === testCase.id, `Result ID must equal case ID ${testCase.id}.`);
  requireCondition(isText(result.engine), `Result ${testCase.id}: engine is required.`);
  requireCondition(
    Array.isArray(result.warnings) && result.warnings.every((warning) => typeof warning === "string"),
    `Result ${testCase.id}: warnings must be an array of strings.`,
  );
  requireCondition(
    result.elapsedMs === undefined
      || (Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0),
    `Result ${testCase.id}: elapsedMs must be a finite nonnegative number when supplied.`,
  );
  requireCondition(
    result.error == null || isText(result.error),
    `Result ${testCase.id}: error must be a nonblank string when supplied.`,
  );
  requireCondition(
    result.rejectionReason === undefined || isText(result.rejectionReason),
    `Result ${testCase.id}: rejectionReason must be a nonblank string when supplied.`,
  );
  const outcome = result.outcome ?? (result.error != null ? "error" : "produced");
  requireCondition(OUTCOMES.has(outcome), `Result ${testCase.id}: invalid outcome.`);
  requireCondition(
    result.error == null || outcome === "error",
    `Result ${testCase.id}: error conflicts with a non-error outcome.`,
  );
  requireCondition(
    outcome === "produced" ? typeof result.text === "string"
      : result.text == null || typeof result.text === "string",
    `Result ${testCase.id}: produced outcomes need text; other outcomes allow absent text.`,
  );
  return outcome;
}

/**
 * Score one case. failedChecks describe explicit benchmark constraints only;
 * no overall accuracy, grammaticality, or semantic-equivalence grade is given.
 * null means "not evaluated", not false/success.
 */
export function scoreCase(testCase, result) {
  validateCase(testCase);
  const outcome = result == null ? "missing" : validateResult(testCase, result);
  const produced = outcome === "produced";
  const text = produced ? result.text : null;
  const unchanged = produced ? text === testCase.input : null;
  const facts = testCase.protectedFacts.filter((fact) => fact.kind !== "meaning");
  const protectedFactChecks = produced ? facts.map((fact) => {
    const actualCount = factCount(text, fact);
    return {
      id: fact.id, kind: fact.kind, value: fact.value ?? null,
      expectedCount: fact.count, actualCount, matched: actualCount === fact.count,
    };
  }) : [];
  const annotationChecks = produced ? testCase.errors.map((error) => {
    const originalObserved = countLiteral(text, error.original) > 0;
    const correctionObserved = error.corrections.some((correction) => countLiteral(text, correction) > 0);
    return {
      id: error.id, originalObserved, correctionObserved,
      evidence: originalObserved ? "original-span-retained"
        : correctionObserved ? "listed-correction-observed" : "unrecognized-rephrasing",
    };
  }) : [];
  const unchangedOnError = produced ? unchanged && testCase.errors.length > 0 : null;
  const failedChecks = [];
  if (unchangedOnError) failedChecks.push("unchanged-annotated-error");
  if (produced && text.trim().length === 0) failedChecks.push("empty-output");
  if (protectedFactChecks.some((check) => !check.matched)) failedChecks.push("protected-fact-mismatch");
  return {
    id: testCase.id,
    category: testCase.category,
    split: testCase.split,
    engine: result?.engine ?? null,
    outcome,
    elapsedMs: result?.elapsedMs ?? null,
    warnings: result?.warnings ? [...result.warnings] : [],
    error: result?.error ?? null,
    rejectionReason: result?.rejectionReason ?? null,
    hasAnnotatedErrors: testCase.errors.length > 0,
    expectedNoop: testCase.expectedNoop,
    mechanicallyCheckableFactCount: facts.length,
    unchanged,
    unchangedOnError,
    acceptedNoop: produced ? testCase.expectedNoop && unchanged : null,
    cleanTextEdited: produced ? testCase.category === "correct" && !unchanged : null,
    expectedNoopEdited: produced ? testCase.expectedNoop && !unchanged : null,
    exactReferenceMatch: produced ? testCase.acceptableOutputs.includes(text) : null,
    annotationChecks,
    protectedFactChecks,
    manualMeaningFacts: testCase.protectedFacts
      .filter((fact) => fact.kind === "meaning")
      .map((fact) => ({ id: fact.id, description: fact.description })),
    reviewNotes: testCase.reviewNotes,
    failedChecks,
    needsReview: !produced || !unchanged || testCase.errors.length > 0 || result.warnings.length > 0,
    meaningPreservation: "not-assessed",
  };
}

function latencySummary(scores) {
  const values = scores.map((score) => score.elapsedMs).filter((value) => value !== null)
    .sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    samples: values.length,
    min: values[0] ?? null,
    median: values.length === 0 ? null
      : values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    p95: values.length === 0 ? null : values[Math.ceil(values.length * 0.95) - 1],
    max: values.at(-1) ?? null,
  };
}

function countOutcomes(scores) {
  return Object.fromEntries(["produced", "rejected", "error", "missing"]
    .map((outcome) => [outcome, scores.filter((score) => score.outcome === outcome).length]));
}

function summarizeScores(scores) {
  const produced = scores.filter((score) => score.outcome === "produced");
  const annotated = scores.filter((score) => score.hasAnnotatedErrors);
  const clean = scores.filter((score) => score.category === "correct");
  const noops = scores.filter((score) => score.expectedNoop);
  const referenceMatches = produced.filter((score) => score.exactReferenceMatch).length;
  const errorReferenceMatches = annotated.filter((score) => score.exactReferenceMatch === true).length;
  const factChecks = produced.flatMap((score) => score.protectedFactChecks);
  return {
    totalCases: scores.length,
    outcomes: countOutcomes(scores),
    exactReference: {
      matches: referenceMatches,
      eligibleCases: scores.length,
      producedNonmatches: produced.filter((score) => !score.exactReferenceMatch).length,
      rate: scores.length === 0 ? null : referenceMatches / scores.length,
    },
    annotatedErrors: {
      cases: annotated.length,
      outcomes: countOutcomes(annotated),
      unchangedFailures: annotated.filter((score) => score.unchangedOnError).length,
      exactReferenceMatches: errorReferenceMatches,
      exactReferenceRate: annotated.length === 0 ? null : errorReferenceMatches / annotated.length,
      retainedSpanCases: annotated.filter((score) => score.annotationChecks
        .some((check) => check.originalObserved)).length,
      allListedCorrectionsObserved: annotated.filter((score) => score.outcome === "produced"
        && score.annotationChecks.every((check) => !check.originalObserved && check.correctionObserved)).length,
      unrecognizedRephrasingCases: annotated.filter((score) => score.annotationChecks
        .some((check) => check.evidence === "unrecognized-rephrasing")).length,
    },
    cleanText: {
      cases: clean.length,
      outcomes: countOutcomes(clean),
      unchanged: clean.filter((score) => score.unchanged === true).length,
      edited: clean.filter((score) => score.cleanTextEdited).length,
    },
    expectedNoop: {
      cases: noops.length,
      outcomes: countOutcomes(noops),
      preserved: noops.filter((score) => score.acceptedNoop).length,
      edited: noops.filter((score) => score.expectedNoopEdited).length,
    },
    protectedFacts: {
      eligibleCases: scores.filter((score) => score.mechanicallyCheckableFactCount > 0).length,
      evaluatedCases: produced.filter((score) => score.mechanicallyCheckableFactCount > 0).length,
      checkedFacts: factChecks.length,
      mismatchedFacts: factChecks.filter((check) => !check.matched).length,
      mismatchCases: produced.filter((score) => score.protectedFactChecks.some((check) => !check.matched)).length,
    },
    casesWithFailedChecks: scores.filter((score) => score.failedChecks.length > 0).length,
    needsReview: scores.filter((score) => score.needsReview).length,
    resultsWithWarnings: scores.filter((score) => score.warnings.length > 0).length,
    latencyMs: latencySummary(scores),
    producedLatencyMs: latencySummary(produced),
  };
}

/**
 * Summarize one run. Duplicate/unknown IDs are errors, not silently discarded
 * results. Missing cases stay in denominators. Call separately for each run;
 * compare heldout/development and error/clean strata rather than a single score.
 */
export function summarize(cases, results) {
  requireCondition(Array.isArray(cases) && Array.isArray(results), "cases and results must be arrays.");
  const caseIds = new Set();
  for (const testCase of cases) {
    validateCase(testCase);
    requireCondition(!caseIds.has(testCase.id), `Duplicate case ID ${testCase.id}.`);
    caseIds.add(testCase.id);
  }
  const byId = new Map();
  for (const result of results) {
    requireCondition(result && caseIds.has(result.id), `Unknown result ID ${result?.id ?? "(missing)"}.`);
    requireCondition(!byId.has(result.id), `Duplicate result ID ${result.id}; summarize each run separately.`);
    byId.set(result.id, result);
  }
  const scores = cases.map((testCase) => scoreCase(testCase, byId.get(testCase.id)));
  return {
    schemaVersion: 1,
    interpretation: {
      exactReference: "Narrow exact-string reference hit rate, not grammar accuracy. Nonmatches may be valid paraphrases.",
      denominator: "All eligible cases, including rejected, errored, and missing results; see outcomes separately.",
      annotationEvidence: "Listed spans only. Observing a replacement is not proof that all errors or meaning were preserved.",
      cleanEdits: "Edits to designated clean/no-op inputs are counted separately, not automatically labeled ungrammatical.",
      protectedFacts: "Exact literal/URL occurrence and paragraph-boundary counts only; associations, order, intent, and negation scope require manual review.",
      review: "Manually audit source annotations/references and edited outputs, including exact-reference hits. Unchanged clean results alone need no output meaning comparison.",
      latency: "Only explicitly supplied elapsedMs values; all-outcome and produced-only distributions. p95 uses nearest rank; no cold/warm, retry, download, or memory metrics inferred.",
    },
    ...summarizeScores(scores),
    engines: [...new Set(scores.map((score) => score.engine).filter((engine) => engine !== null))].sort(),
    byCategory: Object.fromEntries([...CATEGORIES]
      .map((category) => [category, summarizeScores(scores.filter((score) => score.category === category))])),
    bySplit: Object.fromEntries([...SPLITS]
      .map((split) => [split, summarizeScores(scores.filter((score) => score.split === split))])),
    scores,
  };
}
