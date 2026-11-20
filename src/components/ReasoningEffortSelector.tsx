import { Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useActions, useModelState } from "@/hooks/use-agent-state";
import { cn, findModel } from "@/lib/utils";
import { notifyUnknownError } from "@/lib/notify";
import { REASONING_EFFORTS } from "@opengui/protocol";
import type { ReasoningEffort } from "@/protocol/host-types";

export function ReasoningEffortSelector({ compact = false }: { compact?: boolean } = {}) {
  const { t } = useTranslation();
  const { providers, selectedModel, reasoningEffort } = useModelState();
  const { setReasoningEffort } = useActions();
  if (!selectedModel || !setReasoningEffort || !reasoningEffort) return null;

  const model = findModel(providers, selectedModel.providerID, selectedModel.modelID);
  if (model?.capabilities.reasoning === false || !model?.reasoningEfforts?.length) return null;
  const efforts = model.reasoningEfforts;
  const effortLabel = t(`reasoningEffort.levels.${reasoningEffort}`);
  const label = t("reasoningEffort.title", { effort: effortLabel });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-responsive-allow="text-clip"
          className={cn(
            "min-h-8 min-w-0 max-w-44 shrink gap-1.5 overflow-hidden px-1.5 text-xs text-muted-foreground hover:text-foreground max-[374px]:shrink-0",
            compact && "max-sm:shrink-0",
          )}
          aria-label={label}
          title={label}
        >
          <Brain className="size-3.5 shrink-0" />
          {!compact && (
            <>
              <span className="min-[375px]:hidden">{effortLabel}</span>
              <span
                className="hidden min-w-0 truncate min-[375px]:inline sm:hidden"
                data-responsive-allow="text-clip"
              >
                {t("reasoningEffort.compactTitle", { effort: effortLabel })}
              </span>
            </>
          )}
          <span className="hidden min-w-0 truncate sm:inline" data-responsive-allow="text-clip">
            {label}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={reasoningEffort}
          onValueChange={(value) => {
            if (!REASONING_EFFORTS.includes(value as ReasoningEffort)) return;
            void setReasoningEffort(value as ReasoningEffort).catch(notifyUnknownError);
          }}
        >
          <DropdownMenuLabel>{t("reasoningEffort.label")}</DropdownMenuLabel>
          {efforts.map((effort) => (
            <DropdownMenuRadioItem key={effort} value={effort} closeOnClick>
              {t(`reasoningEffort.levels.${effort}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
