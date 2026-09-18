import type { RewriteAction } from "../types.ts";
import { linkPattern } from "./links.ts";

export function cleanEditOutput(output: string): string {
  let cleaned = output
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^<text>\s*/i, "")
    .replace(/\s*<\/text>$/i, "")
    .replace(
      /^(?:(?:revised|rewritten|corrected|edited)\s+(?:text|version)|(?:concise|longer|casual|professional|confident|enthusiastic|light[- ]hearted)(?:\s+(?:text|version))?)\s*:\s*/i,
      "",
    )
    .trim();

  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (typeof parsed === "string") cleaned = parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      cleaned = cleaned.slice(1, -1);
    }
  } else if (cleaned.startsWith("“") && cleaned.endsWith("”")) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned.trim();
}

export function normalizeEditOutput(output: string, source: string): string {
  let normalized = cleanEditOutput(output)
    .replace(/(^|[\s([{"“])i(?=$|[\s,.;:!?'"”)\]}])/gu, "$1I");
  normalized = normalized.replace(
    /^(\P{L}*)(\p{Ll})/u,
    (_, prefix: string, letter: string) => prefix + letter.toLocaleUpperCase("en-US"),
  );

  const sourcePunctuation = source.trim().match(/[.!?…]$/u)?.[0];
  if (sourcePunctuation && !/[.!?…]$/u.test(normalized)) {
    normalized += sourcePunctuation;
  }
  return normalized;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

function coverage(source: string[], candidate: string[]): number {
  const counts = new Map<string, number>();
  for (const word of candidate) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of source) {
    const count = counts.get(word) ?? 0;
    if (count > 0) {
      shared += 1;
      counts.set(word, count - 1);
    }
  }
  return shared / Math.max(1, source.length);
}

const sentenceStarters = new Set([
  "a", "after", "although", "an", "and", "are", "as", "at", "before", "both",
  "but", "by", "can", "could", "do", "does", "for", "from", "had", "has",
  "have", "he", "her", "here", "hey", "hi", "hello", "how", "however", "i",
  "if", "in", "is", "it", "its", "last", "let", "me", "my", "no", "nobody",
  "none", "now", "on", "one", "only", "or", "our", "please", "several",
  "she", "so", "some", "thank", "thanks", "that", "the", "their", "there",
  "these", "they", "this", "those", "to", "today", "tomorrow", "unfortunately",
  "was", "we", "what", "when", "where", "which", "while", "who", "why",
  "will", "with", "would", "yesterday", "you", "your",
]);

const fillerWords = new Set([
  ...sentenceStarters,
  "be", "been", "being", "because", "itself", "really", "very", "just", "maybe",
  "might", "wanted", "want", "writing", "wondering", "possibly", "possible",
  "ask", "asking", "able", "could", "can", "please", "would", "like",
]);

