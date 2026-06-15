import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useSessionState } from "@/hooks/use-agent-state";
import { cn } from "@/lib/utils";
import type { ReasoningTranscriptPart } from "@/protocol/session-transcript";
import { formatDuration, hideZeroDurationLabel } from "./duration";

const TIMELINE_ROW_BASE = "flex min-w-0 items-center gap-1.5";
const TIMELINE_BUTTON_RESET =
  "m-0 appearance-none border-0 bg-transparent p-0 text-left text-inherit";

export function ReasoningPartView({
  part,
  isLastReasoning,
}: {
  part: ReasoningTranscriptPart;
  isLastReasoning?: boolean;
}) {
  const isThinking = !part.time.end;
  const { t } = useTranslation();
  const { isBusy } = useSessionState();
  const [expanded, setExpanded] = useState(isThinking);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasText = !!part.text?.trim();
  // Start false so first visible render counts as "became visible".
  // Needed when backend batches snapshots and component first mounts only
  // after reasoning text already exists.
  const prevHasTextRef = useRef(false);

  useEffect(() => {
    const becameVisible = hasText && !prevHasTextRef.current;
    if (isThinking || (becameVisible && isLastReasoning && isBusy)) {
      setExpanded(true);
    } else if (!isLastReasoning || !isBusy) {
      setExpanded(false);
    }
    prevHasTextRef.current = hasText;
  }, [hasText, isThinking, isLastReasoning, isBusy]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: part.text triggers scroll on new streamed content
  useEffect(() => {
    if (isThinking && expanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [part.text, isThinking, expanded]);

  if (!hasText) return null;

  const durationMs = part.time.end && part.time.start ? part.time.end - part.time.start : null;
  const durationLabel =
    durationMs !== null ? hideZeroDurationLabel(formatDuration(durationMs)) : null;

  return (
    <div className="text-xs font-mono text-muted-foreground overflow-hidden">
      <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)} className="m-0">
        <summary
          className={cn(
            TIMELINE_ROW_BASE,
            TIMELINE_BUTTON_RESET,
            "list-none hover:text-foreground transition-colors cursor-pointer [&::-webkit-details-marker]:hidden",
          )}
        >
          <span className="w-3 shrink-0 flex items-center justify-center">
            <ChevronRight
              className={cn("size-3 transition-transform duration-150", expanded && "rotate-90")}
            />
          </span>
          <span className="font-medium">
            {isThinking ? t("reasoning.thinkingRunning") : t("reasoning.thinking")}
          </span>
          {durationLabel && <span className="opacity-60">{durationLabel}</span>}
        </summary>
      </details>
      {expanded && (
        <div
          ref={contentRef}
          className="pl-5 pt-1 text-xs text-muted-foreground leading-relaxed max-h-96 overflow-auto"
        >
          <div className="[&_.markdown-renderer]:text-xs [&_.markdown-renderer]:text-muted-foreground [&_.markdown-renderer_code]:text-[0.85em]">
            <MarkdownRenderer content={part.text.trim()} />
          </div>
        </div>
      )}
    </div>
  );
}
