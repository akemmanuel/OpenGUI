import type {
  AppUpdateState,
  DesktopBackendStatus,
  ElectronAPI,
  InstalledPluginInfo,
  IPCResult,
  PluginCatalogAuditResponse,
  PluginCatalogCuratedResponse,
  PluginCatalogDetailResponse,
  PluginCatalogListResponse,
  PluginCatalogSearchResponse,
} from "@/types/electron";

type InstallProgressEvent = { chunk: string; type: "stdout" | "stderr" | "system" };

export interface ShellSkillsApi {
  list(directory?: string): Promise<InstalledPluginInfo[]>;
  marketplace: {
    list(
      view?: string,
      page?: number,
      perPage?: number,
      apiKey?: string,
    ): Promise<PluginCatalogListResponse>;
    search(query: string, limit?: number, apiKey?: string): Promise<PluginCatalogSearchResponse>;
    detail(source: string, slug: string, apiKey?: string): Promise<PluginCatalogDetailResponse>;
    audit(source: string, slug: string, apiKey?: string): Promise<PluginCatalogAuditResponse>;
    curated(apiKey?: string): Promise<PluginCatalogCuratedResponse>;
  };
  install(
    source: string,
    directory?: string,
    globalScope?: boolean,
  ): Promise<{ exitCode?: number }>;
  remove(
    skillName: string,
    directory?: string,
    globalScope?: boolean,
  ): Promise<{ exitCode?: number }>;
  update(
    skillName?: string,
    directory?: string,
    globalScope?: boolean,
  ): Promise<{ exitCode?: number }>;
  listInstalled(directory?: string): Promise<InstalledPluginInfo[]>;
  checkCli(): Promise<{ available: boolean; command: string | null }>;
  onInstallProgress(callback: (data: InstallProgressEvent) => void): () => void;
}

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
  skills: ShellSkillsApi;
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

function unwrapRpcResult<T>(value: T | IPCResult<T>, fallback: string): T {
  if (
    value &&
    typeof value === "object" &&
    "success" in value &&
    typeof (value as IPCResult<T>).success === "boolean"
  ) {
    const result = value as IPCResult<T>;
    if (!result.success) throw new Error(result.error || fallback);
    return result.data as T;
  }
  return value as T;
}

function createSkillsApi(input: {
  rpc<T>(channel: string, args?: unknown[]): Promise<T>;
  onBackendChannel<T = unknown>(channel: string, callback: (data: T) => void): () => void;
}): ShellSkillsApi {
  const call = async <T>(
    channel: string,
    args: unknown[] = [],
    fallback = "Plugin operation failed",
  ) => unwrapRpcResult(await input.rpc<T | IPCResult<T>>(channel, args), fallback);

  return {
    list: (directory) => call("skills:list-installed", [directory], "Failed to list plugins"),
    marketplace: {
      list: (view, page, perPage, apiKey) =>
        call(
          "skills:marketplace:list",
          [view, page, perPage, apiKey],
          "Failed to list plugin catalog entries",
        ),
      search: (query, limit, apiKey) =>
        call(
          "skills:marketplace:search",
          [query, limit, apiKey],
          "Failed to search plugin catalog entries",
        ),
      detail: (source, slug, apiKey) =>
        call(
          "skills:marketplace:detail",
          [source, slug, apiKey],
          "Failed to load plugin catalog entry",
        ),
      audit: (source, slug, apiKey) =>
        call(
          "skills:marketplace:audit",
          [source, slug, apiKey],
          "Failed to audit plugin catalog entry",
        ),
      curated: (apiKey) =>
        call(
          "skills:marketplace:curated",
          [apiKey],
          "Failed to load curated plugin catalog entries",
        ),
    },
    install: (source, directory, globalScope) =>
      call("skills:install", [source, directory, globalScope], "Failed to install plugin"),
    remove: (skillName, directory, globalScope) =>
      call("skills:remove", [skillName, directory, globalScope], "Failed to remove plugin"),
    update: (skillName, directory, globalScope) =>
      call("skills:update", [skillName, directory, globalScope], "Failed to update plugin"),
    listInstalled: (directory) =>
      call("skills:list-installed", [directory], "Failed to list installed plugins"),
    checkCli: () => call("skills:check-cli", [], "Failed to check plugins CLI"),
    onInstallProgress: (callback) =>
      input.onBackendChannel<InstallProgressEvent>("skills:install-progress", callback),
  };
}

async function webRpc<T>(channel: string, args: unknown[] = []) {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, args }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error || `RPC failed: ${channel}`);
  return body.value as T;
}

export function createElectronDesktopShell(api: ElectronAPI): DesktopShellClient {
  const rpc = async <T>(channel: string, args: unknown[] = []) => {
    const baseUrl = api.backendUrl?.replace(/\/+$/, "");
    if (!baseUrl) throw new Error(`Desktop backend is not available: ${channel}`);
    if (api.backendFetch) {
      const response = await api.backendFetch({
        url: `${baseUrl}/api/rpc`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, args }),
      });
      const body = JSON.parse(response.body || "null");
      if (response.status < 200 || response.status >= 300 || !body?.ok) {
        throw new Error(body?.error || `RPC failed: ${channel}`);
      }
      return body.value as T;
    }
    return await webRpc<T>(channel, args);
  };

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
    skills: createSkillsApi({
      rpc,
      onBackendChannel: (channel, callback) => subscribeToRawBackendChannel(api, channel, callback),
    }),
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
    skills: createSkillsApi({
      rpc: webRpc,
      onBackendChannel: (channel, callback) => {
        const stream = new EventSource("/api/events");
        stream.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message?.channel === channel) callback(message.data);
          } catch (error) {
            console.error("Bad web event payload", error);
          }
        };
        return () => stream.close();
      },
    }),
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
