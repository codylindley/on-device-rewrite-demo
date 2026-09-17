import assert from "node:assert/strict";
import test from "node:test";
import { diffWords, type DiffPart } from "../src/lib/diff.ts";

function reconstruct(parts: DiffPart[], side: "before" | "after"): string {
  return parts
    .filter(({ kind }) => kind === "same" || kind === (side === "before" ? "removed" : "added"))
    .map(({ value }) => value)
    .join("");
}

test("produces a word-level diff for normal text", () => {
  const before = "We was ready.";
  const after = "We were ready.";
  const parts = diffWords(before, after);

  assert.equal(reconstruct(parts, "before"), before);
  assert.equal(reconstruct(parts, "after"), after);
  assert.ok(parts.some(({ kind }) => kind === "removed"));
  assert.ok(parts.some(({ kind }) => kind === "added"));
});

test("falls back to a bounded coarse diff for very long text", () => {
  const sharedStart = "Start " + "word ".repeat(1100);
  const before = sharedStart + "old ending";
  const after = sharedStart + "new ending";
  const parts = diffWords(before, after);

  assert.equal(reconstruct(parts, "before"), before);
  assert.equal(reconstruct(parts, "after"), after);
  assert.ok(parts.length <= 4);
});
