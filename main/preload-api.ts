import type { ElectronAPI } from "../src/types/preload-api";
import type { SettingsBridgeChange } from "../src/types/settings";
import type { AppUpdateState, DesktopBackendStatus } from "../src/types/shell";

type Listener<T = unknown> = (data: T) => void;

export interface PreloadIpc {
  sendSync(channel: string, ...args: unknown[]): unknown;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, data: never) => void): void;
  removeListener(channel: string, listener: (event: unknown, data: never) => void): void;
}

type BackendConfigSync = Pick<
  ElectronAPI,
  "kind" | "backendUrl" | "backendToken" | "backendStatus"
>;

export function createDisabledUpdateState(currentVersion: string): AppUpdateState {
  return {
    status: "disabled",
    platformSupported: false,
    currentVersion,
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
}

export function createElectronAPI(input: {
  ipc: PreloadIpc;
  locationSearch: string;
  currentVersion: string;
  reportSubscriptionError?: (error: unknown) => void;
}): ElectronAPI {
  const { ipc } = input;
  const backendConfig = ipc.sendSync("backend:get-config-sync") as BackendConfigSync;
  const invoke = <T extends (...args: never[]) => Promise<unknown>>(channel: string): T =>
    ((...args: never[]) => ipc.invoke(channel, ...args)) as T;
  const listen = <T>(channel: string, callback: Listener<T>) => {
    const handler = (_event: unknown, data: T) => callback(data);
    ipc.on(channel, handler as (event: unknown, data: never) => void);
    return () => ipc.removeListener(channel, handler as (event: unknown, data: never) => void);
  };

  return {
    kind: backendConfig.kind ?? "electron",
    backendUrl: backendConfig.backendUrl ?? null,
    backendToken: backendConfig.backendToken ?? null,
    backendStatus: backendConfig.backendStatus ?? "stopped",
    settings: {
      getAllSync: () => ipc.sendSync("settings:get-all-sync") as Record<string, string>,
      getSync: (key) => ipc.sendSync("settings:get-sync", key) as string | null,
      setSync: (key, value) => ipc.sendSync("settings:set-sync", key, value) as boolean,
      removeSync: (key) => ipc.sendSync("settings:remove-sync", key) as boolean,
      mergeSync: (entries) => ipc.sendSync("settings:merge-sync", entries) as boolean,
      set: invoke("settings:set"),
      remove: invoke("settings:remove"),
      onDidChange: (callback: Listener<SettingsBridgeChange>) =>
        listen("settings:changed", callback),
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
    restartBackend: invoke("backend:restart-managed"),
    backendFetch: invoke("backend:fetch"),
    onMaximizeChange: (callback) => listen("window:maximizeChanged", callback),
    onBackendStatusChange: (callback: Listener<DesktopBackendStatus>) =>
      listen("backend:status-changed", callback),
    subscribeBackendEvents: (callback) => {
      const remove = listen("backend:event", callback);
      void ipc
        .invoke("backend:events-subscribe")
        .catch(input.reportSubscriptionError ?? (() => undefined));
      return () => {
        remove();
        void ipc.invoke("backend:events-unsubscribe").catch(() => undefined);
      };
    },
    openDirectory: invoke("dialog:openDirectory"),
    detachProject: invoke("window:detachProject"),
    getDetachedProject: () => new URLSearchParams(input.locationSearch).get("detach"),
    getDetachedProjects: invoke("window:getDetachedProjects"),
    onDetachedProjectsChange: (callback) => listen("window:detachedProjectsChanged", callback),
    openExternal: invoke("shell:openExternal"),
    updates: {
      isManaged: true,
      getState: invoke("update:get-state"),
      check: invoke("update:check"),
      download: invoke("update:download"),
      install: invoke("update:install"),
      onStateChanged: (callback) => listen("update:state-changed", callback),
    },
    openInFileBrowser: invoke("shell:openInFileBrowser"),
    openInTerminal: invoke("shell:openInTerminal"),
  };
}
