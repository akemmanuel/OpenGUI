/**
 * Variant selector button.
 * Cycles through available model variants on click.
 */

import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import { useActions, useModelState } from "@/hooks/use-agent-state";
import { findModel } from "@/lib/utils";

function formatVariantLabel(value: string | undefined, offLabel: string) {
  if (!value) return "—";
  if (value === "none") return offLabel;
  return value;
}

export function VariantSelector() {
  const { t } = useTranslation();
  const { cycleVariant } = useActions();
  const { providers, selectedModel, currentVariant } = useModelState();
  const capabilities = useBackendCapabilities();

  const model = useMemo(() => {
    if (!selectedModel) return undefined;
    return findModel(providers, selectedModel.providerID, selectedModel.modelID);
  }, [providers, selectedModel]);

  const variantKeys = useMemo(() => {
    if (!model?.variants) return [];
    return Object.keys(model.variants).filter((key) => !model.variants?.[key]?.disabled);
  }, [model]);

  if (!capabilities?.models || !selectedModel) return null;

  const supportsReasoning = variantKeys.length > 0;
  if (!supportsReasoning) return null;

  const label = formatVariantLabel(currentVariant, t("variantSelector.off"));
  const tooltipText = t("variantSelector.thinkingEffort", { level: label });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="!h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              cycleVariant();
            }}
          >
            <Sparkles className="size-3.5 shrink-0" />
            <span className="truncate max-w-[100px]">{label}</span>
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
