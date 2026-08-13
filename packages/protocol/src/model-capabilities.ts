export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ModelReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CatalogModelMetadata {
  name?: string;
  release_date?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: unknown[] }>;
  limit?: { context?: number };
}

export type FlatModelCatalog = Record<string, CatalogModelMetadata>;

export interface ModelCatalogHints {
  baseUrl?: string;
  providerHint?: string;
}

const VENDOR_HOST_HINTS: Record<string, string> = {
  "api.anthropic.com": "anthropic",
  "api.deepseek.com": "deepseek",
  "api.openai.com": "openai",
  "api.x.ai": "xai",
};

const MODEL_PREFIX_HINTS: Array<[prefix: string, provider: string]> = [
  ["claude-", "anthropic"],
  ["deepseek-", "deepseek"],
  ["gpt-", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["grok-", "xai"],
];

function providerFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return VENDOR_HOST_HINTS[new URL(baseUrl).hostname.toLowerCase()];
  } catch {
    return undefined;
  }
}

function providerFromModelId(modelId: string): string | undefined {
  return MODEL_PREFIX_HINTS.find(([prefix]) => modelId.startsWith(prefix))?.[1];
}

function optionRichness(model: CatalogModelMetadata): number {
  const options = model.reasoning_options ?? [];
  const effortValues = options
    .filter((option) => option.type === "effort")
    .reduce((count, option) => count + (option.values?.length ?? 0), 0);
  return (options.some((option) => option.type === "toggle") ? 100 : 0) + effortValues;
}

/** Selects one authoritative catalog entry. Reseller capabilities are never unioned. */
export function selectCatalogModel(
  catalog: FlatModelCatalog | null,
  modelId: string,
  hints: ModelCatalogHints = {},
): CatalogModelMetadata | null {
  if (!catalog) return null;
  const candidates = Object.entries(catalog).filter(
    ([key]) => key === modelId || key.endsWith(`/${modelId}`),
  );
  if (candidates.length === 0) return null;

  const preferredProvider =
    hints.providerHint ?? providerFromBaseUrl(hints.baseUrl) ?? providerFromModelId(modelId);
  return (
    candidates.toSorted(([leftKey, left], [rightKey, right]) => {
      const leftProvider = leftKey.split("/", 1)[0];
      const rightProvider = rightKey.split("/", 1)[0];
      const providerDifference =
        Number(rightProvider === preferredProvider) - Number(leftProvider === preferredProvider);
      if (providerDifference !== 0) return providerDifference;
      const richnessDifference = optionRichness(right) - optionRichness(left);
      if (richnessDifference !== 0) return richnessDifference;
      return leftKey.localeCompare(rightKey);
    })[0]?.[1] ?? null
  );
}

export function reasoningEffortsFromCatalogModel(
  model: CatalogModelMetadata,
): ModelReasoningEffort[] | undefined {
  if (model.reasoning !== true) return undefined;
  const efforts = new Set<ModelReasoningEffort>();
  const options = model.reasoning_options ?? [];
  if (options.some((option) => option.type === "toggle")) efforts.add("none");
  for (const option of options) {
    if (option.type !== "effort") continue;
    for (const value of option.values ?? []) {
      if (REASONING_EFFORTS.includes(value as ModelReasoningEffort)) {
        efforts.add(value as ModelReasoningEffort);
      }
    }
  }
  if (efforts.size === 0 || (efforts.size === 1 && efforts.has("none"))) {
    return ["none", "high"];
  }
  return REASONING_EFFORTS.filter((effort) => efforts.has(effort));
}
