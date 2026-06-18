import type { Workspace } from "@/types/electron";

/** True when the user has a workspace selected and can attach project directories to it. */
export function canManageProjects(
  workspaces: Workspace[],
  activeWorkspaceId: string,
  activeWorkspace: Workspace | null | undefined,
): boolean {
  if (workspaces.length === 0) return false;
  if (!activeWorkspace) return false;
  if (!activeWorkspaceId) return false;
  return workspaces.some((workspace) => workspace.id === activeWorkspaceId);
}

export function openAddWorkspaceDialog() {
  window.dispatchEvent(
    new CustomEvent("opengui:open-workspace-dialog", { detail: { mode: "add" as const } }),
  );
}
