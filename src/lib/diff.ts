export type DiffLine = { type: "same" | "add" | "remove"; text: string };

export type DiffResult = {
  added: number;
  removed: number;
  lines: DiffLine[];
};

export function parseUnifiedDiff(diffText: string): DiffResult | null {
  const diffLines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  for (const line of diffText.split("\n")) {
    if (
      !line ||
      line.startsWith("@@") ||
      line.startsWith("diff --git ") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("index ") ||
      line === "\\ No newline at end of file"
    ) {
      continue;
    }

    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === "+") {
      diffLines.push({ type: "add", text });
      added++;
    } else if (prefix === "-") {
      diffLines.push({ type: "remove", text });
      removed++;
    } else if (prefix === " ") {
      diffLines.push({ type: "same", text });
    }
  }

  return diffLines.length > 0 ? { added, removed, lines: diffLines } : null;
}
