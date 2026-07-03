import { DEFAULT_MODEL_MAX_AGE_MONTHS } from "@/lib/constants";
import {
  filterModelSearchCandidates,
  normalizeModelQuery,
  type ModelSearchCandidate,
} from "@/lib/model-search";
import type { ProvidersData } from "@/types/electron";

export type ModelOption = ModelSearchCandidate & {
  reasoning: boolean;
};

export type ModelGroup = {
  id: string;
  name: string;
  models: ModelOption[];
};

export function groupModelsByProvider(models: ModelOption[]): ModelGroup[] {
  const grouped = new Map<string, ModelGroup>();
  for (const model of models) {
    const existing = grouped.get(model.providerID);
    if (existing) {
      existing.models.push(model);
      continue;
    }
    grouped.set(model.providerID, {
      id: model.providerID,
      name: model.providerName,
      models: [model],
    });
  }
  return [...grouped.values()];
}

export function buildCatalogModelGroups(input: {
  providers: ProvidersData["providers"];
  selectedModelValue: string | null;
  favoriteValues: ReadonlySet<string>;
  modelMaxAgeMonths: number;
  now?: number;
}): ModelGroup[] {
  const now = input.now ?? Date.now();
  const maxAgeMs =
    input.modelMaxAgeMonths > 0 ? 1000 * 60 * 60 * 24 * 30.4375 * input.modelMaxAgeMonths : null;
  const alwaysIncludeValues = new Set<string>();
  if (input.selectedModelValue) {
    alwaysIncludeValues.add(input.selectedModelValue);
  }
  for (const fav of input.favoriteValues) {
    alwaysIncludeValues.add(fav);
  }

  return input.providers
    .filter((provider) => Object.keys(provider.models).length > 0)
    .map((provider) => {
      const modelEntries = Object.entries(provider.models);
      const shouldApplyAgeFilter = modelEntries.length > 10;

      return {
        id: provider.id,
        name: provider.name,
        models: modelEntries
          .filter(([key, model]) => {
            const value = `${provider.id}/${key}`;
            if (alwaysIncludeValues.has(value)) return true;
            if (model.status === "deprecated") return false;
            if (!shouldApplyAgeFilter || maxAgeMs === null) return true;
            const timestamp = Date.parse(model.release_date);
            if (!Number.isFinite(timestamp)) return true;
            return Math.abs(now - timestamp) < maxAgeMs;
          })
          .sort(([, a], [, b]) => a.name.localeCompare(b.name))
          .map(([key, model]) => ({
            value: `${provider.id}/${key}`,
            providerID: provider.id,
            modelID: key,
            providerName: provider.name,
            label: model.name,
            reasoning: model.capabilities.reasoning,
          })),
      };
    })
    .filter((group) => group.models.length > 0);
}

export function getStoredModelMaxAgeMonths(
  readStorage: (key: string) => string | null,
  storageKey: string,
): number {
  const raw = readStorage(storageKey);
  if (raw === null) return DEFAULT_MODEL_MAX_AGE_MONTHS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MODEL_MAX_AGE_MONTHS;
  if (parsed <= 0) return 0;
  return parsed;
}

export function partitionBrowseModels(input: {
  groups: ModelGroup[];
  favoriteModels: ModelOption[];
  recentModels: ModelOption[];
  normalizedQuery: string;
  allModels: ModelOption[];
}): {
  browseGroups: ModelGroup[];
  filteredGroups: ModelGroup[];
  searchMatches: ModelOption[];
  visibleModels: ModelOption[];
} {
  const excludedFromGroups = new Set<string>();
  for (const model of input.favoriteModels) excludedFromGroups.add(model.value);
  for (const model of input.recentModels) excludedFromGroups.add(model.value);

  const browseGroups = input.groups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => !excludedFromGroups.has(model.value)),
    }))
    .filter((group) => group.models.length > 0);

  const searchMatches = input.normalizedQuery
    ? filterModelSearchCandidates(input.allModels, input.normalizedQuery)
    : [];

  const filteredGroups = input.normalizedQuery
    ? groupModelsByProvider(searchMatches)
    : browseGroups;

  const visibleModels = input.normalizedQuery
    ? searchMatches
    : [
        ...input.favoriteModels,
        ...input.recentModels,
        ...browseGroups.flatMap((group) => group.models),
      ];

  return { browseGroups, filteredGroups, searchMatches, visibleModels };
}

export { normalizeModelQuery };
