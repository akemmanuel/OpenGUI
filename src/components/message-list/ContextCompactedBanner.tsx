import { Layers } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ContextCompactedBanner() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 mb-2 select-none">
      <div className="flex-1 h-px bg-amber-500/30" />
      <div className="flex items-center gap-1.5 text-[11px] text-amber-500/80 font-mono">
        <Layers className="size-3" />
        <span>{t("messageActions.contextCompacted")}</span>
      </div>
      <div className="flex-1 h-px bg-amber-500/30" />
    </div>
  );
}
