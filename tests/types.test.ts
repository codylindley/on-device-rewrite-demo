import assert from "node:assert/strict";
import test from "node:test";
import { EDIT_ACTIONS, isRewriteAction, isRewriteRequest } from "../src/types.ts";

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
