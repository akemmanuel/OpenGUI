import type { Provider } from "@/protocol/harness-types";
import type { HarnessId } from "@/agents";

// ---------------------------------------------------------------------------
// Provider management types
// ---------------------------------------------------------------------------

export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
}

export interface ProviderOAuthAuthorization {
  url: string;
  method: "auto" | "code";
  instructions: string;
}

export type ProviderAuth =
  | { type: "api"; key: string }
  | {
      type: "oauth";
      refresh: string;
      access: string;
      expires: number;
      accountId?: string;
      enterpriseUrl?: string;
    }
  | { type: "wellknown"; key: string; token: string };

export interface AllProvidersData {
  all: Provider[];
  default: { [key: string]: string };
  connected: string[];
  authKindByProvider?: Record<string, "env" | "api" | "subscription" | "config" | "custom">;
}

// ---------------------------------------------------------------------------
// Connection + preload bridge types
// ---------------------------------------------------------------------------

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "error";
export type ConnectionKind = "project" | "chat-infra";

export interface ConnectionStatus {
  state: ConnectionState;
  kind?: ConnectionKind;
  serverUrl: string | null;
  serverVersion: string | null;
  error: string | null;
  lastEventAt: number | null;
}

export interface ConnectionConfig {
  workspaceId?: string;
  baseUrl: string;
  username?: string;
  password?: string;
  authToken?: string;
  directory?: string;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  settings?: Record<string, unknown>;
  serverUrl: string;
  username?: string;
  password?: string;
  authToken?: string;
  isLocal: boolean;
  projects: string[];
  selectedModel?: SelectedModel | null;
  selectedAgent?: string | null;
  lastActiveSessionId?: string | null;
}

/** Native preload events, tagged with source directory. Adapter normalizes these for app use. */
export type BridgeEvent =
  | {
      type: "connection:status";
      payload: ConnectionStatus;
      directory: string;
      workspaceId?: string;
    }
  | {
      type: "opencode:event";
      payload: unknown;
      directory: string;
      workspaceId?: string;
    }
  | {
      type: "claude-code:event";
      payload: unknown;
      directory?: string;
      workspaceId?: string;
    }
  | {
      type: "pi:event";
      payload: unknown;
      directory?: string;
      workspaceId?: string;
    }
  | {
      type: "codex:event";
      payload: unknown;
      directory?: string;
      workspaceId?: string;
    };

export type NativeBackendEvent = BridgeEvent;

/** Standard IPC result envelope */
export interface IPCResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Native preload bridge API
// ---------------------------------------------------------------------------

export interface SelectedModel {
  providerID: string;
  modelID: string;
}

export interface ProvidersData {
  providers: Provider[];
  default: { [key: string]: string };
}

export type HarnessInventoryStatus = "ready" | "warning" | "error" | "disabled";
export type HarnessInventoryAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface HarnessInventoryCliDiagnostics {
  command: string;
  resolvedPath: string | null;
  checkedPaths: string[];
}

export interface HarnessInventoryModel {
  providerID?: string;
  modelID: string;
  name?: string;
}

export interface HarnessInventoryAgent {
  id: string;
  name: string;
}

export interface HarnessInventory {
  harnessId: HarnessId;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  status: HarnessInventoryStatus;
  auth: {
    status: HarnessInventoryAuthStatus;
    label?: string;
    email?: string;
  };
  version: string | null;
  models: HarnessInventoryModel[];
  agents: HarnessInventoryAgent[];
  message?: string;
  checkedAt: string;
  diagnostics: {
    cli: HarnessInventoryCliDiagnostics;
  };
}

// ---------------------------------------------------------------------------
// Plugin Catalog Types
// ---------------------------------------------------------------------------

export interface PluginCatalogEntry {
  id: string;
  slug: string;
  name: string;
  source: string;
  description?: string;
  url?: string;
  installs: number;
  createdAt?: string;
  updatedAt?: string;
  change?: number;
}

