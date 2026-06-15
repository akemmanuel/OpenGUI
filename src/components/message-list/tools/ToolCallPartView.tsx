import { Check, ChevronRight, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import { useConnectionState } from "@/hooks/use-agent-state";
import { cn } from "@/lib/utils";
import type { ToolCallTranscriptPart } from "@/protocol/session-transcript";
import { ToolCallOutputView } from "./ToolCallOutputView";
import { getToolCallViewModel, type ToolCallStatus } from "./toolCallModel";

const ROW = "flex min-w-0 items-center gap-1.5";
const BUTTON_RESET = "m-0 appearance-none border-0 bg-transparent p-0 text-left text-inherit";

function ToolCallIcon({
  status,
  expandable,
  expanded,
}: {
  status: ToolCallStatus;
  expandable: boolean;
  expanded: boolean;
}) {
  if (status === "running") return <Spinner className="size-3 shrink-0" />;
  if (status === "error") return <X className="size-3 shrink-0 text-destructive" />;
  if (!expandable) return <Check className="size-3 shrink-0" />;
  return (
    <ChevronRight
      className={cn("size-3 transition-transform duration-150", expanded && "rotate-90")}
    />
  );
}

export function ToolCallPartView({
  part,
  expandedToolCalls,
  onToggleToolCall,
}: {
  part: ToolCallTranscriptPart;
  expandedToolCalls?: ReadonlySet<string>;
  onToggleToolCall?: (partId: string, expanded: boolean) => void;
}) {
  const { workspaceServerUrl } = useConnectionState();
  const { t } = useTranslation();
  const tool = getToolCallViewModel(part, workspaceServerUrl, t);
  const expanded = expandedToolCalls?.has(part.id) ?? false;
  const setExpanded = (nextExpanded: boolean) => onToggleToolCall?.(part.id, nextExpanded);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoExpand =
    tool.status === "running" &&
    tool.expandable &&
    (tool.kind === "bash" ||
      (tool.kind === "task" &&
        tool.output.some((block) => block.type === "task" && block.taskInfo.childSessionId)));

  useEffect(() => {
    if (shouldAutoExpand && !expanded) setExpanded(true);
  }, [expanded, shouldAutoExpand]);

  useEffect(() => {
    if (!expanded || tool.status !== "running" || (tool.kind !== "bash" && tool.kind !== "task")) {
      return;
    }
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [expanded, tool.status, tool.kind, tool.output]);

  const rowContent = (
    <>
      <span className="w-3 shrink-0 flex items-center justify-center">
        <ToolCallIcon status={tool.status} expandable={tool.expandable} expanded={expanded} />
      </span>
      <span
        className={cn(
          "font-medium truncate",
          tool.status === "error" ? "text-destructive/90" : "text-foreground/70",
        )}
        title={tool.label}
      >
        {tool.label}
      </span>
      {tool.matchCount != null && (
        <span className="text-[11px] text-blue-400 ml-auto whitespace-nowrap">
          {tool.matchCount} {tool.matchCount === 1 ? "match" : "matches"}
        </span>
      )}
      {tool.diffSummary && (
        <span className="flex items-center gap-1 ml-auto whitespace-nowrap text-[11px]">
          <span className="text-emerald-500">+{tool.diffSummary.added}</span>
          <span className="text-red-400">-{tool.diffSummary.removed}</span>
        </span>
      )}
      {tool.durationLabel && (
        <span className="ml-auto opacity-70 tabular-nums text-[11px] whitespace-nowrap">
          {tool.durationLabel}
        </span>
      )}
    </>
  );

  return (
    <div className="text-xs font-mono text-muted-foreground overflow-hidden">
      {tool.expandable ? (
        <details
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
          className="m-0"
        >
          <summary
            className={cn(
              ROW,
              BUTTON_RESET,
              "list-none hover:text-foreground cursor-pointer transition-colors [&::-webkit-details-marker]:hidden",
            )}
          >
            {rowContent}
          </summary>
        </details>
      ) : (
        <div className={cn(ROW, "cursor-default")}>{rowContent}</div>
      )}
      {tool.expandable && expanded && (
        <div ref={outputRef} className="max-h-96 overflow-auto">
          <ToolCallOutputView blocks={tool.output} />
        </div>
      )}
    </div>
  );
}
