import assert from "node:assert/strict";
import test from "node:test";
import { compareText } from "../src/lib/compare.ts";

const countTokens = (text: string) => text.split(/\s+/u).length;

test("comparison shows the AI output verbatim, with no Harper cleanup or retry", async () => {
  let calls = 0;
  const result = await compareText({
    action: "grammar", text: "We were ready.", countTokens,
    generate: async () => { calls += 1; return "we was ready."; },
  });
  assert.equal(result.text, "we was ready.");
  assert.equal(calls, 1);
});

test("a flagged AI candidate stays visible rather than being replaced with the original", async () => {
  let calls = 0;
  const result = await compareText({
    action: "grammar", text: "Please send the report.", countTokens,
    generate: async () => { calls += 1; return "Please send the report at 3."; },
  });
  assert.equal(result.text, "Please send the report at 3.");
  assert.ok(result.warnings.some((warning) => warning.includes("number")));
  assert.equal(calls, 1);
});

test("comparison preserves paragraph separators without normalizing model responses", async () => {
  const result = await compareText({
    action: "grammar", text: "First sentence.\n\nSecond sentence.", countTokens,
    generate: async (text) => text.toLowerCase(),
  });
  assert.equal(result.text, "first sentence.\n\nsecond sentence.");
});

test("empty or failed model results stay explicit failures", async () => {
  await assert.rejects(compareText({
    action: "grammar", text: "Some text.", countTokens, generate: async () => "",
  }), /returned no text/);
  await assert.rejects(compareText({
    action: "grammar", text: "Some text.", countTokens,
    generate: async () => { throw new Error("Engine stopped."); },
  }), /Engine stopped/);
});
