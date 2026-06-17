import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  CLI_COMMAND_BY_HARNESS,
  HARNESS_IDS,
  HARNESS_LABELS,
  type ActiveHarnessId,
} from "../src/agents/index.ts";
import type { HarnessInventory, HarnessInventoryCliDiagnostics } from "../src/types/electron.d.ts";

function safeDiagnosticCwd() {
  // Version/path probes do not need a project cwd. Avoid inheriting a cwd inside
  // Documents/Desktop in dev or ad-hoc packaged launches, which can trigger
  // macOS privacy prompts before the user has opened a project.
  return homedir();
}

export function isHarnessId(value: unknown): value is ActiveHarnessId {
  return typeof value === "string" && HARNESS_IDS.includes(value as ActiveHarnessId);
}

function binaryNames(command: string) {
  if (process.platform !== "win32") return [command];
  if (/\.(?:exe|cmd|bat|ps1)$/i.test(command)) return [command];
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, `${command}.ps1`, command];
}

function commonBinaryPaths(command: string): string[] {
  const bins = binaryNames(command);
  const home = homedir();
  const directories = [
    ...(command === "opencode" ? [join(home, ".opencode", "bin")] : []),
    ...(command === "grok" ? [join(home, ".grok", "bin")] : []),
    join(home, ".claude", "local"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, "Library", "pnpm"),
    join(home, "AppData", "Roaming", "npm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  return directories.flatMap((directory) => bins.map((bin) => join(directory, bin)));
}

function commandFromShell(command: string): string | null {
  if (process.platform === "win32") return null;
  for (const shell of [process.env.SHELL, "/bin/zsh", "/bin/bash"].filter(Boolean) as string[]) {
    const result = spawnSync(shell, ["-lc", `command -v ${command}`], {
      cwd: safeDiagnosticCwd(),
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const candidate = result.stdout?.split(/\r?\n/)[0]?.trim();
    if (candidate) return candidate;
  }
  return null;
}

export function resolveHarnessCli(harnessId: ActiveHarnessId): HarnessInventoryCliDiagnostics {
  const command = CLI_COMMAND_BY_HARNESS[harnessId];
  const checkedPaths = commonBinaryPaths(command);
  for (const candidate of checkedPaths) {
    if (existsSync(candidate)) {
      return { command, resolvedPath: candidate, checkedPaths };
    }
  }

  const shellResolved = commandFromShell(command);
  if (shellResolved) {
    return { command, resolvedPath: shellResolved, checkedPaths: [...checkedPaths, "$PATH"] };
  }

  if (process.platform === "win32") {
    const result = spawnSync("where", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const candidates = (result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((left, right) => windowsCliPriority(left) - windowsCliPriority(right));
    const candidate = candidates[0];
    if (candidate)
      return { command, resolvedPath: candidate, checkedPaths: [...checkedPaths, "where"] };
  }

  return { command, resolvedPath: null, checkedPaths };
}

function windowsCliPriority(path: string) {
  if (/\.cmd$/i.test(path)) return 0;
  if (/\.exe$/i.test(path)) return 1;
  if (/\.bat$/i.test(path)) return 2;
  if (!/\.[^\\/]+$/i.test(path)) return 3;
  if (/\.ps1$/i.test(path)) return 4;
  return 5;
}

function readVersion(command: string, resolvedPath: string): string | null {
  const isWindowsScript = /\.(?:cmd|bat)$/i.test(resolvedPath);
  const result =
    process.platform === "win32" && isWindowsScript
      ? spawnSync("cmd.exe", ["/d", "/c", `${command} --version`], {
          cwd: safeDiagnosticCwd(),
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawnSync(resolvedPath, ["--version"], {
          cwd: safeDiagnosticCwd(),
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/)[0]?.trim() || null;
}

export function getHarnessInventory(harnessId: ActiveHarnessId): HarnessInventory {
  const cli = resolveHarnessCli(harnessId);
  const checkedAt = new Date().toISOString();
  if (!cli.resolvedPath) {
    return {
      harnessId,
      displayName: HARNESS_LABELS[harnessId],
      enabled: true,
      installed: false,
      status: "error",
      auth: { status: "unknown" },
      version: null,
      models: [],
      agents: [],
      message: `${HARNESS_LABELS[harnessId]} CLI (${cli.command}) was not found.`,
      checkedAt,
      diagnostics: { cli },
    };
  }

  const version = readVersion(cli.command, cli.resolvedPath);
  if (!version) {
    return {
      harnessId,
      displayName: HARNESS_LABELS[harnessId],
      enabled: true,
      installed: false,
      status: "error",
      auth: { status: "unknown" },
      version: null,
      models: [],
      agents: [],
      message: `${HARNESS_LABELS[harnessId]} CLI was found at ${basename(cli.resolvedPath)}, but it could not be executed.`,
      checkedAt,
      diagnostics: { cli },
    };
  }

  return {
    harnessId,
    displayName: HARNESS_LABELS[harnessId],
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "unknown" },
    version,
    models: [],
    agents: [],
    message: `${HARNESS_LABELS[harnessId]} CLI is ready. Model catalog is loaded per project via SDK loadResources() or harness list_models.`,
    checkedAt,
    diagnostics: { cli },
  };
}

export function getHarnessInventories(): HarnessInventory[] {
  return HARNESS_IDS.map(getHarnessInventory);
}
