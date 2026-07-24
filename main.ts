import type { BrowserWindow as BrowserWindowType, WebContents } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain, shell, session } =
  require("electron") as typeof import("electron");
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { createSettingsStore } from "./settings-store.js";
import { createBackendSidecarController } from "./main/backend-sidecar.js";
import { broadcastToAllWindows } from "./lib/window-broadcast.js";
import { findFilesInDirectory } from "./server/services/file-search.js";
import {
  defaultTerminalInvocation,
  desktopWindowFrameOptions,
  installDesktopChromiumSwitches,
  installWebNavigationPolicy,
  isWebUrl,
} from "./main/desktop-shell.js";
import { bootstrapDesktopApp } from "./main/desktop-bootstrap.js";
import { createDesktopUpdateController } from "./main/update-controller.js";
import pkg from "./package.json" with { type: "json" };
import {
  assertBackendFetchRequest,
  assertProjectPath,
  registerValidatedIpcHandler,
} from "./main/ipc-security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("OpenGUI");
app.setPath("userData", path.join(app.getPath("appData"), "OpenGUI"));
// Keep Chromium compositor tiles and the native window backing store aligned.
// Without this, macOS can color-convert only some 256px GPU tiles and show
// horizontal dark bands inside an otherwise opaque frameless window.
installDesktopChromiumSwitches(process.platform, app.commandLine);

const DEV_SERVER_URL = process.env.OPENGUI_DEV_SERVER_URL || "http://localhost:3000";
const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";
const APP_ENTRY_URL = isDev
  ? DEV_SERVER_URL
  : new URL(`file://${path.join(__dirname, "..", "dist", "index.html")}`).href;
const settingsStore = createSettingsStore(app.getPath("userData"));
const backendSidecar = createBackendSidecarController({
  app,
  settingsStore,
  isDev,
  devServerUrl: DEV_SERVER_URL,
  onStatusChange: (status) => {
    broadcastToAllWindows("backend:status-changed", status);
  },
});
const desktopUpdates = createDesktopUpdateController({
  updater: autoUpdater,
  currentVersion: pkg.version,
  isPackaged: app.isPackaged,
  platform: process.platform,
  publish: (state) => broadcastToAllWindows("update:state-changed", state),
});

let mainWindow: BrowserWindowType | null = null;

function broadcastSettingsChange(key: string, value: unknown) {
  broadcastToAllWindows("settings:changed", { key, value });
}

function parseCommand(command: unknown): string[] {
  if (typeof command !== "string") return [];
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!matches) return [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ""));
}

function isGhostty(cmd: string | undefined) {
  if (!cmd) return false;
  return cmd.trim().split(/\s+/)[0] === "ghostty";
}

function spawnCustomCommand(command: unknown, options: SpawnOptions = {}) {
  const parts = parseCommand(command);
  if (parts.length === 0) return false;
  const [cmd, ...args] = parts;
  if (!cmd) return false;
  const child = spawn(cmd, args, options);
  child.on("error", () => {});
  child.unref();
  return true;
}

