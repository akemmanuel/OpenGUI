import { Minimize, Minus, Plus, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

function WindowButton({
  icon,
  onClick,
  isClose = false,
  kind = "default",
  macTone = "minimize",
  label,
}: {
  icon: ReactNode;
  onClick: () => void;
  isClose?: boolean;
  kind?: "default" | "mac";
  macTone?: "close" | "minimize" | "maximize";
  label: string;
}) {
  if (kind === "mac") {
    const colors =
      macTone === "close"
        ? "bg-[#ff5f57] border-[#e14640]"
        : macTone === "maximize"
          ? "bg-[#28c840] border-[#1fa533]"
          : "bg-[#ffbd2e] border-[#df9e1b]";
    return (
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`group relative size-3 rounded-full border transition-opacity hover:opacity-95 active:opacity-80 ${colors}`}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <span className="absolute inset-0 flex items-center justify-center text-black/70 opacity-0 transition-opacity group-hover:opacity-100">
          {icon}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`w-12 h-9 flex items-center justify-center text-muted-foreground hover:bg-accent active:bg-accent/80 transition-colors ${isClose ? "hover:!bg-red-600 hover:!text-white" : "hover:text-foreground"}`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {icon}
    </button>
  );
}

export function WindowControls({
  isMac,
  isMaximized,
  window: shellWindow,
}: {
  isMac: boolean;
  isMaximized: boolean;
  window: { minimize: () => void; maximize: () => void; close: () => void };
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`absolute right-0 top-0 h-full flex items-center gap-2 ${isMac ? "px-2" : "pl-2"}`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {isMac ? (
        <div className="flex items-center gap-2">
          <WindowButton
            icon={<Plus className="size-2" strokeWidth={2.75} />}
            label={t("windowControls.maximize")}
            onClick={shellWindow.maximize}
            kind="mac"
            macTone="maximize"
          />
          <WindowButton
            icon={<Minus className="size-2" strokeWidth={2.75} />}
            label={t("windowControls.minimize")}
            onClick={shellWindow.minimize}
            kind="mac"
          />
          <WindowButton
            icon={<X className="size-2" strokeWidth={2.75} />}
            label={t("windowControls.close")}
            onClick={shellWindow.close}
            kind="mac"
            macTone="close"
            isClose
          />
        </div>
      ) : (
        <div className="flex items-center">
          <WindowButton
            label={t("windowControls.minimize")}
            icon={<Minus className="size-4" />}
            onClick={shellWindow.minimize}
          />
          <WindowButton
            label={t(isMaximized ? "windowControls.restore" : "windowControls.maximize")}
            icon={isMaximized ? <Minimize className="size-4" /> : <Square className="size-4" />}
            onClick={shellWindow.maximize}
          />
          <WindowButton
            label={t("windowControls.close")}
            icon={<X className="size-4" />}
            onClick={shellWindow.close}
            isClose
          />
        </div>
      )}
    </div>
  );
}
