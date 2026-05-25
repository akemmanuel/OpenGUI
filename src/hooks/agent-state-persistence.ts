import { DEFAULT_SERVER_URL, STORAGE_KEYS } from "@/lib/constants";
import { persistOrRemoveJSON, storageGet, storageParsed, storageSetJSON } from "@/lib/safe-storage";
import { getWorkspaceRootProjectDirectory } from "@/lib/worktree-placement";
import { normalizeProjectPath } from "@/lib/utils";
import type { SelectedModel, Workspace } from "@/types/electron";

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

interface WorktreeMetadata {
  parentDir: string;
  branch: string;
  createdAt: string;
  lastOpenedAt: string;
}

export type WorktreeParentMap = Record<string, WorktreeMetadata>;

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
  return getWorkspaceRootProjectDirectory(directory, worktreeParents);
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