function getDesktopTerminalCommand() {
  const gsettingsKeys = [
    "org.cinnamon.desktop.default-applications.terminal exec",
    "org.gnome.desktop.default-applications.terminal exec",
  ];

  for (const key of gsettingsKeys) {
    try {
      const raw = execSync(`gsettings get ${key}`, {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const terminal = raw.replace(/^'|'$/g, "");
      if (terminal && terminal !== "x-terminal-emulator") return terminal;
    } catch {
      // gsettings schema not available, try next
    }
  }

  return null;
}

function getLinuxTerminalCandidates(dirPath: string): string[][] {
  return [
    getDesktopTerminalCommand(),
    process.env.TERMINAL,
    "x-terminal-emulator",
    ["gnome-terminal", "--working-directory", dirPath],
    ["konsole", "--workdir", dirPath],
    ["xfce4-terminal", "--working-directory", dirPath],
    ["alacritty", "--working-directory", dirPath],
    ["kitty", "-d", dirPath],
    ["wezterm", "start", "--cwd", dirPath],
    "xterm",
    ["ghostty", "--working-directory", dirPath],
  ]
    .filter(Boolean)
    .map((candidate) => (Array.isArray(candidate) ? candidate : parseCommand(candidate)))
    .filter((candidate): candidate is string[] => Array.isArray(candidate) && candidate.length > 0);
}

function trySpawnCandidates(candidates: string[][], options: SpawnOptions) {
  const tryNext = (index: number) => {
    if (index >= candidates.length) return;
    const candidate = candidates[index];
    if (!candidate) return;
    const [cmd, ...args] = candidate;
    if (!cmd) return;
    const child = spawn(cmd, args, options);
    child.on("error", () => tryNext(index + 1));
    child.unref();
  };
  tryNext(0);
}

function openLinuxTerminal(dirPath: string, spawnOpts: SpawnOptions) {
  trySpawnCandidates(getLinuxTerminalCandidates(dirPath), spawnOpts);
}

function createBrowserWindow({
  width,
  height,
  minWidth = 450,
  minHeight = 500,
}: {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
}) {
  const win = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    show: false,
    frame: false,
    ...desktopWindowFrameOptions(process.platform),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  installWebNavigationPolicy({
    webContents: win.webContents,
    appEntryUrl: APP_ENTRY_URL,
    openExternal: (url) => shell.openExternal(url),
  });

  win.on("maximize", () => {
    win.webContents.send("window:maximizeChanged", true);
  });

  win.on("unmaximize", () => {
    win.webContents.send("window:maximizeChanged", false);
  });

  return win;
}

function createWindow() {
  const win = createBrowserWindow({ width: 1200, height: 800 });
  mainWindow = win;

  if (isDev) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  win.once("ready-to-show", () => {
    win.show();
  });
}

function installDevNetworkFailureLogging() {
  if (!isDev) return;
  const seen = new Set<string>();
  session.defaultSession.webRequest.onCompleted((details) => {
    if (details.statusCode < 400) return;
    const key = `${details.method} ${details.url} ${details.statusCode}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.error(
      `[net] FAILED ${details.method} ${details.url} -> ${details.statusCode} ${details.statusLine}`,
    );
  });
  session.defaultSession.webRequest.onErrorOccurred((details) => {
    // SSE/EventSource connections are intentionally long-lived and are often
    // reported by Chromium as ERR_ABORTED/ERR_FAILED during teardown or
    // workspace switches. The renderer owns retry/error handling for these;
    // do not treat their lifecycle as failed HTTP requests in dev logging.
    if (details.url.includes("/api/events/")) return;
    // Chromium can issue a cache-only font revalidation while Vite replaces a
    // stylesheet during HMR. The font remains available from Vite and the page
    // already has the loaded face, so this is not an actionable network error.
    if (details.error === "net::ERR_CACHE_MISS" && details.url.endsWith(".woff2")) return;
    const key = `${details.method} ${details.url} ${details.error}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.error(`[net] ERROR ${details.method} ${details.url} -> ${details.error}`);
  });
}

/** Track detached project windows so we can detect duplicates and clean up. */
const detachedWindows = new Map<string, BrowserWindowType>(); // projectDir -> BrowserWindow

function getDetachedProjectDirectories() {
  return Array.from(detachedWindows.entries())
    .filter(([, win]) => win && !win.isDestroyed())
    .map(([projectDir]) => projectDir);
}

function broadcastDetachedProjects() {
  broadcastToAllWindows("window:detachedProjectsChanged", getDetachedProjectDirectories());
}

function createProjectWindow(projectDir: string) {
  // Reuse existing detached window if one already exists for this project
  const existing = detachedWindows.get(projectDir);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    broadcastDetachedProjects();
    return;
  }

  const win = createBrowserWindow({ width: 900, height: 700 });

  detachedWindows.set(projectDir, win);

  const projectLabel = projectDir.split(/[\\/]/).pop() || projectDir;
  win.setTitle(`OpenGUI - ${projectLabel}`);

  const loadUrl = isDev
    ? `${DEV_SERVER_URL}?detach=${encodeURIComponent(projectDir)}`
    : `file://${path.join(__dirname, "..", "dist", "index.html")}?detach=${encodeURIComponent(projectDir)}`;

  void win.loadURL(loadUrl);

  win.once("ready-to-show", () => {
    win.show();
    broadcastDetachedProjects();
  });

  win.on("closed", () => {
    detachedWindows.delete(projectDir);
    broadcastDetachedProjects();
  });

  return win;
}

// IPC handlers
ipcMain.on("settings:get-all-sync", (event) => {
  event.returnValue = settingsStore.getAll();
});

ipcMain.on("settings:get-sync", (event, key) => {
  event.returnValue = settingsStore.get(key);
});

ipcMain.on("settings:set-sync", (event, key, value) => {
  const success = settingsStore.set(key, value);
  if (success) broadcastSettingsChange(key, value);
  event.returnValue = success;
});

ipcMain.on("settings:remove-sync", (event, key) => {
  const success = settingsStore.remove(key);
  if (success) broadcastSettingsChange(key, null);
  event.returnValue = success;
});

ipcMain.on("settings:merge-sync", (event, entries) => {
  let success = false;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    success = settingsStore.merge(entries);
    if (success) {
      for (const [key, value] of Object.entries(entries)) {
        if (typeof key === "string" && typeof value === "string") {
          broadcastSettingsChange(key, value);
        }
      }
    }
  }
  event.returnValue = success;
});

