import assert from "node:assert/strict";
import test from "node:test";
import { Dialect, LocalLinter, type Lint, type Linter } from "harper.js";
import { binary } from "harper.js/binary";
import { proofreadText } from "../src/lib/quick-grammar.ts";

function linterWith(rewrite: (text: string) => string | Promise<string>): Linter {
  return {
    lint: async (text: string) => {
      const replacement = await rewrite(text);
      if (replacement === text) return [];
      return [{
        lint_kind: () => "Grammar",
        get_problem_text: () => text,
        suggestion_count: () => 1,
        suggestions: () => [{ get_replacement_text: () => replacement }],
        span: () => ({ start: 0, end: text.length }),
      } as unknown as Lint];
    },
    applySuggestion: async (_text, _lint, suggestion) => suggestion.get_replacement_text(),
  } as Linter;
}

test("proofreads with Harper only and preserves paragraph whitespace and Unicode", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  const progress: Array<[number, number]> = [];
  try {
    const result = await proofreadText(
      "\tWe was suppose to leave.  We would of waited.\r\n\r\n  🙂\n",
      linter,
      (completed, total) => progress.push([completed, total]),
    );

    assert.equal(result.text, "\tWe were supposed to leave.  We would have waited.\r\n\r\n  🙂\n");
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
  } finally {
    await linter.dispose();
  }
});

test("unchanged proofreading is usable and does not claim the text is error-free", async () => {
  const text = "  “we was waiting.”\n\nCafé 👩🏽‍💻 stays here.  ";
  const calls: string[] = [];
  const result = await proofreadText(text, linterWith((section) => {
    calls.push(section);
    return section;
  }));

  assert.deepEqual(result, { text, warnings: [] });
  assert.deepEqual(calls, ["“we was waiting.”", "Café 👩🏽‍💻 stays here."]);
});

test("unsafe Harper suggestions are retained with a specific warning and no retries", async () => {
  const calls: string[] = [];
  const progress: Array<[number, number]> = [];
  const result = await proofreadText(
    "We was ready.\n\nWe have 3 files.\n\nThe report is ready.",
    linterWith((text) => {
      calls.push(text);
      return text.replace("was", "were").replace("3", "4");
    }),
    (completed, total) => progress.push([completed, total]),
  );

  assert.equal(result.text, "We were ready.\n\nWe have 3 files.\n\nThe report is ready.");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Section 2 was left unchanged.*number/);
  assert.deepEqual(calls, ["We was ready.", "We have 3 files.", "The report is ready."]);
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
});

test("all unsafe proofreading fails rather than presenting an unchanged result", async () => {
  let calls = 0;
  await assert.rejects(
    proofreadText("We have 3 files.\n\nWe have 3 folders.", linterWith((text) => {
      calls += 1;
      return text.replace("3", "4");
    })),
    /proofreader could not produce a usable edit.*number/,
  );
  assert.equal(calls, 2);
});

test("an accepted no-op remains usable alongside a rejected section", async () => {
  const text = "We have 3 files.  The report is ready.";
  const result = await proofreadText(text, linterWith((section) => section.replace("3", "4")));
  assert.equal(result.text, text);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Section 1 was left unchanged.*number/);
});

test("proofreading uses shared URL and negation preservation checks", async () => {
  for (const [source, candidate, reason] of [
    ["Keep https://example.com/Case here.", "Keep https://example.com/case here.", /link/],
    [
      "We didn’t approve the draft, but we accepted the budget.",
      "We approved the draft, but we didn’t accept the budget.",
      /negation/,
    ],
  ] as const) {
    await assert.rejects(proofreadText(source, linterWith(() => candidate)), reason);
  }
});

test("proofreading preserves an unbroken Unicode passage without inventing neural tokens", async () => {
  const text = "\t" + "é👩🏽‍💻".repeat(300) + "\n\n";
  let calls = 0;
  const result = await proofreadText(text, linterWith((section) => {
    calls += 1;
    return section;
  }));
  assert.deepEqual(result, { text, warnings: [] });
  assert.equal(calls, 1);
});

test("long multi-sentence passages yield between batches", async () => {
  let yielded = false;
  const timer = setTimeout(() => { yielded = true; }, 0);
  let calls = 0;
  try {
    await proofreadText("The report is ready. ".repeat(17), linterWith((text) => {
      calls += 1;
      if (calls === 17) assert.equal(yielded, true);
      return text;
    }));
    assert.equal(calls, 17);
  } finally {
    clearTimeout(timer);
  }
});

test("proofreading rejects empty input and propagates linter and progress failures", async () => {
  const failure = new Error("Harper failed.");
  await assert.rejects(proofreadText(" \r\n\t", linterWith((text) => text)), /Add some text/);
  await assert.rejects(
    proofreadText("The report is ready.", linterWith(() => { throw failure; })),
    (error) => error === failure,
  );
  const linter = linterWith(() => "We were ready.");
  linter.applySuggestion = async () => { throw failure; };
  await assert.rejects(proofreadText("We was ready.", linter), (error) => error === failure);
  await assert.rejects(
    proofreadText("The report is ready.", linterWith((text) => text), () => { throw failure; }),
    (error) => error === failure,
  );
});
