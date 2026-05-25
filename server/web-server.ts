import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createSettingsStore as createSettingsStoreImpl } from "../settings-store.ts";
import index from "../src/index.html";
import { getBackendCapabilities } from "./services/capabilities.ts";
import { findFilesInDirectory } from "./services/file-search.ts";
import type { ServerWebSocket } from "bun";

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

type WebSocketClient = ServerWebSocket<unknown>;

class FakeSender extends EventEmitter {
  id = 1;
  private destroyed = false;

  constructor(private readonly broadcast: (channel: string, data: unknown) => void) {
    super();
  }

  send(channel: string, data: unknown) {
    this.broadcast(channel, data);
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

interface IpcEvent {
  sender: FakeSender;
}

class FakeIpcMain {
  private handlers = new Map<string, Handler>();
  private listeners = new Map<string, Handler>();

  handle(channel: string, handler: Handler) {
    if (this.handlers.has(channel)) {
      console.warn(`[web] Replacing RPC handler ${channel}`);
    }
    this.handlers.set(channel, handler);
  }

  on(channel: string, handler: Handler) {
    this.listeners.set(channel, handler);
  }

  send(channel: string, event: IpcEvent, args: unknown[] = []) {
    const listener = this.listeners.get(channel);
    if (!listener) return;
    listener(event, ...args);
  }

  async invoke(channel: string, event: IpcEvent, args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No RPC handler registered for ${channel}`);
    return await handler(event, ...args);
  }
}

function parseCommand(command: string) {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!matches) return [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}

function isWebUrl(url: unknown) {
  return typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"));
}

function spawnDetached(command: string, args: string[], cwd?: string) {
  const child = Bun.spawn([command, ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  child.unref();
}

function openExternal(url: string) {
  if (!isWebUrl(url)) return;
  if (process.platform === "darwin") spawnDetached("open", [url]);
  else if (process.platform === "win32") spawnDetached("cmd.exe", ["/c", "start", "", url]);
  else spawnDetached("xdg-open", [url]);
}

function openPath(path: string) {
  if (process.platform === "darwin") spawnDetached("open", [path]);
  else if (process.platform === "win32") spawnDetached("explorer.exe", [path]);
  else spawnDetached("xdg-open", [path]);
}

async function runPicker(command: string[]) {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
  } catch {
    return null;
  }

  const timeout = setTimeout(() => proc.kill(), 120_000);
  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const output = (await new Response(proc.stdout as ReadableStream<Uint8Array>).text()).trim();
    return output || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function chooseDirectory() {
  if (process.platform === "darwin") {
    return await runPicker([
      "osascript",
      "-e",
      'POSIX path of (choose folder with prompt "Open project folder")',
    ]);
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Open project folder'",
      "if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }",
    ].join("; ");
    return await runPicker(["powershell.exe", "-NoProfile", "-Command", script]);
  }

  const linuxPickers = [
    ["zenity", "--file-selection", "--directory", "--title=Open project folder"],
    ["kdialog", "--getexistingdirectory", homedir(), "Open project folder"],
    ["yad", "--file-selection", "--directory", "--title=Open project folder"],
  ];

  for (const picker of linuxPickers) {
    const directory = await runPicker(picker);
    if (directory) return directory;
  }

  return null;
}

function isCommandAvailable(command: string) {
  try {
    const probe = process.platform === "win32" ? ["where", command] : ["which", command];
    const result = Bun.spawnSync(probe, { stdout: "ignore", stderr: "ignore" });
    return result.success;
  } catch {
    return false;
  }
}

const BACKEND_CLI_DEFS = {
  opencode: {
    command: "opencode",
    packageName: "opencode-ai",
    knownPaths: () => [
      join(
        homedir(),
        ".opencode",
        "bin",
        process.platform === "win32" ? "opencode.exe" : "opencode",
      ),
      process.platform === "win32" ? "" : "/usr/local/bin/opencode",
    ],
  },
  "claude-code": {
    command: "claude",
    packageName: "@anthropic-ai/claude-code",
    knownPaths: () => [
      join(homedir(), ".claude", "local", process.platform === "win32" ? "claude.exe" : "claude"),
    ],
  },
  pi: { command: "pi", packageName: "@earendil-works/pi-coding-agent", knownPaths: () => [] },
  codex: { command: "codex", packageName: "@openai/codex", knownPaths: () => [] },
} as const;

type BackendCliId = keyof typeof BACKEND_CLI_DEFS;

function isBackendCliId(value: unknown): value is BackendCliId {
  return typeof value === "string" && value in BACKEND_CLI_DEFS;
}

function isBackendAvailable(backendId: BackendCliId) {
  const def = BACKEND_CLI_DEFS[backendId];
  return (
    isCommandAvailable(def.command) ||
    def.knownPaths().some((binaryPath) => !!binaryPath && existsSync(binaryPath))
  );
}

function getBackendInstallCommand(backendId: unknown): [string, string[]] | null {
  if (!isBackendCliId(backendId)) return null;
  const packageName = BACKEND_CLI_DEFS[backendId].packageName;
  const managers = [
    { command: "pnpm", args: ["add", "-g", packageName] },
    { command: "npm", args: ["install", "-g", packageName] },
    { command: "bun", args: ["install", "-g", packageName] },
  ];
  const manager = managers.find((candidate) => isCommandAvailable(candidate.command));
  return manager ? [manager.command, manager.args] : null;
}

function openTerminal(dirPath: string, command = "") {
  if (!existsSync(dirPath)) return;
  const parts = parseCommand(command);
  if (parts.length > 0) {
    const [cmd, ...args] = parts;
    if (!cmd) return;
    spawnDetached(cmd, args, dirPath);
    return;
  }
  if (process.platform === "darwin") spawnDetached("open", ["-a", "Terminal", dirPath]);
  else if (process.platform === "win32")
    spawnDetached("cmd.exe", ["/c", "start", "cmd.exe", "/k", `cd /d "${dirPath}"`]);
  else {
    const terminal = process.env.TERMINAL || "x-terminal-emulator";
    spawnDetached(terminal, [], dirPath);
  }
}

function createSettingsStore(userData: string) {
  return createSettingsStoreImpl(userData);
}

async function setupHandlers(
  ipcMain: FakeIpcMain,
  sender: FakeSender,
  broadcast: (channel: string, data: unknown) => void,
) {
  const userData = join(homedir(), ".config", "OpenGUI-web");
  await mkdir(userData, { recursive: true });
  const settingsStore = createSettingsStore(userData);

  const emitSettingsChange = (key: string, value: unknown) =>
    broadcast("settings:changed", { key, value });

  ipcMain.handle("settings:get-all", () => settingsStore.getAll());
  ipcMain.handle("settings:get", (_event, key) => settingsStore.get(key as string));
  ipcMain.handle("settings:set", (_event, key, value) => {
    const success = settingsStore.set(key as string, value as string);
    if (success) emitSettingsChange(key as string, value);
    return success;
  });
  ipcMain.handle("settings:remove", (_event, key) => {
    const success = settingsStore.remove(key as string);
    if (success) emitSettingsChange(key as string, null);
    return success;
  });
  ipcMain.handle("settings:merge", (_event, entries) => {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
    const success = settingsStore.merge(entries);
    if (success) {
      for (const [key, value] of Object.entries(entries)) emitSettingsChange(key, value);
    }
    return success;
  });

  ipcMain.handle("window:minimize", () => undefined);
  ipcMain.handle("window:maximize", () => undefined);
  ipcMain.handle("window:close", () => undefined);
  ipcMain.handle("window:isMaximized", () => false);
  ipcMain.handle("window:detachProject", () => undefined);
  ipcMain.handle("window:getDetachedProjects", () => []);
  ipcMain.handle("platform:get", () => process.platform);
  ipcMain.handle("platform:homeDir", () => homedir());
  ipcMain.handle("platform:detectBackends", () => ({
    opencode: isBackendAvailable("opencode"),
    "claude-code": isBackendAvailable("claude-code"),
    pi: isBackendAvailable("pi"),
    codex: isBackendAvailable("codex"),
  }));
  ipcMain.handle("backend:install", async (event, backendId) => {
    const installCommand = getBackendInstallCommand(backendId);
    if (!installCommand) {
      return { success: false, error: "Unknown backend id or no supported package manager found" };
    }
    const [command, args] = installCommand;
    const child = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const sendStream = async (
      stream: ReadableStream<Uint8Array> | null,
      type: "stdout" | "stderr",
    ) => {
      if (!stream) return;
      for await (const chunk of stream) {
        event.sender.send("backend:install-progress", {
          chunk: new TextDecoder().decode(chunk),
          type,
        });
      }
    };
    await Promise.all([sendStream(child.stdout, "stdout"), sendStream(child.stderr, "stderr")]);
    const exitCode = await child.exited;
    return { success: exitCode === 0, exitCode };
  });
  ipcMain.handle(
    "platform:locale",
    () => Intl.DateTimeFormat().resolvedOptions().locale || "en-US",
  );
  ipcMain.handle("app:isPackaged", () => false);
  ipcMain.handle("dialog:openDirectory", () => chooseDirectory());
  ipcMain.handle("shell:openExternal", (_event, url) =>
    openExternal(typeof url === "string" ? url : ""),
  );
  ipcMain.handle("shell:openInFileBrowser", (_event, dirPath, command = "") => {
    const dir = typeof dirPath === "string" ? dirPath : "";
    if (!dir) return;
    if (typeof command === "string" && command) {
      const parts = parseCommand(command);
      if (parts.length > 0) {
        const [cmd, ...args] = parts;
        if (!cmd) return;
        spawnDetached(cmd, args.length > 0 ? args : [dir], dir);
        return;
      }
    }
    openPath(dir);
  });
  ipcMain.handle("shell:openInTerminal", (_event, dirPath, command = "") =>
    openTerminal(
      typeof dirPath === "string" ? dirPath : "",
      typeof command === "string" ? command : "",
    ),
  );

  const getAllWindows = () => [
    {
      isDestroyed: () => false,
      webContents: { send: (channel: string, data: unknown) => broadcast(channel, data) },
    },
  ];

  const [
    { setupOpenCodeBridge },
    { setupClaudeCodeBridge },
    { setupPiBridge },
    { setupCodexBridge },
  ] = await Promise.all([
    import("../opencode-bridge.ts"),
    import("../claude-code-bridge.ts"),
    import("../pi-bridge.ts"),
    import("../codex-bridge.ts"),
  ]);

  setupOpenCodeBridge(ipcMain, getAllWindows);
  setupClaudeCodeBridge(ipcMain, getAllWindows);
  ipcMain.send("claude-code:renderer-ready", { sender });
  setupPiBridge(ipcMain, getAllWindows, { userData });
  setupCodexBridge(ipcMain, getAllWindows, { userData });

  return { sender };
}

const clients = new Set<WebSocketClient>();
const broadcast = (channel: string, data: unknown) => {
  const payload = JSON.stringify({ channel, data });
  for (const client of clients) client.send(payload);
};

const ipcMain = new FakeIpcMain();
const sender = new FakeSender(broadcast);
const ready = setupHandlers(ipcMain, sender, broadcast);

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";

function parseAllowedRoots() {
  const raw = process.env.OPENGUI_ALLOWED_ROOTS || homedir();
  return raw
    .split(",")
    .map((entry) => resolve(entry.trim()))
    .filter(Boolean);
}

const allowedRoots = parseAllowedRoots();

async function resolveSafeDirectory(inputPath: string | null) {
  const requested = resolve(inputPath?.trim() || allowedRoots[0] || homedir());
  const actual = await realpath(requested);
  const info = await stat(actual);
  if (!info.isDirectory()) throw new Error("Path is not a directory");
  const allowed = allowedRoots.some((root) => actual === root || actual.startsWith(`${root}/`));
  if (!allowed) throw new Error("Path outside OPENGUI_ALLOWED_ROOTS");
  return actual;
}

async function listServerDirectories(inputPath: string | null) {
  const path = await resolveSafeDirectory(inputPath);
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name), type: "dir" as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  const canGoUp = allowedRoots.some((root) => parent === root || parent.startsWith(`${root}/`));
  return { path, parent: canGoUp ? parent : null, roots: allowedRoots, entries: dirs };
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function serveBuiltFile(request: Request) {
  const url = new URL(request.url);
  const requestedPath = decodeURIComponent(url.pathname);
  const safePath = requestedPath.includes("..") ? "/index.html" : requestedPath;
  const distPath = resolve("dist", safePath === "/" ? "index.html" : safePath.slice(1));
  const distRoot = resolve("dist");
  const filePath =
    distPath.startsWith(distRoot) && existsSync(distPath) ? distPath : join(distRoot, "index.html");
  return new Response(Bun.file(filePath), {
    headers: { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" },
  });
}

function handleFetch(request: Request, server: Bun.Server<unknown>) {
  if (new URL(request.url).pathname === "/api/events") {
    if (server.upgrade(request, { data: undefined })) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  if (isProduction) return serveBuiltFile(request);
  return new Response("Not found", { status: 404 });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rpcErrorCode(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("not available") || message.includes("not found"))
    return "BACKEND_UNAVAILABLE";
  if (message.includes("auth") || message.includes("login")) return "AUTH_REQUIRED";
  if (message.includes("permission") || message.includes("denied")) return "PERMISSION_DENIED";
  if (message.includes("timeout") || message.includes("timed out")) return "BACKEND_TIMEOUT";
  return "UNKNOWN";
}

function normalizeRpcArgs(channel: string, args: unknown[]) {
  // OpenCode resource RPCs are directory-aware. In web mode the app can ask for
  // models/providers before a project is selected; without a directory the bridge
  // returns "No connection available", so the model selector stays hidden.
  if (
    (channel === "opencode:providers" ||
      channel === "opencode:agents" ||
      channel === "opencode:commands" ||
      channel === "opencode:provider:list" ||
      channel === "opencode:provider:auth-methods") &&
    (typeof args[0] !== "string" || !args[0].trim())
  ) {
    return [allowedRoots[0] || homedir(), args[1], ...args.slice(2)];
  }
  return args;
}

function logRpc(channel: string, startedAt: number, ok: boolean, error?: unknown) {
  const durationMs = Date.now() - startedAt;
  const status = ok ? "ok=true" : `ok=false code=${rpcErrorCode(error)}`;
  console.info(`[rpc] channel=${channel || "<missing>"} duration=${durationMs}ms ${status}`);
}

function jsonError(error: unknown, status = 500) {
  const message = getErrorMessage(error);
  return Response.json(
    { ok: false, error: message, code: rpcErrorCode(error), recoverable: status < 500 },
    { status },
  );
}

const routes = {
  "/api/capabilities": Response.json({ ok: true, value: getBackendCapabilities() }),
  "/api/rpc": {
    POST: async (request: Request) => {
      const startedAt = Date.now();
      let channel = "";
      await ready;
      try {
        const body = await request.json();
        channel = String(body?.channel ?? "");
        const rawArgs = Array.isArray(body?.args) ? body.args : [];
        const args = normalizeRpcArgs(channel, rawArgs);
        const value =
          channel === "files:find"
            ? await findFilesInDirectory(
                await resolveSafeDirectory(String(args[0] ?? "")),
                String(args[1] ?? ""),
              )
            : await ipcMain.invoke(channel, { sender }, args);
        logRpc(channel, startedAt, true);
        return Response.json({ ok: true, value });
      } catch (error) {
        logRpc(channel, startedAt, false, error);
        return jsonError(error);
      }
    },
  },
  "/api/fs/list": async (request: Request) => {
    try {
      const path = new URL(request.url).searchParams.get("path");
      return Response.json({ ok: true, value: await listServerDirectories(path) });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  },
  "/api/health": Response.json({ ok: true, mode: "web", allowedRoots }),
  ...(isProduction ? {} : { "/*": index }),
};

const server = Bun.serve({
  port,
  hostname,
  routes: routes as Parameters<typeof Bun.serve>[0]["routes"],
  fetch: handleFetch,
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    close(ws) {
      clients.delete(ws);
    },
    message() {},
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.info(`OpenGUI web running at ${server.url}`);
