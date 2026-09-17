import assert from "node:assert/strict";
import test from "node:test";
import { splitIntoSections, splitIntoSentences } from "../src/lib/sections.ts";

const countWords = (text: string) => text.trim() ? text.trim().split(/\s+/u).length : 0;

test("keeps normal paragraphs intact and preserves all whitespace", () => {
  const text = "First paragraph stays together.\n\nSecond paragraph stays together.";
  const sections = splitIntoSections(text, countWords, 10);

  assert.equal(sections.map(({ text: value }) => value).join(""), text);
  assert.deepEqual(
    sections.filter(({ editable }) => editable).map(({ text: value }) => value),
    ["First paragraph stays together.", "Second paragraph stays together."],
  );
});

test("splits only paragraphs that exceed the token budget", () => {
  const text = "One two three four. Five six seven eight. Nine ten eleven twelve.";
  const sections = splitIntoSections(text, countWords, 8);

  assert.equal(sections.map(({ text: value }) => value).join(""), text);
  for (const section of sections.filter(({ editable }) => editable)) {
    assert.ok(countWords(section.text) <= 8);
  }
  assert.equal(sections.filter(({ editable }) => editable).length, 2);
});

test("splits an unbroken oversized token without losing characters", () => {
  const text = "abcdefghijklmnop";
  const sections = splitIntoSections(text, (value) => Array.from(value).length, 5);

  assert.equal(sections.map(({ text: value }) => value).join(""), text);
  assert.ok(sections.every(({ text: value }) => Array.from(value).length <= 5));
});

test("rejects an invalid section budget", () => {
  assert.throws(() => splitIntoSections("text", countWords, 0), RangeError);
});

test("preserves whitespace while splitting a paragraph into sentences", () => {
  const text = "First sentence.  Second sentence.";
  const sections = splitIntoSentences(text);
  assert.equal(sections.map(({ text: value }) => value).join(""), text);
  assert.deepEqual(
    sections.filter(({ editable }) => editable).map(({ text: value }) => value),
    ["First sentence.", "Second sentence."],
  );
});
