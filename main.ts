import type { BrowserWindow as BrowserWindowType, WebContents } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain, shell, session } =
  require("electron") as typeof import("electron");
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { createSettingsStore } from "./settings-store.js";
import { createBackendSidecarController } from "./main/backend-sidecar.js";
import { broadcastToAllWindows } from "./lib/window-broadcast.js";
import { findFilesInDirectory } from "./server/services/file-search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("OpenGUI");
app.setPath("userData", path.join(app.getPath("appData"), "OpenGUI"));

const DEV_SERVER_URL = process.env.OPENGUI_DEV_SERVER_URL || "http://localhost:3000";
const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";
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

/** Check if a URL uses a web protocol (http/https). */
function isWebUrl(url: unknown) {
  return typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"));
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
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    show: false,
    frame: false,
    ...(isMac ? { transparent: true } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
    ...(!isMac ? { backgroundColor: "#1a1a1a" } : {}),
  });

  // Intercept all external link navigations and open them in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const appOrigins = [DEV_SERVER_URL, "file://"];
    const isInternal = appOrigins.some((origin) => url.startsWith(origin));
    if (!isInternal) {
      event.preventDefault();
      if (isWebUrl(url)) void shell.openExternal(url);
    }
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

function assertLocalBackendUrl(rawUrl: string, backendUrl: string) {
  const requested = new URL(rawUrl, backendUrl);
  const backend = new URL(backendUrl);
  if (requested.protocol !== backend.protocol || requested.host !== backend.host) {
    throw new Error("Refusing to proxy non-local backend request");
  }
  return requested;
}

ipcMain.handle("backend:fetch", async (_event, request) => {
  const config = backendSidecar.getConfig() ?? (await backendSidecar.start());
  const url = assertLocalBackendUrl(String(request?.url ?? "/"), config.url);
  const headers = new Headers(request?.headers ?? {});
  if (config.token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${config.token}`);
  }
  const response = await fetch(url, {
    method: typeof request?.method === "string" ? request.method : "GET",
    headers,
    body: typeof request?.body === "string" ? request.body : undefined,
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
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
            webContents.send("backend:event", JSON.parse(data));
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

ipcMain.handle("window:detachProject", (_event, projectDir) => {
  if (typeof projectDir !== "string" || projectDir.length === 0) return;
  createProjectWindow(projectDir);
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

ipcMain.handle("platform:homeDir", () => {
  return homedir();
});

// Open a URL in the system browser (not in Electron)
ipcMain.handle("shell:openExternal", (_event, url) => {
  if (isWebUrl(url)) void shell.openExternal(url);
});

// Open a directory in the system file browser
ipcMain.handle("shell:openInFileBrowser", (_event, dirPath, command = "") => {
  if (typeof dirPath !== "string" || dirPath.length === 0) return;
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
});

// Open a terminal at a directory (cross-platform)
ipcMain.handle("shell:openInTerminal", (_event, dirPath, command = "") => {
  if (typeof dirPath !== "string" || dirPath.length === 0) return;
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
  if (platform === "darwin") {
    spawn("open", ["-a", "Terminal", dirPath], spawnOpts);
  } else if (platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", `cd /d "${dirPath}"`], {
      ...spawnOpts,
      shell: true,
    });
  } else {
    openLinuxTerminal(dirPath, spawnOpts);
  }
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

ipcMain.handle("files:find", async (_event, directory, query) => {
  return await findFilesInDirectory(directory, query);
});

void app.whenReady().then(async () => {
  installDevNetworkFailureLogging();

  try {
    await backendSidecar.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("OpenGUI backend failed to start", message);
    app.quit();
    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  void backendSidecar.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
