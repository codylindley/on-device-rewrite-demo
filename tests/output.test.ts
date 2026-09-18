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

test("cleans labels emitted by tone and length rewrites", () => {
  assert.equal(cleanEditOutput("Enthusiastic version: Great news—the update is ready!"), "Great news—the update is ready!");
  assert.equal(cleanEditOutput("Light-hearted: The draft is ready."), "The draft is ready.");
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

test("accepts a faithful longer edit and rejects one that is not longer", () => {
  assert.equal(
    rejectedEditReason(
      "longer",
      "Please review the draft carefully.",
      "Please take a thorough look at the draft and review it carefully.",
    ),
    null,
  );
  assert.match(
    rejectedEditReason("longer", "Please review the draft.", "Review the draft.") ?? "",
    /not longer/,
  );
});

test("accepts fact-preserving tone rewrites", () => {
  const source = "Please send the project update when it is ready.";
  const candidates = {
    casual: "Send the project update when it’s ready, please.",
    professional: "Please send the project update once it is ready.",
    confident: "Send the project update when it is ready.",
    enthusiastic: "Great news—please send the project update when it is ready!",
    lighthearted: "Please send the project update when it is ready for the spotlight.",
  } as const;

  for (const [action, candidate] of Object.entries(candidates)) {
    assert.equal(
      rejectedEditReason(action as keyof typeof candidates, source, candidate),
      null,
      action,
    );
  }
});

test("rejects creative modes that only perform a generic correction", () => {
  assert.match(
    rejectedEditReason(
      "lighthearted",
      "We was waiting for the update.",
      "We were waiting for the update.",
    ) ?? "",
    /playful/,
  );
  assert.match(
    rejectedEditReason(
      "enthusiastic",
      "The update is ready.",
      "The update is now ready.",
    ) ?? "",
    /enthusiastic/,
  );
});

test("rejects a light-hearted aside that invents a new request or plan", () => {
  assert.match(
    rejectedEditReason(
      "lighthearted",
      "Please send the project update tomorrow.",
      "Please send the project update tomorrow—let's find a way to make it work together!",
    ) ?? "",
    /new request or plan/,
  );
});

test("rejects placeholder copy and a newly invented question", () => {
  const source = "Please send the project update tomorrow.";
  const candidate = "Please send the project update tomorrow—a playful observation about the schedule?";
  assert.match(rejectedEditReason("lighthearted", source, candidate) ?? "", /placeholder/);
  assert.match(
    rejectedEditReason(
      "lighthearted",
      source,
      "Please send the project update tomorrow—ready for the spotlight?",
    ) ?? "",
    /introduced a question/,
  );
});

test("protects explicit relative dates in every rewrite mode", () => {
  assert.match(
    rejectedEditReason(
      "lighthearted",
      "Can we move tomorrow's review later?",
      "Can we move our next review later—calendar juggling time?",
    ) ?? "",
    /tomorrow/,
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

test("accepts a concise edit that keeps negative meaning without an explicit negator", () => {
  const source =
    "Hey team, I wanted to check if we could maybe move tomorrows review a little later because I haven't finish the notes yet.";
  assert.equal(
    rejectedEditReason(
      "concise",
      source,
      "Hey team, can we move tomorrow's review later? I'm still finishing the notes.",
    ),
    null,
  );
});

test("still rejects a concise edit that flips the negation to a positive claim", () => {
  const source =
    "Hey team, I wanted to check if we could maybe move tomorrows review a little later because I haven't finish the notes yet.";
  assert.match(
    rejectedEditReason(
      "concise",
      source,
      "Hey team, can we move tomorrow's review later? I have finished the notes.",
    ) ?? "",
    /negation/,
  );
});

test("detects negations written without an apostrophe", () => {
  assert.match(
    rejectedEditReason(
      "professional",
      "We dont want to exceed the budget.",
      "We want to exceed the budget.",
    ) ?? "",
    /negation/,
  );
});

test("rejects changing a person into an existential there-is statement", () => {
  const source =
    "Everyone should admit it instead of pretending like there some kind of expert.";
  assert.match(
    rejectedEditReason(
      "grammar",
      source,
      "Everyone should admit it instead of pretending like there is some kind of expert.",
    ) ?? "",
    /changed who/,
  );
  assert.match(
    rejectedEditReason(
      "professional",
      source,
      "Everyone should acknowledge it rather than pretending like there's some kind of expert.",
    ) ?? "",
    /changed who/,
  );
  assert.equal(
    rejectedEditReason(
      "grammar",
      source,
      "Everyone should admit it instead of pretending like they're some kind of expert.",
    ),
    null,
  );
});
