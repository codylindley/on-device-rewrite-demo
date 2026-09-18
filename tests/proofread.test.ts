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

test("applies safe boundary and contextual their/there corrections", async () => {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  try {
    assert.equal(
      await applyConservativeProofreading(
        "Their are alot of reasons, but their report is ready.",
        linter,
      ),
      "There are a lot of reasons, but their report is ready.",
    );
    assert.equal(
      await applyConservativeProofreading(
        "Remember when your suppose to leave, when you suppose to return, and to right their own essays.",
        linter,
      ),
      "Remember when you're supposed to leave, when you're supposed to return, and to write their own essays.",
    );
    assert.equal(
      await applyConservativeProofreading("Your proposal is ready.", linter),
      "Your proposal is ready.",
    );
  } finally {
    await linter.dispose();
  }
});
