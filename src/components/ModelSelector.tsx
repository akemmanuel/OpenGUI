/**
 * Harness → Provider → Model selection dialog (PromptBox affordance).
 */

import { BrainCircuit, Check, Lightbulb, Loader2, Search, Star } from "lucide-react";
import {
  type KeyboardEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { HARNESS_IDS, HARNESS_LABELS, type HarnessId } from "@/agents";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createHarnessInventoryView } from "@/hooks/harness-inventory-view";
import { resolvePromptBoxHarnessId } from "@/hooks/prompt-box-selection";
import { getSessionDirectory } from "@/hooks/agent-session-utils";
import {
  useAvailableHarnessIds,
  useCurrentHarnessId,
  useRoutedHarness,
} from "@/hooks/use-agent-backend";
import {
  useActions,
  useConnectionState,
  useModelState,
  useSessionState,
} from "@/hooks/use-agent-state";
import { fetchHarnessInventoriesCached } from "@/lib/harness-inventory-cache";
import { DEFAULT_MODEL_MAX_AGE_MONTHS, MAX_RECENT_MODELS, STORAGE_KEYS } from "@/lib/constants";
import {
  ensureResourceCatalog,
  getCachedResourceBundle,
  makeCatalogKey,
} from "@/lib/resource-catalog-cache";
import {
  filterModelSearchCandidates,
  findExactModelReferenceMatch,
  normalizeModelQuery,
  type ModelSearchCandidate,
} from "@/lib/model-search";
import { storageGet, storageParsed, storageSetJSON } from "@/lib/safe-storage";
import { cn } from "@/lib/utils";
import { useOpenGuiClient } from "@/protocol/provider";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";
import type { HarnessInventory } from "@/types/electron";

type ModelOption = ModelSearchCandidate & {
  reasoning: boolean;
};

type ModelGroup = {
  id: string;
  name: string;
  models: ModelOption[];
};

function harnessInventoryHint(
  inventory: HarnessInventory | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!inventory?.installed) return "";
  if (inventory.status === "ready" && inventory.models.length > 0) {
    return t("modelSelector.harnessReady", { count: inventory.models.length });
  }
  return t("modelSelector.harnessCliFound");
}

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
  const { t } = useTranslation();
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
          title={isFavorite ? t("modelSelector.removeFavorite") : t("modelSelector.addFavorite")}
        >
          <Star className={cn("size-3", isFavorite && "fill-current")} />
        </button>
      </span>
    </div>
  );
}

