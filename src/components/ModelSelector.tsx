/**
 * Model selector dialog.
 * Adds searchable model picking with recent selections.
 */

import { BrainCircuit, Check, Lightbulb, Search, Star } from "lucide-react";
import { type KeyboardEventHandler, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_BACKEND_LABELS } from "@/agents";
import { ProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  useAvailableBackendIds,
  useBackendCapabilities,
  useCurrentAgentBackendId,
} from "@/hooks/use-agent-backend";
import { useActions, useModelState, useSessionState } from "@/hooks/use-agent-state";
import { DEFAULT_MODEL_MAX_AGE_MONTHS, MAX_RECENT_MODELS, STORAGE_KEYS } from "@/lib/constants";
import {
  filterModelSearchCandidates,
  findExactModelReferenceMatch,
  normalizeModelQuery,
  type ModelSearchCandidate,
} from "@/lib/model-search";
import { storageGet, storageParsed, storageSetJSON } from "@/lib/safe-storage";
import { cn } from "@/lib/utils";

type ModelOption = ModelSearchCandidate & {
  reasoning: boolean;
};

type ModelGroup = {
  id: string;
  name: string;
  models: ModelOption[];
};

function getStoredModelMaxAgeMonths(): number {
  const raw = storageGet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS);
  if (raw === null) return DEFAULT_MODEL_MAX_AGE_MONTHS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MODEL_MAX_AGE_MONTHS;
  if (parsed <= 0) return 0;
  return parsed;
}

function groupModelsByProvider(models: ModelOption[]): ModelGroup[] {
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

function ModelRow({
  model,
  isCurrent,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
  onMouseEnter,
  showProvider,
}: {
  model: ModelOption;
  isCurrent: boolean;
  isActive: boolean;
  isFavorite: boolean;
  onSelect: (model: ModelOption) => void;
  onToggleFavorite: (value: string) => void;
  onMouseEnter: (value: string) => void;
  showProvider?: boolean;
}) {
  return (
    <div
      className={cn(
        "group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs",
        isActive
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent hover:text-accent-foreground",
        isCurrent && !isActive && "bg-accent/60 text-foreground",
      )}
      onMouseEnter={() => onMouseEnter(model.value)}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onClick={() => onSelect(model)}
      >
        {showProvider && (
          <ProviderIcon
            provider={model.providerID}
            className="size-3 shrink-0 text-muted-foreground"
          />
        )}
        <span className="truncate">{model.label}</span>
        {showProvider && (
          <span className="text-[10px] text-muted-foreground">{model.providerName}</span>
        )}
        {model.reasoning && <Lightbulb className="size-3 shrink-0 text-amber-500" />}
      </button>
      <span className="flex shrink-0 items-center gap-1">
        {isCurrent && <Check className="size-3.5 text-primary" />}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(model.value);
          }}
          className={cn(
            "rounded p-0.5",
            isFavorite ? "text-amber-500" : "text-muted-foreground/50 hover:!text-amber-500",
          )}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Star className={cn("size-3", isFavorite && "fill-current")} />
        </button>
      </span>
    </div>
  );
}

