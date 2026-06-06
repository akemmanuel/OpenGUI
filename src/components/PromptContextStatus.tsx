import { Loader2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function PromptContextStatus({
  contextPercent,
  contextTokens,
  contextCost,
  contextLimit,
  isLoading,
  isDisabled,
  isCompacting,
  isCompactingInProgress,
  onCompact,
}: {
  contextPercent: number;
  contextTokens?: number | null;
  contextCost?: number | null;
  contextLimit?: number | null;
  isLoading?: boolean;
  isDisabled: boolean;
  isCompacting: boolean;
  isCompactingInProgress: boolean;
  onCompact: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const isCompactingOrInProgress = isCompacting || isCompactingInProgress;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <div className="flex">
          <button
            type="button"
            className={cn(
              "flex items-center gap-1 text-[11px] tabular-nums select-none cursor-pointer rounded-md px-1.5 py-0.5 hover:bg-accent transition-colors",
              isCompactingOrInProgress && "animate-pulse",
              contextPercent >= 90
                ? "text-destructive hover:text-destructive"
                : contextPercent >= 70
                  ? "text-amber-500 hover:text-amber-600"
                  : "text-muted-foreground/70 hover:text-foreground",
            )}
          >
            {isCompactingOrInProgress ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 20 20"
                className="shrink-0 -rotate-90"
                aria-hidden="true"
              >
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  opacity="0.2"
                />
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${Math.max(contextPercent, 0) * 0.5027} 50.27`}
                />
              </svg>
            )}
            {isCompactingOrInProgress
              ? t("contextStatus.compacting")
              : contextPercent === 0
                ? "0%"
                : contextPercent < 1
                  ? "<1%"
                  : `${contextPercent}%`}
          </button>
        </div>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-48 p-3 text-xs z-50">
        <div className="font-semibold mb-2">{t("contextStatus.contextWindow")}</div>
        {contextTokens != null && contextLimit != null ? (
          <div className="text-muted-foreground mb-1">
            {contextTokens.toLocaleString()} / {contextLimit.toLocaleString()}{" "}
            {t("contextStatus.tokens")}
          </div>
        ) : contextTokens != null ? (
          <div className="text-muted-foreground mb-1">
            {contextTokens.toLocaleString()} {t("contextStatus.tokens")}
          </div>
        ) : null}
        {contextCost != null && contextCost > 0 && (
          <div className="text-muted-foreground mb-2">
            {t("contextStatus.cost")}: $
            {contextCost < 0.01 ? contextCost.toFixed(6) : contextCost.toFixed(4)}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full mt-2 gap-2"
          disabled={isLoading || isDisabled || isCompactingInProgress}
          onClick={onCompact}
        >
          <Minimize2 className="size-3" />
          {t("contextStatus.compact")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
