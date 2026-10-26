import { AlertCircle, ChevronDown, Loader2, Pencil, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActions, useWorkspaceState } from "@/hooks/use-agent-state";
import { openAddWorkspaceDialog, openEditWorkspaceDialog } from "@/hooks/workspace-guards";

type WorkspaceStatus =
  | { busy?: boolean; error?: unknown; needsAttention?: boolean; connected?: boolean }
  | undefined;

function StatusMark({ status }: { status: WorkspaceStatus }) {
  if (status?.busy) return <Loader2 className="size-3 animate-spin text-muted-foreground" />;
  if (status?.error) return <AlertCircle className="size-3 text-destructive" />;
  if (status?.needsAttention) return <span className="size-2 rounded-full bg-amber-500" />;
  if (status?.connected) return <span className="size-2 rounded-full bg-emerald-500" />;
  return <span className="size-2 rounded-full border border-muted-foreground/60" />;
}

/** Desktop switches between Hosts from the sidebar header instead of a title bar tab strip. */
export function WorkspaceSwitcher() {
  const { t } = useTranslation();
  const { switchWorkspace } = useActions();
  const { activeWorkspaceId, supportsMultipleWorkspaces, workspaceStatuses, workspaces } =
    useWorkspaceState();
  if (!supportsMultipleWorkspaces) return null;

  const active = workspaces.find(({ id }) => id === activeWorkspaceId) ?? null;
  if (!active) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        onClick={openAddWorkspaceDialog}
      >
        <Plus className="size-3.5" />
        {t("workspace.addWorkspace")}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("workspace.switchWorkspace")}
          title={t("workspace.switchWorkspace")}
          className="h-7 min-w-0 max-w-44 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <StatusMark status={workspaceStatuses[active.id]} />
          <span className="min-w-0 truncate">{active.name}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-56 max-w-72">
        <DropdownMenuRadioGroup
          value={active.id}
          onValueChange={(id) => switchWorkspace(String(id))}
        >
          {workspaces.map((workspace) => (
            <DropdownMenuRadioItem
              key={workspace.id}
              value={workspace.id}
              closeOnClick
              className="h-8"
            >
              <span className="flex size-3.5 items-center justify-center">
                <StatusMark status={workspaceStatuses[workspace.id]} />
              </span>
              <span className="min-w-0 truncate">{workspace.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="h-8" onClick={openEditWorkspaceDialog}>
          <Pencil className="text-muted-foreground" />
          {t("workspace.editTitle")}
        </DropdownMenuItem>
        <DropdownMenuItem className="h-8" onClick={openAddWorkspaceDialog}>
          <Plus className="text-muted-foreground" />
          {t("workspace.addWorkspace")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