export function ModelSelector() {
  const { t } = useTranslation();
  const client = useOpenGuiClient();
  const { setPromptBoxSelection } = useActions();
  const { providers: committedProviders, selectedModel } = useModelState();
  const { activeSessionId, sessions, activeTargetDirectory, activeTargetHarnessId } =
    useSessionState();
  const { activeWorkspace, activeWorkspaceId } = useConnectionState();
  const fallbackHarnessId = useCurrentHarnessId();
  const availableHarnessIds = useAvailableHarnessIds();
  const { route: selectedHarnessRoute } = useRoutedHarness();
  const lockedHarnessId = selectedHarnessRoute.locked ? selectedHarnessRoute.harnessId : null;

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const resolvedHarnessId = useMemo(
    () =>
      resolvePromptBoxHarnessId({
        activeSession,
        activeTargetHarnessId,
        fallbackHarnessId,
      }),
    [activeSession, activeTargetHarnessId, fallbackHarnessId],
  );

  const [open, setOpen] = useState(false);
  const [dialogHarnessId, setDialogHarnessId] = useState<HarnessId>(resolvedHarnessId);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [resolvedCatalogKey, setResolvedCatalogKey] = useState<string | null>(null);
  const [inventories, setInventories] = useState<HarnessInventory[]>([]);
  const [inventoriesReady, setInventoriesReady] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [recentValues, setRecentValues] = useState<string[]>([]);
  const [favoriteValues, setFavoriteValues] = useState<Set<string>>(new Set());
  const [modelMaxAgeMonths, setModelMaxAgeMonths] = useState(() => getStoredModelMaxAgeMonths());
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const catalogRequestRef = useRef(0);

  const inventoryView = useMemo(
    () =>
      createHarnessInventoryView({
        status: inventoriesReady ? "ready" : "loading",
        inventories,
        candidateHarnessIds: availableHarnessIds,
        lockedHarnessId,
      }),
    [availableHarnessIds, inventories, inventoriesReady, lockedHarnessId],
  );
  const inventoryByHarness = inventoryView.byHarnessId;

  const dialogCatalogTarget = useMemo(() => {
    const directory = activeTargetDirectory ?? getSessionDirectory(activeSession) ?? null;
    return {
      directory,
      workspaceId: activeWorkspaceId,
      baseUrl: activeWorkspace && !activeWorkspace.isLocal ? activeWorkspace.serverUrl : undefined,
      authToken:
        activeWorkspace && !activeWorkspace.isLocal ? activeWorkspace.authToken : undefined,
    };
  }, [activeSession, activeTargetDirectory, activeWorkspace, activeWorkspaceId]);

  const activeCatalogKey = useMemo(
    () =>
      makeCatalogKey({
        harnessId: dialogHarnessId,
        workspaceId: dialogCatalogTarget.workspaceId,
        directory: dialogCatalogTarget.directory,
        baseUrl: dialogCatalogTarget.baseUrl,
        authToken: dialogCatalogTarget.authToken,
      }),
    [dialogHarnessId, dialogCatalogTarget],
  );

  const catalogMatchesDialog = resolvedCatalogKey === activeCatalogKey;

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
    if (!open) return;
    let cancelled = false;
    void fetchHarnessInventoriesCached(client).then((rows) => {
      if (cancelled) return;
      setInventories(rows);
      setInventoriesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  const ensureCatalogForHarness = useCallback(
    async (harnessId: HarnessId) => {
      const key = makeCatalogKey({
        harnessId,
        workspaceId: dialogCatalogTarget.workspaceId,
        directory: dialogCatalogTarget.directory,
        baseUrl: dialogCatalogTarget.baseUrl,
        authToken: dialogCatalogTarget.authToken,
      });
      if (resolvedCatalogKey === key && getCachedResourceBundle(key)) {
        setCatalogLoading(false);
        return;
      }
      const cached = getCachedResourceBundle(key);
      if (cached) {
        setResolvedCatalogKey(key);
        setCatalogLoading(false);
        return;
      }
      const requestId = ++catalogRequestRef.current;
      setCatalogLoading(true);
      try {
        await ensureResourceCatalog({
          harnessId,
          target: {
            workspaceId: dialogCatalogTarget.workspaceId,
            directory: dialogCatalogTarget.directory,
            baseUrl: dialogCatalogTarget.baseUrl,
            authToken: dialogCatalogTarget.authToken,
          },
          loadResources: client.harnesses.loadResources.bind(client.harnesses),
        });
        if (requestId !== catalogRequestRef.current) return;
        setResolvedCatalogKey(key);
      } catch {
        if (requestId !== catalogRequestRef.current) return;
        setResolvedCatalogKey(key);
      } finally {
        if (requestId === catalogRequestRef.current) {
          setCatalogLoading(false);
        }
      }
    },
    [client, dialogCatalogTarget, resolvedCatalogKey],
  );

  const openDialog = useCallback(() => {
    const harnessId = lockedHarnessId ?? resolvedHarnessId;
    setDialogHarnessId(harnessId);
    setOpen(true);
  }, [lockedHarnessId, resolvedHarnessId]);

  useEffect(() => {
    const handler = () => openDialog();
    window.addEventListener("open-model-selector", handler);
    return () => window.removeEventListener("open-model-selector", handler);
  }, [openDialog]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, dialogHarnessId]);

  const catalogProviders = useMemo(() => {
    if (!open) return committedProviders;
    return getCachedResourceBundle(activeCatalogKey)?.providersData.providers ?? [];
  }, [open, activeCatalogKey, committedProviders, resolvedCatalogKey]);

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

    return catalogProviders
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
  }, [catalogProviders, selectedModel, favoriteValues, modelMaxAgeMonths]);

  const allModels = useMemo(() => groups.flatMap((group) => group.models), [groups]);

  const currentValue = selectedModel
    ? `${selectedModel.providerID}/${selectedModel.modelID}`
    : null;

  const currentModel = useMemo(
    () => (currentValue ? allModels.find((model) => model.value === currentValue) : null),
    [allModels, currentValue],
  );

  const triggerLabel = useMemo(() => {
    if (!selectedModel) {
      return t("modelSelector.chooseHarnessAndModel");
    }
    const harnessLabel = HARNESS_LABELS[resolvedHarnessId];
    const modelLabel =
      currentModel?.label ?? `${selectedModel.providerID}/${selectedModel.modelID}`;
    return `${harnessLabel} · ${modelLabel}`;
  }, [currentModel?.label, resolvedHarnessId, selectedModel, t]);

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
  }, [open, dialogHarnessId, visibleModels]);

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
    setCatalogLoading(false);
  };

  const handleMobileBackCloseModelSelector = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveValue(null);
    setCatalogLoading(false);
    return true;
  }, []);
  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.MODEL_SELECTOR,
    open,
    handleMobileBackCloseModelSelector,
  );

  const selectModel = (model: ModelOption) => {
    setPromptBoxSelection({
      harnessId: dialogHarnessId,
      model: { providerID: model.providerID, modelID: model.modelID },
    });
    setRecentValues((previous) => {
      const next = [model.value, ...previous.filter((v) => v !== model.value)];
      return next.slice(0, MAX_RECENT_MODELS);
    });
    closeSelector();
  };

  const onHarnessTabChange = (value: string | number | null) => {
    if (typeof value !== "string" || !HARNESS_IDS.includes(value as HarnessId)) return;
    const harnessId = value as HarnessId;
    setDialogHarnessId(harnessId);
    setQuery("");
    void ensureCatalogForHarness(harnessId);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      closeSelector();
      return;
    }
    openDialog();
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
  const showModelList = catalogMatchesDialog && !catalogLoading;
  const showEmptyHarness =
    catalogMatchesDialog && !catalogLoading && !hasResults && !normalizedQuery;
  const harnessRows = inventoryView.selectorHarnessIds;

  useEffect(() => {
    if (!open || harnessRows.length === 0) return;
    if (harnessRows.includes(dialogHarnessId)) return;
    const next =
      lockedHarnessId && harnessRows.includes(lockedHarnessId) ? lockedHarnessId : harnessRows[0];
    if (!next) return;
    setDialogHarnessId(next);
    void ensureCatalogForHarness(next);
  }, [open, harnessRows, dialogHarnessId, lockedHarnessId, ensureCatalogForHarness]);

  useEffect(() => {
    if (!open || !inventoriesReady || harnessRows.length === 0) return;
    if (!harnessRows.includes(dialogHarnessId)) return;
    void ensureCatalogForHarness(dialogHarnessId);
  }, [open, inventoriesReady, harnessRows, dialogHarnessId, ensureCatalogForHarness]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={t("modelSelector.dialogTitle")}
          className="!h-7 min-w-0 shrink gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={(event) => {
            event.preventDefault();
            openDialog();
          }}
        >
          {selectedModel && currentModel ? (
            <ProviderIcon provider={currentModel.providerID} className="size-3.5 shrink-0" />
          ) : (
            <BrainCircuit className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{triggerLabel}</span>
        </Button>
      </DialogTrigger>

      <DialogContent
        className="p-0 sm:max-w-2xl"
        finalFocus={() =>
          document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-box-textarea"]')
        }
      >
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-base">{t("modelSelector.dialogTitle")}</DialogTitle>
        </DialogHeader>

        {!inventoriesReady ? (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("modelSelector.checkingHarnesses")}
          </div>
        ) : harnessRows.length === 0 ? (
          <div className="space-y-2 px-4 pb-6 text-sm text-muted-foreground">
            <p>{t("modelSelector.noHarnessInstalled")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                closeSelector();
                window.dispatchEvent(new CustomEvent("opengui:open-settings"));
              }}
            >
              {t("modelSelector.openSettings")}
            </Button>
          </div>
        ) : (
          <Tabs value={dialogHarnessId} onValueChange={onHarnessTabChange} className="gap-3">
            <div className="px-4">
              <TabsList className="h-auto w-full flex-wrap justify-start gap-1 p-1">
                {harnessRows.map((harnessId) => {
                  const hint = harnessInventoryHint(inventoryByHarness.get(harnessId), t);
                  const disabled = Boolean(lockedHarnessId && lockedHarnessId !== harnessId);
                  return (
                    <TabsTrigger
                      key={harnessId}
                      value={harnessId}
                      disabled={disabled}
                      title={hint || HARNESS_LABELS[harnessId]}
                      className="min-w-0 flex-none px-3 py-1.5 text-xs"
                    >
                      {HARNESS_LABELS[harnessId]}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>

            {lockedHarnessId && (
              <p className="px-4 text-[11px] text-muted-foreground">
                {t("modelSelector.harnessLocked")}
              </p>
            )}

            <TabsContent value={dialogHarnessId} className="mt-0 outline-none">
              <div className="px-4 pb-3">
                <div className="relative">
                  <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={inputRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={handleInputKeyDown}
                    onFocus={(e) => e.target.select()}
                    placeholder={t("modelSelector.searchPlaceholder")}
                    className="h-8 pl-8 text-xs"
                    disabled={!showModelList && !normalizedQuery}
                  />
                </div>
              </div>

              <div className="max-h-[60vh] space-y-4 overflow-y-auto px-2 pb-4">
                {(catalogLoading || !catalogMatchesDialog) && (
                  <div className="flex items-center justify-center gap-2 px-2 py-8 text-xs text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {t("modelSelector.loadingCatalog")}
                  </div>
                )}

                {showEmptyHarness && (
                  <div className="space-y-2 px-2 py-4 text-xs text-muted-foreground">
                    <p>{t("modelSelector.noModelsForHarness")}</p>
                    <p>{t("modelSelector.noModelsForHarnessHint")}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        closeSelector();
                        window.dispatchEvent(new CustomEvent("opengui:open-settings"));
                      }}
                    >
                      {t("modelSelector.openSettings")}
                    </Button>
                  </div>
                )}

                {showModelList && !normalizedQuery && favoriteModels.length > 0 && (
                  <div className="space-y-1">
                    <div className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {t("modelSelector.favorites")}
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

                {showModelList && !normalizedQuery && recentModels.length > 0 && (
                  <div className="space-y-1">
                    <div className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {t("modelSelector.recent")}
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

                {showModelList && hasResults ? (
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
                ) : showModelList && normalizedQuery ? (
                  <div className="px-2 text-xs text-muted-foreground">
                    {t("modelSelector.noModelsMatch", { query: query.trim() })}
                  </div>
                ) : null}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
