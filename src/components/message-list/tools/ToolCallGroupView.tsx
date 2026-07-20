import { Check, ChevronRight } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { TranscriptPart, ToolCallTranscriptPart } from "@/protocol/session-transcript";
import { ToolCallPartView } from "./ToolCallPartView";

function toolGroupSummary(parts: ToolCallTranscriptPart[], t: TFunction, running: boolean) {
  const counts = { command: 0, read: 0, write: 0, edit: 0, other: 0 };
  for (const part of parts) {
    const name = part.tool.toLowerCase();
    if (name === "shell" || name === "bash") counts.command += 1;
    else if (name === "read") counts.read += 1;
    else if (name === "write") counts.write += 1;
    else if (name === "edit") counts.edit += 1;
    else counts.other += 1;
  }

  const summary = [
    counts.command &&
      t(running ? "toolGroup.runningCommands" : "toolGroup.commands", {
        count: counts.command,
      }),
    counts.read && t(running ? "toolGroup.reading" : "toolGroup.read", { count: counts.read }),
    counts.write && t(running ? "toolGroup.writing" : "toolGroup.wrote", { count: counts.write }),
    counts.edit && t(running ? "toolGroup.editing" : "toolGroup.edited", { count: counts.edit }),
    counts.other &&
      t(running ? "toolGroup.usingOther" : "toolGroup.other", { count: counts.other }),
  ]
    .filter(Boolean)
    .join(", ");
  return summary ? `${summary[0]!.toLocaleUpperCase()}${summary.slice(1)}` : summary;
}

export function ToolCallGroupView({
  parts,
  awaitingAssistantResponse = false,
  expandedToolCalls,
  onSetToolCallExpanded,
}: {
  parts: TranscriptPart[];
  awaitingAssistantResponse?: boolean;
  expandedToolCalls?: ReadonlySet<string>;
  onSetToolCallExpanded?: (partId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const groupId = `tool-group:${parts[0]?.id ?? "empty"}`;
  const expanded = expandedToolCalls?.has(groupId) ?? false;
  const tools = parts.filter((part): part is ToolCallTranscriptPart => part.type === "tool");
  // Keep the activity indicator alive after the final tool finishes while the
  // assistant is still deciding what to say next. Once text follows this
  // group (or the turn completes), the group settles to its final icon.
  const running =
    awaitingAssistantResponse ||
    tools.some((part) => part.state.status === "running" || part.state.status === "pending");
  const summary = toolGroupSummary(tools, t, running);

  return (
    <details
      open={expanded}
      onToggle={(event) => onSetToolCallExpanded?.(groupId, event.currentTarget.open)}
      className="text-xs font-mono text-muted-foreground"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="flex size-3 shrink-0 items-center justify-center">
          {running ? <Spinner className="size-3" /> : <Check className="size-3" />}
        </span>
        <span className="min-w-0 truncate font-medium text-foreground/70">{summary}</span>
        <ChevronRight
          className={cn(
            "ml-auto size-3 shrink-0 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
      </summary>
      {expanded && (
        <div className="mt-1 max-h-64 overflow-y-auto overscroll-contain pl-[18px] pr-1">
          <div className="flex flex-col gap-1">
            {tools.map((part) => (
              <ToolCallPartView
                key={part.id}
                part={part}
                expandedToolCalls={expandedToolCalls}
                onSetToolCallExpanded={onSetToolCallExpanded}
              />
            ))}
          </div>
        </div>
      )}
    </details>
  );
}