ipcMain.handle("settings:set", (_event, key, value) => {
  const success = settingsStore.set(key, value);
  if (success) broadcastSettingsChange(key, value);
  return success;
});

ipcMain.handle("settings:remove", (_event, key) => {
  const success = settingsStore.remove(key);
  if (success) broadcastSettingsChange(key, null);
  return success;
});

ipcMain.on("backend:get-config-sync", (event) => {
  const config = backendSidecar.getConfig();
  event.returnValue = {
    kind: "electron",
    backendUrl: config?.url ?? null,
    backendToken: config?.token ?? null,
    backendStatus: backendSidecar.getStatus(),
  };
});

ipcMain.handle("backend:restart-managed", async () => {
  const config = await backendSidecar.restart();
  return {
    url: config.url,
    token: config.token,
    status: backendSidecar.getStatus(),
  };
});

registerValidatedIpcHandler({
  ipcMain,
  channel: "backend:fetch",
  appEntryUrl: APP_ENTRY_URL,
  validate: (request) => request,
  handler: async (rawRequest) => {
    const config = backendSidecar.getConfig() ?? (await backendSidecar.start());
    const request = assertBackendFetchRequest(rawRequest, config.url);
    const headers = new Headers(request.headers);
    if (config.token) headers.set("authorization", `Bearer ${config.token}`);
    const response = await fetch(new URL(request.url, config.url), {
      method: request.method,
      headers,
      body: request.body,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  },
});

const backendEventSubscriptions = new Map<number, AbortController>();

async function subscribeBackendEventsForWebContents(webContents: WebContents) {
  const existing = backendEventSubscriptions.get(webContents.id);
  if (existing) return;

  const config = backendSidecar.getConfig() ?? (await backendSidecar.start());
  const controller = new AbortController();
  backendEventSubscriptions.set(webContents.id, controller);

  webContents.once("destroyed", () => {
    controller.abort();
    backendEventSubscriptions.delete(webContents.id);
  });

  void (async () => {
    try {
      const url = new URL("/api/events/v2", config.url);
      const headers = new Headers();
      if (config.token) headers.set("authorization", `Bearer ${config.token}`);
      const response = await fetch(url, { headers, signal: controller.signal });
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = chunk
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice("data: ".length))
            .join("\n");
          if (data && !webContents.isDestroyed()) {
            try {
              webContents.send("backend:event", JSON.parse(data));
            } catch {
              console.warn("Skipping malformed SSE event from backend");
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("Backend IPC event proxy failed", error);
    } finally {
      backendEventSubscriptions.delete(webContents.id);
    }
  })();
}

ipcMain.handle("backend:events-subscribe", async (event) => {
  await subscribeBackendEventsForWebContents(event.sender);
  return true;
});

ipcMain.handle("backend:events-unsubscribe", (event) => {
  backendEventSubscriptions.get(event.sender.id)?.abort();
  backendEventSubscriptions.delete(event.sender.id);
  return true;
});

ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle("window:maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) {
    win.unmaximize();
  } else {
    win?.maximize();
  }
});

ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("window:isMaximized", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win?.isMaximized() ?? false;
});

ipcMain.handle("window:focus", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.focus();
});

registerValidatedIpcHandler({
  ipcMain,
  channel: "window:detachProject",
  appEntryUrl: APP_ENTRY_URL,
  validate: (projectDir) => assertProjectPath(projectDir, process.platform),
  handler: (projectDir) => createProjectWindow(projectDir),
});

ipcMain.handle("window:getDetachedProjects", () => {
  return getDetachedProjectDirectories();
});

ipcMain.handle("platform:get", () => {
  return process.platform;
});

ipcMain.handle("platform:locale", () => {
  return app.getLocale();
});

ipcMain.handle("app:isPackaged", () => {
  return app.isPackaged;
});

