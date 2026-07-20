import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, Copy } from "lucide-react";
import { copyTextToClipboard } from "@/lib/browser";
import type { TranscriptMessageEntry } from "@/protocol/session-transcript";

export function AssistantMessageError({
  error,
}: {
  error: TranscriptMessageEntry["info"]["error"];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!error) return null;
  const message =
    "data" in error && error.data && typeof error.data === "object" && "message" in error.data
      ? String(error.data.message)
      : error.name;

  const { summary, detail } = useMemo(() => summarizeErrorMessage(message), [message]);

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-xl border border-destructive/25 bg-destructive/10 text-destructive shadow-sm">
      <div className="flex min-w-0 items-start gap-2 p-3 sm:p-3.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/15 sm:size-6">
          <AlertTriangle className="size-4 sm:size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-5 sm:text-xs">{summary}</div>
          {detail && !expanded && (
            <div className="mt-1 line-clamp-2 break-words text-xs leading-5 text-destructive/80 sm:line-clamp-1">
              {detail}
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <pre className="mx-3 mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-destructive/15 bg-background/70 p-2.5 font-mono text-[11px] leading-4 text-destructive/90 sm:max-h-48">
          {message}
        </pre>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-destructive/15 px-3 py-2">
        <button
          type="button"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-destructive/85 transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/45"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown
            className={
              expanded
                ? "size-3.5 rotate-180 transition-transform"
                : "size-3.5 transition-transform"
            }
            aria-hidden="true"
          />
          {expanded ? t("messageError.hideDetails") : t("messageError.showDetails")}
        </button>
        <button
          type="button"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-destructive/85 transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/45"
          onClick={() => void copyTextToClipboard(message)}
        >
          <Copy className="size-3.5" aria-hidden="true" />
          {t("messageError.copy")}
        </button>
      </div>
    </div>
  );
}

function summarizeErrorMessage(message: string): { summary: string; detail: string } {
  const trimmed = message.trim();
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0 && colonIndex < 80) {
    return {
      summary: trimmed.slice(0, colonIndex).trim(),
      detail: trimmed.slice(colonIndex + 1).trim(),
    };
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  return {
    summary: firstLine.slice(0, 96),
    detail: trimmed.length > 96 ? trimmed.slice(96).trim() : "",
  };
}
