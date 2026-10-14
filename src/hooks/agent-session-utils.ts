import { normalizeProjectPath } from "@/lib/path";
import type { SessionMeta } from "@/lib/persistence/session";
import type { Session } from "@/hooks/agent-state-types";

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

export function getSessionExecutionDirectory(session: Session | undefined | null) {
  const sessionDirectory = normalizeProjectPath(getSessionDirectory(session) ?? "");
  return sessionDirectory || null;
}

export function createSessionProjectMoveMeta(
  session: Session | undefined | null,
  _meta: SessionMeta | undefined,
  targetDirectory: string,
  now = Date.now(),
): Partial<SessionMeta> | null {
  const normalizedTargetDirectory = normalizeProjectPath(targetDirectory);
  if (!getSessionExecutionDirectory(session) || !normalizedTargetDirectory) return null;

  return {
    sidebarSection: "projects",
    displayProjectDir: normalizedTargetDirectory,
    sidebarMovedAt: now,
  };
}

export function createSessionProjectDetachMeta(
  session: Session | undefined | null,
  _meta: SessionMeta | undefined,
  now = Date.now(),
  fallbackDirectory?: string | null,
): Partial<SessionMeta> | null {
  if (!getSessionExecutionDirectory(session) && !normalizeProjectPath(fallbackDirectory ?? "")) {
    return null;
  }

  return {
    sidebarSection: "chats",
    displayProjectDir: null,
    sidebarMovedAt: now,
  };
}

export function getSessionWorkspaceId(session: Session | undefined | null) {
  if (!session) return null;
  return session._workspaceId ?? null;
}

export type ProjectTarget = {
  directory?: string;
  workspaceId?: string;
  baseUrl?: string;
};

export function getSessionProjectTarget(
  session: Session | undefined | null,
  _meta?: SessionMeta,
): ProjectTarget | null {
  const directory = getSessionExecutionDirectory(session);
  if (!directory) return null;
  return {
    directory,
    workspaceId: getSessionWorkspaceId(session) ?? undefined,
  };
}

export function shouldAutoNameSession(session: Session | undefined | null) {
  const title = session?.title?.trim();
  return !title || ["untitled", "new session"].includes(title.toLowerCase());
}
