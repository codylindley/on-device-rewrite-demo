import type { RewriteAction } from "../types.ts";
import { normalizeEditOutput, rejectedEditReason, rejectedStructuredFactReason } from "./output.ts";
import { splitIntoSections, splitIntoSentences, type TextSection } from "./sections.ts";

export interface EditResult {
  text: string;
  warnings: string[];
}

export interface EditSectionsOptions {
  action: RewriteAction;
  sections: TextSection[];
  generate(text: string, retry: boolean): Promise<string>;
  fallback?(text: string): Promise<string>;
  onProgress?(completed: number, total: number): void;
}

interface EditOptions extends Omit<EditSectionsOptions, "sections"> {
  text: string;
  countTokens(text: string): number;
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

  return editSections({
    action,
    sections: splitIntoSections(text, countTokens),
    generate,
    fallback,
    onProgress,
  });
}

export async function editSections({
  action,
  sections: preparedSections,
  generate,
  fallback,
  onProgress,
}: EditSectionsOptions): Promise<EditResult> {
  // The small local model is more reliable at contextual spelling and grammar
  // when it can focus on one sentence at a time. Other rewrite modes keep the
  // larger paragraph context so tone and length stay coherent.
  const sections = action === "grammar"
    ? preparedSections.flatMap((section) =>
        section.editable ? splitIntoSentences(section.text) : [section]
      )
    : preparedSections.map((section) =>
        section.text.trim() ? section : { ...section, editable: false }
      );
  const total = sections.filter((section) => section.editable).length;
  const source = preparedSections.map(({ text }) => text).join("");
  if (!total) {
    if (!source.trim()) throw new Error("Add some text before choosing an edit.");
    if (action === "grammar") return { text: source, warnings: [] };
    throw new Error("The model could not produce a usable edit. There is no editable prose outside protected links.");
  }

  const result: string[] = [];
  const warnings: string[] = [];
  let usableSections = 0;
  let completed = 0;
  onProgress?.(0, total);

  const normalize = (output: string, source: string) =>
    output.trim() === source.trim() ? source : normalizeEditOutput(output, source);

  const editSection = async (
    section: TextSection,
    allowSentenceFallback: boolean,
  ): Promise<EditResult & { usable: boolean }> => {
    if (!section.editable) return { text: section.text, warnings: [], usable: false };

    let candidate = "";
    let rejection: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      candidate = normalize(
        await generate(section.text, attempt > 0),
        section.text,
      );
      rejection = rejectedEditReason(action, section.text, candidate);
      if (!rejection) return { text: candidate, warnings: [], usable: true };
    }

    const sentenceSections = allowSentenceFallback
      ? splitIntoSentences(section.text)
      : [];
    if (sentenceSections.filter(({ editable }) => editable).length > 1) {
      const sentenceResults: Array<EditResult & { usable: boolean }> = [];
      for (const sentence of sentenceSections) {
        sentenceResults.push(await editSection(sentence, false));
      }
      if (sentenceResults.some((item) => item.usable)) {
        return {
          text: sentenceResults.map((item) => item.text).join(""),
          warnings: sentenceResults.flatMap((item) => item.warnings),
          usable: true,
        };
      }
    }

    if (fallback) {
      const fallbackCandidate = normalize(
        await fallback(section.text),
        section.text,
      );
      const fallbackRejection = rejectedEditReason(
        "grammar",
        section.text,
        fallbackCandidate,
      );
      // An unchanged fallback must not turn rejected rewrites into a successful no-op.
      if (!fallbackRejection && fallbackCandidate !== section.text) {
        return {
          text: fallbackCandidate,
          warnings: [
            "the requested rewrite could not be applied safely, so only spelling and grammar were corrected",
          ],
          usable: true,
        };
      }
    }

    return {
      text: section.text,
      warnings: [rejection ?? "the model returned an unsafe edit"],
      usable: false,
    };
  };

  for (const section of sections) {
    if (!section.editable) {
      result.push(section.text);
      continue;
    }
    const sectionResult = await editSection(section, true);
    result.push(sectionResult.text);
    if (sectionResult.usable) usableSections += 1;
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

  if (usableSections === 0) {
    throw new Error(`The model could not produce a usable edit. ${warnings[0]}`);
  }
  const text = result.join("");
  const combinedRejection = rejectedStructuredFactReason(source, text);
  if (combinedRejection) {
    throw new Error(`The model could not produce a usable edit. Combined sections failed preservation: ${combinedRejection}.`);
  }
  return { text, warnings };
}
