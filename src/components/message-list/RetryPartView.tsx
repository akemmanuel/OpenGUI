import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TranscriptPart } from "@/protocol/session-transcript";

export function RetryPartView({ part }: { part: TranscriptPart & { type: "retry" } }) {
  const { t } = useTranslation();
  const { attempt, maxAttempts, code } = part.metadata ?? {};
  const label =
    typeof attempt === "number" && typeof maxAttempts === "number"
      ? t(code === "timeout" ? "modelRetry.timeout" : "modelRetry.attempt", {
          attempt,
          maxAttempts,
        })
      : t("modelRetry.generic");

  return (
    <div
      className="my-2 flex items-center gap-2 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
