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
import { findModel } from "@/lib/utils";
import { notifyUnknownError } from "@/lib/notify";
import type { ReasoningEffort } from "@/protocol/host-types";

const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function ReasoningEffortSelector() {
  const { t } = useTranslation();
  const { providers, selectedModel, reasoningEffort } = useModelState();
  const { setReasoningEffort } = useActions();
  if (!selectedModel || !setReasoningEffort || !reasoningEffort) return null;

  const model = findModel(providers, selectedModel.providerID, selectedModel.modelID);
  // Keep reasoning available for custom models and sessions whose model is not
  // in the current catalog. Only hide it when metadata explicitly says the
  // model cannot reason.
  if (model?.capabilities.reasoning === false) return null;
  const efforts = model?.reasoningEfforts?.length ? model.reasoningEfforts : [...EFFORTS];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="!h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          title={t("reasoningEffort.title", {
            effort: t(`reasoningEffort.levels.${reasoningEffort}`),
          })}
        >
          <Brain className="size-3.5" />
          <span>
            {t("reasoningEffort.compact", {
              effort: t(`reasoningEffort.levels.${reasoningEffort}`),
            })}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={reasoningEffort}
          onValueChange={(value) => {
            if (!EFFORTS.includes(value as ReasoningEffort)) return;
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