registerValidatedIpcHandler({
  ipcMain,
  channel: "update:get-state",
  appEntryUrl: APP_ENTRY_URL,
  validate: () => undefined,
  handler: () => desktopUpdates.getState(),
});
registerValidatedIpcHandler({
  ipcMain,
  channel: "update:check",
  appEntryUrl: APP_ENTRY_URL,
  validate: () => undefined,
  handler: () => desktopUpdates.check(),
});
registerValidatedIpcHandler({
  ipcMain,
  channel: "update:download",
  appEntryUrl: APP_ENTRY_URL,
  validate: () => undefined,
  handler: () => desktopUpdates.download(),
});
registerValidatedIpcHandler({
  ipcMain,
  channel: "update:install",
  appEntryUrl: APP_ENTRY_URL,
  validate: () => undefined,
  handler: () => desktopUpdates.install(),
});

ipcMain.handle("platform:homeDir", () => {
  return homedir();
});

// Open a URL in the system browser (not in Electron)
registerValidatedIpcHandler({
  ipcMain,
  channel: "shell:openExternal",
  appEntryUrl: APP_ENTRY_URL,
  validate: (url) => {
    if (!isWebUrl(url)) throw new TypeError("Invalid external URL");
    return url;
  },
  handler: (url) => shell.openExternal(url),
});

// Open a directory in the system file browser
registerValidatedIpcHandler({
  ipcMain,
  channel: "shell:openInFileBrowser",
  appEntryUrl: APP_ENTRY_URL,
  validate: (dirPath, command = "") => {
    if (typeof command !== "string" || command.length > 4_096 || command.includes("\0")) {
      throw new TypeError("Invalid file browser command");
    }
    return { dirPath: assertProjectPath(dirPath, process.platform), command };
  },
  handler: ({ dirPath, command }) => {
    const spawnOpts: SpawnOptions = { detached: true, stdio: "ignore", cwd: dirPath };
    const parts = parseCommand(command);
    if (parts.length > 0) {
      const [cmd, ...args] = parts;
      if (!cmd) return;
      const child = spawn(cmd, args.length > 0 ? args : [dirPath], spawnOpts);
      child.on("error", () => {
        void shell.openPath(dirPath);
      });
      child.unref();
      return;
    }
    void shell.openPath(dirPath);
  },
});

// Open a terminal at a directory (cross-platform)
registerValidatedIpcHandler({
  ipcMain,
  channel: "shell:openInTerminal",
  appEntryUrl: APP_ENTRY_URL,
  validate: (dirPath, command = "") => {
    if (typeof command !== "string" || command.length > 4_096 || command.includes("\0")) {
      throw new TypeError("Invalid terminal command");
    }
    return { dirPath: assertProjectPath(dirPath, process.platform), command };
  },
  handler: ({ dirPath, command }) => {
    const platform = process.platform;
    const spawnOpts: SpawnOptions = { detached: true, stdio: "ignore", cwd: dirPath };
    // Custom terminal handling – special case for Ghostty
    if (command) {
      const parts = parseCommand(command);
      const [cmd, ...args] = parts;
      if (!cmd) return;
      if (isGhostty(cmd)) {
        // Ghostty requires explicit --working-directory flag
        spawn(cmd, [...args, "--working-directory", dirPath], spawnOpts).unref();
        return;
      }
      if (spawnCustomCommand(command, spawnOpts)) return;
    }
    const invocation = defaultTerminalInvocation(platform, dirPath);
    if (invocation) {
      spawn(invocation.command, invocation.args, { ...spawnOpts, shell: invocation.shell });
    } else {
      openLinuxTerminal(dirPath, spawnOpts);
    }
  },
});

ipcMain.handle("dialog:openDirectory", async (event) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, {
        properties: ["openDirectory", "createDirectory"],
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
});

registerValidatedIpcHandler({
  ipcMain,
  channel: "files:find",
  appEntryUrl: APP_ENTRY_URL,
  validate: (directory, query) => {
    if (typeof query !== "string" || query.length > 1_000 || query.includes("\0")) {
      throw new TypeError("Invalid file search query");
    }
    return { directory: assertProjectPath(directory, process.platform), query };
  },
  handler: async ({ directory, query }) => await findFilesInDirectory(directory, query),
});

void bootstrapDesktopApp({
  app,
  platform: process.platform,
  backend: backendSidecar,
  createWindow,
  getAllWindows: () => BrowserWindow.getAllWindows(),
  installReadyIntegrations: () => {
    installDevNetworkFailureLogging();
    void desktopUpdates.check();
  },
  showStartupError: (error) =>
    dialog.showErrorBox("OpenGUI backend failed to start", error.message),
  reportShutdownError: (error) => console.error("Failed to stop Desktop Host", error),
});
