import { linkPattern } from "./links.ts";

export const MAX_SECTION_TOKENS = 192;

export interface TextSection {
  text: string;
  editable: boolean;
}

type TokenCounter = (text: string) => number;

/** A combining mark, ZWJ emoji, or flag is one character made of several code points; splitting it corrupts it. */
function graphemes(word: string): string[] {
  if (typeof Intl.Segmenter !== "function") return Array.from(word);
  return Array.from(
    new Intl.Segmenter("en", { granularity: "grapheme" }).segment(word),
    (part) => part.segment,
  );
}

function sentenceSegments(text: string): string[] {
  if (typeof Intl.Segmenter !== "function") return [text];
  const links = Array.from(text.matchAll(linkPattern), (match) => ({
    start: match.index, end: match.index + match[0].length,
  }));
  const result: string[] = [];
  let linkIndex = 0;
  let pending = "";
  for (const { segment, index } of new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)) {
    pending += segment;
    const boundary = index + segment.length;
    while (links[linkIndex] && links[linkIndex].end <= boundary) linkIndex += 1;
    // Intl.Segmenter can mistake a URL's "?CapitalizedQuery" for a sentence break.
    if (links[linkIndex]?.start < boundary && links[linkIndex].end > boundary) continue;
    result.push(pending);
    pending = "";
  }
  if (pending) result.push(pending);
  return result;
}

export function splitIntoSentences(text: string): TextSection[] {
  const sections: TextSection[] = [];
  for (const segment of sentenceSegments(text)) {
    const leading = segment.match(/^\s*/u)?.[0] ?? "";
    const body = segment.trim();
    if (leading) sections.push({ text: leading, editable: false });
    if (body) sections.push({ text: body, editable: true });
    const trailing = body ? segment.slice(leading.length + body.length) : "";
    if (trailing) sections.push({ text: trailing, editable: false });
  }
  return sections;
}

export function splitIntoSections(
  text: string,
  countTokens: TokenCounter,
  maxTokens = MAX_SECTION_TOKENS,
): TextSection[] {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError("The section token budget must be a positive integer.");
  }

  const sections: TextSection[] = [];
  const add = (value: string) => {
    if (!value) return;
    const leading = value.match(/^\s*/u)?.[0] ?? "";
    const body = value.trim();
    const trailing = body ? value.slice(leading.length + body.length) : "";
    if (leading) sections.push({ text: leading, editable: false });
    if (body) sections.push({ text: body, editable: true });
    if (trailing) sections.push({ text: trailing, editable: false });
  };

  const splitLongSentence = (sentence: string) => {
    let chunk = "";
    for (const word of sentence.match(/\s+|\S+/gu) ?? []) {
      if (countTokens(chunk + word) <= maxTokens) {
        chunk += word;
        continue;
      }
      add(chunk);
      chunk = "";

      if (countTokens(word) <= maxTokens) {
        chunk = word;
        continue;
      }

      if (word.match(linkPattern)) {
        sections.push({ text: word, editable: false });
        continue;
      }

      // An unbroken token can still exceed the budget; never split a grapheme cluster.
      const characters = graphemes(word);
      let offset = 0;
      while (offset < characters.length) {
        let low = 1;
        let high = Math.min(characters.length - offset, maxTokens * 8);
        let fits = 0;
        while (low <= high) {
          const length = Math.floor((low + high) / 2);
          if (countTokens(characters.slice(offset, offset + length).join("")) <= maxTokens) {
            fits = length;
            low = length + 1;
          } else {
            high = length - 1;
          }
        }
        if (!fits) {
          throw new Error("A character in this text exceeds the model's section token budget.");
        }
        add(characters.slice(offset, offset + fits).join(""));
        offset += fits;
      }
    }
    add(chunk);
  };

  for (const paragraph of text.split(/(\r?\n+)/u)) {
    if (!paragraph.trim()) {
      add(paragraph);
      continue;
    }
    if (countTokens(paragraph) <= maxTokens) {
      add(paragraph);
      continue;
    }

    const sentences = sentenceSegments(paragraph);
    let chunk = "";
    for (const sentence of sentences) {
      if (countTokens(chunk + sentence) <= maxTokens) {
        chunk += sentence;
        continue;
      }
      add(chunk);
      chunk = "";
      if (countTokens(sentence) <= maxTokens) chunk = sentence;
      else splitLongSentence(sentence);
    }
    add(chunk);
  }
  return sections;
}
