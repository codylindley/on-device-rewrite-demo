import type { RewriteAction } from "../types.ts";

export function cleanEditOutput(output: string): string {
  let cleaned = output
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^<text>\s*/i, "")
    .replace(/\s*<\/text>$/i, "")
    .replace(/^(?:revised|rewritten|corrected|edited)\s+(?:text|version)\s*:\s*/i, "")
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

function links(text: string): string[] {
  return (text.match(/(?:https?:\/\/|www\.)[^\s<>"“”]+/giu) ?? [])
    .map((link) => link.replace(/[.,;:!?]+$/u, "").toLowerCase());
}

function capitalizedTerms(text: string): string[] {
  return (text.match(/\b\p{Lu}[\p{L}\p{M}'’.-]{2,}\b/gu) ?? [])
    .filter((word) => !sentenceStarters.has(word.toLowerCase()));
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
] as const;

function wordCount(text: string, word: string): number {
  return words(text).filter((candidate) => candidate === word).length;
}

export function rejectedEditReason(
  action: RewriteAction,
  source: string,
  candidate: string,
): string | null {
  if (!candidate.trim()) return "the model returned no edited text";
  if (candidate.trim() === source.trim()) return "the model returned the section unchanged";
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
  const lengthRatio = candidate.length / Math.max(1, source.length);
  if (!candidateWords.length || lengthRatio < (action === "concise" ? 0.12 : 0.35) ||
      lengthRatio > 2.5) {
    return "the edit changed too much of the section";
  }
  if (candidateWords.some((word) => word.length > 48 && !sourceWords.includes(word))) {
    return "the edit contains malformed words";
  }
  if (source.includes("?") && !candidate.includes("?")) {
    return "the edit removed a question";
  }

  const numberTokens = (text: string) => text.match(/\b\d+(?:[.,:]\d+)*\b/gu) ?? [];
  if (coverage(numberTokens(source), numberTokens(candidate)) < 1 && numberTokens(source).length) {
    return "the edit changed or removed a number";
  }
  const candidateLinks = new Set(links(candidate));
  if (links(source).some((link) => !candidateLinks.has(link))) {
    return "the edit changed or removed a link";
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
  const negationPattern =
    /\b(?:ain't|aren't|arent|barely|cannot|can't|cant|couldn't|couldnt|didn't|didnt|doesn't|doesnt|don't|dont|hadn't|hadnt|hardly|hasn't|hasnt|haven't|havent|isn't|isnt|neither|never|no|nobody|none|nor|not|nothing|nowhere|rarely|seldom|shouldn't|shouldnt|wasn't|wasnt|weren't|werent|without|won't|wont|wouldn't|wouldnt)\b/giu;
  // A concise rewrite may carry the original negative meaning without an explicit
  // negator, e.g. "I haven't finished" -> "I'm still finishing the notes".
  const negativePolarityPattern =
    /\b(?:awaiting|incomplete|lack|lacked|lacking|lacks|outstanding|pending|still|unable|unfinished|unresolved|yet)\b|\bin progress\b/giu;
  if ((source.match(negationPattern) ?? []).length > 0 &&
      (candidate.match(negationPattern) ?? []).length === 0 &&
      (candidate.match(negativePolarityPattern) ?? []).length === 0) {
    return "the edit removed a negation";
  }
  const lowerCandidateWords = new Set(candidateWords);
  if (capitalizedTerms(source).some((term) => !lowerCandidateWords.has(term.toLowerCase()))) {
    return "the edit changed or removed a name";
  }

  const originalContent = contentWords(source);
  if (originalContent.length >= 4 &&
      coverage(originalContent, contentWords(candidate)) < (action === "concise" ? 0.5 : 0.55)) {
    return "the edit omitted too much of the original content";
  }
  if (action === "grammar" && sourceWords.length > 3 &&
      coverage(sourceWords, candidateWords) < 0.5) {
    return "the correction paraphrased too much of the original wording";
  }
  return null;
}
