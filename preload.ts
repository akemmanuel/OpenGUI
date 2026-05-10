// @ts-nocheck
import { contextBridge, ipcRenderer } from "electron";

const invoke =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);

function createBridgeApi(prefix, options = {}) {
  const api = {
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
    onEvent: (callback) => {
      if (options.rendererReady) ipcRenderer.send(`${prefix}:renderer-ready`);
      const handler = (_event, data) => callback(data);
      ipcRenderer.on(`${prefix}:bridge-event`, handler);
      return () => ipcRenderer.removeListener(`${prefix}:bridge-event`, handler);
    },
  };

  for (const [name, channel] of Object.entries(options.extraInvoke ?? {})) {
    api[name] = invoke(`${prefix}:${String(channel)}`);
  }

  return api;
}

contextBridge.exposeInMainWorld("electronAPI", {
  settings: {
    getAllSync: () => ipcRenderer.sendSync("settings:get-all-sync"),
    getSync: (key) => ipcRenderer.sendSync("settings:get-sync", key),
    setSync: (key, value) => ipcRenderer.sendSync("settings:set-sync", key, value),
    removeSync: (key) => ipcRenderer.sendSync("settings:remove-sync", key),
    mergeSync: (entries) => ipcRenderer.sendSync("settings:merge-sync", entries),
    set: invoke("settings:set"),
    remove: invoke("settings:remove"),
    onDidChange: (callback) => {
      const handler = (_event, change) => callback(change);
      ipcRenderer.on("settings:changed", handler);
      return () => ipcRenderer.removeListener("settings:changed", handler);
    },
  },

  // Window controls
  minimize: invoke("window:minimize"),
  maximize: invoke("window:maximize"),
  close: invoke("window:close"),
  isMaximized: invoke("window:isMaximized"),
  getPlatform: invoke("platform:get"),
  getSystemLocale: invoke("platform:locale"),
  detectBackends: invoke("platform:detectBackends"),
  isPackaged: invoke("app:isPackaged"),
  onMaximizeChange: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on("window:maximizeChanged", handler);
    return () => ipcRenderer.removeListener("window:maximizeChanged", handler);
  },

  // Directory picker
  openDirectory: invoke("dialog:openDirectory"),

  // Detach a project into its own window
  detachProject: invoke("window:detachProject"),

  // Get the detached project directory from the URL query param (empty if not detached)
  getDetachedProject: () => {
    const params = new URLSearchParams(window.location.search);
    return params.get("detach") || null;
  },
  getDetachedProjects: invoke("window:getDetachedProjects"),
  onDetachedProjectsChange: (callback) => {
    const handler = (_event, detachedProjects) => callback(detachedProjects);
    ipcRenderer.on("window:detachedProjectsChanged", handler);
    return () => ipcRenderer.removeListener("window:detachedProjectsChanged", handler);
  },

  // Open a URL in the system browser
  openExternal: invoke("shell:openExternal"),

  updates: {
    getState: invoke("updates:getState"),
    check: invoke("updates:check"),
    download: invoke("updates:download"),
    install: invoke("updates:install"),
    onStateChanged: (callback) => {
      const handler = (_event, nextState) => callback(nextState);
      ipcRenderer.on("updates:state-changed", handler);
      return () => ipcRenderer.removeListener("updates:state-changed", handler);
    },
  },

  // Open a directory in the system file browser
  openInFileBrowser: invoke("shell:openInFileBrowser"),

  // Open a terminal at a directory
  openInTerminal: invoke("shell:openInTerminal"),

  // Home directory (for path abbreviation)
  getHomeDir: invoke("platform:homeDir"),

  // Backend installer – runs allowlisted backend install and streams progress events
  installBackend: invoke("backend:install"),
  onInstallProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("backend:install-progress", handler);
    return () => ipcRenderer.removeListener("backend:install-progress", handler);
  },

  // Worktree setup helpers
  worktree: {
    detectSetup: invoke("worktree:detect-setup"),
    runSetup: invoke("worktree:run-setup"),
  },

  // Git helpers
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

  claudeCode: createBridgeApi("claude-code", { rendererReady: true }),
  pi: createBridgeApi("pi"),
  codex: createBridgeApi("codex"),
  opencode: createBridgeApi("opencode", {
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
    },
  }),
});
