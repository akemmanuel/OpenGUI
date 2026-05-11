import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleCheck,
  FileCode,
  FileEdit,
  FilePlus,
  Layers,
  MessageCircleQuestion,
  Search,
  SquareTerminal,
  Wrench,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { TerminalOutput } from "@/components/message-list/TerminalOutput";
import { Spinner } from "@/components/ui/spinner";
import { useConnectionState } from "@/hooks/use-agent-state";
import { todoStatusConfig, type TodoItem } from "@/lib/todos";
import { cn, looksLikeTerminalOutput } from "@/lib/utils";
import { ApplyPatchFilesView } from "./ApplyPatchFilesView";
import { getToolPresentation, type ToolPresentation } from "./toolPresentation";
import type { ToolKind } from "./toolTypes";

const TIMELINE_ROW_BASE = "flex min-w-0 items-center gap-1.5";
const TIMELINE_BUTTON_RESET =
  "m-0 appearance-none border-0 bg-transparent p-0 text-left text-inherit";

function toolIcon(kind: ToolKind): LucideIcon {
  switch (kind) {
    case "bash":
      return SquareTerminal;
    case "read":
      return FileCode;
    case "edit":
      return FileEdit;
    case "write":
      return FilePlus;
    case "grep":
    case "glob":
      return Search;
    case "task":
      return Layers;
    case "todo":
      return CircleCheck;
    case "question":
      return MessageCircleQuestion;
    default:
      return Wrench;
  }
}

