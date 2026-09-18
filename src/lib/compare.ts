import type { RewriteAction } from "../types.ts";
import type { EditResult } from "./edit.ts";
import { rejectedEditReason, rejectedStructuredFactReason } from "./output.ts";
import { splitIntoSections, splitIntoSentences } from "./sections.ts";

export function comparisonWarnings(action: RewriteAction, source: string, candidate: string): string[] {
  const reason = rejectedEditReason(action, source, candidate);
  return reason ? [`An automatic check could not confirm this edit: ${reason}. The output has not been replaced or hidden.`] : [];
}

export async function compareText(options: {
  action: RewriteAction;
  text: string;
  countTokens(text: string): number;
  generate(text: string): Promise<string>;
  onProgress?(completed: number, total: number): void;
}): Promise<EditResult> {
  if (!options.text.trim()) throw new Error("Add some text before running a comparison.");
  const paragraphs = splitIntoSections(options.text, options.countTokens);
  const sections = options.action === "grammar"
    ? paragraphs.flatMap((section) => section.editable ? splitIntoSentences(section.text) : [section])
    : paragraphs;
  const total = sections.filter(({ editable }) => editable).length;
  const output: string[] = [];
  const warnings: string[] = [];
  let completed = 0;
  options.onProgress?.(0, total);
  for (const section of sections) {
    if (!section.editable) {
      output.push(section.text);
      continue;
    }
    const candidate = await options.generate(section.text);
    if (!candidate.trim()) throw new Error(`The AI returned no text for section ${completed + 1}.`);
    output.push(candidate);
    warnings.push(...comparisonWarnings(options.action, section.text, candidate)
      .map((warning) => `Section ${completed + 1}: ${warning}`));
    completed += 1;
    options.onProgress?.(completed, total);
  }
  const text = output.join("");
  const combined = rejectedStructuredFactReason(options.text, text);
  if (combined) warnings.push(`Review the combined output: ${combined}.`);
  if (!total) warnings.push("This input contains only protected content; it was not sent to the AI.");
  return { text, warnings };
}