function contentWords(text: string): string[] {
  return words(text)
    .filter((word) => word.length > 2 && !fillerWords.has(word))
    .map((word) => word.replace(/['’]/gu, "").replace(/(?<=.{4})(?:ing|ed|s)$/u, ""));
}

function sameItems(source: string[], candidate: string[]): boolean {
  return source.length === candidate.length &&
    (!source.length || coverage(source, candidate) === 1);
}

function numbers(text: string): string[] {
  return (text.match(
    /(?:[+−-]\s*)?(?:\p{Sc}\s*)?(?:[+−-]\s*)?(?:\p{Nd}+(?:[.,:/-]\p{Nd}+)*|[.,]\p{Nd}+)(?:[eE][+−-]?\p{Nd}+)?(?:\s*(?:[%‰‱]|\p{Sc}|(?:hundred|thousand|million|billion|trillion|[kmbt])\b))?/giu,
  ) ?? []).map((number) => number.replace(/\s+/gu, ""));
}

function links(text: string): string[] {
  return (text.match(linkPattern) ?? [])
    .map((link) => {
      const parts = link.match(/^(https?:\/\/)?([^/?#]+)(.*)$/iu);
      if (!parts) return link;
      const [, scheme = "", authority, resource] = parts;
      const userInfoEnd = authority.lastIndexOf("@") + 1;
      // Paths, queries, fragments, credentials, and ambiguous trailing punctuation
      // are case-sensitive data; only the scheme and host can change case.
      return scheme.toLowerCase() + authority.slice(0, userInfoEnd) +
        authority.slice(userInfoEnd).toLowerCase() + resource;
    });
}

export function rejectedStructuredFactReason(source: string, candidate: string): string | null {
  if (!sameItems(numbers(source), numbers(candidate))) {
    return "the edit added, changed, removed, or repeated a number";
  }
  if (!sameItems(links(source), links(candidate))) {
    return "the edit added, changed, removed, or repeated a link";
  }
  return null;
}

function capitalizedTerms(text: string): string[] {
  return (text.replace(linkPattern, "").match(/\b\p{Lu}[\p{L}\p{M}'’.-]{2,}\b/gu) ?? [])
    .filter((word) => {
      const normalized = word.toLowerCase().replace(/’/gu, "'");
      return !sentenceStarters.has(normalized.replace(/'(?:m|re|ve|ll|d|s)$/u, "")) &&
        !negativeContractions.has(normalized);
    });
}

const semanticMarkers = [
  "above",
  "after",
  "before",
  "below",
  "decrease",
  "earlier",
  "increase",
  "inside",
  "later",
  "maximum",
  "minimum",
  "off",
  "outside",
  "today",
  "tomorrow",
  "tonight",
  "yesterday",
] as const;

function wordCount(text: string, word: string): number {
  return words(text).filter((candidate) =>
    candidate === word || candidate === `${word}s` ||
    candidate === `${word}'s` || candidate === `${word}’s`
  ).length;
}

function addsNewCue(source: string, candidate: string, cues: readonly string[]): boolean {
  const sourceText = source.toLowerCase();
  const candidateText = candidate.toLowerCase();
  return cues.some((cue) => candidateText.includes(cue) && !sourceText.includes(cue));
}

const negativeContractions = new Set([
  "ain't", "aren't", "can't", "couldn't", "didn't", "doesn't", "don't",
  "hadn't", "hasn't", "haven't", "isn't", "mustn't", "needn't", "shan't",
  "shouldn't", "wasn't", "weren't", "won't", "wouldn't",
].flatMap((word) => [word, word.replace("'", "")]));

const negativeWords = new Set([
  "barely", "hardly", "neither", "never", "no", "nobody", "none", "nor",
  "not", "nothing", "nowhere", "rarely", "seldom", "without",
]);

const anchorNoise = new Set([
  "a", "an", "the", "am", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "can", "could", "will", "would",
  "shall", "should", "must", "may", "might", "to", "of", "for", "in", "on",
  "at", "by", "with", "as", "please", "itself", "myself", "yourself",
  "ourselves", "themselves", "himself", "herself", "yet",
]);

const irregularAnchors: Record<string, string> = {
  went: "go", gone: "go", goes: "go", going: "go",
  saw: "see", seen: "see", sees: "see", seeing: "see",
  began: "begin", begun: "begin", begins: "begin", beginning: "begin",
};

function anchor(word: string): string {
  if (irregularAnchors[word]) return irregularAnchors[word];
  let stem = word.replace(/'(?:m|re|ve|ll|d|s)$/u, "");
  if (stem.length > 4) {
    if (/(?:ied|ies)$/u.test(stem)) stem = stem.slice(0, -3) + "y";
    else if (/(?:ing|ed)$/u.test(stem)) {
      stem = stem.replace(/(?:ing|ed)$/u, "").replace(/([b-df-hj-np-tv-z])\1$/u, "$1");
    } else if (/(?:ches|shes|xes|zes|sses)$/u.test(stem)) stem = stem.slice(0, -2);
    else if (/[^s]s$/u.test(stem)) stem = stem.slice(0, -1);
  }
  return stem.length > 3 ? stem.replace(/e$/u, "") : stem;
}

interface NegativeScope {
  marker: string;
  before: string[];
  after: string[];
  unfinished: boolean;
}

function negativeScopes(text: string, implicitCompletion = false): NegativeScope[] {
  const scopes: NegativeScope[] = [];
  // These local anchors are conservative evidence, not a semantic proof. Keeping
  // both sides prevents a negator elsewhere in a passage from masking a reversal.
  const clauses = text.split(/[.!?;,\r\n…]+|[—–]|\b(?:but|because|although|though|while|whereas)\b/giu);
  for (const clause of clauses) {
    const tokens = words(clause).map((word) => word.replace(/’/gu, "'"));
    const anchors = (values: string[]) =>
      values.filter((word) => !anchorNoise.has(word)).map((word) =>
        negativeContractions.has(word) || word === "cannot" ? "not" : anchor(word)
      );
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const completion = implicitCompletion && token === "still" &&
        /^(?:finishing|completing)$/u.test(tokens[index + 1] ?? "");
      const marker = completion || negativeContractions.has(token) || token === "cannot"
        ? "not"
        : negativeWords.has(token) ? token : null;
      if (!marker || (implicitCompletion && !completion)) continue;
      const after = anchors(tokens.slice(index + 1));
      scopes.push({
        marker,
        before: anchors(tokens.slice(0, index)),
        after,
        unfinished: marker === "not" &&
          /^(?:finish|complet)$/u.test(after[0] ?? "") &&
          (/^(?:haven't|havent|hasn't|hasnt)$/u.test(token) ||
            (token === "not" && /^(?:have|has)$/u.test(tokens[index - 1] ?? ""))),
      });
    }
  }
  return scopes;
}

function sameScope(source: NegativeScope, candidate: NegativeScope): boolean {
  return source.marker === candidate.marker &&
    source.before.join(" ") === candidate.before.join(" ") &&
    source.after.join(" ") === candidate.after.join(" ");
}

function rejectedNegationReason(
  action: RewriteAction,
  source: string,
  candidate: string,
): string | null {
  const original = negativeScopes(source);
  const remaining = negativeScopes(candidate);
  const completions = action === "concise" ? negativeScopes(candidate, true) : [];
  for (const scope of original) {
    const match = remaining.findIndex((other) => sameScope(scope, other));
    if (match >= 0) {
      remaining.splice(match, 1);
      continue;
    }
    const completion = scope.unfinished
      ? completions.findIndex((other) => sameScope(scope, other))
      : -1;
    if (completion >= 0) {
      completions.splice(completion, 1);
      continue;
    }
    return "the edit removed or changed the scope of a negation";
  }
  return remaining.length ? "the edit added or changed the scope of a negation" : null;
}

export function rejectedEditReason(
  action: RewriteAction,
  source: string,
  candidate: string,
): string | null {
  if (!candidate.trim()) return "the model returned no edited text";
  if (candidate.trim() === source.trim()) {
    return action === "grammar" ? null : "the model returned the section unchanged";
  }
  if (/<\/?think>|<\/?text>|```/iu.test(candidate)) {
    return "the model returned unfinished formatting or reasoning";
  }
  if (/^(?:sure|certainly|of course)[,!:]/iu.test(candidate) &&
      !/^(?:sure|certainly|of course)[,!:]/iu.test(source)) {
    return "the model answered the text instead of editing it";
  }

  const sourceWords = words(source);
  const candidateWords = words(candidate);
  if (action === "concise" && candidateWords.length > sourceWords.length) {
    return "the concise edit was longer than the original";
  }
  if (action === "longer" && candidateWords.length <= sourceWords.length) {
    return "the longer edit was not longer than the original";
  }
  if (action === "enthusiastic" &&
      !((candidate.includes("!") && !source.includes("!")) || addsNewCue(source, candidate, [
        "amazing", "delighted", "excited", "fantastic", "glad", "good news", "great",
        "happy", "looking forward", "thrilled", "wonderful",
      ]))) {
    return "the enthusiastic edit did not sound enthusiastic";
  }
  if (action === "lighthearted" &&
      !((/[—–]\s*\p{L}/u.test(candidate) && !/[—–]\s*\p{L}/u.test(source)) ||
        addsNewCue(source, candidate, [
          "breeze", "bright", "cheer", "friendly", "glad", "happily",
          "smile", "spotlight", "sunny",
        ]))) {
    return "the light-hearted edit did not sound playful";
  }
  if (action === "lighthearted" &&
      /\bplayful\s+(?:aside|observation|phrase)\b/iu.test(candidate) &&
      !/\bplayful\s+(?:aside|observation|phrase)\b/iu.test(source)) {
    return "the light-hearted edit returned a placeholder instead of edited text";
  }
  if (action === "lighthearted" &&
      /\blet['’]?s\b/iu.test(candidate) && !/\blet['’]?s\b/iu.test(source)) {
    return "the light-hearted edit introduced a new request or plan";
  }
  const lengthRatio = candidate.length / Math.max(1, source.length);
  const minimumLengthRatio = action === "concise" ? 0.12 : action === "longer" ? 0.75 : 0.35;
  const maximumLengthRatio = action === "longer" ? 3.5 : 2.5;
  if (!candidateWords.length || lengthRatio < minimumLengthRatio ||
      lengthRatio > maximumLengthRatio) {
    return "the edit changed too much of the section";
  }
  if (candidateWords.some((word) => word.length > 48 && !sourceWords.includes(word))) {
    return "the edit contains malformed words";
  }
  const structuredFactRejection = rejectedStructuredFactReason(source, candidate);
  if (structuredFactRejection) return structuredFactRejection;
  const sourceHasQuestion = source.replace(linkPattern, "").includes("?");
  const candidateHasQuestion = candidate.replace(linkPattern, "").includes("?");
  if (sourceHasQuestion && !candidateHasQuestion) {
    return "the edit removed a question";
  }
  if (action === "lighthearted" && !sourceHasQuestion && candidateHasQuestion) {
    return "the edit introduced a question";
  }

  if ((source.match(/\p{Extended_Pictographic}/gu) ?? []).join("") !==
      (candidate.match(/\p{Extended_Pictographic}/gu) ?? []).join("")) {
    return "the edit changed or removed an emoji";
  }
  for (const marker of semanticMarkers) {
    if (wordCount(candidate, marker) < wordCount(source, marker)) {
      return `the edit changed or removed the meaning of “${marker}”`;
    }
  }
  const negationRejection = rejectedNegationReason(action, source, candidate);
  if (negationRejection) return negationRejection;
  const lowerCandidateWords = new Set(candidateWords);
  if (capitalizedTerms(source).some((term) => !lowerCandidateWords.has(term.toLowerCase()))) {
    return "the edit changed or removed a name";
  }

  const personalPretence =
    /\b(?:everyone|everybody|they|people|someone|somebody|anyone|anybody|nobody|he|she|we|you)\b[^.!?]{0,120}\bpretend(?:s|ed|ing)?\s+(?:as if|like)\s+there\s+(?:(?:a|an|the)\s+|some(?:\s+kind\s+of)?\s+)/iu;
  const existentialPretence =
    /\bpretend(?:s|ed|ing)?\s+(?:as if|like)\s+(?:there\s+(?:is|are)\b|there['’]s\b)/iu;
  if (personalPretence.test(source) && existentialPretence.test(candidate)) {
    return "the correction changed who the sentence describes";
  }

  const originalContent = contentWords(source);
  const minimumContentCoverage = action === "concise"
    ? 0.5
    : action === "lighthearted"
      ? 0.45
      : action === "casual" || action === "confident" || action === "enthusiastic"
        ? 0.5
        : 0.55;
  if (originalContent.length >= 4 &&
      coverage(originalContent, contentWords(candidate)) < minimumContentCoverage) {
    return "the edit omitted too much of the original content";
  }
  if (action === "grammar" && sourceWords.length > 3 &&
      coverage(sourceWords, candidateWords) < 0.5) {
    return "the correction paraphrased too much of the original wording";
  }
  return null;
}
