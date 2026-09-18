import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scoreCase, summarize } from "./score.mjs";

const corpus = JSON.parse(readFileSync(new URL("./grammar-corpus.json", import.meta.url), "utf8"));
const candidates = JSON.parse(readFileSync(new URL("./model-candidates.json", import.meta.url), "utf8"));
const cases = corpus.cases;

function getCase(id) {
  const found = cases.find((item) => item.id === id);
  assert.ok(found, `Missing fixture ${id}`);
  return found;
}

function resultFor(id, text = getCase(id).acceptableOutputs[0], extra = {}) {
  return { id, text, warnings: [], engine: "test-engine", ...extra };
}

function fact(score, id) {
  const found = score.protectedFactChecks.find((check) => check.id === id);
  assert.ok(found, `Missing fact check ${id}`);
  return found;
}

test("the fixed original corpus has 120 unique cases and balanced category splits", () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(cases.length, 120);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.equal(new Set(cases.map((item) => item.input)).size, cases.length);
  assert.equal(corpus.authorship.sensitiveData, false);
  assert.match(corpus.reviewPolicy.sourceReviewStatus, /required.*not yet completed/u);
  for (const [category, count] of Object.entries({
    correct: 30, "annotated-error": 60, "protected-fact-adversarial": 30,
  })) {
    const stratum = cases.filter((item) => item.category === category);
    assert.equal(stratum.length, count);
    assert.equal(stratum.filter((item) => item.split === "development").length, count * 2 / 3);
    assert.equal(stratum.filter((item) => item.split === "heldout").length, count / 3);
    assert.equal(corpus.counts[category], count);
  }
  assert.equal(cases.filter((item) => item.expectedNoop).length, corpus.counts.expectedNoop);
  assert.equal(cases.filter((item) => item.errors.length > 0).length, corpus.counts.casesWithAnnotatedErrors);
  for (const item of cases) {
    assert.ok(Array.isArray(item.focus) && item.focus.length > 0, item.id);
    assert.equal(item.split === "heldout", Number(item.id.slice(1)) % 3 === 0, item.id);
    assert.equal(item.errors.length === 0, item.expectedNoop, item.id);
  }
});

test("all listed references resolve their annotations and preserve mechanical facts", () => {
  for (const item of cases) {
    for (const reference of item.acceptableOutputs) {
      const score = scoreCase(item, resultFor(item.id, reference));
      assert.equal(score.exactReferenceMatch, true, item.id);
      assert.deepEqual(score.failedChecks, [], item.id);
      assert.ok(score.annotationChecks.every((check) => !check.originalObserved && check.correctionObserved), item.id);
      assert.ok(score.protectedFactChecks.every((check) => check.matched), item.id);
      assert.equal(score.meaningPreservation, "not-assessed", item.id);
      if (item.errors.length) assert.equal(score.needsReview, true, item.id);
    }
  }
});

test("copying everything cannot win error correction even though clean no-ops match", () => {
  const report = summarize(cases, cases.map((item) => resultFor(item.id, item.input)));
  assert.deepEqual(report.outcomes, { produced: 120, rejected: 0, error: 0, missing: 0 });
  assert.equal(report.annotatedErrors.cases, 75);
  assert.equal(report.annotatedErrors.unchangedFailures, 75);
  assert.equal(report.annotatedErrors.retainedSpanCases, 75);
  assert.equal(report.annotatedErrors.exactReferenceMatches, 0);
  assert.equal(report.annotatedErrors.exactReferenceRate, 0);
  assert.equal(report.annotatedErrors.allListedCorrectionsObserved, 0);
  assert.equal(report.cleanText.unchanged, 30);
  assert.equal(report.cleanText.edited, 0);
  assert.equal(report.expectedNoop.preserved, 45);
  assert.equal(report.casesWithFailedChecks, 75);
  assert.equal(report.exactReference.matches, 45);
  assert.equal(report.byCategory["annotated-error"].annotatedErrors.unchangedFailures, 60);
  assert.equal(report.byCategory["protected-fact-adversarial"].annotatedErrors.unchangedFailures, 15);
  assert.equal(report.bySplit.development.totalCases, 80);
  assert.equal(report.bySplit.heldout.totalCases, 40);
  assert.equal("accuracy" in report, false);
  assert.equal("semanticAccuracy" in report, false);
});

