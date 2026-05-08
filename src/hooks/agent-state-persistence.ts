import { DEFAULT_SERVER_URL, MAX_RECENT_PROJECTS, STORAGE_KEYS } from "@/lib/constants";
import { persistOrRemoveJSON, storageGet, storageParsed, storageSetJSON } from "@/lib/safe-storage";
import { normalizeProjectPath } from "@/lib/utils";
import type { ConnectionStatus, SelectedModel, Workspace } from "@/types/electron";

export interface RecentProject {
  workspaceId?: string;
  directory: string;
  serverUrl: string;
  username?: string;
  lastConnected: number;
}

export const NOTIFICATIONS_ENABLED_KEY = STORAGE_KEYS.NOTIFICATIONS_ENABLED;
export const LOCAL_WORKSPACE_ID = "local";

export type SessionColor =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "gray"
  | null;

export interface SessionMeta {
  color?: SessionColor;
  tags?: string[];
  pinnedAt?: string;
  selectedModel?: SelectedModel | null;
  selectedAgent?: string | null;
  selectedVariant?: string | null;
  originMode?: "chat" | "project";
  assignedProjectDir?: string | null;
  assignedProjectMovedAt?: number | null;
  assignedProjectSourceDir?: string | null;
  pendingDirectoryChangeNotice?: boolean;
  hideSystemAppendBlocks?: boolean;
  movedToSessionId?: string;
  hiddenBootstrapPrefix?: string;
}

export interface ProjectMeta {
  pinnedAt?: string;
  hidden?: boolean;
}

export type SessionMetaMap = Record<string, SessionMeta>;
export type ProjectMetaMap = Record<string, ProjectMeta>;

function persistPrunedMap<T>(
  key: string,
  map: Record<string, T>,
  shouldKeep: (value: T) => boolean,
) {
  const pruned: Record<string, T> = {};
  for (const [id, value] of Object.entries(map)) {
    if (shouldKeep(value)) pruned[id] = value;
  }
  persistOrRemoveJSON(key, pruned, Object.keys(pruned).length === 0);
}

export function getSessionMetaMap(): SessionMetaMap {
  return storageParsed<SessionMetaMap>(STORAGE_KEYS.SESSION_META) ?? {};
}

export function persistSessionMetaMap(meta: SessionMetaMap) {
  persistPrunedMap(STORAGE_KEYS.SESSION_META, meta, (m) =>
    Boolean(
      (m.color && m.color !== null) ||
      (m.tags && m.tags.length > 0) ||
      (m.pinnedAt && m.pinnedAt.length > 0) ||
      Object.hasOwn(m, "selectedModel") ||
      Object.hasOwn(m, "selectedAgent") ||
      Object.hasOwn(m, "selectedVariant") ||
      m.originMode === "chat" ||
      Object.hasOwn(m, "assignedProjectDir") ||
      Object.hasOwn(m, "assignedProjectMovedAt") ||
      Object.hasOwn(m, "assignedProjectSourceDir") ||
      m.pendingDirectoryChangeNotice === true ||
      m.hideSystemAppendBlocks === true ||
      Object.hasOwn(m, "movedToSessionId") ||
      Object.hasOwn(m, "hiddenBootstrapPrefix"),
    ),
  );
}

export function getProjectMetaMap(): ProjectMetaMap {
  return storageParsed<ProjectMetaMap>(STORAGE_KEYS.PROJECT_META) ?? {};
}

export function persistProjectMetaMap(meta: ProjectMetaMap) {
  persistPrunedMap(STORAGE_KEYS.PROJECT_META, meta, (value) =>
    Boolean((value.pinnedAt && value.pinnedAt.length > 0) || value.hidden === true),
  );
}

export function getStoredDefaultChatDirectory(): string | null {
  const stored = storageGet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY);
  return stored ? normalizeProjectPath(stored) : null;
}

export function resolveDefaultChatDirectory(homeDir: string | null): string | null {
  return getStoredDefaultChatDirectory() ?? (homeDir ? normalizeProjectPath(homeDir) : null);
}

export interface WorktreeMetadata {
  parentDir: string;
  branch: string;
  createdAt: string;
  lastOpenedAt: string;
}

export type WorktreeParentMap = Record<string, WorktreeMetadata>;

export function getWorktreeParentDir(map: WorktreeParentMap, dir: string): string | undefined {
  return map[dir]?.parentDir;
}

export function getWorktreeParents(): WorktreeParentMap {
  const raw = storageParsed<Record<string, unknown>>(STORAGE_KEYS.WORKTREE_PARENTS) ?? {};
  const result: WorktreeParentMap = {};
  let changed = false;
  for (const [dir, val] of Object.entries(raw)) {
    const normalizedDir = normalizeProjectPath(dir);
    if (!normalizedDir) {
      changed = true;
      continue;
    }
    if (typeof val === "string") {
      changed = true;
      result[normalizedDir] = {
        parentDir: normalizeProjectPath(val),
        branch: "unknown",
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      };
    } else if (val && typeof val === "object" && "parentDir" in val) {
      const metadata = val as WorktreeMetadata;
      const normalizedParentDir = normalizeProjectPath(metadata.parentDir);
      if (!normalizedParentDir) {
        changed = true;
        continue;
      }
      if (normalizedDir !== dir || normalizedParentDir !== metadata.parentDir) {
        changed = true;
      }
      result[normalizedDir] = {
        ...metadata,
        parentDir: normalizedParentDir,
      };
    }
  }
  if (changed) persistWorktreeParents(result);
  return result;
}