export function ModelSelector() {
  const { setModel, setDraftBackend } = useActions();
  const { providers, selectedModel } = useModelState();
  const { sessions, activeSessionId, draftSessionBackendId } = useSessionState();
  const availableBackendIds = useAvailableBackendIds();
  const preferredBackendId = useCurrentAgentBackendId();
  const capabilities = useBackendCapabilities();
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const lockedBackendId = activeSession?._backendId ?? null;
  const selectedBackendId = lockedBackendId ?? draftSessionBackendId ?? preferredBackendId;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [recentValues, setRecentValues] = useState<string[]>([]);
  const [favoriteValues, setFavoriteValues] = useState<Set<string>>(new Set());
  const [modelMaxAgeMonths, setModelMaxAgeMonths] = useState(() => getStoredModelMaxAgeMonths());
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const recentArr = storageParsed<unknown[]>(STORAGE_KEYS.RECENT_MODELS);
    if (Array.isArray(recentArr)) {
      setRecentValues(recentArr.filter((v): v is string => typeof v === "string"));
    }
    const favArr = storageParsed<unknown[]>(STORAGE_KEYS.FAVORITE_MODELS);
    if (Array.isArray(favArr)) {
      setFavoriteValues(new Set(favArr.filter((v): v is string => typeof v === "string")));
    }
    setStorageHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncModelMaxAge = () => {
      setModelMaxAgeMonths(getStoredModelMaxAgeMonths());
    };
    window.addEventListener("storage", syncModelMaxAge);
    window.addEventListener("model-max-age-months-changed", syncModelMaxAge);
    return () => {
      window.removeEventListener("storage", syncModelMaxAge);
      window.removeEventListener("model-max-age-months-changed", syncModelMaxAge);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !storageHydrated) return;
    storageSetJSON(STORAGE_KEYS.RECENT_MODELS, recentValues.slice(0, MAX_RECENT_MODELS));
  }, [recentValues, storageHydrated]);

  useEffect(() => {
    if (typeof window === "undefined" || !storageHydrated) return;
    storageSetJSON(STORAGE_KEYS.FAVORITE_MODELS, [...favoriteValues]);
  }, [favoriteValues, storageHydrated]);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("open-model-selector", handler);
    return () => window.removeEventListener("open-model-selector", handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const groups = useMemo(() => {
    const now = Date.now();
    const maxAgeMs =
      modelMaxAgeMonths > 0 ? 1000 * 60 * 60 * 24 * 30.4375 * modelMaxAgeMonths : null;
    const alwaysIncludeValues = new Set<string>();
    if (selectedModel) {
      alwaysIncludeValues.add(`${selectedModel.providerID}/${selectedModel.modelID}`);
    }
    for (const fav of favoriteValues) {
      alwaysIncludeValues.add(fav);
    }

    return providers
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
  }, [providers, selectedModel, favoriteValues, modelMaxAgeMonths]);

  const allModels = useMemo(() => groups.flatMap((group) => group.models), [groups]);

  const currentValue = selectedModel
    ? `${selectedModel.providerID}/${selectedModel.modelID}`
    : null;

  const currentModel = useMemo(
    () => (currentValue ? allModels.find((model) => model.value === currentValue) : null),
    [allModels, currentValue],
  );

  const normalizedQuery = normalizeModelQuery(query);

  const favoriteModels = useMemo(() => {
    const byValue = new Map(allModels.map((model) => [model.value, model]));
    return [...favoriteValues]
      .map((value) => byValue.get(value))
      .filter((model): model is ModelOption => Boolean(model))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allModels, favoriteValues]);

  const recentModels = useMemo(() => {
    const byValue = new Map(allModels.map((model) => [model.value, model]));
    return recentValues
      .map((value) => byValue.get(value))
      .filter((model): model is ModelOption => Boolean(model))
      .filter((model) => model.value !== currentValue && !favoriteValues.has(model.value))
      .slice(0, MAX_RECENT_MODELS);
  }, [allModels, currentValue, recentValues, favoriteValues]);

  const excludedFromGroups = useMemo(() => {
    const set = new Set<string>();
    for (const model of favoriteModels) set.add(model.value);
    for (const model of recentModels) set.add(model.value);
    return set;
  }, [favoriteModels, recentModels]);

  const browseGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          models: group.models.filter((model) => !excludedFromGroups.has(model.value)),
        }))
        .filter((group) => group.models.length > 0),
    [groups, excludedFromGroups],
  );

  const searchMatches = useMemo(
    () => (normalizedQuery ? filterModelSearchCandidates(allModels, normalizedQuery) : []),
    [allModels, normalizedQuery],
  );

  const filteredGroups = useMemo(
    () => (normalizedQuery ? groupModelsByProvider(searchMatches) : browseGroups),
    [browseGroups, normalizedQuery, searchMatches],
  );

  const visibleModels = useMemo(() => {
    if (normalizedQuery) {
      return searchMatches;
    }
    return [...favoriteModels, ...recentModels, ...browseGroups.flatMap((group) => group.models)];
  }, [browseGroups, favoriteModels, normalizedQuery, recentModels, searchMatches]);

  const activeModel = useMemo(
    () =>
      activeValue ? (visibleModels.find((model) => model.value === activeValue) ?? null) : null,
    [activeValue, visibleModels],
  );

  useEffect(() => {
    if (!open) return;
    if (visibleModels.length === 0) {
      setActiveValue(null);
      return;
    }
    setActiveValue((current) => {
      if (current && visibleModels.some((model) => model.value === current)) {
        return current;
      }
      return visibleModels[0]?.value ?? null;
    });
  }, [open, visibleModels]);

  const toggleFavorite = (value: string) => {
    setFavoriteValues((prev) => {
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  };

  const closeSelector = () => {
    setOpen(false);
    setQuery("");
    setActiveValue(null);
  };

  const selectModel = (model: ModelOption) => {
    setModel({ providerID: model.providerID, modelID: model.modelID });
    setRecentValues((previous) => {
      const next = [model.value, ...previous.filter((v) => v !== model.value)];
      return next.slice(0, MAX_RECENT_MODELS);
    });
    closeSelector();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      closeSelector();
      return;
    }
    setOpen(true);
  };

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
        ? findExactModelReferenceMatch(query, allModels)
        : undefined;
      const target = exactMatch ?? activeModel;
      if (!target) return;
      event.preventDefault();
      selectModel(target);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeSelector();
    }
  };

  const hasResults = filteredGroups.some((group) => group.models.length > 0);

  if (!capabilities?.models || providers.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title="Select model"
          className="!h-7 min-w-0 shrink gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {currentModel ? (
            <ProviderIcon provider={currentModel.providerID} className="size-3.5 shrink-0" />
          ) : (
            <BrainCircuit className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{currentModel?.label ?? "Select model"}</span>
        </Button>
      </DialogTrigger>

      <DialogContent
        className="p-0 sm:max-w-2xl"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-box-textarea"]')?.focus();
        }}
      >
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-base">Select model</DialogTitle>
        </DialogHeader>

        {availableBackendIds.length > 1 && (
          <div className="px-4 pb-2">
            <div className="flex flex-wrap gap-1.5">
              {availableBackendIds.map((backendId) => {
                const isSelected = selectedBackendId === backendId;
                return (
                  <Button
                    key={backendId}
                    type="button"
                    variant={isSelected ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={!!lockedBackendId}
                    onClick={() => setDraftBackend(backendId)}
                  >
                    {AGENT_BACKEND_LABELS[backendId]}
                  </Button>
                );
              })}
            </div>
            {lockedBackendId && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Backend locked for this session.
              </p>
            )}
          </div>
        )}

        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
              onFocus={(e) => e.target.select()}
              placeholder="Search provider, model, or id..."
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-2 pb-4">
          {!normalizedQuery && favoriteModels.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Favorites
              </div>
              {favoriteModels.map((model) => (
                <ModelRow
                  key={`fav-${model.value}`}
                  model={model}
                  isCurrent={model.value === currentValue}
                  isActive={model.value === activeValue}
                  isFavorite={true}
                  onSelect={selectModel}
                  onToggleFavorite={toggleFavorite}
                  onMouseEnter={setActiveValue}
                  showProvider
                />
              ))}
            </div>
          )}

          {!normalizedQuery && recentModels.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Recent
              </div>
              {recentModels.map((model) => (
                <ModelRow
                  key={`recent-${model.value}`}
                  model={model}
                  isCurrent={model.value === currentValue}
                  isActive={model.value === activeValue}
                  isFavorite={favoriteValues.has(model.value)}
                  onSelect={selectModel}
                  onToggleFavorite={toggleFavorite}
                  onMouseEnter={setActiveValue}
                  showProvider
                />
              ))}
            </div>
          )}

          {hasResults ? (
            filteredGroups.map((group) => (
              <div key={group.id} className="space-y-1">
                <div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  <ProviderIcon provider={group.id} className="size-3.5 shrink-0" />
                  {group.name}
                </div>
                {group.models.map((model) => (
                  <ModelRow
                    key={model.value}
                    model={model}
                    isCurrent={model.value === currentValue}
                    isActive={model.value === activeValue}
                    isFavorite={favoriteValues.has(model.value)}
                    onSelect={selectModel}
                    onToggleFavorite={toggleFavorite}
                    onMouseEnter={setActiveValue}
                    showProvider={Boolean(normalizedQuery)}
                  />
                ))}
              </div>
            ))
          ) : (
            <div className="px-2 text-xs text-muted-foreground">
              No models match "{query.trim()}".
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
