import assert from "node:assert/strict";
import test from "node:test";
import { Dialect, LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";
import { applyConservativeProofreading, inspectProofreading } from "../src/lib/proofread.ts";

test("applies high-confidence grammar cleanup without applying style suggestions", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const corrected = await applyConservativeProofreading(
      "We was suppose to leave, but we would of waited.",
      linter,
    );

    assert.equal(
      corrected,
      "We were supposed to leave, but we would have waited.",
    );
  } finally {
    await linter.dispose();
  }
});

test("applies safe boundary and contextual their/there corrections", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    assert.equal(
      await applyConservativeProofreading(
        "Their are alot of reasons, but their report is ready.",
        linter,
      ),
      "There are a lot of reasons, but their report is ready.",
    );
    assert.equal(
      await applyConservativeProofreading(
        "Remember when your suppose to leave, when you suppose to return, and to right their own essays.",
        linter,
      ),
      "Remember when you're supposed to leave, when you're supposed to return, and to write their own essays.",
    );
    assert.equal(
      await applyConservativeProofreading("Your proposal is ready.", linter),
      "Your proposal is ready.",
    );
  } finally {
    await linter.dispose();
  }
});

test("readability findings cannot hide spelling findings in a long sentence", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const source = "Their are alot of reasons why peeple keep writing long sentences about a report that they want to share with a freind even though it would be easier to read with a little more care and attention to each word because every reader should be able to follow the explanation without struggling to understand the central point.";
    const result = await inspectProofreading(source, linter);
    assert.ok(result.findings.some((finding) => finding.kind === "Readability"));
    assert.ok(result.findings.some((finding) => finding.problem === "peeple" && finding.suggestions.includes("people")));
    assert.ok(result.findings.some((finding) => finding.problem === "freind" && finding.suggestions.includes("friend")));
    assert.match(result.text, /^There are a lot of reasons/);
  } finally {
    await linter.dispose();
  }
});

test("ambiguous suggestions are exposed without blindly applying the first spelling", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const result = await inspectProofreading("I tryed writting.", linter);
    const tried = result.findings.find((finding) => finding.problem === "tryed");
    assert.ok(tried?.suggestions.includes("tried"));
    assert.equal(tried?.applied, false);
    assert.ok(result.text.includes("tryed"));
    const writing = result.findings.find((finding) => finding.problem === "writting");
    assert.ok(writing?.suggestions.includes("writing"));
    assert.equal(writing?.applied, false);
  } finally {
    await linter.dispose();
  }
});

test("names and identifiers survive a rule engine that only sees their shape", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const result = await inspectProofreading(
      "Bo asked whether the retryLimit was to low.",
      linter,
    );

    assert.equal(result.text, "Bo asked whether the retryLimit was too low.");
  } finally {
    await linter.dispose();
  }
});

test("a file extension is not mistaken for a sentence needing capitals", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const result = await inspectProofreading("Set retryLimit to 5 in config/app.json.", linter);

    assert.equal(result.text, "Set retryLimit to 5 in config/app.json.");
  } finally {
    await linter.dispose();
  }
});

test("recasing an all-lowercase word is still applied", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const result = await inspectProofreading("i went to the store yesterday.", linter);

    assert.equal(result.text, "I went to the store yesterday.");
  } finally {
    await linter.dispose();
  }
});

test("an unrelated word choice never outranks a spelling the speller was unsure about", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const result = await inspectProofreading("Do not print anything untill the form is signed.", linter);

    assert.equal(result.text, "Do not print anything untill the form is signed.");
    const substitution = result.findings.find((finding) => finding.suggestions.includes("distill"));
    assert.equal(substitution?.applied, false);
  } finally {
    await linter.dispose();
  }
});

test("respacing a misspelling is still trusted because it keeps the same letters", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const result = await inspectProofreading("There are alot of details left.", linter);

    assert.equal(result.text, "There are a lot of details left.");
  } finally {
    await linter.dispose();
  }
});
