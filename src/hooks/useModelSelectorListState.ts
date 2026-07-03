import { type KeyboardEventHandler, useEffect, useMemo, useState } from "react";
import {
  buildCatalogModelGroups,
  normalizeModelQuery,
  partitionBrowseModels,
  type ModelGroup,
  type ModelOption,
} from "@/components/model-selector-groups";
import { MAX_RECENT_MODELS } from "@/lib/constants";
import { findExactModelReferenceMatch } from "@/lib/model-search";
import type { ProvidersData } from "@/types/electron";

export function useModelSelectorListState(input: {
  open: boolean;
  dialogHarnessId: string;
  query: string;
  catalogProviders: ProvidersData["providers"];
  selectedModelValue: string | null;
  favoriteValues: ReadonlySet<string>;
  recentValues: readonly string[];
  modelMaxAgeMonths: number;
  onSelectModel: (model: ModelOption) => void;
  onClose: () => void;
}) {
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const normalizedQuery = normalizeModelQuery(input.query);

  const groups = useMemo(
    () =>
      buildCatalogModelGroups({
        providers: input.catalogProviders,
        selectedModelValue: input.selectedModelValue,
        favoriteValues: input.favoriteValues,
        modelMaxAgeMonths: input.modelMaxAgeMonths,
      }),
    [
      input.catalogProviders,
      input.selectedModelValue,
      input.favoriteValues,
      input.modelMaxAgeMonths,
    ],
  );

  const allModels = useMemo(() => groups.flatMap((group) => group.models), [groups]);

  const favoriteModels = useMemo(() => {
    const byValue = new Map(allModels.map((model) => [model.value, model]));
    return [...input.favoriteValues]
      .map((value) => byValue.get(value))
      .filter((model): model is ModelOption => Boolean(model))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allModels, input.favoriteValues]);

  const recentModels = useMemo(() => {
    const byValue = new Map(allModels.map((model) => [model.value, model]));
    return input.recentValues
      .map((value) => byValue.get(value))
      .filter((model): model is ModelOption => Boolean(model))
      .filter(
        (model) =>
          model.value !== input.selectedModelValue && !input.favoriteValues.has(model.value),
      )
      .slice(0, MAX_RECENT_MODELS);
  }, [allModels, input.selectedModelValue, input.recentValues, input.favoriteValues]);

  const { filteredGroups, visibleModels } = useMemo(
    () =>
      partitionBrowseModels({
        groups,
        favoriteModels,
        recentModels,
        normalizedQuery,
        allModels,
      }),
    [groups, favoriteModels, recentModels, normalizedQuery, allModels],
  );

  const activeModel = useMemo(
    () =>
      activeValue ? (visibleModels.find((model) => model.value === activeValue) ?? null) : null,
    [activeValue, visibleModels],
  );

  useEffect(() => {
    if (!input.open) return;
    if (visibleModels.length === 0) {
      setActiveValue(null);
      return;
    }
    setActiveValue((current) => {
      if (current && visibleModels.some((model) => model.value === current)) return current;
      return visibleModels[0]?.value ?? null;
    });
  }, [input.open, input.dialogHarnessId, visibleModels]);

  const moveActive = (direction: -1 | 1) => {
    if (visibleModels.length === 0) return;
    const currentIndex = activeValue
      ? visibleModels.findIndex((model) => model.value === activeValue)
      : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (startIndex + direction + visibleModels.length) % visibleModels.length;
    setActiveValue(visibleModels[nextIndex]?.value ?? null);
  };

  const handleInputKeyDown: KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter") {
      const exactMatch = normalizedQuery
        ? findExactModelReferenceMatch(input.query, allModels)
        : undefined;
      const target = exactMatch ?? activeModel;
      if (!target) return;
      event.preventDefault();
      input.onSelectModel(target);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setActiveValue(null);
      input.onClose();
    }
  };

  const hasResults = filteredGroups.some((group) => group.models.length > 0);

  return {
    normalizedQuery,
    allModels,
    favoriteModels,
    recentModels,
    filteredGroups: filteredGroups as ModelGroup[],
    visibleModels,
    activeValue,
    setActiveValue,
    handleInputKeyDown,
    hasResults,
  };
}
