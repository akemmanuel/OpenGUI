import type { Session, InternalAgentState } from "@/hooks/agent-state-types";
import { getSessionWorkspaceId, parseProjectKey } from "@/hooks/agent-session-utils";
import { normalizeProjectPath } from "@/lib/utils";
import type { Workspace } from "@/types/electron";

export function buildActiveWorkspaceProjectSet({
  activeWorkspace,
  projectWorkspaceMap,
}: {
  activeWorkspace: Workspace | null | undefined;
  projectWorkspaceMap: InternalAgentState["projectWorkspaceMap"];
}): Set<string> {
  const directories = new Set<string>();
  if (!activeWorkspace) return directories;
  for (const project of activeWorkspace.projects) {
    const normalized = normalizeProjectPath(project);
    if (normalized) directories.add(normalized);
  }
  for (const [projectKey, workspaceIds] of Object.entries(projectWorkspaceMap)) {
    if (workspaceIds?.has(activeWorkspace.id)) {
      const normalized = normalizeProjectPath(parseProjectKey(projectKey).directory);
      if (normalized) directories.add(normalized);
    }
  }
  return directories;
}

export function filterActiveWorkspaceSessions({
  sessions,
  sessionMeta,
  activeWorkspace,
  activeWorkspaceProjectSet,
}: {
  sessions: Session[];
  sessionMeta: InternalAgentState["sessionMeta"];
  activeWorkspace: Workspace | null | undefined;
  activeWorkspaceProjectSet: Set<string>;
}): Session[] {
  if (!activeWorkspace) return [];
  return sessions.filter((session) => {
    const assignedProjectDir = normalizeProjectPath(
      sessionMeta[session.id]?.assignedProjectDir ?? "",
    );
    if (assignedProjectDir && activeWorkspaceProjectSet.has(assignedProjectDir)) {
      return true;
    }
    const sessionWorkspaceId = getSessionWorkspaceId(session);
    if (sessionWorkspaceId) return sessionWorkspaceId === activeWorkspace.id;
    const directory = normalizeProjectPath((session._projectDir ?? session.directory) || "");
    return activeWorkspaceProjectSet.has(directory);
  });
}
