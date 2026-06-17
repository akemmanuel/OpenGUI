import { normalizeProjectPath } from "@/lib/utils";
import { getHarnessIdFromSessionId, type HarnessId } from "@/agents";
import type { ProjectMetaMap, SessionMeta } from "@/hooks/agent-state-persistence";
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

export function getEffectiveSessionDirectory(
  session: Session | undefined | null,
  meta?: SessionMeta,
) {
  const assignedDirectory = meta?.assignedProjectDir
    ? normalizeProjectPath(meta.assignedProjectDir)
    : "";
  const nativeDirectory = meta?.nativeProjectDir ? normalizeProjectPath(meta.nativeProjectDir) : "";
  const sessionDirectory = normalizeProjectPath(getSessionDirectory(session) ?? "");
  return assignedDirectory || nativeDirectory || sessionDirectory || null;
}

export function createSessionProjectMoveMeta(
  session: Session | undefined | null,
  meta: SessionMeta | undefined,
  targetDirectory: string,
  now = Date.now(),
): Partial<SessionMeta> | null {
  const nativeDirectory = normalizeProjectPath(
    meta?.nativeProjectDir ?? getSessionDirectory(session) ?? "",
  );
  const normalizedTargetDirectory = normalizeProjectPath(targetDirectory);
  if (!nativeDirectory || !normalizedTargetDirectory) return null;

  const currentDirectory = getEffectiveSessionDirectory(session, meta) ?? nativeDirectory;
  const directoryChanged = currentDirectory !== normalizedTargetDirectory;

  return {
    originMode: meta?.originMode === "chat" ? "chat" : "project",
    nativeProjectDir: nativeDirectory,
    assignedProjectDir:
      nativeDirectory === normalizedTargetDirectory ? null : normalizedTargetDirectory,
    assignedProjectMovedAt: directoryChanged ? now : null,
    assignedProjectSourceDir: directoryChanged ? currentDirectory : null,
    pendingDirectoryChangeNotice: directoryChanged,
    hideSystemAppendBlocks: directoryChanged,
    detachedFromProject: false,
    detachedFromProjectAt: null,
  };
}

export function createSessionProjectDetachMeta(
  session: Session | undefined | null,
  meta: SessionMeta | undefined,
  now = Date.now(),
  fallbackDirectory?: string | null,
): Partial<SessionMeta> | null {
  const nativeDirectory = normalizeProjectPath(
    meta?.nativeProjectDir ?? fallbackDirectory ?? getSessionDirectory(session) ?? "",
  );
  if (!nativeDirectory) return null;

  const currentDirectory = getEffectiveSessionDirectory(session, meta) ?? nativeDirectory;
  const directoryChanged = currentDirectory !== nativeDirectory;

  return {
    originMode: "chat",
    nativeProjectDir: nativeDirectory,
    assignedProjectDir: null,
    assignedProjectMovedAt: null,
    assignedProjectSourceDir: directoryChanged ? currentDirectory : null,
    pendingDirectoryChangeNotice: directoryChanged,
    hideSystemAppendBlocks: directoryChanged,
    detachedFromProject: true,
    detachedFromProjectAt: now,
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
  meta?: SessionMeta,
): ProjectTarget | null {
  const directory = getEffectiveSessionDirectory(session, meta);
  if (!directory) return null;
  return {
    directory,
    workspaceId: getSessionWorkspaceId(session) ?? undefined,
  };
}

/** Filesystem directory for backend session APIs (messages, queue, …). */
export function directoryScopeForSessionApi(
  session: Session | undefined | null,
  meta?: SessionMeta,
): string | undefined {
  const fromTarget = getSessionProjectTarget(session, meta)?.directory;
  if (fromTarget) return fromTarget;
  if (!session) return undefined;
  const raw = session._projectDir ?? session.directory;
  if (!raw) return undefined;
  const normalized = normalizeProjectPath(raw);
  return normalized || raw;
}

export function getSessionHarnessId(session: Session | undefined | null): HarnessId | null {
  return (
    session?._harnessId ?? session?._backendId ?? getHarnessIdFromSessionId(session?.id) ?? null
  );
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

function getSessionSortTime(session: Session | undefined | null): number {
  if (!session) return 0;
  const time = session.time;
  if (!time || typeof time !== "object") return 0;
  const updated = time.updated;
  const created = time.created;
  if (typeof updated === "number" && Number.isFinite(updated)) return updated;
  if (typeof created === "number" && Number.isFinite(created)) return created;
  return 0;
}

export function sortSessionsNewestFirst(sessions: Session[]): Session[] {
  const defined = sessions.filter(
    (session): session is Session => !!session && typeof session.id === "string",
  );
  return [...defined].sort((a, b) => {
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
