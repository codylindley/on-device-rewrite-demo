import type { Lint, Linter } from "harper.js";

const AUTOMATIC_LINT_KINDS = new Set([
  "Agreement",
  "Capitalization",
  "Grammar",
  "Spelling",
  "Usage",
  "WordChoice",
]);

function isAutomaticLint(lint: Lint): boolean {
  if (!AUTOMATIC_LINT_KINDS.has(lint.lint_kind())) return false;
  if (lint.suggestion_count() !== 1) return false;
  const replacement = lint.suggestions()[0]?.get_replacement_text();
  return replacement !== undefined && replacement !== lint.get_problem_text();
}

export async function applyConservativeProofreading(
  text: string,
  linter: Linter,
): Promise<string> {
  const candidates = (await linter.lint(text))
    .filter(isAutomaticLint)
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
  return corrected;
}
