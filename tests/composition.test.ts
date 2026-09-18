import assert from "node:assert/strict";
import test from "node:test";
import { editSections, editText } from "../src/lib/edit.ts";
import { rejectedEditReason } from "../src/lib/output.ts";

test("a grammar model receives the complete URL and can correct its surrounding sentence", async () => {
  const source = 'Open "https://example.test/Reports/Q3?Team=Blue&Token=AbC#Summary" after you logs in.';
  const seen: string[] = [];
  const result = await editText({
    action: "grammar", text: source,
    countTokens: (text) => text.split(/\s+/u).length,
    generate: async (text) => { seen.push(text); return text.replace("logs in", "log in"); },
  });
  assert.deepEqual(seen, [source]);
  assert.equal(result.text, source.replace("logs in", "log in"));
  assert.deepEqual(result.warnings, []);
});

test("prepared sections cannot bypass link preservation after they are recombined", async () => {
  await assert.rejects(editSections({
    action: "grammar",
    sections: [
      { text: "https://example.test/?", editable: false },
      { text: "value=read", editable: true },
    ],
    generate: async () => "value=write",
  }), /Combined sections failed preservation:.*link/);
});

test("numeric facts are also protected across prepared section boundaries", async () => {
  await assert.rejects(editSections({
    action: "grammar",
    sections: [
      { text: "Order ", editable: false },
      { text: "1", editable: true },
      { text: "2.", editable: false },
    ],
    generate: async () => "1.",
  }), /Combined sections failed preservation:.*number/);
});

test("protected-only text has no grammar edits but does not count as a completed style rewrite", async () => {
  const text = "https://example.test/Report?Token=AbCd";
  const options = {
    sections: [{ text, editable: false }],
    generate: async () => { throw new Error("Protected links must not be generated."); },
  };
  assert.deepEqual(await editSections({ ...options, action: "grammar" }), { text, warnings: [] });
  await assert.rejects(editSections({ ...options, action: "confident" }), /no editable prose/);
});

test("a URL query does not stand in for a real question", () => {
  const url = '"https://example.test/guide?mode=Read"';
  assert.match(rejectedEditReason(
    "grammar", `Can you review ${url}?`, `You can review ${url}.`,
  ) ?? "", /removed a question/);
  assert.match(rejectedEditReason(
    "lighthearted", `Review ${url}.`, `Could we review ${url}? — a bright plan!`,
  ) ?? "", /introduced a question/);
});
