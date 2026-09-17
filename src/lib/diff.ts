export type DiffKind = "same" | "added" | "removed";

export interface DiffPart {
  kind: DiffKind;
  value: string;
}

function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]+/gu) ?? [];
}

function appendPart(parts: DiffPart[], kind: DiffKind, value: string) {
  if (!value) return;

  const previous = parts.at(-1);
  if (previous?.kind === kind) {
    previous.value += value;
  } else {
    parts.push({ kind, value });
  }
}

export function diffWords(before: string, after: string): DiffPart[] {
  const oldTokens = tokenize(before);
  const newTokens = tokenize(after);
  const width = newTokens.length + 1;
  const table = new Uint16Array((oldTokens.length + 1) * width);

  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * width + newIndex;
      table[index] = oldTokens[oldIndex] === newTokens[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(
            table[(oldIndex + 1) * width + newIndex],
            table[oldIndex * width + newIndex + 1],
          );
    }
  }

  const parts: DiffPart[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex] === newTokens[newIndex]) {
      appendPart(parts, "same", oldTokens[oldIndex]);
      oldIndex += 1;
      newIndex += 1;
    } else if (
      table[(oldIndex + 1) * width + newIndex] >=
      table[oldIndex * width + newIndex + 1]
    ) {
      appendPart(parts, "removed", oldTokens[oldIndex]);
      oldIndex += 1;
    } else {
      appendPart(parts, "added", newTokens[newIndex]);
      newIndex += 1;
    }
  }

  while (oldIndex < oldTokens.length) {
    appendPart(parts, "removed", oldTokens[oldIndex]);
    oldIndex += 1;
  }

  while (newIndex < newTokens.length) {
    appendPart(parts, "added", newTokens[newIndex]);
    newIndex += 1;
  }

  return parts;
}
