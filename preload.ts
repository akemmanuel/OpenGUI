import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AppUpdateState,
  ElectronAPI,
  InstallProgress,
  SettingsBridgeChange,
} from "./src/types/electron";

type Listener<T = unknown> = (data: T) => void;

function invoke<T extends (...args: never[]) => Promise<unknown>>(channel: string): T {
  return ((...args: never[]) => ipcRenderer.invoke(channel, ...args)) as T;
}

const BACKEND_EVENT_CHANNELS = [
  "opencode:bridge-event",
  "claude-code:bridge-event",
  "pi:bridge-event",
  "codex:bridge-event",
] as const;

const electronAPI: ElectronAPI = {
  openGui: {
    invoke: (channel, args = []) => ipcRenderer.invoke(channel, ...args),
    onBackendEvent: (callback) => {
      const handlers = BACKEND_EVENT_CHANNELS.map((channel) => {
        const handler = (_event: IpcRendererEvent, data: unknown) => callback({ channel, data });
        ipcRenderer.on(channel, handler);
        if (channel === "claude-code:bridge-event") ipcRenderer.send("claude-code:renderer-ready");
        return { channel, handler };
      });
      return () => {
        for (const { channel, handler } of handlers) ipcRenderer.removeListener(channel, handler);
      };
    },
  },
  settings: {
    getAllSync: () => ipcRenderer.sendSync("settings:get-all-sync"),
    getSync: (key: string) => ipcRenderer.sendSync("settings:get-sync", key),
    setSync: (key: string, value: string) => ipcRenderer.sendSync("settings:set-sync", key, value),
    removeSync: (key: string) => ipcRenderer.sendSync("settings:remove-sync", key),
    mergeSync: (entries: Record<string, string>) =>
      ipcRenderer.sendSync("settings:merge-sync", entries),
    set: invoke("settings:set"),
    remove: invoke("settings:remove"),
    onDidChange: (callback: Listener<SettingsBridgeChange>) => {
      const handler = (_event: IpcRendererEvent, change: SettingsBridgeChange) => callback(change);
      ipcRenderer.on("settings:changed", handler);
      return () => {
        ipcRenderer.removeListener("settings:changed", handler);
      };
    },
  },

  minimize: invoke("window:minimize"),
  maximize: invoke("window:maximize"),
  close: invoke("window:close"),
  isMaximized: invoke("window:isMaximized"),
  getPlatform: invoke("platform:get"),
  getSystemLocale: invoke("platform:locale"),
  detectBackends: invoke("platform:detectBackends"),
  isPackaged: invoke("app:isPackaged"),
  onMaximizeChange: (callback: Listener<boolean>) => {
    const handler = (_event: IpcRendererEvent, isMaximized: boolean) => callback(isMaximized);
    ipcRenderer.on("window:maximizeChanged", handler);
    return () => {
      ipcRenderer.removeListener("window:maximizeChanged", handler);
    };
  },

  openDirectory: invoke("dialog:openDirectory"),
  detachProject: invoke("window:detachProject"),
  getDetachedProject: () => new URLSearchParams(window.location.search).get("detach"),
  getDetachedProjects: invoke("window:getDetachedProjects"),
  onDetachedProjectsChange: (callback: Listener<string[]>) => {
    const handler = (_event: IpcRendererEvent, detachedProjects: string[]) =>
      callback(detachedProjects);
    ipcRenderer.on("window:detachedProjectsChanged", handler);
    return () => {
      ipcRenderer.removeListener("window:detachedProjectsChanged", handler);
    };
  },

  openExternal: invoke("shell:openExternal"),
  updates: {
    getState: invoke("updates:getState"),
    check: invoke("updates:check"),
    download: invoke("updates:download"),
    install: invoke("updates:install"),
    onStateChanged: (callback: Listener<AppUpdateState>) => {
      const handler = (_event: IpcRendererEvent, nextState: AppUpdateState) => callback(nextState);
      ipcRenderer.on("updates:state-changed", handler);
      return () => {
        ipcRenderer.removeListener("updates:state-changed", handler);
      };
    },
  },

  openInFileBrowser: invoke("shell:openInFileBrowser"),
  openInTerminal: invoke("shell:openInTerminal"),
  getHomeDir: invoke("platform:homeDir"),
  installBackend: invoke("backend:install"),
  onInstallProgress: (callback: Listener<InstallProgress>) => {
    const handler = (_event: IpcRendererEvent, data: InstallProgress) => callback(data);
    ipcRenderer.on("backend:install-progress", handler);
    return () => {
      ipcRenderer.removeListener("backend:install-progress", handler);
    };
  },
  onSkillsInstallProgress: (callback: Listener<InstallProgress>) => {
    const handler = (_event: IpcRendererEvent, data: InstallProgress) => callback(data);
    ipcRenderer.on("opencode:skills:install-progress", handler);
    return () => {
      ipcRenderer.removeListener("opencode:skills:install-progress", handler);
    };
  },

  worktree: {
    detectSetup: invoke("worktree:detect-setup"),
    runSetup: invoke("worktree:run-setup"),
  },

  git: {
    isRepo: invoke("git:is-repo"),
    listBranches: invoke("git:branch:list"),
    currentBranch: invoke("git:current-branch"),
    listWorktrees: invoke("git:worktree:list"),
    addWorktree: invoke("git:worktree:add"),
    removeWorktree: invoke("git:worktree:remove"),
    merge: invoke("git:merge"),
    mergeAbort: invoke("git:merge:abort"),
    getRemoteUrl: invoke("git:remote:url"),
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
