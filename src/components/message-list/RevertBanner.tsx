import { Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export function RevertBanner({
  revertedCount,
  onRestore,
}: {
  revertedCount: number;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 mt-4 select-none">
      <div className="flex-1 h-px bg-orange-500/30" />
      <div className="flex items-center gap-2 text-[11px] text-orange-500/80 font-mono">
        <Undo2 className="size-3" />
        <span>{t("revertBanner.reverted", { count: revertedCount })}</span>
        <span className="text-orange-500/50">|</span>
        <button
          type="button"
          onClick={onRestore}
          className="hover:text-orange-500 transition-colors cursor-pointer"
        >
          {t("revertBanner.restore")}
        </button>
      </div>
      <div className="flex-1 h-px bg-orange-500/30" />
    </div>
  );
}
