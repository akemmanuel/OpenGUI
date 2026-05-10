import type { DiffLine } from "@/lib/diff";
import { cn } from "@/lib/utils";

/** Inline diff viewer component. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const CONTEXT = 2;
  const changeIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.type !== "same") {
      for (let c = Math.max(0, i - CONTEXT); c <= Math.min(lines.length - 1, i + CONTEXT); c++) {
        changeIndices.add(c);
      }
    }
  }

  const elements: React.ReactNode[] = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    if (!changeIndices.has(i)) {
      if (!skipping) {
        skipping = true;
        elements.push(
          <div key={`skip-${i}`} className="text-muted-foreground/40 px-2 select-none">
            ...
          </div>,
        );
      }
      continue;
    }
    skipping = false;
    const line = lines[i];
    if (!line) continue;
    const bg =
      line.type === "add"
        ? "bg-emerald-500/10 text-emerald-400"
        : line.type === "remove"
          ? "bg-red-500/10 text-red-400"
          : "text-muted-foreground/60";
    const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    elements.push(
      <div key={i} className={cn("px-2 whitespace-pre-wrap break-all", bg)}>
        <span className="select-none inline-block w-4 shrink-0 opacity-60">{prefix}</span>
        {line.text || "\u00A0"}
      </div>,
    );
  }

  return (
    <div className="mt-1 ml-5 rounded border border-border/40 bg-background/60 overflow-auto max-h-64 text-[11px] font-mono leading-relaxed">
      {elements}
    </div>
  );
}
