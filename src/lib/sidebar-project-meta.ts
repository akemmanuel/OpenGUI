import { makeProjectKey } from "@/hooks/agent-session-utils";
export interface SidebarProjectMetaLike {
  pinnedAt?: string | null;
  hidden?: boolean | null;
}
export type SidebarProjectMetaMapLike = Record<string, SidebarProjectMetaLike | undefined>;

/**
 * Sidebar project metadata is persisted by workspace-scoped project key.
 * Components should never index ProjectMetaMap by bare directory paths.
 */
export function getSidebarProjectMeta(
  projectMeta: SidebarProjectMetaMapLike,
  workspaceId: string | null | undefined,
  directory: string,
): SidebarProjectMetaLike | undefined {
  return projectMeta[makeProjectKey(workspaceId, directory)];
}

export function isSidebarProjectPinned(
  projectMeta: SidebarProjectMetaMapLike,
  workspaceId: string | null | undefined,
  directory: string,
): boolean {
  return !!getSidebarProjectMeta(projectMeta, workspaceId, directory)?.pinnedAt;
}

export function isSidebarProjectHidden(
  projectMeta: SidebarProjectMetaMapLike,
  workspaceId: string | null | undefined,
  directory: string,
): boolean {
  return getSidebarProjectMeta(projectMeta, workspaceId, directory)?.hidden === true;
}
