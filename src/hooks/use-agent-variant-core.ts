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

export function getEnabledVariantKeys(model: Model | undefined): string[] {
	if (!model?.variants) return [];
	return Object.keys(model.variants).filter(
		(key) => !model.variants?.[key]?.disabled,
	);
}

export function normalizeVariantSelection(
	current: string | undefined,
	model: Model | undefined,
): string | undefined {
	const keys = getEnabledVariantKeys(model);
	if (keys.length === 0) return undefined;
	if (current && keys.includes(current)) return current;
	return keys[0];
}

export function cycleVariantSelection(
	current: string | undefined,
	model: Model | undefined,
): string | undefined {
	const keys = getEnabledVariantKeys(model);
	if (keys.length === 0) return undefined;
	if (current === undefined) return keys[0];
	const idx = keys.indexOf(current);
	if (idx < 0) return keys[0];
	return keys[(idx + 1) % keys.length];
}

export function previousVariantSelection(
	current: string | undefined,
	model: Model | undefined,
): string | undefined {
	const keys = getEnabledVariantKeys(model);
	if (keys.length === 0) return undefined;
	if (current === undefined) return keys[keys.length - 1];
	const idx = keys.indexOf(current);
	if (idx < 0) return keys[keys.length - 1];
	return keys[(idx - 1 + keys.length) % keys.length];
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
	const model = useMemo(() => {
		if (!selectedModel) return undefined;
		return findModel(
			providers,
			selectedModel.providerID,
			selectedModel.modelID,
		);
	}, [selectedModel, providers]);

	const currentVariant = useMemo(
		() =>
			normalizeVariantSelection(
				resolveVariant(selectedModel, variantSelections, agents, selectedAgent),
				model,
			),
		[selectedModel, variantSelections, agents, selectedAgent, model],
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
		const key = variantKey(selectedModel.providerID, selectedModel.modelID);
		const next = cycleVariantSelection(currentVariant, model);
		if (currentVariant === next) return;
		const newSelections = updateVariantSelections(variantSelections, key, next);
		dispatch({ type: "SET_VARIANT_SELECTIONS", payload: newSelections });
		persistVariantSelections(newSelections);
	}, [selectedModel, currentVariant, model, variantSelections, dispatch]);

	const setVariant = useCallback(
		(variant: string | undefined) => {
			if (!selectedModel) return;
			const key = variantKey(selectedModel.providerID, selectedModel.modelID);
			if (currentVariant === variant) return;
			const newSelections = updateVariantSelections(
				variantSelections,
				key,
				variant,
			);
			dispatch({ type: "SET_VARIANT_SELECTIONS", payload: newSelections });
			persistVariantSelections(newSelections);
		},
		[selectedModel, currentVariant, variantSelections, dispatch],
	);

	const revertVariant = useCallback(() => {
		if (!selectedModel) return;
		const key = variantKey(selectedModel.providerID, selectedModel.modelID);
		const previous = previousVariantSelection(currentVariant, model);
		if (currentVariant === previous) return;
		const newSelections = updateVariantSelections(
			variantSelections,
			key,
			previous,
		);
		dispatch({ type: "SET_VARIANT_SELECTIONS", payload: newSelections });
		persistVariantSelections(newSelections);
	}, [selectedModel, currentVariant, model, variantSelections, dispatch]);

	return {
		currentVariant,
		setModel,
		setAgent,
		cycleVariant,
		setVariant,
		revertVariant,
	};
}
