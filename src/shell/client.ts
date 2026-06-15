import type { AppUpdateState, DesktopBackendStatus, ElectronAPI } from "@/types/electron";

export interface DesktopShellClient {
  runtime: {
    isElectron: boolean;
  };
  backend?: {
    url: string;
    token?: string | null;
    status: DesktopBackendStatus | null;
    restart(): Promise<void>;
    onStatusChange(callback: (status: DesktopBackendStatus) => void): () => void;
  };
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(callback: (isMaximized: boolean) => void): () => void;
  };
  dialog: {
    openDirectory(): Promise<string | null>;
  };
  navigation: {
    openExternal(url: string): Promise<void>;
  };
  system: {
    openInFileBrowser(dirPath: string, command?: string): Promise<void>;
    openInTerminal(dirPath: string, command?: string): Promise<void>;
  };
  platform: {
    getPlatform(): Promise<string>;
    getSystemLocale(): Promise<string>;
  };
  updates: {
    isManaged: boolean;
    getState(): Promise<AppUpdateState>;
    check(): Promise<AppUpdateState>;
    download(): Promise<AppUpdateState>;
    install(): Promise<boolean>;
    onStateChanged(callback: (state: AppUpdateState) => void): () => void;
  };
  detachedProjects: {
    getCurrent(): string | null;
    getAll(): Promise<string[]>;
    onChange(callback: (detachedProjects: string[]) => void): () => void;
  };
  events: {
    onBackendChannel<T = unknown>(channel: string, callback: (data: T) => void): () => void;
  };
}

const NOOP_UNSUBSCRIBE = () => {};

function createDisabledUpdateState(): AppUpdateState {
  return {
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
}

function rawBackendEventUrl(api: ElectronAPI) {
  if (!api.backendUrl) return null;
  const url = new URL(api.backendUrl);
  url.pathname = "/api/events";
  if (api.backendToken) url.searchParams.set("token", api.backendToken);
  return url.toString();
}

function subscribeToRawBackendChannel<T = unknown>(
  api: ElectronAPI,
  channel: string,
  callback: (data: T) => void,
) {
  const url = rawBackendEventUrl(api);
  if (!url) return NOOP_UNSUBSCRIBE;

  const stream = new EventSource(url);
  stream.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message?.channel === channel) callback(message.data as T);
    } catch (error) {
      console.error("Bad raw backend event payload", error);
    }
  };
  stream.onerror = (error) => {
    console.error("Raw backend event stream error", error);
  };
  return () => stream.close();
}

export function createElectronDesktopShell(api: ElectronAPI): DesktopShellClient {
  return {
    runtime: {
      isElectron: true,
    },
    backend: api.backendUrl
      ? {
          url: api.backendUrl,
          token: api.backendToken ?? null,
          status: api.backendStatus ?? null,
          restart: async () => {
            await api.restartBackend?.();
          },
          onStatusChange: (callback) => api.onBackendStatusChange?.(callback) ?? NOOP_UNSUBSCRIBE,
        }
      : undefined,
    window: {
      minimize: () => api.minimize(),
      maximize: () => api.maximize(),
      close: () => api.close(),
      isMaximized: () => api.isMaximized(),
      onMaximizeChange: (callback) => api.onMaximizeChange(callback),
    },
    dialog: {
      openDirectory: () => api.openDirectory(),
    },
    navigation: {
      openExternal: (url) => api.openExternal(url),
    },
    system: {
      openInFileBrowser: (dirPath, command) => api.openInFileBrowser(dirPath, command),
      openInTerminal: (dirPath, command) => api.openInTerminal(dirPath, command),
    },
    platform: {
      getPlatform: () => api.getPlatform(),
      getSystemLocale: () => api.getSystemLocale(),
    },
    updates: {
      // No native auto-updater: the renderer only checks GitHub releases and
      // shows a dismissible notification dialog.
      isManaged: false,
      getState: () => api.updates.getState(),
      check: () => api.updates.check(),
      download: () => api.updates.download(),
      install: () => api.updates.install(),
      onStateChanged: (callback) => api.updates.onStateChanged(callback),
    },
    detachedProjects: {
      getCurrent: () => api.getDetachedProject(),
      getAll: () => api.getDetachedProjects(),
      onChange: (callback) => api.onDetachedProjectsChange(callback),
    },
    events: {
      onBackendChannel: (channel, callback) => subscribeToRawBackendChannel(api, channel, callback),
    },
  };
}

export function createWebDesktopShell(): DesktopShellClient {
  const disabledUpdateState = createDisabledUpdateState();

  return {
    runtime: {
      isElectron: false,
    },
    backend: undefined,
    window: {
      minimize: async () => {},
      maximize: async () => {},
      close: async () => {},
      isMaximized: async () => false,
      onMaximizeChange: () => NOOP_UNSUBSCRIBE,
    },
    dialog: {
      openDirectory: async () => null,
    },
    navigation: {
      openExternal: async (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    system: {
      openInFileBrowser: async () => {},
      openInTerminal: async () => {},
    },
    platform: {
      getPlatform: async () => "web",
      getSystemLocale: async () => navigator.language,
    },
    updates: {
      isManaged: false,
      getState: async () => disabledUpdateState,
      check: async () => disabledUpdateState,
      download: async () => disabledUpdateState,
      install: async () => false,
      onStateChanged: () => NOOP_UNSUBSCRIBE,
    },
    detachedProjects: {
      getCurrent: () => new URLSearchParams(window.location.search).get("detach"),
      getAll: async () => [],
      onChange: () => NOOP_UNSUBSCRIBE,
    },
    events: {
      onBackendChannel: () => NOOP_UNSUBSCRIBE,
    },
  };
}
