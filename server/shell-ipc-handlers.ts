import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { BackendServiceContext } from "./services/index.ts";
import { getHarnessInventories } from "./harness-inventory.ts";

interface IpcSender {
  send(channel: string, data: unknown): void;
}

interface IpcEvent {
  sender: IpcSender;
}

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

interface IpcHandlerRegistry {
  handle(channel: string, handler: Handler): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseCommand(command: string) {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!matches) return [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}

function spawnDetached(command: string, args: string[], cwd?: string) {
  const child = spawn(command, args, {
    cwd,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function isWebUrl(url: unknown) {
  return typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"));
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
  const [file, ...args] = command;
  if (!file) return null;

  let proc;
  try {
    proc = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }

  const stdoutChunks: Buffer[] = [];
  proc.stdout?.on("data", (chunk) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });

  const timeout = setTimeout(() => proc.kill(), 120_000);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code) => resolve(code));
    });
    if (exitCode !== 0) return null;
    return Buffer.concat(stdoutChunks).toString("utf8").trim() || null;
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

  for (const picker of [
    ["zenity", "--file-selection", "--directory", "--title=Open project folder"],
    ["kdialog", "--getexistingdirectory", homedir(), "Open project folder"],
    ["yad", "--file-selection", "--directory", "--title=Open project folder"],
  ]) {
    const directory = await runPicker(picker);
    if (directory) return directory;
  }

  return null;
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
  else spawnDetached(process.env.TERMINAL || "x-terminal-emulator", [], dirPath);
}

export function registerShellIpcHandlers(input: {
  ipcMain: IpcHandlerRegistry;
  broadcast: (channel: string, data: unknown) => void;
  services: BackendServiceContext;
}) {
  const { ipcMain, broadcast, services } = input;
  const emitSettingsChange = (key: string, value: unknown) =>
    broadcast("settings:changed", { key, value });

  ipcMain.handle("settings:get-all", () => services.storage.getAllSettings());
  ipcMain.handle("settings:get", (_event, key) =>
    typeof key === "string" ? services.storage.getSetting(key) : null,
  );
  ipcMain.handle("settings:set", async (_event, key, value) => {
    if (typeof key !== "string" || typeof value !== "string") return false;
    const success = await services.storage.setSetting(key, value);
    if (success) emitSettingsChange(key, value);
    return success;
  });
  ipcMain.handle("settings:remove", async (_event, key) => {
    if (typeof key !== "string") return false;
    const success = await services.storage.removeSetting(key);
    if (success) emitSettingsChange(key, null);
    return success;
  });
  ipcMain.handle("settings:merge", async (_event, entries) => {
    if (!isPlainObject(entries)) return false;
    const normalizedEntries = Object.fromEntries(
      Object.entries(entries).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
    const success = await services.storage.mergeSettings(normalizedEntries);
    if (success) {
      for (const [key, value] of Object.entries(normalizedEntries)) emitSettingsChange(key, value);
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
  ipcMain.handle("platform:harnessInventory", () => getHarnessInventories());
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

  ipcMain.handle("agent-backends:restart", async () => {
    const results: Record<string, { success: boolean; error?: string }> = {};
    for (const harnessId of services.harnesses.getManagedHarnessIds()) {
      try {
        await services.harnesses.restartHarness(harnessId);
        results[harnessId] = { success: true };
      } catch (error) {
        results[harnessId] = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { success: true, data: results };
  });
}
