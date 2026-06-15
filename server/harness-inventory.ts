import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { HARNESS_IDS, HARNESS_LABELS, type ActiveHarnessId } from "../src/agents/index.ts";
import type { HarnessInventory, HarnessInventoryCliDiagnostics } from "../src/types/electron.d.ts";

const BINARY_BY_HARNESS: Record<ActiveHarnessId, string> = {
  opencode: "opencode",
  "claude-code": "claude",
  pi: "pi",
  codex: "codex",
};

function safeDiagnosticCwd() {
  // Version/path probes do not need a project cwd. Avoid inheriting a cwd inside
  // Documents/Desktop in dev or ad-hoc packaged launches, which can trigger
  // macOS privacy prompts before the user has opened a project.
  return homedir();
}

export function isHarnessId(value: unknown): value is ActiveHarnessId {
  return typeof value === "string" && HARNESS_IDS.includes(value as ActiveHarnessId);
}

function binaryName(command: string) {
  return process.platform === "win32" && !command.endsWith(".exe") ? `${command}.exe` : command;
}

function commonBinaryPaths(command: string): string[] {
  const bin = binaryName(command);
  const home = homedir();
  return [
    ...(command === "opencode" ? [join(home, ".opencode", "bin", bin)] : []),
    join(home, ".claude", "local", bin),
    join(home, ".local", "bin", bin),
    join(home, ".bun", "bin", bin),
    join(home, "Library", "pnpm", bin),
    "/opt/homebrew/bin/" + bin,
    "/usr/local/bin/" + bin,
    "/usr/bin/" + bin,
  ];
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
  const command = BINARY_BY_HARNESS[harnessId];
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
    const candidate = result.stdout?.split(/\r?\n/)[0]?.trim();
    if (candidate)
      return { command, resolvedPath: candidate, checkedPaths: [...checkedPaths, "where"] };
  }

  return { command, resolvedPath: null, checkedPaths };
}

function readVersion(resolvedPath: string): string | null {
  const result = spawnSync(resolvedPath, ["--version"], {
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

  const version = readVersion(cli.resolvedPath);
  return {
    harnessId,
    displayName: HARNESS_LABELS[harnessId],
    enabled: true,
    installed: true,
    status: "warning",
    auth: { status: "unknown" },
    version,
    models: [],
    agents: [],
    message: `${HARNESS_LABELS[harnessId]} was found at ${basename(cli.resolvedPath)}, but OpenGUI has not discovered runtime models from it yet.`,
    checkedAt,
    diagnostics: { cli },
  };
}

export function getHarnessInventories(): HarnessInventory[] {
  return HARNESS_IDS.map(getHarnessInventory);
}