test("correct unchanged input is accepted without pretending to assess meaning", () => {
  const item = getCase("C01");
  const score = scoreCase(item, resultFor(item.id, item.input));
  assert.equal(score.acceptedNoop, true);
  assert.equal(score.unchanged, true);
  assert.equal(score.unchangedOnError, false);
  assert.equal(score.cleanTextEdited, false);
  assert.equal(score.exactReferenceMatch, true);
  assert.equal(score.needsReview, false);
  assert.deepEqual(score.failedChecks, []);
  assert.equal(score.meaningPreservation, "not-assessed");
});

test("unlisted valid paraphrases need review rather than being marked wrong", () => {
  const item = getCase("E01");
  const score = scoreCase(item, resultFor(item.id, "Mira goes to the library on foot every Monday."));
  assert.equal(score.exactReferenceMatch, false);
  assert.equal(score.unchangedOnError, false);
  assert.deepEqual(score.failedChecks, []);
  assert.equal(score.annotationChecks[0].evidence, "unrecognized-rephrasing");
  assert.equal(score.needsReview, true);
  assert.equal(score.meaningPreservation, "not-assessed");
  assert.equal("correct" in score, false);
  assert.equal("semanticEquivalent" in score, false);
  const report = summarize([item], [resultFor(item.id, "Mira goes to the library on foot every Monday.")]);
  assert.equal(report.exactReference.producedNonmatches, 1);
  assert.equal(report.annotatedErrors.unrecognizedRephrasingCases, 1);
  assert.equal(report.casesWithFailedChecks, 0);
});

test("clean-text edits are counted separately from correction and grammaticality", () => {
  const item = getCase("C01");
  const result = resultFor(item.id, "Mira checks the latch prior to leaving.");
  const score = scoreCase(item, result);
  assert.equal(score.cleanTextEdited, true);
  assert.equal(score.expectedNoopEdited, true);
  assert.equal(score.needsReview, true);
  assert.deepEqual(score.failedChecks, []);
  const report = summarize([item], [result]);
  assert.equal(report.cleanText.edited, 1);
  assert.equal(report.annotatedErrors.cases, 0);
  assert.equal(report.annotatedErrors.exactReferenceRate, null);
});

test("exact-reference hits stay narrow, including multiple legitimate phrasings", () => {
  for (const id of ["E17", "E18", "E26", "E30", "E35", "E36", "E41"]) {
    const item = getCase(id);
    assert.ok(item.acceptableOutputs.length > 1, id);
    for (const text of item.acceptableOutputs) {
      const score = scoreCase(item, resultFor(id, text));
      assert.equal(score.exactReferenceMatch, true, id);
      assert.equal(score.needsReview, true, id);
      assert.equal(score.meaningPreservation, "not-assessed", id);
    }
  }
  const item = getCase("E01");
  const score = scoreCase(item, resultFor(item.id, `${item.acceptableOutputs[0]} `));
  assert.equal(score.exactReferenceMatch, false);
  assert.equal(score.annotationChecks[0].correctionObserved, true);
  assert.deepEqual(score.failedChecks, []);
});

test("changing only whitespace does not generate correction evidence", () => {
  const item = getCase("E01");
  const result = resultFor(item.id, `${item.input} `);
  const score = scoreCase(item, result);
  assert.equal(score.exactReferenceMatch, false);
  assert.equal(score.annotationChecks[0].originalObserved, true);
  assert.equal(score.annotationChecks[0].correctionObserved, false);
  assert.equal(score.needsReview, true);
  const report = summarize([item], [result]);
  assert.equal(report.annotatedErrors.exactReferenceRate, 0);
  assert.equal(report.annotatedErrors.allListedCorrectionsObserved, 0);
  assert.equal(report.annotatedErrors.retainedSpanCases, 1);
});

test("partial fixes expose the remaining annotation rather than a complete correction", () => {
  const item = getCase("E53");
  const result = resultFor(item.id, item.input.replace("lamp are", "lamp is"));
  const score = scoreCase(item, result);
  assert.equal(score.annotationChecks[0].evidence, "listed-correction-observed");
  assert.equal(score.annotationChecks[1].evidence, "original-span-retained");
  assert.equal(score.exactReferenceMatch, false);
  assert.equal(score.needsReview, true);
  assert.equal(summarize([item], [result]).annotatedErrors.allListedCorrectionsObserved, 0);
});

