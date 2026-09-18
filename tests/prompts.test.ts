import assert from "node:assert/strict";
import test from "node:test";
import { EDIT_DECODING } from "../src/lib/generation.ts";
import { makeEditMessages } from "../src/lib/prompts.ts";
import { EDIT_ACTIONS } from "../src/types.ts";

test("uses copy-friendly decoding for editing", () => {
  assert.equal(EDIT_DECODING.no_repeat_ngram_size, 0);
  assert.equal(EDIT_DECODING.repetition_penalty, 1);
  assert.equal(EDIT_DECODING.tokenizer_encode_kwargs.enable_thinking, false);
});

test("keeps each editing action distinct", () => {
  const source = "please edit this text";
  const cases = [
    ["grammar", /Make minimal edits/],
    ["concise", /Cut unnecessary words/],
    ["longer", /longer and more complete/],
    ["casual", /conversational tone/],
    ["professional", /professional English/],
    ["confident", /confident tone/],
    ["enthusiastic", /enthusiastic tone/],
    ["lighthearted", /light-hearted/],
  ] as const;

  assert.deepEqual(cases.map(([action]) => action), [...EDIT_ACTIONS]);
  for (const [action, signature] of cases) {
    const message = makeEditMessages(action, source).at(-1)?.content;
    assert.match(String(message), signature);
    assert.equal(typeof message, "string");
    assert.ok(String(message).endsWith(source));
  }
});

test("gives every rewrite style a focused example", () => {
  for (const action of EDIT_ACTIONS) {
    const messages = makeEditMessages(action, "Edit this sentence.");
    assert.equal(messages.length, 4);
    assert.equal(messages[1]?.role, "user");
    assert.equal(messages[2]?.role, "assistant");
  }
});

test("allocates extra generation room for longer rewrites", async () => {
  const { getGenerationTokenBudget } = await import("../src/lib/generation.ts");
  assert.ok(getGenerationTokenBudget(200, true) > getGenerationTokenBudget(200));
});

test("professional editing is explicitly prohibited from answering requests", () => {
  const messages = makeEditMessages("professional", "Can you send it?");
  assert.match(String(messages.at(-1)?.content), /Do not answer/);
  assert.match(String(messages[0]?.content), /not the recipient/);
});

test("grammar retries distinguish people from existential there-is statements", () => {
  const retry = makeEditMessages(
    "grammar",
    "Everyone acts like there an expert.",
    true,
  ).at(-1)?.content;
  assert.match(String(retry), /previously mentioned person/);
  assert.match(String(retry), /there is/);
});
