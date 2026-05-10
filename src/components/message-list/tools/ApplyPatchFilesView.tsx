import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { getApplyPatchActionLabel, type ApplyPatchFileDiff } from "./applyPatch";
import { DiffView } from "./DiffView";

export function ApplyPatchFilesView({ files }: { files: ApplyPatchFileDiff[] }) {
  if (files.length === 1) {
    const file = files[0];
    if (!file) return null;
    return file.lines.length > 0 ? (
      <DiffView lines={file.lines} />
    ) : (
      <div className="pl-7 pt-1 text-[11px] text-muted-foreground">No line diff available.</div>
    );
  }

  return (
    <div className="mt-1 ml-5 space-y-1.5">
      {files.map((file) => {
        const hasDiff = file.lines.length > 0;
        const actionLabel = getApplyPatchActionLabel(file);
        const pathLabel =
          file.type === "move" && file.previousPath && file.previousPath !== file.path
            ? `${file.previousPath} -> ${file.path}`
            : file.path;
        return (
          <details
            key={file.id}
            open={files.length === 1}
            className="rounded border border-border/40 bg-background/40 overflow-hidden"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 hover:bg-accent/30 transition-colors [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90" />
              <span
                className={cn(
                  "shrink-0 text-[11px] font-medium",
                  file.type === "add"
                    ? "text-emerald-500"
                    : file.type === "delete"
                      ? "text-red-400"
                      : "text-foreground/70",
                )}
              >
                {actionLabel}
              </span>
              <span className="truncate text-[11px] text-muted-foreground" title={pathLabel}>
                {pathLabel}
              </span>
              <span className="ml-auto flex items-center gap-1 whitespace-nowrap text-[11px]">
                <span className="text-emerald-500">+{file.added}</span>
                <span className="text-red-400">-{file.removed}</span>
              </span>
            </summary>
            {hasDiff ? (
              <DiffView lines={file.lines} />
            ) : (
              <div className="px-2 pb-2 text-[11px] text-muted-foreground">
                No line diff available.
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}
