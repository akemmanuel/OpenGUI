/**
 * Harness → Provider → Model selection dialog (PromptBox affordance).
 */

import { BrainCircuit } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HARNESS_IDS, HARNESS_LABELS, type HarnessId } from "@/agents";
import { ModelSelectorContent } from "@/components/ModelSelectorContent";
import type { ModelOption } from "@/components/model-selector-groups";
import { ProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createHarnessInventoryView } from "@/hooks/harness-inventory-view";
import { resolvePromptBoxHarnessId } from "@/hooks/prompt-box-selection";
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
import { useModelSelectorCatalogEffects } from "@/hooks/useModelSelectorCatalogEffects";
import { useModelSelectorInventories } from "@/hooks/useModelSelectorInventories";
import { useModelSelectorListState } from "@/hooks/useModelSelectorListState";
import { useModelSelectorPreferences } from "@/hooks/useModelSelectorPreferences";
import {
  resolveModelSelectorCatalogTarget,
  useModelSelectorCatalog,
} from "@/hooks/useModelSelectorCatalog";
import { useOpenGuiClient } from "@/protocol/provider";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";

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
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const { recentValues, favoriteValues, modelMaxAgeMonths, recordRecentSelection, toggleFavorite } =
    useModelSelectorPreferences();
  const { inventories, inventoriesReady } = useModelSelectorInventories(open, client);

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

  const catalogTarget = useMemo(
    () =>
      resolveModelSelectorCatalogTarget({
        activeSession,
        activeTargetDirectory,
        activeWorkspace,
        activeWorkspaceId,
      }),
    [activeSession, activeTargetDirectory, activeWorkspace, activeWorkspaceId],
  );

  const {
    catalogReady,
    catalogLoading,
    catalogTerminal,
    catalogProviders,
    ensureCatalogForHarness,
  } = useModelSelectorCatalog({
    open,
    dialogHarnessId,
    client,
    catalogTarget,
    committedProviders,
  });

  const harnessRows = inventoryView.selectorHarnessIds;

  useModelSelectorCatalogEffects({
    open,
    inventoriesReady,
    harnessRows,
    dialogHarnessId,
    lockedHarnessId,
    ensureCatalogForHarness,
    setDialogHarnessId,
  });

  const currentValue = selectedModel
    ? `${selectedModel.providerID}/${selectedModel.modelID}`
    : null;

  const closeSelector = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const selectModel = useCallback(
    (model: ModelOption) => {
      setPromptBoxSelection({
        harnessId: dialogHarnessId,
        model: { providerID: model.providerID, modelID: model.modelID },
      });
      recordRecentSelection(model.value);
      closeSelector();
    },
    [closeSelector, dialogHarnessId, recordRecentSelection, setPromptBoxSelection],
  );

  const {
    normalizedQuery,
    allModels,
    favoriteModels,
    recentModels,
    filteredGroups,
    activeValue,
    setActiveValue,
    handleInputKeyDown,
    hasResults,
  } = useModelSelectorListState({
    open,
    dialogHarnessId,
    query,
    catalogProviders,
    selectedModelValue: currentValue,
    favoriteValues,
    recentValues,
    modelMaxAgeMonths,
    onSelectModel: selectModel,
    onClose: closeSelector,
  });

  const closeSelectorWithActiveReset = useCallback(() => {
    setActiveValue(null);
    closeSelector();
  }, [closeSelector, setActiveValue]);

  const currentModel = useMemo(
    () => (currentValue ? allModels.find((model) => model.value === currentValue) : null),
    [allModels, currentValue],
  );

  const triggerLabel = useMemo(() => {
    if (!selectedModel) return t("modelSelector.chooseHarnessAndModel");
    const harnessLabel = HARNESS_LABELS[resolvedHarnessId];
    const modelLabel =
      currentModel?.label ?? `${selectedModel.providerID}/${selectedModel.modelID}`;
    return `${harnessLabel} · ${modelLabel}`;
  }, [currentModel?.label, resolvedHarnessId, selectedModel, t]);

  const openDialog = useCallback(() => {
    setDialogHarnessId(lockedHarnessId ?? resolvedHarnessId);
    setOpen(true);
  }, [lockedHarnessId, resolvedHarnessId]);

  useEffect(() => {
    const handler = () => openDialog();
    window.addEventListener("open-model-selector", handler);
    return () => window.removeEventListener("open-model-selector", handler);
  }, [openDialog]);

  const focusHarnessTabInDialog = useCallback(() => {
    const root = document.querySelector('[data-slot="dialog-content"]');
    if (!root) return null;
    return (
      root.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-active]') ??
      root.querySelector<HTMLElement>('[data-slot="tabs-trigger"]')
    );
  }, []);

  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.MODEL_SELECTOR,
    open,
    useCallback(() => {
      closeSelectorWithActiveReset();
      return true;
    }, [closeSelectorWithActiveReset]),
  );

  const onHarnessTabChange = (value: string | number | null) => {
    if (typeof value !== "string" || !HARNESS_IDS.includes(value as HarnessId)) return;
    setDialogHarnessId(value as HarnessId);
    setQuery("");
    void ensureCatalogForHarness(value as HarnessId);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      closeSelectorWithActiveReset();
      return;
    }
    openDialog();
  };

  const showModelList = catalogReady && !catalogLoading;
  const showEmptyHarness = catalogTerminal && !catalogLoading && !hasResults && !normalizedQuery;

  useEffect(() => {
    if (!open || !inventoriesReady || harnessRows.length === 0) return;
    const frame = requestAnimationFrame(() => focusHarnessTabInDialog()?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, inventoriesReady, harnessRows.length, dialogHarnessId, focusHarnessTabInDialog]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={t("modelSelector.dialogTitle")}
          className="!h-7 min-w-0 shrink gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
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
        initialFocus={() => focusHarnessTabInDialog() ?? inputRef.current}
        finalFocus={() =>
          document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-box-textarea"]')
        }
      >
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-base">{t("modelSelector.dialogTitle")}</DialogTitle>
        </DialogHeader>

        <ModelSelectorContent
          inventoriesReady={inventoriesReady}
          harnessRows={harnessRows}
          inventoryView={inventoryView}
          lockedHarnessId={lockedHarnessId}
          dialogHarnessId={dialogHarnessId}
          onHarnessTabChange={onHarnessTabChange}
          query={query}
          setQuery={setQuery}
          inputRef={inputRef}
          handleInputKeyDown={handleInputKeyDown}
          catalogLoading={catalogLoading}
          catalogTerminal={catalogTerminal}
          showModelList={showModelList}
          showEmptyHarness={showEmptyHarness}
          normalizedQuery={normalizedQuery}
          favoriteModels={favoriteModels}
          recentModels={recentModels}
          filteredGroups={filteredGroups}
          hasResults={hasResults}
          currentValue={currentValue}
          activeValue={activeValue}
          setActiveValue={setActiveValue}
          favoriteValues={favoriteValues}
          selectModel={selectModel}
          toggleFavorite={toggleFavorite}
          closeSelector={closeSelectorWithActiveReset}
        />
      </DialogContent>
    </Dialog>
  );
}
