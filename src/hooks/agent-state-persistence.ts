import { DEFAULT_SERVER_URL, STORAGE_KEYS } from "@/lib/constants";
import {
  persistOrRemoveJSON,
  storageGet,
  storageParsed,
  storageSet,
  storageSetJSON,
} from "@/lib/safe-storage";
import { getWorkspaceRootProjectDirectory } from "@/lib/worktree-placement";
import { normalizeProjectPath } from "@/lib/utils";
import type { OpenGuiClient, FrontendWorkspaceRecord } from "@/protocol/client";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import type { VariantSelections } from "@/hooks/use-agent-variant-core";
import type { SelectedModel, Workspace } from "@/types/electron";

export const NOTIFICATIONS_ENABLED_KEY = STORAGE_KEYS.NOTIFICATIONS_ENABLED;
export const LOCAL_WORKSPACE_ID = "local";
const LEGACY_WORKSPACE_MIGRATION_KEY = "opengui:workspaceMigrationV1";

interface WorkspaceSettingsRecord {
  serverUrl?: string;
  username?: string;
  password?: string;
  authToken?: string;
  defaultChatDirectory?: string | null;
  isLocal?: boolean;
  selectedModel?: SelectedModel | null;
  selectedAgent?: string | null;
  lastActiveSessionId?: string | null;
  projectOrder?: string[];
  hiddenProjects?: string[];
  order?: number;
}

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
  nativeProjectDir?: string | null;
  assignedProjectDir?: string | null;
  assignedProjectMovedAt?: number | null;
  assignedProjectSourceDir?: string | null;
  pendingDirectoryChangeNotice?: boolean;
  hideSystemAppendBlocks?: boolean;
  movedToSessionId?: string;
  hiddenBootstrapPrefix?: string;
  detachedFromProject?: boolean;
  detachedFromProjectAt?: number | null;
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
      Object.hasOwn(m, "nativeProjectDir") ||
      Object.hasOwn(m, "assignedProjectDir") ||
      Object.hasOwn(m, "assignedProjectMovedAt") ||
      Object.hasOwn(m, "assignedProjectSourceDir") ||
      m.pendingDirectoryChangeNotice === true ||
      m.hideSystemAppendBlocks === true ||
      Object.hasOwn(m, "movedToSessionId") ||
      Object.hasOwn(m, "hiddenBootstrapPrefix") ||
      m.detachedFromProject === true ||
      typeof m.detachedFromProjectAt === "number",
    ),
  );
}

export function getProjectMetaMap(): ProjectMetaMap {
  return storageParsed<ProjectMetaMap>(STORAGE_KEYS.PROJECT_META) ?? {};
}

export type WorkspaceVariantSelectionsMap = Record<string, VariantSelections>;

export function getWorkspaceVariantSelectionsMap(): WorkspaceVariantSelectionsMap {
  return (
    storageParsed<WorkspaceVariantSelectionsMap>(STORAGE_KEYS.WORKSPACE_VARIANT_SELECTIONS) ?? {}
  );
}

export function getVariantSelectionsForWorkspace(workspaceId: string): VariantSelections {
  return (
    getWorkspaceVariantSelectionsMap()[workspaceId] ??
    storageParsed<VariantSelections>(STORAGE_KEYS.VARIANT_SELECTIONS) ??
    {}
  );
}

export function persistVariantSelectionsForWorkspace(
  workspaceId: string,
  selections: VariantSelections,
) {
  const next = {
    ...getWorkspaceVariantSelectionsMap(),
    [workspaceId]: selections,
  };
  persistOrRemoveJSON(
    STORAGE_KEYS.WORKSPACE_VARIANT_SELECTIONS,
    next,
    Object.values(next).every((value) => Object.keys(value).length === 0),
  );
}

export function persistProjectMetaMap(meta: ProjectMetaMap) {
  persistPrunedMap(STORAGE_KEYS.PROJECT_META, meta, (value) =>
    Boolean((value.pinnedAt && value.pinnedAt.length > 0) || value.hidden === true),
  );
}

