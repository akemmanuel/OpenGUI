import { PanelRightIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFilesPanel } from "./files-panel-context";

const LazyFilesPanel = lazy(() =>
  import("./FilesPanel").then((module) => ({ default: module.FilesPanel })),
);

/** Fetch the browser and preview code only when the panel is opened. */
export function FilesPanelSlot() {
  const panel = useFilesPanel();
  return panel?.open ? (
    <Suspense fallback={null}>
      <LazyFilesPanel />
    </Suspense>
  ) : null;
}

/** Opens the panel; hidden while it is open or when there is no project. */
export function FilesPanelToggle() {
  const { t } = useTranslation();
  const panel = useFilesPanel();
  if (!panel?.root || panel.open) return null;
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const label = `${t("filesPanel.toggle")} (${modifier}Shift+E)`;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 bg-background/90 text-muted-foreground hover:text-foreground"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      title={label}
      aria-label={label}
      aria-expanded={panel.open}
      onClick={panel.toggle}
    >
      <PanelRightIcon />
    </Button>
  );
}
