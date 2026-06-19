import { GitFork, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export function MessageBubbleActions({
  onFork,
  onRevert,
}: {
  onFork?: () => void;
  onRevert?: () => void;
}) {
  const { t } = useTranslation();
  if (!onFork && !onRevert) return null;

  return (
    <div className="absolute -left-9 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {onRevert && (
        <button
          type="button"
          onClick={onRevert}
          title={t("messageActions.revertToMessage")}
          className="p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <Undo2 className="size-3.5" />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          onClick={onFork}
          title={t("messageActions.forkFromMessage")}
          className="p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <GitFork className="size-3.5" />
        </button>
      )}
    </div>
  );
}
