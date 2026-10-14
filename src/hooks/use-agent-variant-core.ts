import type { Model } from "@/protocol/agent-types";

export type VariantSelections = Record<string, string | undefined>;

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

function getEnabledVariantKeys(model: Model | undefined): string[] {
  if (!model?.variants) return [];
  return Object.keys(model.variants).filter((key) => !model.variants?.[key]?.disabled);
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
