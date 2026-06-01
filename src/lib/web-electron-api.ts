import type { AgentBackendId } from "@/agents";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import type { ElectronAPI, InstallProgress } from "@/types/electron";

type Listener = (data: unknown) => void;

const SETTINGS_PREFIX = "opengui:web:settings:";
const listeners = new Map<string, Set<Listener>>();

function emit(channel: string, data: unknown) {
  for (const listener of listeners.get(channel) ?? []) listener(data);
}

function on(channel: string, callback: Listener) {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(callback);
  return () => set?.delete(callback);
}

function getConfiguredBackendToken() {
  return getShellWorkspacePolicy().configuredWebWorkspace?.authToken;
}

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const headers = new Headers({ "content-type": "application/json" });
  const token = getConfiguredBackendToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers,
    body: JSON.stringify({ channel, args }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `RPC failed: ${channel}`);
  }
  return body.value as T;
}

function settingKey(key: string) {
  return `${SETTINGS_PREFIX}${key}`;
}

function settingsGetSync(key: string) {
  return localStorage.getItem(settingKey(key));
}

function settingsSetSync(key: string, value: string) {
  localStorage.setItem(settingKey(key), value);
  void invoke("settings:set", key, value).catch(console.error);
  emit("settings:changed", { key, value });
  return true;
}

function settingsRemoveSync(key: string) {
  localStorage.removeItem(settingKey(key));
  void invoke("settings:remove", key).catch(console.error);
  emit("settings:changed", { key, value: null });
  return true;
}

function getAllSettingsSync() {
  const result: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(SETTINGS_PREFIX)) continue;
    const value = localStorage.getItem(key);
    if (value != null) result[key.slice(SETTINGS_PREFIX.length)] = value;
  }
  return result;
}

function mergeSettingsSync(entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) settingsSetSync(key, value);
  void invoke("settings:merge", entries).catch(console.error);
  return true;
}

function subscribeEvents() {
  let closed = false;
  let retry: number | undefined;
  let stream: EventSource | undefined;

  const connect = () => {
    const url = new URL(`${location.protocol}//${location.host}/api/events`);
    const token = getConfiguredBackendToken();
    if (token) url.searchParams.set("token", token);
    stream = new EventSource(url.toString());
    stream.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.channel) emit(message.channel, message.data);
      } catch (error) {
        console.error("Bad web event", error);
      }
    };
    stream.onerror = () => {
      stream?.close();
      if (closed) return;
      retry = window.setTimeout(connect, 1000);
    };
  };

  connect();
  return () => {
    closed = true;
    if (retry) window.clearTimeout(retry);
    stream?.close();
  };
}

function isCapacitorNativeRuntime() {
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

export function installWebElectronAPI() {
  if (window.electronAPI) return;
  if (location.protocol === "file:") return;
  if (isCapacitorNativeRuntime()) return;

  subscribeEvents();

  const api = {
    kind: "web",
    backendUrl: null,
    backendToken: null,
    backendStatus: "running",
    settings: {
      getAllSync: getAllSettingsSync,
      getSync: settingsGetSync,
      setSync: settingsSetSync,
      removeSync: settingsRemoveSync,
      mergeSync: mergeSettingsSync,
      set: async (key: string, value: string) => settingsSetSync(key, value),
      remove: async (key: string) => settingsRemoveSync(key),
      onDidChange: (callback: (change: unknown) => void) => on("settings:changed", callback),
    },
    minimize: () => invoke("window:minimize"),
    maximize: () => invoke("window:maximize"),
    close: () => invoke("window:close"),
    isMaximized: () => invoke("window:isMaximized"),
    getPlatform: () => invoke("platform:get"),
    getSystemLocale: () => invoke("platform:locale"),
    detectBackends: () => invoke("platform:detectBackends"),
    isPackaged: () => invoke("app:isPackaged"),
    onMaximizeChange: () => () => {},
    openDirectory: () => invoke("dialog:openDirectory"),
    detachProject: (projectDir: string) => invoke("window:detachProject", projectDir),
    getDetachedProject: () => new URLSearchParams(window.location.search).get("detach"),
    getDetachedProjects: () => invoke("window:getDetachedProjects"),
    onDetachedProjectsChange: () => () => {},
    openExternal: (url: string) => invoke("shell:openExternal", url),
    updates: {
      getState: async () => ({ status: "idle" }),
      check: async () => undefined,
      download: async () => undefined,
      install: async () => undefined,
      onStateChanged: () => () => {},
    },
    openInFileBrowser: (dirPath: string, command = "") =>
      invoke("shell:openInFileBrowser", dirPath, command),
    openInTerminal: (dirPath: string, command = "") =>
      invoke("shell:openInTerminal", dirPath, command),
    getHomeDir: () => invoke("platform:homeDir"),
    installBackend: (backendId: AgentBackendId) => invoke("backend:install", backendId),
    onInstallProgress: (callback: (progress: InstallProgress) => void) =>
      on("backend:install-progress", callback as Listener),
    worktree: {
      detectSetup: (worktreePath: string) => invoke("worktree:detect-setup", worktreePath),
      runSetup: (worktreePath: string, command: string) =>
        invoke("worktree:run-setup", worktreePath, command),
    },
    git: {
      isRepo: (directory: string) => invoke("git:is-repo", directory),
      listBranches: (directory: string) => invoke("git:branch:list", directory),
      currentBranch: (directory: string) => invoke("git:current-branch", directory),
      listWorktrees: (directory: string) => invoke("git:worktree:list", directory),
      addWorktree: (
        directory: string,
        worktreePath: string,
        branch: string,
        isNewBranch: boolean,
      ) => invoke("git:worktree:add", directory, worktreePath, branch, isNewBranch),
      removeWorktree: (directory: string, worktreePath: string) =>
        invoke("git:worktree:remove", directory, worktreePath),
      merge: (directory: string, branch: string) => invoke("git:merge", directory, branch),
      mergeAbort: (directory: string) => invoke("git:merge:abort", directory),
      getRemoteUrl: (directory: string) => invoke("git:remote:url", directory),
    },
  };

  window.electronAPI = api as unknown as ElectronAPI;
}
