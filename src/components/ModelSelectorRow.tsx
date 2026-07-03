import { Check, Lightbulb, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "@/components/provider-icons";
import { cn } from "@/lib/utils";
import type { ModelOption } from "@/components/model-selector-groups";

export function ModelSelectorRow({
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