test("rejected and error outcomes never score their retained or candidate text", () => {
  for (const id of ["C01", "E01"]) {
    const item = getCase(id);
    for (const text of [item.input, item.acceptableOutputs[0], null, undefined]) {
      const rejected = scoreCase(item, resultFor(id, text, { outcome: "rejected", rejectionReason: "Guard declined." }));
      assert.equal(rejected.outcome, "rejected");
      assert.equal(rejected.exactReferenceMatch, null);
      assert.equal(rejected.unchangedOnError, null);
      assert.equal(rejected.acceptedNoop, null);
      assert.deepEqual(rejected.annotationChecks, []);
      assert.deepEqual(rejected.protectedFactChecks, []);
      assert.equal(rejected.needsReview, true);
      const failed = scoreCase(item, resultFor(id, text, { error: "Model unavailable." }));
      assert.equal(failed.outcome, "error");
      assert.equal(failed.exactReferenceMatch, null);
      assert.deepEqual(failed.failedChecks, []);
    }
  }
  const report = summarize(
    [getCase("C01"), getCase("E01")],
    [resultFor("C01", undefined, { outcome: "rejected" }), resultFor("E01", undefined, { error: "Unavailable." })],
  );
  assert.deepEqual(report.outcomes, { produced: 0, rejected: 1, error: 1, missing: 0 });
  assert.equal(report.exactReference.matches, 0);
  assert.equal(report.cleanText.unchanged, 0);
  assert.equal(report.annotatedErrors.unchangedFailures, 0);
  assert.equal(report.annotatedErrors.outcomes.error, 1);
});

test("warnings do not invent rejection and explicit rejection can have no warnings", () => {
  const item = getCase("E01");
  const warned = resultFor(item.id, item.input, { warnings: ["Model returned input."] });
  const score = scoreCase(item, warned);
  assert.equal(score.outcome, "produced");
  assert.deepEqual(score.failedChecks, ["unchanged-annotated-error"]);
  assert.equal(score.needsReview, true);
  const rejected = scoreCase(item, resultFor(item.id, item.input, { outcome: "rejected" }));
  assert.equal(rejected.outcome, "rejected");
  assert.deepEqual(rejected.warnings, []);
  assert.equal(summarize([item], [warned]).resultsWithWarnings, 1);
});

test("missing outcomes remain in denominators and cannot masquerade as no-ops", () => {
  const selected = [getCase("E01"), getCase("E02")];
  const report = summarize(selected, [resultFor("E01")]);
  assert.deepEqual(report.outcomes, { produced: 1, rejected: 0, error: 0, missing: 1 });
  assert.equal(report.exactReference.rate, 0.5);
  assert.equal(report.annotatedErrors.exactReferenceRate, 0.5);
  assert.equal(report.scores[1].outcome, "missing");
  assert.equal(report.scores[1].unchanged, null);
  assert.equal(report.scores[1].exactReferenceMatch, null);
  assert.equal(report.scores[1].elapsedMs, null);
  assert.equal(report.scores[1].engine, null);
  assert.deepEqual(report.scores[1].protectedFactChecks, []);
});

test("repeated numbers require their original multiplicity with token boundaries", () => {
  const item = getCase("P03");
  const score = scoreCase(item, resultFor(item.id, "Room 7 contains stools, not 8."));
  assert.equal(fact(score, "sevens").actualCount, 1);
  assert.equal(fact(score, "sevens").matched, false);
  assert.ok(score.failedChecks.includes("protected-fact-mismatch"));
  for (const text of [
    "Room 70 contains 7 stools, not 8.",
    "Room 7 contains 7.5 stools, not 8.",
    "Room +7 contains 7 stools, not 8.",
    "Room 7 contains -7 stools, not 8.",
    "Room 7 contains 7 stools and 7 shelves, not 8.",
  ]) {
    assert.equal(fact(scoreCase(item, resultFor(item.id, text)), "sevens").matched, false, text);
  }
  const identifiers = getCase("P19");
  const removed = scoreCase(identifiers, resultFor(identifiers.id, "Set retryLimit and timeoutMs to 3000."));
  assert.equal(fact(removed, "retries").actualCount, 0);
  assert.equal(fact(removed, "timeout").actualCount, 1);
});

test("names, identifier casing, and version prefixes are protected exactly", () => {
  const names = scoreCase(getCase("P02"), resultFor("P02", "Jo and Jo are different account labels."));
  assert.equal(fact(names, "mixed-case-label").actualCount, 2);
  assert.equal(fact(names, "upper-case-label").actualCount, 0);
  const versions = scoreCase(getCase("P29"), resultFor("P29", "Keep version v2.4.10 in the manifest."));
  assert.equal(fact(versions, "required-version").actualCount, 0);
  assert.equal(fact(versions, "excluded-version").actualCount, 1);
  const changedName = scoreCase(getCase("P01"), resultFor("P01", "Ayla Cheng has the original receipt."));
  assert.equal(fact(changedName, "full-name").actualCount, 0);
});

