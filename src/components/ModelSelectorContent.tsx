import { Loader2, Search } from "lucide-react";
import type { KeyboardEventHandler, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { HARNESS_LABELS, type HarnessId } from "@/agents";
import { ModelSelectorRow } from "@/components/ModelSelectorRow";
import type { ModelGroup, ModelOption } from "@/components/model-selector-groups";
import { ProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { HarnessInventoryView } from "@/hooks/harness-inventory-view";
import type { HarnessInventory } from "@/types/electron";

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

export function ModelSelectorContent({
  inventoriesReady,
  harnessRows,
  inventoryView,
  lockedHarnessId,
  dialogHarnessId,
  onHarnessTabChange,
  query,
  setQuery,
  inputRef,
  handleInputKeyDown,
  catalogLoading,
  catalogTerminal,
  showModelList,
  showEmptyHarness,
  normalizedQuery,
  favoriteModels,
  recentModels,
  filteredGroups,
  hasResults,
  currentValue,
  activeValue,
  setActiveValue,
  favoriteValues,
  selectModel,
  toggleFavorite,
  closeSelector,
}: {
  inventoriesReady: boolean;
  harnessRows: HarnessId[];
  inventoryView: HarnessInventoryView;
  lockedHarnessId: HarnessId | null;
  dialogHarnessId: HarnessId;
  onHarnessTabChange: (value: string | number | null) => void;
  query: string;
  setQuery: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  handleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  catalogLoading: boolean;
  catalogTerminal: boolean;
  showModelList: boolean;
  showEmptyHarness: boolean;
  normalizedQuery: string;
  favoriteModels: ModelOption[];
  recentModels: ModelOption[];
  filteredGroups: ModelGroup[];
  hasResults: boolean;
  currentValue: string | null;
  activeValue: string | null;
  setActiveValue: (value: string | null) => void;
  favoriteValues: ReadonlySet<string>;
  selectModel: (model: ModelOption) => void;
  toggleFavorite: (value: string) => void;
  closeSelector: () => void;
}) {
  const { t } = useTranslation();
  const inventoryByHarness = inventoryView.byHarnessId;

  if (!inventoriesReady) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("modelSelector.checkingHarnesses")}
      </div>
    );
  }

  if (harnessRows.length === 0) {
    return (
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
    );
  }

  return (
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
        <p className="px-4 text-[11px] text-muted-foreground">{t("modelSelector.harnessLocked")}</p>
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
          {(catalogLoading || !catalogTerminal) && (
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
                <ModelSelectorRow
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
                <ModelSelectorRow
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
                  <ModelSelectorRow
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
  );
}
