import assert from "node:assert/strict";
import test from "node:test";
import { editSections, editText } from "../src/lib/edit.ts";
import { EDIT_ACTIONS } from "../src/types.ts";

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

test("edits grammar paragraphs one sentence at a time", async () => {
  const generated: string[] = [];
  const result = await editText({
    action: "grammar",
    text: "We was ready. They is waiting.",
    countTokens: countWords,
    generate: async (text) => {
      generated.push(text);
      return text === "We was ready." ? "We were ready." : "They are waiting.";
    },
  });

  assert.deepEqual(generated, ["We was ready.", "They is waiting."]);
  assert.equal(result.text, "We were ready. They are waiting.");
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

test("falls back to grammar when a style rewrite is unsafe", async () => {
  const result = await editText({
    action: "professional",
    text: "We was ready.",
    countTokens: countWords,
    generate: async () => "Sure: I can help.",
    fallback: async () => "We were ready.",
  });

  assert.equal(result.text, "We were ready.");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /only spelling and grammar were corrected/);
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

test("falls back to individual sentences for a rejected style rewrite", async () => {
  const result = await editText({
    action: "professional",
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

test("unchanged grammar returns no suggestions without retrying or normalizing the source", async () => {
  const text = "  “we was waiting.”\r\n\r\n  We are ready.  ";
  const calls: Array<[string, boolean]> = [];
  const progress: Array<[number, number]> = [];
  const result = await editText({
    action: "grammar",
    text,
    countTokens: countWords,
    generate: async (section, retry) => {
      calls.push([section, retry]);
      return section;
    },
    fallback: async () => { throw new Error("No fallback was needed."); },
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  assert.deepEqual(result, { text, warnings: [] });
  assert.deepEqual(calls, [["“we was waiting.”", false], ["We are ready.", false]]);
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
});

test("all unchanged style rewrites still retry and fail explicitly", async () => {
  for (const action of EDIT_ACTIONS.filter((action) => action !== "grammar")) {
    const attempts: boolean[] = [];
    await assert.rejects(
      editText({
        action,
        text: "we are waiting.",
        countTokens: countWords,
        generate: async (text, retry) => {
          attempts.push(retry);
          return text;
        },
      }),
      /could not produce a usable edit.*unchanged/,
    );
    assert.deepEqual(attempts, [false, true], action);
  }
});

test("accepted unchanged grammar and unsafe retained text have distinct outcomes", async () => {
  const attempts: string[] = [];
  const result = await editText({
    action: "grammar",
    text: "The report is ready.\n\nWe have 3 files.",
    countTokens: countWords,
    generate: async (text) => {
      attempts.push(text);
      return text.includes("3") ? text.replace("3", "4") : text;
    },
  });

  assert.equal(result.text, "The report is ready.\n\nWe have 3 files.");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Section 2 was left unchanged.*number/);
  assert.deepEqual(attempts, ["The report is ready.", "We have 3 files.", "We have 3 files."]);
});

test("an unchanged grammar fallback cannot mask rejected candidates", async () => {
  for (const action of ["grammar", "professional"] as const) {
    let fallbackCalls = 0;
    await assert.rejects(
      editText({
        action,
        text: "we have 3 files.",
        countTokens: countWords,
        generate: async () => "We have 4 files.",
        fallback: async (text) => {
          fallbackCalls += 1;
          return text;
        },
      }),
      /could not produce a usable edit.*number/,
    );
    assert.equal(fallbackCalls, 1);
  }
});

test("prepared sections use the shared grammar sentence splitting without tokenization", async () => {
  const generated: string[] = [];
  const result = await editSections({
    action: "grammar",
    sections: [
      { text: "\t", editable: false },
      { text: "We was ready.  They is waiting.", editable: true },
      { text: "\r\n\r\n", editable: false },
      { text: "Keep this literal.", editable: false },
    ],
    generate: async (text) => {
      generated.push(text);
      return text === "We was ready." ? "We were ready." : "They are waiting.";
    },
  });

  assert.deepEqual(generated, ["We was ready.", "They is waiting."]);
  assert.deepEqual(result, {
    text: "\tWe were ready.  They are waiting.\r\n\r\nKeep this literal.",
    warnings: [],
  });
});

test("sentence fallback counts usable results rather than counting their warnings", async () => {
  const result = await editSections({
    action: "professional",
    sections: [{ text: "We was ready. We have 3 files.", editable: true }],
    generate: async () => "Sure: I can help.",
    fallback: async (text) => text === "We was ready." ? "We were ready." : text,
  });

  assert.equal(result.text, "We were ready. We have 3 files.");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /left partly unchanged.*only spelling and grammar.*answered/);
});

test("editSections propagates generation, fallback, and progress errors", async () => {
  const failure = new Error("Provider failed.");
  const base = {
    action: "grammar" as const,
    sections: [{ text: "We have 3 files.", editable: true }],
  };
  await assert.rejects(
    editSections({ ...base, generate: async () => { throw failure; } }),
    (error) => error === failure,
  );
  await assert.rejects(
    editSections({
      ...base,
      generate: async () => "We have 4 files.",
      fallback: async () => { throw failure; },
    }),
    (error) => error === failure,
  );
  await assert.rejects(
    editSections({
      ...base,
      generate: async (text) => text,
      onProgress: () => { throw failure; },
    }),
    (error) => error === failure,
  );
});