test("signed quantities and price precision cannot be silently dropped", () => {
  const item = getCase("P27");
  const correct = scoreCase(item, resultFor(item.id));
  assert.equal(fact(correct, "negative-reading").actualCount, 1);
  assert.equal(fact(correct, "excluded-positive").actualCount, 1);
  const changed = scoreCase(item, resultFor(item.id, item.acceptableOutputs[0].replace("-3 °C", "3 °C")));
  assert.equal(fact(changed, "negative-reading").actualCount, 0);
  assert.equal(fact(changed, "excluded-positive").actualCount, 2);
  const price = scoreCase(getCase("C15"), resultFor("C15", "The fee is $18.500 per hour, not per day."));
  assert.equal(fact(price, "price").actualCount, 0);
  const decimal = scoreCase(getCase("P21"), resultFor("P21", "Our target is 2.50 kg per box, not 2.50 g."));
  assert.equal(fact(decimal, "decimals").actualCount, 0);
  assert.equal(decimal.needsReview, true);
});

test("complete URL tokens preserve path, query, fragment casing and multiplicity", () => {
  const item = getCase("P07");
  const original = item.protectedFacts[0].value;
  for (const changed of [
    original.replace("/Reports/", "/reports/"),
    original.replace("Team=Blue", "team=Blue"),
    original.replace("Token=AbC", "Token=abc"),
    original.replace("#Summary", "#summary"),
    original.replace("#Summary", ""),
    `${original}/extra`,
    `${original}&added=1`,
  ]) {
    const score = scoreCase(item, resultFor(item.id, item.acceptableOutputs[0].replace(original, changed)));
    assert.equal(fact(score, "url").matched, false, changed);
    assert.ok(score.failedChecks.includes("protected-fact-mismatch"));
  }
  const duplicate = scoreCase(item, resultFor(item.id, `${item.acceptableOutputs[0]} "${original}"`));
  assert.equal(fact(duplicate, "url").actualCount, 2);
});

test("negation and quantity associations require review even when all facts match", () => {
  const moved = scoreCase(getCase("P12"), resultFor("P12", "I agreed not to replace the cover."));
  assert.ok(moved.protectedFactChecks.every((check) => check.matched));
  assert.deepEqual(moved.failedChecks, []);
  assert.equal(moved.exactReferenceMatch, false);
  assert.equal(moved.needsReview, true);
  assert.equal(moved.meaningPreservation, "not-assessed");
  assert.ok(moved.manualMeaningFacts.some((item) => item.id === "negation-scope"));
  const swapped = scoreCase(getCase("P05"), resultFor("P05", "The rate is $19.50 per day, not $19.50 per hour."));
  assert.ok(swapped.protectedFactChecks.every((check) => check.matched));
  assert.ok(swapped.annotationChecks.every((check) => check.correctionObserved));
  assert.equal(swapped.exactReferenceMatch, false);
  assert.equal(swapped.needsReview, true);
  assert.equal(swapped.meaningPreservation, "not-assessed");
  const debts = scoreCase(getCase("P28"), resultFor("P28", "Nia owes Bo $18.00, and Bo owes Nia $8.00."));
  assert.ok(debts.protectedFactChecks.every((check) => check.matched));
  assert.equal(debts.needsReview, true);
  assert.equal(debts.meaningPreservation, "not-assessed");
});

test("quoted instructions are literal data and quoted errors can legitimately remain", () => {
  const injected = scoreCase(getCase("P14"), resultFor("P14", "YES"));
  assert.equal(injected.exactReferenceMatch, false);
  assert.equal(fact(injected, "quote").actualCount, 0);
  assert.ok(injected.failedChecks.includes("protected-fact-mismatch"));
  const item = getCase("P15");
  const unchanged = scoreCase(item, resultFor(item.id, item.input));
  assert.equal(unchanged.acceptedNoop, true);
  assert.deepEqual(unchanged.failedChecks, []);
  const altered = scoreCase(item, resultFor(item.id, item.input.replace("She go home.", "She goes home.")));
  assert.equal(fact(altered, "quote").matched, false);
  assert.equal(altered.expectedNoopEdited, true);
});