export function getLegacyStoredDefaultChatDirectory(): string | null {
  const stored = storageGet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY);
  return stored ? normalizeProjectPath(stored) : null;
}

export function getWorkspaceDefaultChatDirectory(
  workspace: Workspace | null | undefined,
): string | null {
  if (!workspace) return null;
  const settings = getWorkspaceSettings(workspace);
  const value = settings.defaultChatDirectory;
  return typeof value === "string" && value.trim() ? normalizeProjectPath(value) : null;
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
  const now = new Date().toISOString();
  const policy = getShellWorkspacePolicy();
  const webConfig = policy.configuredWebWorkspace;
  const serverUrl = webConfig?.baseUrl ?? DEFAULT_SERVER_URL;
  return {
    id: LOCAL_WORKSPACE_ID,
    name: webConfig?.name || "Local",
    createdAt: now,
    updatedAt: now,
    settings: { isLocal: true, serverUrl, authToken: webConfig?.authToken },
    serverUrl,
    authToken: webConfig?.authToken,
    isLocal: true,
    projects: [],
    selectedModel: null,
    selectedAgent: null,
    lastActiveSessionId: null,
  };
}

function normalizeProjectList(projects: string[]): string[] {
  return Array.from(
    new Set(projects.map((project) => normalizeProjectPath(project)).filter(Boolean)),
  );
}

function getWorkspaceSettings(
  workspace: Workspace | FrontendWorkspaceRecord,
): WorkspaceSettingsRecord {
  const settings =
    workspace.settings &&
    typeof workspace.settings === "object" &&
    !Array.isArray(workspace.settings)
      ? (workspace.settings as WorkspaceSettingsRecord)
      : {};
  return settings;
}

function orderProjectPaths(
  paths: string[],
  order: string[] | undefined,
  hiddenProjects?: string[],
): string[] {
  const normalizedOrder = normalizeProjectList(order ?? []);
  const hidden = new Set(normalizeProjectList(hiddenProjects ?? []));
  const uniquePaths = normalizeProjectList(paths);
  const ordered: string[] = [];
  for (const entry of normalizedOrder) {
    if (uniquePaths.includes(entry) && !ordered.includes(entry)) ordered.push(entry);
  }
  for (const path of uniquePaths) {
    if (!ordered.includes(path)) ordered.push(path);
  }
  return ordered.filter((project) => !hidden.has(project));
}

