import type { BrowserWindow as BrowserWindowType } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain, shell } =
  require("electron") as typeof import("electron");
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { createSettingsStore } from "./settings-store.js";
import { setupUpdateManager } from "./main/update-manager.js";
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

function isCommandAvailable(cmd: unknown) {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`, {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

const BACKEND_CLI_DEFS = {
  opencode: {
    command: "opencode",
    packageName: "opencode-ai",
    knownPaths: () => [
      path.join(
        homedir(),
        ".opencode",
        "bin",
        process.platform === "win32" ? "opencode.exe" : "opencode",
      ),
    ],
  },
  "claude-code": {
    command: "claude",
    packageName: "@anthropic-ai/claude-code",
    knownPaths: () => [
      path.join(
        homedir(),
        ".claude",
        "local",
        process.platform === "win32" ? "claude.exe" : "claude",
      ),
    ],
  },
  pi: {
    command: "pi",
    packageName: "@earendil-works/pi-coding-agent",
    knownPaths: () => [],
  },
  codex: {
    command: "codex",
    packageName: "@openai/codex",
    knownPaths: () => [],
  },
} satisfies Record<string, { command: string; packageName: string; knownPaths: () => string[] }>;

type BackendCliId = keyof typeof BACKEND_CLI_DEFS;

function isKnownBackendId(backendId: unknown): backendId is BackendCliId {
  return typeof backendId === "string" && backendId in BACKEND_CLI_DEFS;
}

function isBackendAvailable(backendId: BackendCliId) {
  const def = BACKEND_CLI_DEFS[backendId];
  if (!def) return false;
  if (isCommandAvailable(def.command)) return true;
  return def.knownPaths().some((binaryPath) => existsSync(binaryPath));
}

function resolvePackageManager() {
  const candidates = [
    { command: "pnpm", argsFor: (packageName: string) => ["add", "-g", packageName] },
    { command: "npm", argsFor: (packageName: string) => ["install", "-g", packageName] },
  ];

  return candidates.find((candidate) => isCommandAvailable(candidate.command));
}

function getBackendInstallCommand(backendId: unknown): [string, string[]] | null {
  if (!isKnownBackendId(backendId)) return null;
  const def = BACKEND_CLI_DEFS[backendId];
  const packageManager = resolvePackageManager();
  if (!packageManager) return null;
  return [packageManager.command, packageManager.argsFor(def.packageName)];
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

ipcMain.handle("platform:detectBackends", () => {
  return {
    opencode: isBackendAvailable("opencode"),
    "claude-code": isBackendAvailable("claude-code"),
    pi: isBackendAvailable("pi"),
    codex: isBackendAvailable("codex"),
  };
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
        properties: ["openDirectory"],
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
});

ipcMain.handle("files:find", async (_event, directory, query) => {
  return await findFilesInDirectory(directory, query);
});

// Install a known backend CLI tool. Renderer passes backend id, not shell text.
// Streams stdout/stderr back to the renderer as "backend:install-progress" events.
ipcMain.handle("backend:install", (event, backendId) => {
  return new Promise((resolve) => {
    const installCommand = getBackendInstallCommand(backendId);
    if (!installCommand) {
      resolve({
        success: false,
        error: "Unknown backend id or no supported package manager found",
      });
      return;
    }

    const [command, args] = installCommand;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const sendChunk = (chunk: unknown, type: "stdout" | "stderr") => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send("backend:install-progress", { chunk: String(chunk), type });
        }
      } catch {
        // renderer gone – ignore
      }
    };

    child.stdout?.on("data", (data) => sendChunk(data, "stdout"));
    child.stderr?.on("data", (data) => sendChunk(data, "stderr"));
    child.on("close", (code) => resolve({ success: code === 0, exitCode: code }));
    child.on("error", (err) => resolve({ success: false, error: err.message }));
  });
});

void app.whenReady().then(async () => {
  try {
    await backendSidecar.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("OpenGUI backend failed to start", message);
    app.quit();
    return;
  }

  createWindow();
  setupUpdateManager();

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
