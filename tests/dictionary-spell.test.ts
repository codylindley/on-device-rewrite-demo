import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import nspell from "nspell";
import { confidentCorrection, spellcheckText } from "../src/lib/dictionary-spell.ts";

// Tests execute from .test-dist, so the vendored data is resolved from the repo root.
// Read as text, exactly as the worker does: nspell misreads a Uint8Array as a dictionary list.
const assets = path.join(process.cwd(), "src/assets/dictionary");
const speller = nspell(
  await readFile(path.join(assets, "en.aff"), "utf8"),
  await readFile(path.join(assets, "en.dic"), "utf8"),
);

test("applies a missing apostrophe and a single nearest neighbour", () => {
  const result = spellcheckText("I recieved it but we havent finished, keep them seperate.", speller);

  assert.equal(result.text, "I received it but we haven't finished, keep them separate.");
  assert.deepEqual(result.findings.map((finding) => finding.problem), ["recieved", "havent", "seperate"]);
  assert.ok(result.findings.every((finding) => finding.applied));
});

test("reports a misspelling with rival neighbours instead of guessing", () => {
  const result = spellcheckText("The adress is wrong and there are alot of details.", speller);

  assert.equal(result.text, "The adress is wrong and there are alot of details.");
  const problems = result.findings.map((finding) => finding.problem);
  assert.deepEqual(problems, ["adress", "alot"]);
  assert.ok(result.findings.every((finding) => !finding.applied));
  assert.ok(result.findings[0]?.suggestions.includes("address"));
});

test("a tie between equally near suggestions is never applied", () => {
  assert.equal(confidentCorrection("adress", ["address", "dress"]), null);
  assert.equal(confidentCorrection("alot", ["allot", "aloe", "slot"]), null);
  assert.equal(confidentCorrection("recieved", ["received", "relieved"]), "received");
  assert.equal(confidentCorrection("havent", ["haven", "haven't", "havens"]), "haven't");
  assert.equal(confidentCorrection("zzzzqqq", ["something"]), null);
});

test("names, acronyms, handles, and numbers are left alone", () => {
  const source = "Maya sent the RSVP link https://exmaple.com/joinn to @teh_group before 3:30.";
  const result = spellcheckText(source, speller);

  assert.equal(result.text, source);
  assert.deepEqual(result.findings, []);
});

test("identifiers, domains, and paths are not prose and are never rewritten", () => {
  for (const source of [
    "We use CoEdIT and ChatGPT.",
    "Use ChatGPT4 today.",
    "Visit figma.com today.",
    "Read /usr/locla/bin now.",
  ]) {
    assert.equal(spellcheckText(source, speller).text, source, source);
  }
});

test("a closing quote belongs to the sentence, not the word", () => {
  const result = spellcheckText("She said \u2018havent\u2019 yesterday.", speller);

  assert.equal(result.text, "She said \u2018haven't\u2019 yesterday.");
});

test("confidence is judged on the whole suggestion list, not the displayed few", () => {
  // `grist` sits past the four shown alternatives; hiding it would fake a lone anagram.
  const result = spellcheckText("This is the girst draft.", speller);

  assert.equal(result.text, "This is the girst draft.");
  assert.equal(result.findings[0]?.applied, false);
  assert.ok(result.findings[0]!.suggestions.length <= 4);
});

test("an elision is two words, so it is reported rather than guessed at", () => {
  assert.equal(confidentCorrection("alot", ["alto", "allot", "slot"]), null);
});

test("capitalization of the original word is preserved", () => {
  const result = spellcheckText("Seperate the two lists.", speller);

  assert.equal(result.text, "Separate the two lists.");
});

test("the dictionary cannot see grammar, and says so by leaving it untouched", () => {
  const result = spellcheckText("We was suppose to review it.", speller);

  assert.equal(result.text, "We was suppose to review it.");
  assert.deepEqual(result.findings, []);
});

test("a capitalised word mid-sentence is reported, never replaced", () => {
  const result = spellcheckText("I sent the draft to Lindley, who runs Vitest.", speller);

  assert.equal(result.text, "I sent the draft to Lindley, who runs Vitest.");
  assert.deepEqual(result.findings.map((finding) => finding.applied), [false, false]);
});

test("a sentence-initial misspelling is still corrected", () => {
  const result = spellcheckText("Teh report is ready. Seperate the two lists.", speller);

  assert.equal(result.text, "The report is ready. Separate the two lists.");
});