function TodoListView({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="border-t border-border/40 pt-1.5 mt-1.5 space-y-0.5">
      {todos.map((todo, i) => {
        const cfg = todoStatusConfig[todo.status] ?? {
          icon: Circle,
          color: "text-muted-foreground",
        };
        const Icon = cfg.icon;
        const isCancelled = todo.status === "cancelled";
        return (
          <div key={`todo-${todo.content}-${i}`} className="flex items-center gap-1.5 min-h-5">
            <Icon className={cn("size-3 shrink-0", cfg.color)} />
            <span
              className={cn(
                "flex-1 text-[11px] leading-tight",
                isCancelled && "line-through opacity-50",
                todo.status === "completed" && "text-muted-foreground",
              )}
            >
              {todo.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ToolHeader({
  presentation,
  expanded,
  setExpanded,
}: {
  presentation: ToolPresentation;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}) {
  const { tool, expandable } = presentation;
  const Icon = toolIcon(tool.kind);
  const icon = expandable ? (
    <ChevronRight
      className={cn("size-3 transition-transform duration-150", expanded && "rotate-90")}
    />
  ) : tool.kind === "unknown" ? (
    <ToolStatusIcon status={tool.status} />
  ) : (
    <Icon className="size-3 shrink-0" />
  );

  const content = (
    <>
      <span className="w-3 shrink-0 flex items-center justify-center">{icon}</span>
      <span className="font-medium text-foreground/70">
        {presentation.title}
        {presentation.hasDynamicLabel && tool.isRunning && !presentation.context ? "..." : ""}
      </span>
      {presentation.context && (
        <span className="truncate" title={presentation.context}>
          {presentation.context}
          {presentation.hasDynamicLabel && tool.isRunning ? "..." : ""}
        </span>
      )}
      {presentation.grepMatchCount != null && (
        <span className="text-[11px] text-blue-400 ml-auto whitespace-nowrap">
          {presentation.grepMatchCount} {presentation.grepMatchCount === 1 ? "match" : "matches"}
        </span>
      )}
      {presentation.diffSummary && (
        <span className="flex items-center gap-1 ml-auto whitespace-nowrap text-[11px]">
          <span className="text-emerald-500">+{presentation.diffSummary.added}</span>
          <span className="text-red-400">-{presentation.diffSummary.removed}</span>
        </span>
      )}
      {tool.kind === "task" && presentation.taskDurationLabel && (
        <span className="ml-auto opacity-70 tabular-nums text-[11px] whitespace-nowrap">
          {presentation.taskDurationLabel}
        </span>
      )}
      {tool.kind === "task" && tool.isRunning && <Spinner className="size-3 ml-auto shrink-0" />}
    </>
  );

  if (!expandable) {
    return <div className={cn(TIMELINE_ROW_BASE, "cursor-default")}>{content}</div>;
  }

  return (
    <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)} className="m-0">
      <summary
        className={cn(
          TIMELINE_ROW_BASE,
          TIMELINE_BUTTON_RESET,
          "list-none hover:text-foreground cursor-pointer transition-colors [&::-webkit-details-marker]:hidden",
        )}
      >
        {content}
      </summary>
    </details>
  );
}

function ToolBody({
  presentation,
  toolOutputRef,
  taskContentRef,
}: {
  presentation: ToolPresentation;
  toolOutputRef: React.RefObject<HTMLPreElement | null>;
  taskContentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const body = presentation.body;
  if (!body) return null;

  switch (body.type) {
    case "terminal":
      return (
        <div className="pl-7 pt-1">
          <TerminalOutput
            content={body.content}
            preRef={toolOutputRef}
            className={cn(
              "max-h-64",
              presentation.tool.kind === "bash" &&
                presentation.tool.status === "error" &&
                "text-destructive",
            )}
          />
        </div>
      );
    case "apply-patch":
      return <ApplyPatchFilesView files={body.files} />;
    case "task":
      return (
        <div ref={taskContentRef} className="pl-7 pt-1 space-y-1 max-h-96 overflow-auto">
          {body.taskInfo.toolCalls.length > 0 && (
            <div className="space-y-0.5">
              {body.taskInfo.toolCalls.map((tc, i) => (
                <div
                  key={`${tc.tool}-${i}`}
                  className="flex items-center gap-1.5 text-xs font-mono"
                >
                  <Wrench className="size-2.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">{tc.tool}</span>
                  {tc.title && (
                    <span className="text-muted-foreground/70 truncate">{tc.title}</span>
                  )}
                  {tc.status === "completed" && (
                    <CheckCircle2 className="size-2.5 text-emerald-500 ml-auto shrink-0" />
                  )}
                  {tc.status === "error" && (
                    <XCircle className="size-2.5 text-destructive ml-auto shrink-0" />
                  )}
                </div>
              ))}
            </div>
          )}
          {body.taskInfo.output && (
            <div className="text-xs">
              {looksLikeTerminalOutput(body.taskInfo.output) ? (
                <TerminalOutput content={body.taskInfo.output} />
              ) : (
                <MarkdownRenderer content={body.taskInfo.output} />
              )}
            </div>
          )}
        </div>
      );
  }
}

export function ToolPartView({
  part,
  expandedToolParts,
  onToggleToolPart,
}: {
  part: ToolPart;
  expandedToolParts?: ReadonlySet<string>;
  onToggleToolPart?: (partId: string, expanded: boolean) => void;
}) {
  const { workspaceServerUrl } = useConnectionState();
  const presentation = getToolPresentation(part, workspaceServerUrl);
  const expanded = expandedToolParts?.has(part.id) ?? false;
  const setExpanded = (nextExpanded: boolean) => onToggleToolPart?.(part.id, nextExpanded);
  const autoExpandedRef = useRef(false);
  const bashAutoExpandedRef = useRef(false);
  const taskContentRef = useRef<HTMLDivElement>(null);
  const toolOutputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (presentation.tool.kind !== "task") return;
    if (
      presentation.tool.isRunning &&
      presentation.taskInfo?.childSessionId &&
      !autoExpandedRef.current
    ) {
      setExpanded(true);
      autoExpandedRef.current = true;
    } else if (!presentation.tool.isRunning && autoExpandedRef.current) {
      setExpanded(false);
    }
  }, [presentation.tool.kind, presentation.tool.isRunning, presentation.taskInfo?.childSessionId]);

  useEffect(() => {
    if (
      presentation.tool.kind === "task" &&
      presentation.tool.isRunning &&
      expanded &&
      taskContentRef.current
    ) {
      taskContentRef.current.scrollTop = taskContentRef.current.scrollHeight;
    }
  }, [presentation.taskInfo, presentation.tool.kind, presentation.tool.isRunning, expanded]);

  useEffect(() => {
    if (
      presentation.tool.kind !== "bash" ||
      !presentation.tool.isRunning ||
      !presentation.bashOutputText ||
      bashAutoExpandedRef.current
    ) {
      return;
    }
    setExpanded(true);
    bashAutoExpandedRef.current = true;
  }, [presentation.tool.kind, presentation.tool.isRunning, presentation.bashOutputText]);

  useEffect(() => {
    if (
      presentation.tool.kind !== "bash" ||
      !expanded ||
      !presentation.bashOutputText ||
      !toolOutputRef.current
    )
      return;
    toolOutputRef.current.scrollTop = toolOutputRef.current.scrollHeight;
  }, [presentation.tool.kind, expanded, presentation.bashOutputText]);

  const hasSideContent =
    (presentation.sideContent.todos && presentation.sideContent.todos.length > 0) ||
    presentation.sideContent.images.length > 0;

  return (
    <div className="text-xs font-mono text-muted-foreground overflow-hidden">
      <ToolHeader presentation={presentation} expanded={expanded} setExpanded={setExpanded} />
      {presentation.expandable && expanded && (
        <ToolBody
          presentation={presentation}
          toolOutputRef={toolOutputRef}
          taskContentRef={taskContentRef}
        />
      )}
      {presentation.error &&
        !(presentation.tool.kind === "bash" && presentation.bashOutputText?.trim()) && (
          <div className="text-destructive pl-5 truncate" title={presentation.error}>
            {presentation.error}
          </div>
        )}
      {hasSideContent && (
        <div className="pl-5 mt-0.5 space-y-1">
          {presentation.sideContent.images.length > 0 && (
            <div
              className={cn(
                "grid gap-2 pt-1",
                presentation.sideContent.images.length === 1 ? "grid-cols-1" : "grid-cols-2",
              )}
            >
              {presentation.sideContent.images.map((image, idx) => (
                <div
                  key={`${image.url}-${idx}`}
                  className="overflow-hidden rounded-md border border-border/60 bg-background/60"
                >
                  <img
                    src={image.src}
                    alt={image.filename ?? `Image attachment ${idx + 1}`}
                    loading="lazy"
                    className="w-full max-h-52 object-contain bg-black/20"
                  />
                  {image.filename && (
                    <div
                      className="px-2 py-1 text-[10px] text-muted-foreground truncate"
                      title={image.filename}
                    >
                      {image.filename}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {presentation.sideContent.todos && presentation.sideContent.todos.length > 0 && (
            <TodoListView todos={presentation.sideContent.todos} />
          )}
        </div>
      )}
    </div>
  );
}

function ToolStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
    case "pending":
      return <Spinner className="size-3 shrink-0" />;
    case "completed":
      return <Check className="size-3 shrink-0" />;
    case "error":
      return <X className="size-3 shrink-0" />;
    default:
      return <span className="size-3 shrink-0" />;
  }
}
