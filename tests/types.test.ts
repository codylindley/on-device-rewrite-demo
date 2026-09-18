import assert from "node:assert/strict";
import test from "node:test";
import { EDIT_ACTIONS, isDownloadApproval, isRewriteAction, isRewriteRequest } from "../src/types.ts";

test("recognizes every supported editing action", () => {
  assert.deepEqual(EDIT_ACTIONS, [
    "grammar",
    "concise",
    "longer",
    "casual",
    "professional",
    "confident",
    "enthusiastic",
    "lighthearted",
  ]);
  assert.ok(EDIT_ACTIONS.every(isRewriteAction));
  assert.equal(isRewriteAction("sarcastic"), false);
});

test("grammar depth cannot silently change style actions or select an incompatible engine", () => {
  const request = { type: "rewrite", id: 1, text: "The report is ready.", action: "grammar", attempt: 0 };
  assert.equal(isRewriteRequest({ ...request, grammarDepth: "quick", engine: "harper" }), true);
  assert.equal(isRewriteRequest({ ...request, grammarDepth: "deep", engine: "coedit" }), true);
  assert.equal(isRewriteRequest({ ...request, grammarDepth: "deep", engine: "harper" }), false);
  assert.equal(isRewriteRequest({ ...request, grammarDepth: "quick", engine: "coedit" }), false);
  assert.equal(isRewriteRequest({ ...request, action: "casual", grammarDepth: "deep" }), false);
  assert.equal(isRewriteRequest({ ...request, grammarDepth: "automatic" }), false);
  assert.equal(isRewriteRequest({ ...request, engine: "remote-api" }), false);
  for (const id of [0, -1, 1.5, "1", NaN]) {
    assert.equal(isDownloadApproval({ type: "allow-download", id, key: "model:q8" }), false);
  }
  assert.equal(isDownloadApproval({ type: "allow-download", id: 1, key: "model:q8" }), true);
  assert.equal(isDownloadApproval({ type: "allow-download", id: 1, key: "" }), false);
});

test("accepts worker requests for every supported action", () => {
  for (const action of EDIT_ACTIONS) {
    assert.equal(isRewriteRequest({
      type: "rewrite",
      id: 1,
      text: "Improve this text.",
      action,
      attempt: 0,
    }), true);
  }
});
