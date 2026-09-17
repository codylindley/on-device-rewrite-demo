import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanEditOutput,
  normalizeEditOutput,
  rejectedEditReason,
} from "../src/lib/output.ts";

test("cleans common model wrappers and quoted JSON strings", () => {
  assert.equal(
    cleanEditOutput(`<think>ignore</think>
\`\`\`text
"Corrected\\ntext."
\`\`\``),
    "Corrected\ntext.",
  );
});

test("normalizes sentence capitalization, first-person I, and terminal punctuation", () => {
  assert.equal(
    normalizeEditOutput("hey team, i can send it", "hey team, i can send it."),
    "Hey team, I can send it.",
  );
});

test("accepts a faithful grammar correction", () => {
  const source =
    "hey team i wanted to ask if you can please sends the report by friday because we was waiting on it";
  const candidate =
    "Hey team, I wanted to ask if you can please send the report by Friday because we were waiting on it.";
  assert.equal(rejectedEditReason("grammar", source, candidate), null);
});

test("rejects responses that answer the supplied text", () => {
  assert.match(
    rejectedEditReason(
      "professional",
      "Could you send the report by Friday?",
      "Sure, I can send the report by Friday.",
    ) ?? "",
    /answered/,
  );
});

test("rejects unchanged output so the editor can retry or warn", () => {
  assert.match(
    rejectedEditReason("grammar", "We was waiting.", "We was waiting.") ?? "",
    /unchanged/,
  );
});

test("rejects edits that remove protected facts", () => {
  const source = "Sarah, can you upload 3 files to https://example.com by 2:30?";
  assert.match(
    rejectedEditReason(
      "professional",
      source,
      "Could you upload the files to https://example.com?",
    ) ?? "",
    /number|question|name/,
  );
  assert.match(
    rejectedEditReason(
      "professional",
      source,
      "Sarah, could you upload 3 files by 2:30?",
    ) ?? "",
    /link/,
  );
});

test("rejects grammar corrections that paraphrase most of the wording", () => {
  assert.match(
    rejectedEditReason(
      "grammar",
      "The projector kept turning itself off during the presentation.",
      "The equipment repeatedly failed while the speaker was presenting.",
    ) ?? "",
    /meaning|omitted|paraphrased/,
  );
});

test("rejects a concise result that is longer than its source", () => {
  assert.match(
    rejectedEditReason(
      "concise",
      "Please send the report.",
      "Please make sure that you send the completed report to me.",
    ) ?? "",
    /longer|omitted/,
  );
});

test("rejects edits that reverse or remove critical semantic markers", () => {
  assert.match(
    rejectedEditReason(
      "professional",
      "The projector kept turning itself off.",
      "The projector kept turning on.",
    ) ?? "",
    /off/,
  );
  assert.match(
    rejectedEditReason(
      "professional",
      "We should not exceed the budget.",
      "We should exceed the budget.",
    ) ?? "",
    /negation/,
  );
});
