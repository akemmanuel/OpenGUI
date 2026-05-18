import { normalizeProjectPath } from "@/lib/utils";
import { getAgentBackendIdFromSessionId, type AgentBackendId } from "@/agents";
import type { ProjectMetaMap } from "@/hooks/agent-state-persistence";
import type { Session } from "@/hooks/agent-state-types";
import type { SelectedModel } from "@/types/electron";

const PROJECT_KEY_SEPARATOR = "\u0000";

export function makeProjectKey(workspaceId: string | null | undefined, directory: string) {
  return `${workspaceId ?? ""}${PROJECT_KEY_SEPARATOR}${normalizeProjectPath(directory)}`;
}

export function parseProjectKey(projectKey: string) {
  const idx = projectKey.indexOf(PROJECT_KEY_SEPARATOR);
  if (idx < 0) {
    return { workspaceId: "", directory: projectKey };
  }
  return {
    workspaceId: projectKey.slice(0, idx),
    directory: projectKey.slice(idx + PROJECT_KEY_SEPARATOR.length),
  };
}

export function getSessionDirectory(session: Session | undefined | null) {
  if (!session) return null;
  return session._projectDir ?? session.directory ?? null;
}

export function getSessionWorkspaceId(session: Session | undefined | null) {
  if (!session) return null;
  return session._workspaceId ?? null;
}

export function getSessionProjectTarget(session: Session | undefined | null) {
  const directory = getSessionDirectory(session);
  if (!directory) return null;
  return {
    directory,
    workspaceId: getSessionWorkspaceId(session) ?? undefined,
  };
}

export function getSessionBackendId(session: Session | undefined | null): AgentBackendId | null {
  return session?._backendId ?? getAgentBackendIdFromSessionId(session?.id) ?? null;
}

export function getSessionSelectedModel(session: Session | undefined | null): SelectedModel | null {
  const model = session?.model;
  if (!model?.providerID || !model.id) return null;
  return { providerID: model.providerID, modelID: model.id };
}

export function getSessionSelectedVariant(session: Session | undefined | null): string | null {
  const variant = session?.model?.variant;
  return typeof variant === "string" && variant.length > 0 ? variant : null;
}

export function getSessionSelectedAgent(session: Session | undefined | null): string | null {
  const agent = session?.agent;
  return typeof agent === "string" && agent.length > 0 ? agent : null;
}

export function shouldAutoNameSession(session: Session | undefined | null) {
  const title = session?.title?.trim();
  return !title || title.toLowerCase() === "untitled";
}

function getSessionSortTime(session: Session): number {
  return session.time.updated ?? session.time.created ?? 0;
}

export function sortSessionsNewestFirst(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const byUpdated = getSessionSortTime(b) - getSessionSortTime(a);
    if (byUpdated !== 0) return byUpdated;
    return b.id.localeCompare(a.id);
  });
}

export function isHiddenProject(
  projectMeta: ProjectMetaMap,
  workspaceId: string | null | undefined,
  directory: string,
): boolean {
  return projectMeta[makeProjectKey(workspaceId, directory)]?.hidden === true;
}