export function persistWorktreeParents(map: WorktreeParentMap) {
  persistOrRemoveJSON(STORAGE_KEYS.WORKTREE_PARENTS, map, Object.keys(map).length === 0);
}

export function isLocalServer(
  raw = storageGet(STORAGE_KEYS.SERVER_URL) ?? DEFAULT_SERVER_URL,
): boolean {
  try {
    const hostname = new URL(raw).hostname;
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

export function getWorkspaceRootDirectory(
  directory: string,
  worktreeParents: WorktreeParentMap,
): string {
  const normalizedDirectory = normalizeProjectPath(directory);
  return normalizeProjectPath(
    worktreeParents[normalizedDirectory]?.parentDir ?? normalizedDirectory,
  );
}

export function createLocalWorkspace(): Workspace {
  return {
    id: LOCAL_WORKSPACE_ID,
    name: "Local",
    serverUrl: DEFAULT_SERVER_URL,
    isLocal: true,
    projects: [],
    selectedModel: null,
    selectedAgent: null,
    lastActiveSessionId: null,
  };
}

export function normalizeWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    name: workspace.name.trim() || (workspace.isLocal ? "Local" : "Workspace"),
    serverUrl: workspace.serverUrl.trim() || DEFAULT_SERVER_URL,
    projects: Array.from(
      new Set(
        (workspace.projects ?? []).map((project) => normalizeProjectPath(project)).filter(Boolean),
      ),
    ),
    selectedModel: workspace.selectedModel ?? null,
    selectedAgent: workspace.selectedAgent ?? null,
    lastActiveSessionId: workspace.lastActiveSessionId ?? null,
  };
}

export function getStoredWorkspaces(): Workspace[] {
  const parsed = storageParsed<Workspace[]>(STORAGE_KEYS.WORKSPACES) ?? [];
  const workspaces = parsed
    .filter((workspace): workspace is Workspace => !!workspace?.id)
    .map((workspace) =>
      normalizeWorkspace({
        ...workspace,
        isLocal: workspace.id === LOCAL_WORKSPACE_ID || workspace.isLocal,
      }),
    );
  const localWorkspace = workspaces.find((workspace) => workspace.id === LOCAL_WORKSPACE_ID);
  if (!localWorkspace) workspaces.unshift(createLocalWorkspace());
  return workspaces.map((workspace) =>
    workspace.id === LOCAL_WORKSPACE_ID
      ? normalizeWorkspace({
          ...workspace,
          name: workspace.name || "Local",
          serverUrl: DEFAULT_SERVER_URL,
          isLocal: true,
        })
      : workspace,
  );
}

export function persistWorkspaces(workspaces: Workspace[]) {
  storageSetJSON(
    STORAGE_KEYS.WORKSPACES,
    workspaces.map((workspace) => normalizeWorkspace(workspace)),
  );
}

export function getActiveWorkspaceId(workspaces: Workspace[]) {
  const stored = storageGet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID);
  if (stored && workspaces.some((workspace) => workspace.id === stored)) {
    return stored;
  }
  return workspaces[0]?.id ?? LOCAL_WORKSPACE_ID;
}

export function getRecentProjects(): RecentProject[] {
  const projects = storageParsed<RecentProject[]>(STORAGE_KEYS.RECENT_PROJECTS) ?? [];
  return projects
    .map((project) => ({
      ...project,
      directory: normalizeProjectPath(project.directory),
      serverUrl: project.serverUrl.replace(/\/+$/, ""),
      username: project.username?.trim() || undefined,
      workspaceId: project.workspaceId?.trim() || undefined,
    }))
    .filter((project) => !!project.directory);
}

export function addRecentProject(project: RecentProject): RecentProject[] {
  const normalizedDirectory = normalizeProjectPath(project.directory);
  const normalizedServerUrl = project.serverUrl.replace(/\/+$/, "");
  const normalizedUsername = project.username?.trim() || undefined;
  const normalizedWorkspaceId = project.workspaceId?.trim() || undefined;
  const existing = getRecentProjects().filter((candidate) => {
    return !(
      (candidate.workspaceId?.trim() || undefined) === normalizedWorkspaceId &&
      normalizeProjectPath(candidate.directory) === normalizedDirectory &&
      candidate.serverUrl.replace(/\/+$/, "") === normalizedServerUrl &&
      (candidate.username?.trim() || undefined) === normalizedUsername
    );
  });
  const updated = [
    {
      ...project,
      workspaceId: normalizedWorkspaceId,
      directory: normalizedDirectory,
      serverUrl: normalizedServerUrl,
      username: normalizedUsername,
    },
    ...existing,
  ].slice(0, MAX_RECENT_PROJECTS);
  storageSetJSON(STORAGE_KEYS.RECENT_PROJECTS, updated);
  return updated;
}

export function getUnreadSessionIds(): Set<string> {
  const arr = storageParsed<string[]>(STORAGE_KEYS.UNREAD_SESSIONS);
  return arr ? new Set(arr) : new Set();
}

export function persistUnreadSessionIds(ids: Set<string>) {
  persistOrRemoveJSON(STORAGE_KEYS.UNREAD_SESSIONS, [...ids], ids.size === 0);
}

export function areNotificationsEnabled(): boolean {
  const raw = storageGet(STORAGE_KEYS.NOTIFICATIONS_ENABLED);
  return raw === null || raw === "true";
}

export function hasAnyConnection(connections: Record<string, ConnectionStatus>): boolean {
  return Object.values(connections).some((c) => c.state === "connected");
}
