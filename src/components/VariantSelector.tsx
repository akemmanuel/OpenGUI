/**
 * Variant selector button.
 * Cycles through available model variants on click.
 * Only renders if the currently selected model has variants.
 */

import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOpenCode } from "@/hooks/use-opencode";
import { findModel } from "@/lib/utils";

export function VariantSelector() {
	const { state, cycleVariant, currentVariant } = useOpenCode();
	const { providers, selectedModel } = state;

	// Get the current model's available variants
	const variantKeys = useMemo(() => {
		if (!selectedModel) return [];
		const model = findModel(
			providers,
			selectedModel.providerID,
			selectedModel.modelID,
		);
		if (!model?.variants) return [];
		return Object.keys(model.variants).filter(
			(k) => !model.variants?.[k]?.disabled,
		);
	}, [providers, selectedModel]);

	// Don't render if no variants available
	if (variantKeys.length === 0) return null;

	const label = currentVariant ?? "default";
	const tooltipText = `Variant: ${label} (click or Ctrl+T to cycle)`;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
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
			</TooltipTrigger>
			<TooltipContent>{tooltipText}</TooltipContent>
		</Tooltip>
	);
}
