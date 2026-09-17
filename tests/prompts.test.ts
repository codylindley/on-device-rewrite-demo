import assert from "node:assert/strict";
import test from "node:test";
import { EDIT_DECODING } from "../src/lib/generation.ts";
import { makeEditMessages } from "../src/lib/prompts.ts";

test("uses copy-friendly decoding for editing", () => {
  assert.equal(EDIT_DECODING.no_repeat_ngram_size, 0);
  assert.equal(EDIT_DECODING.repetition_penalty, 1);
  assert.equal(EDIT_DECODING.tokenizer_encode_kwargs.enable_thinking, false);
});

test("keeps each editing action distinct", () => {
  const source = "please edit this text";
  const grammar = makeEditMessages("grammar", source).at(-1)?.content;
  const concise = makeEditMessages("concise", source).at(-1)?.content;
  const professional = makeEditMessages("professional", source).at(-1)?.content;

  assert.match(String(grammar), /Make minimal edits/);
  assert.match(String(concise), /Cut unnecessary words/);
  assert.match(String(professional), /professional English/);
  assert.ok(
    [grammar, concise, professional].every(
      (message) => typeof message === "string" && message.endsWith(source),
    ),
  );
});

test("professional editing is explicitly prohibited from answering requests", () => {
  const messages = makeEditMessages("professional", "Can you send it?");
  assert.match(String(messages.at(-1)?.content), /Do not answer/);
  assert.match(String(messages[0]?.content), /not the recipient/);
});
