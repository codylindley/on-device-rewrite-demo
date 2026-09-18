import type { RewriteAction } from "../types.ts";
import { normalizeEditOutput, rejectedEditReason } from "./output.ts";
import { splitIntoSections, splitIntoSentences, type TextSection } from "./sections.ts";

export interface EditResult {
  text: string;
  warnings: string[];
}

interface EditOptions {
  action: RewriteAction;
  text: string;
  countTokens(text: string): number;
  generate(text: string, retry: boolean): Promise<string>;
  fallback?(text: string): Promise<string>;
  onProgress?(completed: number, total: number): void;
}

export async function editText({
  action,
  text,
  countTokens,
  generate,
  fallback,
  onProgress,
}: EditOptions): Promise<EditResult> {
  if (!text.trim()) throw new Error("Add some text before choosing an edit.");

  const paragraphSections = splitIntoSections(text, countTokens);
  // The small local model is more reliable at contextual spelling and grammar
  // when it can focus on one sentence at a time. Other rewrite modes keep the
  // larger paragraph context so tone and length stay coherent.
  const sections = action === "grammar"
    ? paragraphSections.flatMap((section) =>
        section.editable ? splitIntoSentences(section.text) : [section]
      )
    : paragraphSections;
  const total = sections.filter((section) => section.editable).length;
  const result: string[] = [];
  const warnings: string[] = [];
  let changedSections = 0;
  let completed = 0;
  onProgress?.(0, total);

  const editSection = async (
    section: TextSection,
    allowSentenceFallback: boolean,
  ): Promise<{ text: string; warnings: string[] }> => {
    if (!section.editable) return { text: section.text, warnings: [] };

    let candidate = "";
    let rejection: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      candidate = normalizeEditOutput(
        await generate(section.text, attempt > 0),
        section.text,
      );
      rejection = rejectedEditReason(action, section.text, candidate);
      if (!rejection) return { text: candidate, warnings: [] };
    }

    const sentenceSections = allowSentenceFallback
      ? splitIntoSentences(section.text)
      : [];
    if (sentenceSections.filter(({ editable }) => editable).length > 1) {
      const sentenceResults: Array<{ text: string; warnings: string[] }> = [];
      for (const sentence of sentenceSections) {
        sentenceResults.push(await editSection(sentence, false));
      }
      const sentenceWarnings = sentenceResults.flatMap((item) => item.warnings);
      if (sentenceWarnings.length < sentenceSections.filter(({ editable }) => editable).length) {
        return {
          text: sentenceResults.map((item) => item.text).join(""),
          warnings: sentenceWarnings,
        };
      }
    }

    if (fallback) {
      const fallbackCandidate = normalizeEditOutput(
        await fallback(section.text),
        section.text,
      );
      const fallbackRejection = rejectedEditReason(
        "grammar",
        section.text,
        fallbackCandidate,
      );
      if (!fallbackRejection) {
        return {
          text: fallbackCandidate,
          warnings: [
            "the requested rewrite could not be applied safely, so only spelling and grammar were corrected",
          ],
        };
      }
    }

    return {
      text: section.text,
      warnings: [rejection ?? "the model returned an unsafe edit"],
    };
  };

  for (const section of sections) {
    if (!section.editable) {
      result.push(section.text);
      continue;
    }
    const sectionResult = await editSection(section, true);
    result.push(sectionResult.text);
    if (sectionResult.text !== section.text) changedSections += 1;
    const uniqueWarnings = [...new Set(sectionResult.warnings)];
    if (uniqueWarnings.length) {
      warnings.push(
        `Section ${completed + 1} was ${
          sectionResult.text === section.text ? "left unchanged" : "left partly unchanged"
        } because ${uniqueWarnings.join("; ")}.`,
      );
    }
    completed += 1;
    onProgress?.(completed, total);
  }

  if (changedSections === 0) {
    throw new Error(`The model could not produce a usable edit. ${warnings[0]}`);
  }
  return { text: result.join(""), warnings };
}
