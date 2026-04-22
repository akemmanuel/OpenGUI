import type { Agent, Model, Provider } from "@opencode-ai/sdk/v2/client";
import { useCallback, useMemo } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageSetJSON, storageSetOrRemove } from "@/lib/safe-storage";
import { findModel } from "@/lib/utils";
import type { SelectedModel } from "@/types/electron";

export type VariantSelections = Record<string, string | undefined>;

export function variantKey(providerID: string, modelID: string): string {
	return `${providerID}/${modelID}`;
}

/** Persist variant selections to storage. */
function persistVariantSelections(selections: VariantSelections): void {
	storageSetJSON(STORAGE_KEYS.VARIANT_SELECTIONS, selections);
}

/**
 * Immutably update a variant selections map: set or delete a key.
 * Returns the new selections object.
 */
export function updateVariantSelections(
	selections: VariantSelections,
	key: string,
	value: string | undefined,
): VariantSelections {
	const next = { ...selections };
	if (value === undefined) {
		delete next[key];
	} else {
		next[key] = value;
	}
	return next;
}

function cycleVariantSelection(
	current: string | undefined,
	model: Model | undefined,
): string | undefined {
	if (!model?.variants) return undefined;
	const keys = Object.keys(model.variants).filter(
		(k) => !model.variants?.[k]?.disabled,
	);
	if (keys.length === 0) return undefined;
	if (current === undefined) return keys[0];
	const idx = keys.indexOf(current);
	if (idx < 0 || idx >= keys.length - 1) return undefined;
	return keys[idx + 1];
}

export function resolveVariant(
	selectedModel: SelectedModel | null,
	variantSelections: VariantSelections,
	agents: Agent[],
	selectedAgent: string | null,
): string | undefined {
	if (!selectedModel) return undefined;
	const key = variantKey(selectedModel.providerID, selectedModel.modelID);
	const explicit = variantSelections[key];
	if (explicit !== undefined) return explicit;
	if (selectedAgent) {
		const agent = agents.find((a) => a.name === selectedAgent);
		if (agent?.variant) return agent.variant;
	}
	return undefined;
}

interface UseVariantParams {
	selectedModel: SelectedModel | null;
	providers: Provider[];
	agents: Agent[];
	selectedAgent: string | null;
	variantSelections: VariantSelections;
	dispatch: (
		action:
			| { type: "SET_SELECTED_MODEL"; payload: SelectedModel | null }
			| { type: "SET_SELECTED_AGENT"; payload: string | null }
			| { type: "SET_VARIANT_SELECTIONS"; payload: VariantSelections },
	) => void;
}

export function useVariant({
	selectedModel,
	providers,
	agents,
	selectedAgent,
	variantSelections,
	dispatch,
}: UseVariantParams) {
	const currentVariant = useMemo(
		() =>
			resolveVariant(selectedModel, variantSelections, agents, selectedAgent),
		[selectedModel, variantSelections, agents, selectedAgent],
	);

	const setModel = useCallback(
		(model: SelectedModel | null) => {
			dispatch({ type: "SET_SELECTED_MODEL", payload: model });
		},
		[dispatch],
	);

	const setAgent = useCallback(
		(agent: string | null) => {
			dispatch({ type: "SET_SELECTED_AGENT", payload: agent });
			storageSetOrRemove(STORAGE_KEYS.SELECTED_AGENT, agent);
		},
		[dispatch],
	);

	const cycleVariant = useCallback(() => {
		if (!selectedModel) return;
		const model = findModel(
			providers,
			selectedModel.providerID,
			selectedModel.modelID,
		);
		const key = variantKey(selectedModel.providerID, selectedModel.modelID);
		const current = variantSelections[key];
		const next = cycleVariantSelection(current, model);
		const newSelections = updateVariantSelections(variantSelections, key, next);
		dispatch({ type: "SET_VARIANT_SELECTIONS", payload: newSelections });
		persistVariantSelections(newSelections);
	}, [selectedModel, providers, variantSelections, dispatch]);

	const setVariant = useCallback(
		(variant: string | undefined) => {
			if (!selectedModel) return;
			const key = variantKey(selectedModel.providerID, selectedModel.modelID);
			const newSelections = updateVariantSelections(
				variantSelections,
				key,
				variant,
			);
			dispatch({ type: "SET_VARIANT_SELECTIONS", payload: newSelections });
			persistVariantSelections(newSelections);
		},
		[selectedModel, variantSelections, dispatch],
	);

	return {
		currentVariant,
		setModel,
		setAgent,
		cycleVariant,
		setVariant,
	};
}
