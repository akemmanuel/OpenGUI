import { PanelLeftIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useActions, useWorkspaceState } from "@/hooks/use-agent-state";
import { WindowControls } from "@/components/title-bar/WindowControls";
import { WorkspaceDialog } from "@/components/title-bar/WorkspaceDialog";
import { useWindowChrome } from "@/components/title-bar/use-window-chrome";

export function TitleBar({
  onToggleLeftSidebar,
  leadingControlBelow = false,
}: {
  onToggleLeftSidebar?: () => void;
  /** The view puts its own control in the top-left corner, where the web trigger would float. */
  leadingControlBelow?: boolean;
}) {
  const { t } = useTranslation();
  const { createWorkspace, removeWorkspace, updateWorkspace } = useActions();
  const { activeWorkspaceId, supportsMultipleWorkspaces, workspaces } = useWorkspaceState();
  const { shell, platform, isMac, isWebRuntime, isMaximized } = useWindowChrome();
  const [dialogMode, setDialogMode] = useState<"add" | "edit" | null>(null);
  const canManageWorkspaces = supportsMultipleWorkspaces;

  useEffect(() => {
    const openDialog = (event: Event) => {
      if (!canManageWorkspaces) return;
      setDialogMode((event as CustomEvent<{ mode?: "add" | "edit" }>).detail?.mode ?? "add");
    };
    window.addEventListener("opengui:open-workspace-dialog", openDialog);
    return () => window.removeEventListener("opengui:open-workspace-dialog", openDialog);
  }, [canManageWorkspaces]);

  const editingWorkspace = useMemo(
    () => workspaces.find(({ id }) => id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );
  if (!platform) return null;

  const dialogInitial =
    dialogMode === "edit" && editingWorkspace
      ? {
          name: editingWorkspace.name,
          serverUrl: editingWorkspace.serverUrl,
          authToken: editingWorkspace.authToken ?? "",
          isLocal: editingWorkspace.isLocal,
        }
      : { name: "", serverUrl: "https://", authToken: "", isLocal: false };

  return (
    <>
      {/* No bar. Web only reserves the safe area; the frameless desktop window keeps a borderless
          drag strip that also holds the window controls. */}
      {isWebRuntime ? (
        <div aria-hidden="true" className="h-[var(--app-safe-top)] shrink-0" />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: Native title bars maximize on double-click.
        <div
          data-slot="window-drag-strip"
          aria-hidden="true"
          className="h-9 shrink-0 select-none"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          onDoubleClick={() => void shell.window.maximize()}
        />
      )}
      {onToggleLeftSidebar && !(isWebRuntime && leadingControlBelow) && (
        <Button
          data-sidebar="trigger"
          data-slot="sidebar-trigger"
          variant="ghost"
          size="icon"
          className="absolute left-2 top-[calc(var(--app-safe-top)+0.25rem)] z-30 size-8 bg-background/90 text-muted-foreground hover:text-foreground"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={`${t("workspace.toggleSidebar")} (Ctrl+B)`}
          onClick={onToggleLeftSidebar}
        >
          <PanelLeftIcon />
          <span className="sr-only">{t("workspace.toggleSidebar")}</span>
        </Button>
      )}
      {!isWebRuntime && (
        <div className="absolute right-0 top-0 z-30 h-9">
          <WindowControls isMac={isMac} isMaximized={isMaximized} window={shell.window} />
        </div>
      )}
      <WorkspaceDialog
        open={canManageWorkspaces && dialogMode !== null}
        onOpenChange={(open) => {
          if (!open) setDialogMode(null);
        }}
        mode={dialogMode ?? "add"}
        initial={dialogInitial}
        onSubmit={(data) => {
          if (dialogMode === "add") createWorkspace(data);
          else if (editingWorkspace) updateWorkspace(editingWorkspace.id, data);
        }}
        onRemove={editingWorkspace ? () => void removeWorkspace(editingWorkspace.id) : undefined}
      />
    </>
  );
}
