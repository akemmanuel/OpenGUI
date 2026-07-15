import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function PromptContextStatus({
  contextPercent,
  contextTokens,
  contextCost,
  contextLimit,
  isEstimated,
}: {
  contextPercent: number;
  contextTokens?: number | null;
  contextCost?: number | null;
  contextLimit?: number | null;
  isEstimated?: boolean;
}) {
  const { t } = useTranslation();
  const percentage = Math.min(100, Math.max(0, contextPercent));
  const remaining = Math.max(0, (contextLimit ?? 0) - (contextTokens ?? 0));
  const tone =
    percentage >= 90
      ? "stroke-destructive text-destructive"
      : percentage >= 70
        ? "stroke-amber-500 text-amber-600 dark:text-amber-400"
        : "stroke-primary text-foreground";
  const details = (
    <>
      <div className="font-medium text-foreground">{t("contextStatus.contextWindow")}</div>
      {contextTokens != null && contextLimit != null && (
        <>
          <div className="mt-1 tabular-nums text-foreground">
            {t("contextStatus.usage", {
              used: contextTokens.toLocaleString(),
              limit: contextLimit.toLocaleString(),
            })}
          </div>
          <div className="tabular-nums text-muted-foreground">
            {t("contextStatus.remaining", { count: remaining.toLocaleString() })}
          </div>
        </>
      )}
      {isEstimated && (
        <div className="mt-1 text-muted-foreground">{t("contextStatus.estimated")}</div>
      )}
      {contextCost != null && contextCost > 0 && (
        <div className="mt-1 text-muted-foreground">
          {t("contextStatus.cost")}: $
          {contextCost < 0.01 ? contextCost.toFixed(6) : contextCost.toFixed(4)}
        </div>
      )}
    </>
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("contextStatus.contextWindow")}
              className={cn(
                "relative flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/60 text-[9px] font-medium tabular-nums transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                tone.split(" ").slice(1).join(" "),
              )}
            >
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-7 -rotate-90"
                viewBox="0 0 28 28"
              >
                <circle
                  className="stroke-foreground/15"
                  cx="14"
                  cy="14"
                  r="11"
                  fill="none"
                  strokeWidth="2.5"
                />
                <circle
                  className={cn(
                    "transition-[stroke-dasharray] duration-300 ease-out",
                    tone.split(" ")[0],
                  )}
                  cx="14"
                  cy="14"
                  r="11"
                  fill="none"
                  pathLength="100"
                  strokeDasharray={`${percentage} 100`}
                  strokeLinecap="round"
                  strokeWidth="2.5"
                />
              </svg>
              <span className="relative">
                {percentage > 0 && percentage < 1 ? "<1%" : `${percentage}%`}
              </span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="block max-w-none bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <div className="min-w-48 text-xs">{details}</div>
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-56 p-3 text-xs">
        {details}
      </PopoverContent>
    </Popover>
  );
}
