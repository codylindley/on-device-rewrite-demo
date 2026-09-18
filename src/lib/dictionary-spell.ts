import type { GrammarFinding } from "../types.ts";

export interface Speller {
  correct(word: string): boolean;
  suggest(word: string): string[];
}

export interface SpellcheckResult {
  text: string;
  findings: GrammarFinding[];
}

const WORD = /[\p{L}][\p{L}'’]*/gu;
/** Links, addresses, handles, tags, bare domains, and paths are identifiers; a dictionary has no opinion on them. */
const PROTECTED = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+|[@#][\w-]+|\/[\w./-]*\w|[\w-]+(?:\.[\w-]+)+/giu;
const MAX_DISTANCE = 2;
const MAX_SUGGESTIONS = 4;
/** Really two words, so a single-token dictionary can never reach the intended answer. */
const ELISIONS = new Set(["alot", "aswell", "infact", "incase", "atleast", "inspite", "everytime"]);

/** Damerau-Levenshtein: a swapped pair is one slip of the fingers, not two edits. */
function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push(new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
}

function bare(word: string): string {
  return word.replace(/['’]/gu, "").toLowerCase();
}

function letters(word: string): string {
  return [...bare(word)].sort().join("");
}

function protectedSpans(text: string): readonly (readonly [number, number])[] {
  return [...text.matchAll(PROTECTED)].map((match) =>
    [match.index ?? 0, (match.index ?? 0) + match[0].length] as const);
}

function matchCase(original: string, replacement: string): string {
  return original[0] === original[0]?.toUpperCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

/** Interior capitals or an adjacent digit mark a product name or identifier, not prose. */
function isIdentifier(text: string, word: string, start: number, end: number): boolean {
  if (/\p{Lu}/u.test(word.slice(1))) return true;
  return /[\d_]/u.test(text[start - 1] ?? "") || /[\d_]/u.test(text[end] ?? "");
}

/** A capital mid-sentence is a name far more often than a typo, and a word list cannot tell which. */
function capitalizedMidSentence(text: string, word: string, start: number): boolean {
  if (!/\p{Lu}/u.test(word[0] ?? "")) return false;
  for (let index = start - 1; index >= 0; index -= 1) {
    const character = text[index]!;
    if (/\s/u.test(character)) continue;
    return !/[.!?:;("'\u201c\u2018\[]/u.test(character);
  }
  return false;
}

/**
 * A dictionary knows a word is wrong; it rarely knows what was meant. Three shapes of
 * correction are safe without a human:
 *
 * 1. a missing apostrophe (`havent` → `haven't`);
 * 2. the same letters in a different order (`recieved` → `received`), which beats a
 *    same-distance rival like `relieved` because the typed letters were already right;
 * 3. a single nearest neighbour with no rival (`seperate` → `separate`).
 *
 * Everything else is reported rather than guessed at. `adress` ties between `address` and
 * `dress`, and `alot` ties between `allot` and `slot` — and the phrase actually wanted
 * there, `a lot`, is two words, which a single-token dictionary can never reach.
 */
export function confidentCorrection(word: string, suggestions: readonly string[]): string | null {
  if (ELISIONS.has(bare(word))) return null;
  const apostrophe = suggestions.find((option) => bare(option) === bare(word) && option !== word);
  if (apostrophe) return apostrophe;

  const rearranged = suggestions.filter((option) => letters(option) === letters(word));
  if (rearranged.length === 1) return rearranged[0] ?? null;
  if (rearranged.length > 1) return null;

  const scored = suggestions.map((option) => ({ option, gap: distance(bare(word), bare(option)) }));
  const best = Math.min(...scored.map((entry) => entry.gap));
  if (!Number.isFinite(best) || best > MAX_DISTANCE) return null;
  const nearest = scored.filter((entry) => entry.gap === best);
  return nearest.length === 1 ? nearest[0]?.option ?? null : null;
}

export function spellcheckText(text: string, speller: Speller): SpellcheckResult {
  const skip = protectedSpans(text);
  const findings: GrammarFinding[] = [];
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(WORD)) {
    // A closing quote belongs to the sentence, not the word: ‘havent’ must keep its final mark.
    const word = match[0].replace(/['’]+$/u, "");
    const start = match.index ?? 0;
    const end = start + word.length;
    if (word.length < 3) continue;
    if (isIdentifier(text, word, start, end)) continue;
    if (skip.some(([from, to]) => start < to && end > from)) continue;
    if (speller.correct(word)) continue;

    // Confidence is judged on the whole list; truncating first hides rivals and over-applies.
    const ranked = speller.suggest(word);
    const guess = confidentCorrection(word, ranked);
    const confident = guess !== null && capitalizedMidSentence(text, word, start) ? null : guess;
    const suggestions = ranked.slice(0, MAX_SUGGESTIONS);
    findings.push({ kind: "Spelling", problem: word, suggestions, applied: confident !== null });
    if (confident === null) continue;
    output += text.slice(cursor, start) + matchCase(word, confident);
    cursor = end;
  }
  return { text: output + text.slice(cursor), findings };
}
