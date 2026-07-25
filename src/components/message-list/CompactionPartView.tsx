import { Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TranscriptPart } from "@/protocol/session-transcript";

export function CompactionPartView({ part }: { part: TranscriptPart & { type: "compaction" } }) {
  const { t } = useTranslation();
  const metadata =
    part.metadata && typeof part.metadata === "object"
      ? (part.metadata as Record<string, unknown>)
      : {};
  const completed = metadata.status === "completed";
  const label = completed
    ? metadata.reason === "manual"
      ? "compaction.completedManual"
      : "compaction.completed"
    : "compaction.inProgress";

  return (
    <div
      className="my-2 flex items-center gap-2 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      {completed ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <LoaderCircle
          className="size-3.5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
      <span>{t(label)}</span>
    </div>
  );
}
