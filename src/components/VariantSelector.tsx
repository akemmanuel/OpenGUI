/**
 * Variant selector button.
 * Cycles through available model variants on click.
 * Stays visible for non-reasoning models so control remains discoverable.
 */

import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import { useActions, useModelState } from "@/hooks/use-agent-state";
import { findModel } from "@/lib/utils";

function formatVariantLabel(value: string | undefined) {
	if (!value) return "default";
	if (value === "none") return "off";
	return value;
}

export function VariantSelector() {
	const { cycleVariant } = useActions();
	const { providers, selectedModel, currentVariant } = useModelState();
	const capabilities = useBackendCapabilities();

	const model = useMemo(() => {
		if (!selectedModel) return undefined;
		return findModel(
			providers,
			selectedModel.providerID,
			selectedModel.modelID,
		);
	}, [providers, selectedModel]);

	const variantKeys = useMemo(() => {
		if (!model?.variants) return [];
		return Object.keys(model.variants).filter(
			(key) => !model.variants?.[key]?.disabled,
		);
	}, [model]);

	if (!capabilities?.models || !selectedModel) return null;

	const supportsReasoning = variantKeys.length > 0;
	const label = supportsReasoning
		? formatVariantLabel(currentVariant)
		: "no reasoning";
	const tooltipText = supportsReasoning
		? `Variant: ${formatVariantLabel(currentVariant)} (click or Ctrl+T to cycle)`
		: `${model?.name ?? "Selected model"} has no reasoning effort options. Pick Sonnet or Opus.`;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={!supportsReasoning}
						className="!h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
						onClick={(e) => {
							e.stopPropagation();
							if (!supportsReasoning) return;
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