function normalizeWorkspaceServerUrl(value: string | undefined) {
  const trimmed = (value || DEFAULT_SERVER_URL).trim() || DEFAULT_SERVER_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function normalizeWorkspace(workspace: Workspace): Workspace {
  const settings = getWorkspaceSettings(workspace);
  const hasSelectedModel = Object.hasOwn(workspace, "selectedModel");
  const hasSelectedAgent = Object.hasOwn(workspace, "selectedAgent");
  const hasLastActiveSessionId = Object.hasOwn(workspace, "lastActiveSessionId");
  const normalizedSelectedModel = hasSelectedModel
    ? (workspace.selectedModel ?? null)
    : (settings.selectedModel ?? null);
  const normalizedSelectedAgent = hasSelectedAgent
    ? (workspace.selectedAgent ?? null)
    : (settings.selectedAgent ?? null);
  const normalizedLastActiveSessionId = hasLastActiveSessionId
    ? (workspace.lastActiveSessionId ?? null)
    : (settings.lastActiveSessionId ?? null);
  const normalizedAuthToken =
    workspace.authToken ??
    settings.authToken ??
    (!settings.username ? settings.password : undefined);

  const normalized: Workspace = {
    ...workspace,
    name: workspace.name.trim() || (workspace.isLocal || settings.isLocal ? "Local" : "Workspace"),
    serverUrl: normalizeWorkspaceServerUrl(workspace.serverUrl || settings.serverUrl),
    isLocal: workspace.isLocal || settings.isLocal === true,
    projects: normalizeProjectList(workspace.projects ?? []),
    authToken: normalizedAuthToken,
    selectedModel: normalizedSelectedModel,
    selectedAgent: normalizedSelectedAgent,
    lastActiveSessionId: normalizedLastActiveSessionId,
    createdAt: workspace.createdAt ?? new Date().toISOString(),
    updatedAt: workspace.updatedAt ?? workspace.createdAt ?? new Date().toISOString(),
    settings: {
      ...settings,
      serverUrl: normalizeWorkspaceServerUrl(workspace.serverUrl || settings.serverUrl),
      username: workspace.username ?? settings.username,
      password: workspace.password ?? settings.password,
      authToken: normalizedAuthToken,
      isLocal: workspace.isLocal || settings.isLocal === true,
      selectedModel: normalizedSelectedModel,
      selectedAgent: normalizedSelectedAgent,
      lastActiveSessionId: normalizedLastActiveSessionId,
      defaultChatDirectory:
        typeof settings.defaultChatDirectory === "string"
          ? normalizeProjectPath(settings.defaultChatDirectory)
          : null,
      projectOrder: normalizeProjectList(workspace.projects ?? settings.projectOrder ?? []),
      hiddenProjects: normalizeProjectList(settings.hiddenProjects ?? []),
      order: typeof settings.order === "number" ? settings.order : undefined,
    },
  };
  return normalized;
}

export function workspaceToCreateInput(workspace: Workspace) {
  const normalized = normalizeWorkspace(workspace);
  return {
    name: normalized.name,
    settings: normalized.settings,
  };
}

export function workspaceToUpdateInput(workspace: Workspace) {
  const normalized = normalizeWorkspace(workspace);
  return {
    name: normalized.name,
    settings: normalized.settings,
  };
}

export function workspaceFromBackend(
  workspace: FrontendWorkspaceRecord,
  projectPaths: string[] = [],
): Workspace {
  const settings = getWorkspaceSettings(workspace);
  return normalizeWorkspace({
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    settings: workspace.settings,
    serverUrl: settings.serverUrl ?? DEFAULT_SERVER_URL,
    username: settings.username,
    password: settings.password,
    authToken: settings.authToken ?? (!settings.username ? settings.password : undefined),
    isLocal: settings.isLocal === true,
    projects: orderProjectPaths(projectPaths, settings.projectOrder, settings.hiddenProjects),
    selectedModel: settings.selectedModel ?? null,
    selectedAgent: settings.selectedAgent ?? null,
    lastActiveSessionId: settings.lastActiveSessionId ?? null,
  });
}

function getLegacyStoredWorkspaces(): Workspace[] {
  const parsed = storageParsed<Workspace[]>(STORAGE_KEYS.WORKSPACES) ?? [];
  const policy = getShellWorkspacePolicy();
  const workspaces = parsed
    .filter((workspace): workspace is Workspace => !!workspace?.id)
    .map((workspace) =>
      normalizeWorkspace({
        ...workspace,
        isLocal: workspace.id === LOCAL_WORKSPACE_ID || workspace.isLocal,
      }),
    );
  const legacyDefaultChatDirectory = getLegacyStoredDefaultChatDirectory();
  const legacyDefaultWorkspaceId = storageGet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID);
  const workspacesWithLegacyDefault = legacyDefaultChatDirectory
    ? workspaces.map((workspace) => {
        if (workspace.id !== legacyDefaultWorkspaceId) return workspace;
        if (workspace.id !== LOCAL_WORKSPACE_ID && !workspace.isLocal) return workspace;
        const settings = getWorkspaceSettings(workspace);
        if (settings.defaultChatDirectory) return workspace;
        return normalizeWorkspace({
          ...workspace,
          settings: { ...settings, defaultChatDirectory: legacyDefaultChatDirectory },
        });
      })
    : workspaces;

  if (policy.shellKind === "mobile") {
    return workspacesWithLegacyDefault.filter(
      (workspace) => !workspace.isLocal && workspace.id !== LOCAL_WORKSPACE_ID,
    );
  }

  if (policy.shellKind === "web") {
    const local = createLocalWorkspace();
    const storedLocal = workspacesWithLegacyDefault.find(
      (workspace) => workspace.id === LOCAL_WORKSPACE_ID,
    );
    const storedSettings = storedLocal ? getWorkspaceSettings(storedLocal) : {};
    return [
      normalizeWorkspace({
        ...local,
        projects: storedLocal?.projects ?? [],
        selectedModel: storedLocal?.selectedModel ?? null,
        selectedAgent: storedLocal?.selectedAgent ?? null,
        lastActiveSessionId: storedLocal?.lastActiveSessionId ?? null,
        settings: {
          ...storedSettings,
          ...local.settings,
          projectOrder: storedSettings.projectOrder,
          hiddenProjects: storedSettings.hiddenProjects,
        },
      }),
    ];
  }

  const localWorkspace = workspacesWithLegacyDefault.find(
    (workspace) => workspace.id === LOCAL_WORKSPACE_ID,
  );
  if (!localWorkspace) workspacesWithLegacyDefault.unshift(createLocalWorkspace());
  return workspacesWithLegacyDefault.map((workspace) =>
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

let backendWorkspaceInitPromise: Promise<Workspace[]> | null = null;

function sortLocalWorkspaces(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((left, right) => {
    const leftOrder = typeof left.settings?.order === "number" ? left.settings.order : 0;
    const rightOrder = typeof right.settings?.order === "number" ? right.settings.order : 0;
    return leftOrder - rightOrder;
  });
}

function getInitialWorkspacesForShell(): Workspace[] {
  const policy = getShellWorkspacePolicy();
  return policy.shellKind === "mobile" ? [] : [createLocalWorkspace()];
}

export async function loadBackendWorkspaces(_client: OpenGuiClient): Promise<Workspace[]> {
  const stored = getLegacyStoredWorkspaces();
  return sortLocalWorkspaces(stored.length > 0 ? stored : getInitialWorkspacesForShell());
}

export async function migrateLegacyWorkspaceState(_client: OpenGuiClient): Promise<Workspace[]> {
  const workspaces = sortLocalWorkspaces(getLegacyStoredWorkspaces());
  persistWorkspaces(workspaces.length > 0 ? workspaces : getInitialWorkspacesForShell());
  storageSet(LEGACY_WORKSPACE_MIGRATION_KEY, "done");
  return getLegacyStoredWorkspaces();
}

export async function initializeBackendWorkspaceState(client: OpenGuiClient): Promise<Workspace[]> {
  if (backendWorkspaceInitPromise) return await backendWorkspaceInitPromise;

  backendWorkspaceInitPromise = (async () => {
    const migrationMarker = storageGet(LEGACY_WORKSPACE_MIGRATION_KEY);
    if (migrationMarker !== "done") {
      return await migrateLegacyWorkspaceState(client);
    }
    return await loadBackendWorkspaces(client);
  })();

  try {
    return await backendWorkspaceInitPromise;
  } finally {
    backendWorkspaceInitPromise = null;
  }
}

export function getStoredWorkspaces(): Workspace[] {
  return getLegacyStoredWorkspaces();
}

export function persistWorkspaces(workspaces: Workspace[]) {
  const policy = getShellWorkspacePolicy();
  const normalized = workspaces.map(normalizeWorkspace);
  const scoped =
    policy.shellKind === "mobile"
      ? normalized.filter((workspace) => !workspace.isLocal && workspace.id !== LOCAL_WORKSPACE_ID)
      : policy.shellKind === "web"
        ? normalized.filter((workspace) => workspace.id === LOCAL_WORKSPACE_ID).slice(0, 1)
        : normalized;
  storageSetJSON(STORAGE_KEYS.WORKSPACES, sortLocalWorkspaces(scoped));
}

export function getActiveWorkspaceId(workspaces: Workspace[]) {
  const stored = storageGet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID);
  if (stored && workspaces.some((workspace) => workspace.id === stored)) {
    return stored;
  }
  return workspaces[0]?.id ?? "";
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