test("paragraph checks flag flattening but do not claim to check order or meaning", () => {
  const item = getCase("P16");
  const flattened = scoreCase(item, resultFor(item.id, item.acceptableOutputs[0].replace("\n\n", " ")));
  assert.equal(fact(flattened, "paragraphs").actualCount, 0);
  assert.ok(flattened.failedChecks.includes("protected-fact-mismatch"));
  const crlf = scoreCase(item, resultFor(item.id, item.acceptableOutputs[0].replaceAll("\n", "\r\n")));
  assert.equal(fact(crlf, "paragraphs").matched, true);
  assert.equal(crlf.exactReferenceMatch, false);
  assert.equal(crlf.needsReview, true);
  const ordered = getCase("P17");
  const reordered = scoreCase(ordered, resultFor(ordered.id, ordered.input.split("\n\n").reverse().join("\n\n")));
  assert.equal(fact(reordered, "paragraphs").matched, true);
  assert.equal(reordered.exactReferenceMatch, false);
  assert.equal(reordered.needsReview, true);
});

test("empty produced output is a failed check, not a fabricated model error", () => {
  const item = getCase("E01");
  for (const text of ["", " \n\t"]) {
    const score = scoreCase(item, resultFor(item.id, text));
    assert.equal(score.outcome, "produced");
    assert.ok(score.failedChecks.includes("empty-output"));
    assert.equal(score.exactReferenceMatch, false);
    assert.equal(score.needsReview, true);
  }
});

test("strict result contracts reject invalid IDs, timings, warnings and conflicting outcomes", () => {
  const item = getCase("E01");
  for (const elapsedMs of [-1, NaN, Infinity, "12", null]) {
    assert.throws(() => scoreCase(item, resultFor(item.id, undefined, { elapsedMs })), /elapsedMs/u);
  }
  assert.throws(() => scoreCase(item, resultFor("E02")), /Result ID/u);
  assert.throws(() => scoreCase(item, resultFor(item.id, undefined, { warnings: "warning" })), /warnings/u);
  assert.throws(() => scoreCase(item, resultFor(item.id, undefined, { warnings: [4] })), /warnings/u);
  assert.throws(() => scoreCase(item, resultFor(item.id, undefined, { engine: "" })), /engine/u);
  assert.throws(() => scoreCase(item, resultFor(item.id, undefined, { outcome: "success" })), /outcome/u);
  assert.throws(() => scoreCase(item, resultFor(item.id, undefined, { error: "Oops", outcome: "produced" })), /conflicts/u);
  assert.throws(() => scoreCase(item, resultFor(item.id, undefined, { error: "" })), /error/u);
  assert.throws(() => scoreCase(item, resultFor(item.id, undefined, { error: { message: "Oops" } })), /error/u);
  assert.throws(() => scoreCase(item, resultFor(item.id, 42)), /text/u);
  assert.throws(() => scoreCase(item, { id: item.id, engine: "engine", warnings: [] }), /text/u);
});

test("summarize rejects duplicates and unknown IDs rather than hiding measurements", () => {
  const item = getCase("E01");
  assert.throws(() => summarize([item, item], []), /Duplicate case/u);
  assert.throws(() => summarize([item], [resultFor(item.id), resultFor(item.id)]), /Duplicate result/u);
  assert.throws(() => summarize([item], [resultFor("E02")]), /Unknown result/u);
  assert.throws(() => summarize([item], [null]), /Unknown result/u);
  assert.throws(() => summarize(corpus, []), /must be arrays/u);
  assert.throws(() => summarize(cases, {}), /must be arrays/u);
});

test("source validation rejects contradictory annotations, no-ops and fact counts", () => {
  const base = getCase("E01");
  assert.throws(() => scoreCase({ ...base, acceptableOutputs: [] }), /nonempty/u);
  assert.throws(() => scoreCase({ ...base, expectedNoop: true }), /safe no-op/u);
  assert.throws(() => scoreCase({ ...base, acceptableOutputs: [base.input] }), /does not resolve/u);
  assert.throws(() => scoreCase({ ...base, split: "training" }), /split/u);
  assert.throws(() => scoreCase({ ...base, errors: [{ ...base.errors[0], original: "not in input" }] }), /original input span/u);
  assert.throws(() => scoreCase({ ...base, errors: [base.errors[0], base.errors[0]] }), /IDs must be distinct/u);
  const badFact = { ...base.protectedFacts[0], count: 2 };
  assert.throws(() => scoreCase({ ...base, protectedFacts: [badFact] }), /does not match the source/u);
  const changedReference = {
    ...base,
    acceptableOutputs: [base.acceptableOutputs[0].replace("Monday", "Tuesday")],
  };
  assert.throws(() => scoreCase(changedReference), /reference changes protected fact/u);
});

