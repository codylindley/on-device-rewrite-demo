import assert from "node:assert/strict";
import test from "node:test";
import { rejectedEditReason } from "../src/lib/output.ts";
import { EDIT_ACTIONS, type RewriteAction } from "../src/types.ts";

const requestSource = (body: string) => `Please, I wanted to ask if you could carefully ${body}`;

function requestCandidate(action: RewriteAction, body: string): string {
  switch (action) {
    case "concise":
    case "confident":
      return body[0].toUpperCase() + body.slice(1);
    case "longer":
      return `${requestSource(body.slice(0, -1))} and make sure to follow this request with care.`;
    case "enthusiastic":
      return `Great news! Please ${body.slice(0, -1)}!`;
    case "lighthearted":
      return `Please ${body.slice(0, -1)}—a breeze.`;
    case "casual":
      return `Please ${body.slice(0, -1)}, thanks.`;
    default:
      return `Please ${body}`;
  }
}

for (const action of EDIT_ACTIONS) {
  test(`${action} preserves numeric values and multiplicity after satisfying action gates`, () => {
    const body = "keep 3 files in the project folder until the review is complete.";
    const source = requestSource(body);
    assert.equal(rejectedEditReason(action, source, requestCandidate(action, body)), null);
    for (const replacement of ["4 files", "the files", "3 files plus 2 more", "3 files plus 3 more"]) {
      assert.match(
        rejectedEditReason(action, source, requestCandidate(action, body.replace("3 files", replacement))) ?? "",
        /number/,
        `${action}: ${replacement}`,
      );
    }
    const withoutNumbers = body.replace("3 files", "the files");
    assert.match(
      rejectedEditReason(
        action,
        requestSource(withoutNumbers),
        requestCandidate(action, body),
      ) ?? "",
      /number/,
      `${action}: newly introduced number`,
    );
  });

  test(`${action} protects numeric signs, percentages, and magnitude`, () => {
    for (const [before, after] of [
      ["-3", "3"], ["3%", "3"], ["$3", "3"], ["3 million", "3 billion"],
      ["0.3", "3"], ["1e3", "1e4"], ["٣", "٤"], ["3m", "3M"],
    ]) {
      const source = requestSource(`keep the target at ${before} until the project review is complete.`);
      const candidate = requestCandidate(action, `keep the target at ${after} until the project review is complete.`);
      assert.equal(rejectedEditReason(action, source, requestCandidate(action,
        `keep the target at ${before} until the project review is complete.`)), null);
      assert.match(rejectedEditReason(action, source, candidate) ?? "", /number/, `${before} → ${after}`);
    }
  });

  test(`${action} allows URL scheme/host casing but protects path, query, and fragment`, () => {
    const url = "https://Example.com/Case/Path?Token=AbC#Part";
    const body = `keep ${url} in the project notes until the review is complete.`;
    const source = requestSource(body);
    const allowed = body.replace(url, "HTTPS://EXAMPLE.COM/Case/Path?Token=AbC#Part");
    assert.equal(rejectedEditReason(action, source, requestCandidate(action, allowed)), null);
    for (const changed of [
      "https://example.com/case/Path?Token=AbC#Part",
      "https://example.com/Case/path?Token=AbC#Part",
      "https://example.com/Case/Path?token=AbC#Part",
      "https://example.com/Case/Path?Token=abc#Part",
      "https://example.com/Case/Path?Token=AbC#part",
    ]) {
      assert.match(
        rejectedEditReason(action, source, requestCandidate(action, body.replace(url, changed))) ?? "",
        /link/,
        changed,
      );
    }
  });

  test(`${action} does not discard meaningful URL punctuation`, () => {
    for (const punctuation of ["!", "?", ";", ":", ",", "."]) {
      const url = `https://example.com/endpoint${punctuation}`;
      const body = `keep ${url} in the project notes until the review is complete.`;
      const source = requestSource(body);
      assert.equal(rejectedEditReason(action, source, requestCandidate(action, body)), null);
      assert.match(
        rejectedEditReason(action, source, requestCandidate(action,
          body.replace(url, "https://example.com/endpoint"))) ?? "",
        /link/,
        punctuation,
      );
    }
  });
}

const negativeSource =
  "For the review, the team did not approved the draft, but the team accepted the budget.";
const negativeCandidates: Record<RewriteAction, string> = {
  grammar: "For the review, the team did not approve the draft, but the team accepted the budget.",
  concise: "The team did not approve the draft, but the team accepted the budget for the review.",
  longer: "For the review, the team did not approve the draft, but the team accepted the budget and carefully recorded that decision for reference.",
  casual: "For the review, the team didn't approve the draft, but the team accepted the budget.",
  professional: "During the review, the team did not approve the draft, but the team accepted the budget.",
  confident: "The team did not approve the draft, but the team accepted the budget for the review.",
  enthusiastic: "Great news! For the review, the team did not approve the draft, but the team accepted the budget!",
  lighthearted: "For the review, the team did not approve the draft, but the team accepted the budget—a breeze.",
};

for (const action of EDIT_ACTIONS) {
  test(`${action} rejects shifted curly-apostrophe negation without relying on tone/length failures`, () => {
    const candidate = negativeCandidates[action];
    assert.equal(rejectedEditReason(action, negativeSource, candidate), null);
    const shifted = candidate
      .replace(/(?:did not|didn't) approve/u, "approved")
      .replace("accepted", "didn’t accept");
    assert.match(rejectedEditReason(action, negativeSource, shifted) ?? "", /negation/);
  });

  test(`${action} rejects an added negation`, () => {
    const source = negativeSource
      .replace("For the review,", "For the project review,")
      .replace("did not approved", "approved");
    const positive = negativeCandidates[action].replace(/(?:did not|didn't) approve/u, "approved");
    const candidate = positive.replace("accepted", "didn’t accept");
    assert.equal(rejectedEditReason(action, source, positive), null);
    assert.match(rejectedEditReason(action, source, candidate) ?? "", /negation/);
  });
}
