import { Check, ChevronRight, X } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ToolCallTranscriptPart } from "@/protocol/session-transcript";
import { ToolCallPartView } from "./ToolCallPartView";

function toolGroupSummary(parts: ToolCallTranscriptPart[], t: TFunction) {
  const counts = { command: 0, read: 0, write: 0, edit: 0, other: 0 };
  for (const part of parts) {
    const name = part.tool.toLowerCase();
    if (name === "shell" || name === "bash") counts.command += 1;
    else if (name === "read") counts.read += 1;
    else if (name === "write") counts.write += 1;
    else if (name === "edit") counts.edit += 1;
    else counts.other += 1;
  }

  return [
    counts.command && t("toolGroup.commands", { count: counts.command }),
    counts.read && t("toolGroup.read", { count: counts.read }),
    counts.write && t("toolGroup.wrote", { count: counts.write }),
    counts.edit && t("toolGroup.edited", { count: counts.edit }),
    counts.other && t("toolGroup.other", { count: counts.other }),
  ]
    .filter(Boolean)
    .join(", ");
}

export function ToolCallGroupView({
  parts,
  expandedToolCalls,
  onSetToolCallExpanded,
}: {
  parts: ToolCallTranscriptPart[];
  expandedToolCalls?: ReadonlySet<string>;
  onSetToolCallExpanded?: (partId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const groupId = `tool-group:${parts[0]?.id ?? "empty"}`;
  const expanded = expandedToolCalls?.has(groupId) ?? false;
  const running = parts.some((part) => part.state.status === "running");
  const failed = parts.some((part) => part.state.status === "error");
  const summary = toolGroupSummary(parts, t);

  return (
    <details
      open={expanded}
      onToggle={(event) => onSetToolCallExpanded?.(groupId, event.currentTarget.open)}
      className="text-xs font-mono text-muted-foreground"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="flex size-3 shrink-0 items-center justify-center">
          {running ? (
            <Spinner className="size-3" />
          ) : failed ? (
            <X className="size-3 text-destructive" />
          ) : (
            <Check className="size-3" />
          )}
        </span>
        <span
          className={cn(
            "min-w-0 truncate font-medium",
            failed ? "text-destructive/90" : "text-foreground/70",
          )}
        >
          {summary}
        </span>
        <ChevronRight
          className={cn(
            "ml-auto size-3 shrink-0 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
      </summary>
      {expanded && (
        <div className="mt-1 flex flex-col gap-1 pl-[18px]">
          {parts.map((part) => (
            <ToolCallPartView
              key={part.id}
              part={part}
              expandedToolCalls={expandedToolCalls}
              onSetToolCallExpanded={onSetToolCallExpanded}
            />
          ))}
        </div>
      )}
    </details>
  );
}
