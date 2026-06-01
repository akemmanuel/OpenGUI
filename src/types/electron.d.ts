import type { Event as OpenCodeEvent, Provider } from "@opencode-ai/sdk/v2/client";

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
      payload: OpenCodeEvent;
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

// ---------------------------------------------------------------------------
// Skills Marketplace Types
// ---------------------------------------------------------------------------

export interface MarketplaceSkill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: "github" | "well-known";
  installUrl: string | null;
  url: string;
  isDuplicate?: boolean;
  installsYesterday?: number;
  change?: number;
}

export interface MarketplaceListResponse {
  data: MarketplaceSkill[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    hasMore: boolean;
  };
}

export interface MarketplaceSearchResponse {
  data: MarketplaceSkill[];
  query: string;
  searchType: "fuzzy" | "semantic";
  count: number;
  durationMs: number;
}

export interface MarketplaceDetailResponse {
  id: string;
  source: string;
  slug: string;
  installs: number;
  hash: string | null;
  files: Array<{ path: string; contents: string }> | null;
}

export interface MarketplaceAuditResponse {
  id: string;
  source: string;
  slug: string;
  audits: Array<{
    provider: string;
    slug: string;
    status: "pass" | "warn" | "fail";
    summary: string;
    auditedAt: string;
    riskLevel?: string;
  }>;
}

export interface MarketplaceCuratedResponse {
  data: Array<{
    owner: string;
    totalInstalls: number;
    featuredRepo: string;
    featuredSkill: string;
    skills: MarketplaceSkill[];
  }>;
  totalOwners: number;
  totalSkills: number;
  generatedAt: string;
}

export interface InstalledSkillInfo {
  name: string;
  slug?: string;
  description: string;
  location: string;
  content: string;
  source?: string;
  remoteKey?: string;
  scope?: "project" | "global";
  pluginName?: string;
  sourceType?: string;
  sourceUrl?: string;
  skillPath?: string;
  skillFolderHash?: string;
  computedHash?: string;
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

export type BackendDetectionResult = Record<"opencode" | "claude-code" | "pi" | "codex", boolean>;

export interface InstallProgress {
  chunk: string;
  type: "stdout" | "stderr";
}

export interface InstallResult {
  success: boolean;
  exitCode?: number | null;
  error?: string;
}

export type DesktopBackendStatus = "starting" | "running" | "stopped" | "crashed";

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
  getPlatform: () => Promise<string>;
  getSystemLocale: () => Promise<string>;
  isPackaged: () => Promise<boolean>;
  restartBackend?: () => Promise<{
    url: string;
    token: string | null;
    status: DesktopBackendStatus;
  }>;
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
    electronAPI?: ElectronAPI;
  }
}
