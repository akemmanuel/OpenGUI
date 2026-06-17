import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AppUpdateState,
  DesktopBackendStatus,
  ElectronAPI,
  SettingsBridgeChange,
} from "./src/types/electron";

type Listener<T = unknown> = (data: T) => void;

type BackendConfigSync = Pick<
  ElectronAPI,
  "kind" | "backendUrl" | "backendToken" | "backendStatus"
>;

function invoke<T extends (...args: never[]) => Promise<unknown>>(channel: string): T {
  return ((...args: never[]) => ipcRenderer.invoke(channel, ...args)) as T;
}

const backendConfig = ipcRenderer.sendSync("backend:get-config-sync") as BackendConfigSync;

const disabledUpdateState: AppUpdateState = {
  status: "disabled",
  platformSupported: false,
  currentVersion: "0.0.0",
  latestVersion: null,
  releaseDate: null,
  releaseNotes: null,
  releaseName: null,
  releaseUrl: null,
  progressPercent: null,
  bytesPerSecond: null,
  transferred: null,
  total: null,
  errorMessage: null,
  downloaded: false,
  autoDownload: false,
  updateInfoFetched: false,
};

const electronAPI: ElectronAPI = {
  kind: backendConfig.kind ?? "electron",
  backendUrl: backendConfig.backendUrl ?? null,
  backendToken: backendConfig.backendToken ?? null,
  backendStatus: backendConfig.backendStatus ?? "stopped",
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
  focus: invoke("window:focus"),
  getPlatform: invoke("platform:get"),
  getSystemLocale: invoke("platform:locale"),
  isPackaged: invoke("app:isPackaged"),
  getHomeDir: invoke("platform:homeDir"),
  getHarnessInventories: invoke("platform:harnessInventory"),
  restartBackend: invoke("backend:restart-managed"),
  backendFetch: invoke("backend:fetch"),
  onMaximizeChange: (callback: Listener<boolean>) => {
    const handler = (_event: IpcRendererEvent, isMaximized: boolean) => callback(isMaximized);
    ipcRenderer.on("window:maximizeChanged", handler);
    return () => {
      ipcRenderer.removeListener("window:maximizeChanged", handler);
    };
  },
  onBackendStatusChange: (callback: Listener<DesktopBackendStatus>) => {
    const handler = (_event: IpcRendererEvent, status: DesktopBackendStatus) => callback(status);
    ipcRenderer.on("backend:status-changed", handler);
    return () => {
      ipcRenderer.removeListener("backend:status-changed", handler);
    };
  },
  subscribeBackendEvents: (callback: Listener<{ channel?: string; data?: unknown }>) => {
    const handler = (_event: IpcRendererEvent, message: { channel?: string; data?: unknown }) =>
      callback(message);
    ipcRenderer.on("backend:event", handler);
    ipcRenderer.invoke("backend:events-subscribe").catch((error) => {
      console.error("Failed to subscribe to backend events", error);
    });
    return () => {
      ipcRenderer.removeListener("backend:event", handler);
      ipcRenderer.invoke("backend:events-unsubscribe").catch(() => undefined);
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
    getState: async () => disabledUpdateState,
    check: async () => disabledUpdateState,
    download: async () => disabledUpdateState,
    install: async () => false,
    onStateChanged: () => () => {},
  },

  openInFileBrowser: invoke("shell:openInFileBrowser"),
  openInTerminal: invoke("shell:openInTerminal"),
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
