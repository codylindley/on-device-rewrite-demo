import assert from "node:assert/strict";
import test from "node:test";
import { Dialect, LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";
import { applyConservativeProofreading } from "../src/lib/proofread.ts";

test("applies high-confidence grammar cleanup without applying style suggestions", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    const corrected = await applyConservativeProofreading(
      "We was suppose to leave, but we would of waited.",
      linter,
    );

    assert.equal(
      corrected,
      "We were supposed to leave, but we would have waited.",
    );
  } finally {
    await linter.dispose();
  }
});