export interface PluginCatalogListResponse {
  data: PluginCatalogEntry[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

export interface PluginCatalogSearchResponse {
  data: PluginCatalogEntry[];
  query: string;
  searchType: "fuzzy" | "semantic";
  count: number;
  durationMs: number;
}

export interface PluginCatalogDetailResponse {
  id: string;
  source: string;
  slug: string;
  readme: string | null;
  manifest: unknown;
  files: Array<{ path: string; contents: string }> | null;
}

export interface PluginCatalogAuditResponse {
  id: string;
  source: string;
  slug: string;
  audits: Array<{
    id: string;
    status: string;
    message?: string;
    details?: unknown;
  }>;
}

export interface PluginCatalogCuratedResponse {
  data: Array<{
    owner: string;
    totalInstalls: number;
    featuredRepo: string;
    featuredPlugin: string;
    skills: PluginCatalogEntry[];
  }>;
  totalOwners: number;
  totalPlugins: number;
  generatedAt: string;
}

export interface InstalledPluginInfo {
  name: string;
  slug?: string;
  description: string;
  location: string;
  source?: string;
  sourceUrl?: string;
  sourceType?: string;
  remoteKey?: string;
  pluginName?: string;
  scope: "project" | "global";
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

export interface GitMergeResult {
  success: boolean;
  conflicts?: string[];
  error?: string;
}

export interface GitBridge {
  isRepo(directory: string): Promise<IPCResult<boolean>>;
  listBranches(directory: string): Promise<IPCResult<string[]>>;
  currentBranch(directory: string): Promise<IPCResult<string>>;
  listWorktrees(directory: string): Promise<IPCResult<GitWorktree[]>>;
  addWorktree(
    directory: string,
    worktreePath: string,
    branch: string,
    isNewBranch: boolean,
  ): Promise<IPCResult<{ path: string }>>;
  removeWorktree(directory: string, worktreePath: string): Promise<IPCResult>;
  merge(directory: string, branch: string): Promise<GitMergeResult>;
  mergeAbort(directory: string): Promise<IPCResult>;
  getRemoteUrl(directory: string): Promise<IPCResult<string>>;
}

export interface WorktreeSetupDetection {
  detected: boolean;
  command?: string;
  file?: string;
  error?: string;
}

export interface WorktreeBridge {
  detectSetup(worktreePath: string): Promise<WorktreeSetupDetection>;
  runSetup(worktreePath: string, command: string): Promise<IPCResult>;
}

// ---------------------------------------------------------------------------
// Window API
// ---------------------------------------------------------------------------

export interface SettingsBridgeChange {
  key: string;
  value: string | null;
}

export interface SettingsBridge {
  getAllSync(): Record<string, string>;
  getSync(key: string): string | null;
  setSync(key: string, value: string): boolean;
  removeSync(key: string): boolean;
  mergeSync(entries: Record<string, string>): boolean;
  set(key: string, value: string): Promise<boolean>;
  remove(key: string): Promise<boolean>;
  onDidChange(callback: (change: SettingsBridgeChange) => void): () => void;
}

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error"
  | "installing"
  | "disabled";

export interface AppUpdateState {
  status: AppUpdateStatus;
  platformSupported: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  releaseName: string | null;
  releaseUrl: string | null;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferred: number | null;
  total: number | null;
  errorMessage: string | null;
  downloaded: boolean;
  autoDownload: boolean;
  updateInfoFetched: boolean;
}

export interface UpdatesBridge {
  getState(): Promise<AppUpdateState>;
  check(): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  install(): Promise<boolean>;
  onStateChanged(callback: (state: AppUpdateState) => void): () => void;
}

export interface InstallProgress {
  chunk: string;
  type: "stdout" | "stderr";
}

export type DesktopBackendStatus = "starting" | "running" | "stopped" | "crashed";

export interface DesktopBackendFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface DesktopBackendFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface ElectronAPI {
  kind?: "electron" | "web";
  backendUrl?: string | null;
  backendToken?: string | null;
  backendStatus?: DesktopBackendStatus;
  settings: SettingsBridge;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  /** Focus this window (Wayland-safe via main process). */
  focus: () => Promise<void>;
  getPlatform: () => Promise<string>;
  getSystemLocale: () => Promise<string>;
  isPackaged: () => Promise<boolean>;
  getHomeDir?: () => Promise<string>;
  getHarnessInventories?: () => Promise<HarnessInventory[]>;
  restartBackend?: () => Promise<{
    url: string;
    token: string | null;
    status: DesktopBackendStatus;
  }>;
  backendFetch?: (request: DesktopBackendFetchRequest) => Promise<DesktopBackendFetchResponse>;
  subscribeBackendEvents?: (
    callback: (message: { channel?: string; data?: unknown } | Record<string, unknown>) => void,
  ) => () => void;
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
  onBackendStatusChange?: (callback: (status: DesktopBackendStatus) => void) => () => void;

  /** Open a native directory picker dialog. Returns the selected path or null. */
  openDirectory: () => Promise<string | null>;

  /** Open a URL in the system browser (not in Electron). */
  openExternal: (url: string) => Promise<void>;
  updates: UpdatesBridge;

  /** Open a directory in the system file browser (Finder / Explorer / Nautilus). */
  openInFileBrowser: (dirPath: string, command?: string) => Promise<void>;

  /** Open a terminal at a directory. */
  openInTerminal: (dirPath: string, command?: string) => Promise<void>;

  /** Open a project in a detached window. */
  detachProject: (projectDir: string) => Promise<void>;

  /** Returns the detached project directory or null if this window is not detached. */
  getDetachedProject: () => string | null;

  /** Returns the set of projects currently shown in detached windows. */
  getDetachedProjects: () => Promise<string[]>;

  /** Subscribe to detached project visibility changes. */
  onDetachedProjectsChange: (callback: (detachedProjects: string[]) => void) => () => void;
}

declare global {
  interface Window {
    Capacitor?: { isNativePlatform?: () => boolean };
    electronAPI?: ElectronAPI;
  }
}
