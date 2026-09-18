import type { Linter } from "harper.js";
import type { EditResult } from "./edit.ts";
import { rejectedEditReason, rejectedStructuredFactReason } from "./output.ts";
import { applyConservativeProofreading } from "./proofread.ts";
import { splitIntoSentences } from "./sections.ts";

export async function proofreadText(
  text: string,
  linter: Linter,
  onProgress?: (completed: number, total: number) => void,
): Promise<EditResult> {
  if (!text.trim()) throw new Error("Add some text before choosing an edit.");

  // Harper has no neural token budget. Keep paragraph and sentence boundaries,
  // including their original separators, instead of inventing a token counter.
  const sections = text.split(/(\r?\n+)/u).flatMap(splitIntoSentences);
  const total = sections.filter(({ editable }) => editable).length;
  const result: string[] = [];
  const warnings: string[] = [];
  let usableSections = 0;
  let completed = 0;
  let yieldAt = Date.now() + 16;
  onProgress?.(0, total);

  for (const section of sections) {
    if (!section.editable) {
      result.push(section.text);
      continue;
    }

    const candidate = await applyConservativeProofreading(section.text, linter);
    const rejection = rejectedEditReason("grammar", section.text, candidate);
    if (rejection) {
      result.push(section.text);
      warnings.push(`Section ${completed + 1} was left unchanged because ${rejection}.`);
    } else {
      result.push(candidate);
      usableSections += 1;
    }
    completed += 1;
    onProgress?.(completed, total);

    if (completed < total && (completed % 16 === 0 || Date.now() >= yieldAt)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      yieldAt = Date.now() + 16;
    }
  }

  if (!usableSections) {
    throw new Error(`The proofreader could not produce a usable edit. ${warnings[0]}`);
  }
  const corrected = result.join("");
  const combinedRejection = rejectedStructuredFactReason(text, corrected);
  if (combinedRejection) {
    throw new Error(`The proofreader could not produce a usable edit. Combined sections failed preservation: ${combinedRejection}.`);
  }
  return { text: corrected, warnings };
}
