import { BrainCircuit, Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useActions, useModelState } from "@/hooks/use-agent-state";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";

export function ModelSelector() {
  const { t } = useTranslation();
  const { setModel } = useActions();
  const { providers, selectedModel } = useModelState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const models = useMemo(
    () =>
      providers.flatMap((provider) =>
        Object.entries(provider.models).map(([modelID, model]) => ({
          providerID: provider.id,
          providerName: provider.name,
          modelID,
          label: model.name || modelID,
        })),
      ),
    [providers],
  );
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return models;
    return models.filter((model) =>
      `${model.providerName} ${model.label} ${model.modelID}`.toLowerCase().includes(normalized),
    );
  }, [models, query]);

  const triggerLabel = selectedModel
    ? `${selectedModel.providerID}/${selectedModel.modelID}`
    : t("modelSelector.dialogTitle");

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("open-model-selector", handler);
    return () => window.removeEventListener("open-model-selector", handler);
  }, []);

  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.MODEL_SELECTOR,
    open,
    useCallback(() => {
      close();
      return true;
    }, [close]),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={t("modelSelector.dialogTitle")}
          className="!h-7 min-w-0 shrink gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {selectedModel ? (
            <ProviderIcon provider={selectedModel.providerID} className="size-3.5 shrink-0" />
          ) : (
            <BrainCircuit className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{triggerLabel}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="p-0 sm:max-w-2xl">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-base">{t("modelSelector.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <div className="border-y px-4 py-3">
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("modelSelector.searchPlaceholder")}
            autoFocus
          />
        </div>
        <div className="max-h-[min(28rem,60vh)] overflow-y-auto p-2">
          {filteredModels.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {t("modelSelector.noModelsMatch", { query })}
            </p>
          ) : (
            filteredModels.map((model) => {
              const selected =
                selectedModel?.providerID === model.providerID &&
                selectedModel.modelID === model.modelID;
              return (
                <button
                  key={`${model.providerID}/${model.modelID}`}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    setModel({ providerID: model.providerID, modelID: model.modelID });
                    close();
                  }}
                >
                  <ProviderIcon provider={model.providerID} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{model.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {model.providerName}
                    </span>
                  </span>
                  {selected && <Check className="size-4 shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