test("latency uses only supplied observations and never invents retries or cache metrics", () => {
  const selected = ["C01", "C02", "C03", "C04", "C05"].map(getCase);
  const results = [
    resultFor("C01", undefined, { elapsedMs: 0 }),
    resultFor("C02", undefined, { elapsedMs: 10 }),
    resultFor("C03", undefined, { elapsedMs: 100, outcome: "rejected", rawAttempts: [1, 2, 3] }),
    resultFor("C04", undefined, { elapsedMs: 30, error: "Unavailable" }),
    resultFor("C05", undefined, { retryCount: 99 }),
  ];
  const report = summarize(selected, results);
  assert.deepEqual(report.latencyMs, { samples: 4, min: 0, median: 20, p95: 100, max: 100 });
  assert.deepEqual(report.producedLatencyMs, { samples: 2, min: 0, median: 5, p95: 10, max: 10 });
  assert.equal("retryCount" in report, false);
  assert.equal("coldStartMs" in report, false);
  assert.equal("rawAttempts" in report.scores[2], false);
  assert.equal("memoryBytes" in report, false);
});

test("empty and wholly missing runs have null rates/timings where appropriate", () => {
  const empty = summarize([], []);
  assert.equal(empty.totalCases, 0);
  assert.equal(empty.exactReference.rate, null);
  assert.equal(empty.annotatedErrors.exactReferenceRate, null);
  assert.deepEqual(empty.latencyMs, { samples: 0, min: null, median: null, p95: null, max: null });
  const missing = summarize(cases, []);
  assert.equal(missing.outcomes.missing, 120);
  assert.equal(missing.exactReference.rate, 0);
  assert.equal(missing.annotatedErrors.exactReferenceRate, 0);
  assert.equal(missing.cleanText.unchanged, 0);
  assert.equal(missing.protectedFacts.checkedFacts, 0);
  assert.deepEqual(missing.engines, []);
});

test("scoring is deterministic and does not mutate cases, results or warning arrays", () => {
  const selected = [structuredClone(getCase("E01")), structuredClone(getCase("C01"))];
  const results = [resultFor("E01", undefined, { warnings: ["Inspect this edit."] }), resultFor("C01")];
  const before = JSON.stringify({ selected, results });
  const first = summarize(selected, results);
  assert.deepEqual(summarize(selected, results), first);
  assert.equal(JSON.stringify({ selected, results }), before);
  first.scores[0].warnings.push("Local mutation.");
  assert.deepEqual(results[0].warnings, ["Inspect this edit."]);
});

test("candidate metadata is pinned, sums exactly, and makes no inferred compatibility claim", () => {
  assert.equal(candidates.method.weightsDownloaded, false);
  assert.equal(candidates.method.graphsInspected, false);
  assert.equal(candidates.method.inferenceRun, false);
  assert.equal(candidates.method.remoteCodeExecuted, false);
  assert.equal(candidates.recommendation.verifiedSmallDropInExport, null);
  for (const candidate of candidates.candidates) {
    assert.match(candidate.revision, /^[a-f0-9]{40}$/u);
    assert.ok(candidate.apiUrl.includes(`/revision/${candidate.revision}?blobs=true`));
    assert.equal(candidate.graphs.reduce((sum, graph) => sum + graph.bytes, 0), candidate.graphBytesTotal);
    for (const file of [...candidate.graphs, ...candidate.supportFiles]) {
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
    }
    assert.equal(candidate.browser.wasmValidated, false);
    assert.equal(candidate.browser.webgpuValidated, false);
    assert.equal(candidate.precision.q4Evidence, false);
  }
  const quantized = candidates.candidates.find((candidate) => candidate.repository.startsWith("rayliuca/"));
  assert.equal(quantized.precision.label, "dynamic-int8");
  assert.equal(quantized.graphBytesTotal, 422844073);
  assert.equal(quantized.provenance.declaredUpstream, null);
  assert.equal(quantized.provenance.declaredLicense, null);
  assert.equal(quantized.browser.mergedDecoderPresent, false);
  const officialLarge = candidates.upstreamEvidence.find((candidate) => candidate.repository === "grammarly/coedit-large");
  assert.equal(officialLarge.declaredLicense, "cc-by-nc-4.0");
  assert.equal(officialLarge.parametersReported, 770000000);
});
