import assert from "node:assert/strict";
import test from "node:test";
import { editText } from "../src/lib/edit.ts";

const countWords = (text: string) => text.trim() ? text.trim().split(/\s+/u).length : 0;

test("edits paragraph sections and preserves paragraph separators", async () => {
  const progress: Array<[number, number]> = [];
  const result = await editText({
    action: "grammar",
    text: "first sentence.\n\nsecond sentence.",
    countTokens: countWords,
    generate: async (text) => text.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase()),
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  assert.equal(result.text, "First sentence.\n\nSecond sentence.");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
});

test("retries a rejected edit once", async () => {
  let calls = 0;
  const result = await editText({
    action: "grammar",
    text: "we was waiting.",
    countTokens: countWords,
    generate: async () => {
      calls += 1;
      return calls === 1 ? "Sure, I can wait." : "We were waiting.";
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.text, "We were waiting.");
});

test("keeps an unsafe section unchanged and reports it", async () => {
  const result = await editText({
    action: "grammar",
    text: "we was ready.\n\nthe projector kept turning itself off.",
    countTokens: countWords,
    generate: async (text) =>
      text.startsWith("we") ? "We were ready." : "The equipment failed.",
  });

  assert.equal(result.text, "We were ready.\n\nthe projector kept turning itself off.");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Section 2 was left unchanged/);
});

test("fails explicitly when every section is unsafe", async () => {
  await assert.rejects(
    editText({
      action: "grammar",
      text: "the projector kept turning itself off.",
      countTokens: countWords,
      generate: async () => "The equipment failed.",
    }),
    /could not produce a usable edit/,
  );
});

test("falls back to individual sentences when a paragraph is unchanged", async () => {
  const result = await editText({
    action: "grammar",
    text: "We was ready. They is waiting.",
    countTokens: countWords,
    generate: async (text) => {
      if (text.includes("ready.") && text.includes("waiting.")) return text;
      if (text === "We was ready.") return "We were ready.";
      return "They are waiting.";
    },
  });

  assert.equal(result.text, "We were ready. They are waiting.");
  assert.deepEqual(result.warnings, []);
});
