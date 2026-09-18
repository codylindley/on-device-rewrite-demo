import type { Lint, Linter } from "harper.js";

const AUTOMATIC_LINT_KINDS = new Set([
  "Agreement",
  "BoundaryError",
  "Capitalization",
  "Grammar",
  "Spelling",
  "Usage",
  "WordChoice",
]);

function isContextuallySafeFirstSuggestion(lint: Lint, text: string): boolean {
  if (lint.lint_kind() !== "Grammar" || lint.get_problem_text().toLowerCase() !== "their") {
    return false;
  }
  const span = lint.span();
  const followingText = text.slice(span.end);
  const replacement = lint.suggestions()[0]?.get_replacement_text().toLowerCase();
  return replacement === "there" && /^\s+(?:are|is|was|were)\b/iu.test(followingText);
}

function isAutomaticLint(lint: Lint, text: string): boolean {
  if (!AUTOMATIC_LINT_KINDS.has(lint.lint_kind())) return false;
  if (lint.suggestion_count() !== 1 && !isContextuallySafeFirstSuggestion(lint, text)) {
    return false;
  }
  const replacement = lint.suggestions()[0]?.get_replacement_text();
  return replacement !== undefined && replacement !== lint.get_problem_text();
}

export async function applyConservativeProofreading(
  text: string,
  linter: Linter,
): Promise<string> {
  const candidates = (await linter.lint(text))
    .filter((lint) => isAutomaticLint(lint, text))
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
