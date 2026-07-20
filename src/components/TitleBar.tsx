import { PanelLeftIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useActions, useWorkspaceState } from "@/hooks/use-agent-state";
import { WindowControls } from "@/components/title-bar/WindowControls";
import { WorkspaceDialog } from "@/components/title-bar/WorkspaceDialog";
import { WorkspaceTabs } from "@/components/title-bar/WorkspaceTabs";
import { useWindowChrome } from "@/components/title-bar/use-window-chrome";

export function TitleBar({ onToggleLeftSidebar }: { onToggleLeftSidebar?: () => void }) {
  const { t } = useTranslation();
  const { createWorkspace, removeWorkspace, switchWorkspace, updateWorkspace, reorderWorkspaces } =
    useActions();
  const { activeWorkspaceId, supportsMultipleWorkspaces, workspaceStatuses, workspaces } =
    useWorkspaceState();
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Native title bars maximize on double-click. */}
      <div
        className="relative z-20 app-safe-top-bar bg-sidebar border-b border-border select-none shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        onDoubleClick={() => {
          if (!isWebRuntime) void shell.window.maximize();
        }}
      >
        <div
          className="absolute left-0 top-[var(--app-safe-top)] h-9 flex items-center px-2"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {onToggleLeftSidebar && (
            <Button
              data-sidebar="trigger"
              data-slot="sidebar-trigger"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onToggleLeftSidebar}
            >
              <PanelLeftIcon />
              <span className="sr-only">{t("workspace.toggleSidebar")}</span>
            </Button>
          )}
        </div>
        <WorkspaceTabs
          workspaces={workspaces}
          workspaceStatuses={workspaceStatuses}
          activeWorkspaceId={activeWorkspaceId}
          canManage={canManageWorkspaces}
          visible={supportsMultipleWorkspaces && workspaces.length > 0}
          isMac={isMac}
          isWebRuntime={isWebRuntime}
          onSwitch={switchWorkspace}
          onReorder={reorderWorkspaces}
          onAdd={() => setDialogMode("add")}
          onEdit={() => setDialogMode("edit")}
        />
        {!isWebRuntime && (
          <WindowControls isMac={isMac} isMaximized={isMaximized} window={shell.window} />
        )}
      </div>
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
