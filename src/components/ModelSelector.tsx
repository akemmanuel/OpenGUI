import { BrainCircuit, Check, Lightbulb, Search } from "lucide-react";
import {
  type KeyboardEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
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
import { useActions, useModelState } from "@/hooks/use-agent-state";
import { MAX_RECENT_MODELS, STORAGE_KEYS } from "@/lib/constants";
import { storageParsed, storageSetJSON } from "@/lib/persistence/storage";
import { cn } from "@/lib/utils";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";

type ModelOption = {
  value: string;
  providerID: string;
  providerName: string;
  modelID: string;
  label: string;
  reasoning: boolean;
};

type ModelGroup = {
  id: string;
  name: string;
  models: ModelOption[];
};

function ModelRow({
  model,
  selected,
  active,
  showProvider,
  onSelect,
  onMouseEnter,
}: {
  model: ModelOption;
  selected: boolean;
  active: boolean;
  showProvider?: boolean;
  onSelect: (model: ModelOption) => void;
  onMouseEnter: (value: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      data-model-value={model.value}
      aria-pressed={selected}
      className={cn(
        "flex h-11 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none transition-colors sm:h-9",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
        selected && !active && "bg-accent/55 text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/60",
      )}
      title={`${model.providerName} · ${model.modelID}`}
      onClick={() => onSelect(model)}
      onMouseEnter={() => onMouseEnter(model.value)}
    >
      {showProvider && <ProviderIcon provider={model.providerID} className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate font-medium">{model.label}</span>
      {showProvider && (
        <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">
          {model.providerName}
        </span>
      )}
      {model.reasoning && (
        <Lightbulb
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label={t("reasoningEffort.label")}
        />
      )}
      <Check
        className={cn(
          "size-4 shrink-0 text-primary transition-opacity",
          selected ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

export function ModelSelector() {
  const { t } = useTranslation();
  const { setModel } = useActions();
  const { providers, selectedModel } = useModelState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentValues, setRecentValues] = useState<string[]>([]);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo<ModelGroup[]>(() => {
    const byProvider = new Map<string, ModelGroup>();
    for (const provider of providers) {
      const group = byProvider.get(provider.id) ?? {
        id: provider.id,
        name: provider.name,
        models: [],
      };
      const knownValues = new Set(group.models.map((model) => model.value));
      for (const [modelID, model] of Object.entries(provider.models)) {
        const value = `${provider.id}/${modelID}`;
        if (knownValues.has(value)) continue;
        group.models.push({
          value,
          providerID: provider.id,
          providerName: provider.name,
          modelID,
          label: model.name || modelID,
          reasoning: model.capabilities.reasoning,
        });
        knownValues.add(value);
      }
      byProvider.set(provider.id, group);
    }
    return [...byProvider.values()]
      .filter((group) => group.models.length > 0)
      .map((group) => ({
        ...group,
        models: group.models.sort((a, b) => a.label.localeCompare(b.label)),
      }));
  }, [providers]);
  const models = useMemo(() => groups.flatMap((group) => group.models), [groups]);
  const currentValue = selectedModel
    ? `${selectedModel.providerID}/${selectedModel.modelID}`
    : null;
  const currentModel = useMemo(
    () => models.find((model) => model.value === currentValue),
    [currentValue, models],
  );

  useEffect(() => {
    const stored = storageParsed<unknown[]>(STORAGE_KEYS.RECENT_MODELS);
    if (!Array.isArray(stored)) return;
    setRecentValues(stored.filter((value): value is string => typeof value === "string"));
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!normalizedQuery) return [];
    return models.filter((model) =>
      `${model.providerName} ${model.label} ${model.modelID}`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [models, normalizedQuery]);

  const recentModels = useMemo(() => {
    const byValue = new Map(models.map((model) => [model.value, model]));
    return recentValues
      .map((value) => byValue.get(value))
      .filter((model): model is ModelOption => Boolean(model))
      .slice(0, 4);
  }, [models, recentValues]);
  const recentSet = useMemo(
    () => new Set(recentModels.map((model) => model.value)),
    [recentModels],
  );
  const browseGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          models: group.models.filter((model) => !recentSet.has(model.value)),
        }))
        .filter((group) => group.models.length > 0),
    [groups, recentSet],
  );
  const visibleModels = useMemo(
    () =>
      normalizedQuery
        ? searchResults
        : [...recentModels, ...browseGroups.flatMap((group) => group.models)],
    [browseGroups, normalizedQuery, recentModels, searchResults],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveValue(null);
  }, []);

  const openSelector = useCallback(() => {
    setOpen(true);
    setActiveValue(currentValue);
  }, [currentValue]);

  useEffect(() => {
    const handler = () => openSelector();
    window.addEventListener("open-model-selector", handler);
    return () => window.removeEventListener("open-model-selector", handler);
  }, [openSelector]);

  useEffect(() => {
    if (!open || visibleModels.length === 0) return;
    setActiveValue((value) =>
      value && visibleModels.some((model) => model.value === value)
        ? value
        : (visibleModels[0]?.value ?? null),
    );
  }, [open, visibleModels]);

  useEffect(() => {
    if (!open || !activeValue) return;
    const frame = requestAnimationFrame(() => {
      const escaped = CSS.escape(activeValue);
      document
        .querySelector<HTMLElement>(`[data-model-value="${escaped}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeValue, open]);

  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.MODEL_SELECTOR,
    open,
    useCallback(() => {
      close();
      return true;
    }, [close]),
  );

  const selectModel = useCallback(
    (model: ModelOption) => {
      setModel({ providerID: model.providerID, modelID: model.modelID });
      setRecentValues((values) => {
        const next = [model.value, ...values.filter((value) => value !== model.value)].slice(
          0,
          MAX_RECENT_MODELS,
        );
        storageSetJSON(STORAGE_KEYS.RECENT_MODELS, next);
        return next;
      });
      close();
    },
    [close, setModel],
  );

  const moveActive = (direction: -1 | 1) => {
    if (visibleModels.length === 0) return;
    const index = activeValue
      ? visibleModels.findIndex((model) => model.value === activeValue)
      : -1;
    const nextIndex =
      index < 0
        ? direction === 1
          ? 0
          : visibleModels.length - 1
        : (index + direction + visibleModels.length) % visibleModels.length;
    setActiveValue(visibleModels[nextIndex]?.value ?? null);
  };

  const handleInputKeyDown: KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      const activeModel = visibleModels.find((model) => model.value === activeValue);
      if (!activeModel) return;
      event.preventDefault();
      selectModel(activeModel);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const triggerLabel = currentModel?.label ?? (selectedModel ? selectedModel.modelID : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) openSelector();
        else close();
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={
            currentModel
              ? `${t("modelSelector.dialogTitle")}: ${currentModel.providerName} · ${currentModel.label}`
              : t("modelSelector.dialogTitle")
          }
          className="!h-7 min-w-0 shrink gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {selectedModel ? (
            <ProviderIcon provider={selectedModel.providerID} className="size-3.5 shrink-0" />
          ) : (
            <BrainCircuit className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{triggerLabel ?? t("modelSelector.dialogTitle")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="grid max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-h-[min(38rem,80dvh)] sm:max-w-2xl"
        initialFocus={() => inputRef.current}
        finalFocus={() =>
          document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-box-textarea"]')
        }
      >
        <DialogHeader className="px-4 pt-4 pb-3">
          <DialogTitle className="text-base">{t("modelSelector.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <div className="border-y px-3 py-2.5 sm:px-4">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={t("modelSelector.searchPlaceholder")}
              className="h-9 pl-8"
            />
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto p-2">
          {normalizedQuery ? (
            searchResults.length > 0 ? (
              <div>
                {searchResults.map((model) => (
                  <ModelRow
                    key={model.value}
                    model={model}
                    selected={model.value === currentValue}
                    active={model.value === activeValue}
                    showProvider
                    onSelect={selectModel}
                    onMouseEnter={setActiveValue}
                  />
                ))}
              </div>
            ) : (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {t("modelSelector.noModelsMatch", { query: query.trim() })}
              </p>
            )
          ) : (
            <div className="space-y-3">
              {visibleModels.length === 0 && (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("modelSelector.noModelsAvailable")}
                </p>
              )}
              {recentModels.length > 0 && (
                <section>
                  <h3 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
                    {t("modelSelector.recent")}
                  </h3>
                  {recentModels.map((model) => (
                    <ModelRow
                      key={`recent-${model.value}`}
                      model={model}
                      selected={model.value === currentValue}
                      active={model.value === activeValue}
                      showProvider
                      onSelect={selectModel}
                      onMouseEnter={setActiveValue}
                    />
                  ))}
                </section>
              )}
              {browseGroups.map((group) => (
                <section key={group.id}>
                  <h3 className="sticky top-0 z-10 flex items-center gap-1.5 bg-popover px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    <ProviderIcon provider={group.id} className="size-3.5 shrink-0" />
                    <span className="truncate">{group.name}</span>
                  </h3>
                  {group.models.map((model) => (
                    <ModelRow
                      key={model.value}
                      model={model}
                      selected={model.value === currentValue}
                      active={model.value === activeValue}
                      onSelect={selectModel}
                      onMouseEnter={setActiveValue}
                    />
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
