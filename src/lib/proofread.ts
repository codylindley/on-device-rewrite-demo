import type { Lint, Linter } from "harper.js";
import type { GrammarFinding } from "../types.ts";

const AUTOMATIC_LINT_KINDS = new Set([
  "Agreement",
  "BoundaryError",
  "Capitalization",
  "Grammar",
  "Spelling",
  "Usage",
  "WordChoice",
]);

/**
 * A rule engine matches shapes, not meaning. A lone token carrying interior capitals or digits, sitting
 * against code punctuation, or merely recased while already capitalised is a name or an identifier, and
 * rewriting it is always wrong.
 */
function isUnsafeTokenEdit(lint: Lint, text: string, replacement: string): boolean {
  const problem = lint.get_problem_text();
  if (/\s/u.test(problem)) return false;
  if (/\p{Lu}/u.test(problem.slice(1)) || /[\d_]/u.test(problem)) return true;
  const span = lint.span();
  if (/[/\\_`.\d]/u.test(text[span.start - 1] ?? "") || /[/\\_`\d]/u.test(text[span.end] ?? "")) {
    return true;
  }
  return replacement.toLowerCase() === problem.toLowerCase() && /\p{Lu}/u.test(problem);
}

function isContextuallySafeFirstSuggestion(lint: Lint, text: string): boolean {
  if (lint.lint_kind() !== "Grammar" || lint.get_problem_text().toLowerCase() !== "their") {
    return false;
  }
  const span = lint.span();
  const followingText = text.slice(span.end);
  const replacement = lint.suggestions()[0]?.get_replacement_text().toLowerCase();
  return replacement === "there" && /^\s+(?:are|is|was|were)\b/iu.test(followingText);
}

/**
 * Harper reports a misspelling and an unrelated word-choice substitution for the same token, and the
 * substitution carries the single suggestion that normally signals confidence. Taking it turns `untill`
 * into `distill`. Only a fix that keeps the same letters — respacing, as in `alot` to `a lot` — or one
 * the speller itself proposed may outrank a spelling the speller was unsure about.
 */
function contradictsSpelling(lint: Lint, spellings: readonly Lint[]): boolean {
  if (lint.lint_kind() === "Spelling") return false;
  const span = lint.span();
  const overlapping = spellings.filter((other) => {
    const otherSpan = other.span();
    return otherSpan.start < span.end && span.start < otherSpan.end;
  });
  if (overlapping.length === 0) return false;
  const replacement = lint.suggestions()[0]?.get_replacement_text() ?? "";
  const collapse = (value: string) => value.replace(/\s+/gu, "").toLowerCase();
  if (collapse(replacement) === collapse(lint.get_problem_text())) return false;
  return !overlapping.some((other) =>
    other
      .suggestions()
      .some((suggestion) => collapse(suggestion.get_replacement_text()) === collapse(replacement)),
  );
}

function isAutomaticLint(lint: Lint, text: string): boolean {  if (!AUTOMATIC_LINT_KINDS.has(lint.lint_kind())) return false;
  if (lint.suggestion_count() !== 1 && !isContextuallySafeFirstSuggestion(lint, text)) {
    return false;
  }
  const replacement = lint.suggestions()[0]?.get_replacement_text();
  if (replacement === undefined || replacement === lint.get_problem_text()) return false;
  if (isUnsafeTokenEdit(lint, text, replacement)) return false;
  return true;
}

export async function inspectProofreading(
  text: string,
  linter: Linter,
): Promise<{ text: string; findings: GrammarFinding[] }> {
  // Deduplicating first lets a whole-sentence readability lint hide spelling fixes.
  const lints = await linter.lint(text, { language: "plaintext", dedup: false });
  const spellings = lints.filter((lint) => lint.lint_kind() === "Spelling");
  const candidates = lints
    .filter((lint) => isAutomaticLint(lint, text) && !contradictsSpelling(lint, spellings))
    .sort((left, right) => right.span().start - left.span().start);

  const selected: Lint[] = [];
  let nextStart = Number.POSITIVE_INFINITY;
  for (const lint of candidates) {
    const span = lint.span();
    if (span.end > nextStart) continue;
    selected.push(lint);
    nextStart = span.start;
  }

  let corrected = text;
  for (const lint of selected) {
    corrected = await linter.applySuggestion(
      corrected,
      lint,
      lint.suggestions()[0],
    );
  }
  return {
    text: corrected,
    findings: lints.map((lint) => ({
      kind: lint.lint_kind(),
      problem: lint.get_problem_text(),
      suggestions: lint.suggestions().map((suggestion) => suggestion.get_replacement_text()),
      applied: selected.includes(lint),
    })),
  };
}

export async function applyConservativeProofreading(
  text: string,
  linter: Linter,
): Promise<string> {
  const { text: corrected } = await inspectProofreading(text, linter);
  return corrected
    .replace(
      /\b(?:your|you)\s+suppose(?:d)?\s+to\b/giu,
      (phrase) => `${/^Y/u.test(phrase) ? "You're" : "you're"} supposed to`,
    )
    .replace(
      /\bto\s+right(?=\s+(?:my|your|his|her|our|their|an?|the)\s+(?:own\s+)?(?:essay|paper|report|draft|email|message|letter|story|article|book|text|response|reply)s?\b)/giu,
      (phrase) => phrase.replace(/right/iu, "write"),
    );
}
