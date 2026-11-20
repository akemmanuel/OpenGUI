import { MessagesSquare, PanelLeftIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useActions, useWorkspaceState } from "@/hooks/use-agent-state";
import { WindowControls } from "@/components/title-bar/WindowControls";
import { WorkspaceDialog } from "@/components/title-bar/WorkspaceDialog";
import { useWindowChrome } from "@/components/title-bar/use-window-chrome";

export function TitleBar({
  onToggleLeftSidebar,
  leadingControlBelow = false,
  trailingControl,
  chatContext,
}: {
  onToggleLeftSidebar?: () => void;
  /** The view puts its own control in the top-left corner, where the web trigger would float. */
  leadingControlBelow?: boolean;
  trailingControl?: ReactNode;
  chatContext?: { title: string; project?: string };
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
      {/* The desktop drag strip also holds native window controls. */}
      {isWebRuntime ? (
        <div
          aria-hidden="true"
          className={
            chatContext
              ? "h-[calc(var(--app-safe-top)+3rem)] shrink-0 border-b bg-background"
              : "h-[var(--app-safe-top)] shrink-0"
          }
        />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: Native title bars maximize on double-click.
        <div
          data-slot="window-drag-strip"
          aria-hidden="true"
          className={`h-9 shrink-0 select-none ${chatContext ? "border-b bg-background" : ""}`}
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          onDoubleClick={() => void shell.window.maximize()}
        />
      )}
      {chatContext && (
        <div
          className={cn(
            "pointer-events-none absolute flex min-w-0 gap-x-2 text-xs",
            onToggleLeftSidebar ? "left-14" : "left-4",
            isWebRuntime
              ? "right-14 top-[var(--app-safe-top)] h-12 flex-col justify-center sm:flex-row sm:items-center sm:justify-start"
              : "right-48 top-0 h-9 items-center",
          )}
        >
          <span
            className="truncate text-sm font-semibold"
            title={chatContext.title}
            data-responsive-allow="text-clip"
          >
            {chatContext.title}
          </span>
          {chatContext.project && chatContext.project !== chatContext.title && (
            <>
              <span className="hidden text-muted-foreground sm:inline" aria-hidden="true">
                /
              </span>
              <span
                className="shrink-0 truncate text-xs text-muted-foreground sm:max-w-[42%] max-sm:max-w-full"
                title={chatContext.project}
                data-responsive-allow="text-clip"
              >
                {chatContext.project}
              </span>
            </>
          )}
        </div>
      )}
      {onToggleLeftSidebar && !(isWebRuntime && leadingControlBelow) && (
        <Button
          data-sidebar="trigger"
          data-slot="sidebar-trigger"
          variant="ghost"
          size="icon"
          className={`absolute left-2 z-30 size-8 max-md:size-11 bg-background/90 text-muted-foreground hover:text-foreground ${isWebRuntime ? "top-[calc(var(--app-safe-top)+0.25rem)]" : "top-0.5"}`}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={`${t("workspace.toggleSidebar")} (Ctrl+B)`}
          onClick={onToggleLeftSidebar}
        >
          <PanelLeftIcon className="hidden md:block" />
          <MessagesSquare className="md:hidden" />
          <span className="sr-only">{t("workspace.toggleSidebar")}</span>
        </Button>
      )}
      <div
        className={`pointer-events-none absolute z-30 flex items-center [&>*]:pointer-events-auto ${isWebRuntime ? "right-2 top-[calc(var(--app-safe-top)+0.25rem)]" : "right-0 top-0 h-9"}`}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {trailingControl}
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
