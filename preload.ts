import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  ClaudeCodeBridge,
  CodexBridge,
  ElectronAPI,
  InstallProgress,
  OpenCodeBridge,
  PiBridge,
  SettingsBridgeChange,
  AppUpdateState,
} from "./src/types/electron";

type Listener<T = unknown> = (data: T) => void;

type BridgeApiOptions = {
  rendererReady?: boolean;
  extraInvoke?: Record<string, string>;
};

type DynamicBridgeApi = Record<
  string,
  ((...args: never[]) => Promise<unknown>) | ((callback: Listener) => () => void)
>;

function invoke<T extends (...args: never[]) => Promise<unknown>>(channel: string): T {
  return ((...args: never[]) => ipcRenderer.invoke(channel, ...args)) as T;
}

function createBridgeApi<T>(prefix: string, options: BridgeApiOptions = {}): T {
  const api: DynamicBridgeApi = {
    addProject: invoke(`${prefix}:project:add`),
    removeProject: invoke(`${prefix}:project:remove`),
    disconnect: invoke(`${prefix}:disconnect`),
    listSessions: invoke(`${prefix}:session:list`),
    createSession: invoke(`${prefix}:session:create`),
    deleteSession: invoke(`${prefix}:session:delete`),
    updateSession: invoke(`${prefix}:session:update`),
    getSessionStatuses: invoke(`${prefix}:session:statuses`),
    forkSession: invoke(`${prefix}:session:fork`),
    getProviders: invoke(`${prefix}:providers`),
    getAgents: invoke(`${prefix}:agents`),
    getCommands: invoke(`${prefix}:commands`),
    getMessages: invoke(`${prefix}:messages`),
    startSession: invoke(`${prefix}:session:start`),
    prompt: invoke(`${prefix}:prompt`),
    abort: invoke(`${prefix}:abort`),
    respondPermission: invoke(`${prefix}:permission`),
    sendCommand: invoke(`${prefix}:command:send`),
    summarizeSession: invoke(`${prefix}:session:summarize`),
    findFiles: invoke(`${prefix}:find:files`),
    onEvent: (callback: Listener) => {
      if (options.rendererReady) ipcRenderer.send(`${prefix}:renderer-ready`);
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(`${prefix}:bridge-event`, handler);
      return () => {
        ipcRenderer.removeListener(`${prefix}:bridge-event`, handler);
      };
    },
  };

  for (const [name, channel] of Object.entries(options.extraInvoke ?? {})) {
    api[name] = invoke(`${prefix}:${channel}`);
  }

  return api as T;
}

const electronAPI: ElectronAPI = {
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

  claudeCode: createBridgeApi<ClaudeCodeBridge>("claude-code", { rendererReady: true }),
  pi: createBridgeApi<PiBridge>("pi"),
  codex: createBridgeApi<CodexBridge>("codex"),
  opencode: createBridgeApi<OpenCodeBridge>("opencode", {
    extraInvoke: {
      revertSession: "session:revert",
      unrevertSession: "session:unrevert",
      listAllProviders: "provider:list",
      getProviderAuthMethods: "provider:auth-methods",
      connectProvider: "provider:connect",
      disconnectProvider: "provider:disconnect",
      oauthAuthorize: "provider:oauth:authorize",
      oauthCallback: "provider:oauth:callback",
      disposeInstance: "instance:dispose",
      replyQuestion: "question:reply",
      rejectQuestion: "question:reject",
      getMcpStatus: "mcp:status",
      addMcp: "mcp:add",
      connectMcp: "mcp:connect",
      disconnectMcp: "mcp:disconnect",
      getConfig: "config:get",
      updateConfig: "config:update",
      getSkills: "skills",
      startServer: "server:start",
      stopServer: "server:stop",
      getServerStatus: "server:status",
      marketplaceList: "skills:marketplace:list",
      marketplaceSearch: "skills:marketplace:search",
      marketplaceDetail: "skills:marketplace:detail",
      marketplaceAudit: "skills:marketplace:audit",
      marketplaceCurated: "skills:marketplace:curated",
      installSkill: "skills:install",
      removeSkill: "skills:remove",
      updateSkill: "skills:update",
      listInstalledSkills: "skills:list-installed",
      checkSkillsCli: "skills:check-cli",
    },
  }),
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
