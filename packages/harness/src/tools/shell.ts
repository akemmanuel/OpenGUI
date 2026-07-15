import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedShell } from "./shell-resolution.ts";

const MAX_RETURNED_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const FORCE_KILL_DELAY_MS = 500;

interface ShellToolInput {
  command: string;
  timeoutMs?: number;
}

export interface ShellToolContext {
  projectDirectory: string;
  dataDirectory: string;
  sessionId: string;
  toolCallId: string;
  shell: ResolvedShell;
  signal: AbortSignal;
}

function parseInput(value: unknown): ShellToolInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.command !== "string" || !input.command.trim()) return null;
  if (input.timeoutMs !== undefined && typeof input.timeoutMs !== "number") return null;
  return input as unknown as ShellToolInput;
}

function commandArguments(shell: ResolvedShell, command: string) {
  return shell.family === "powershell"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    : ["-lc", command];
}

function terminateProcessTree(child: ChildProcess, force: boolean) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // The process exited between the status check and signal.
    }
  }
}

function safePathSegment(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}

export async function executeShellTool(context: ShellToolContext, rawInput: unknown) {
  const input = parseInput(rawInput);
  if (!input) return { error: "shell requires a non-empty command and optional timeoutMs" };
  const timeoutMs = Math.max(
    1,
    Math.min(MAX_TIMEOUT_MS, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const outputDirectory = join(
    context.dataDirectory,
    "tool-output",
    safePathSegment(context.sessionId),
  );
  await mkdir(outputDirectory, { recursive: true });
  const fullOutputPath = join(outputDirectory, `${safePathSegment(context.toolCallId)}.log`);
  const fullOutput = createWriteStream(fullOutputPath, { flags: "w" });
  let returnedOutput = Buffer.alloc(0);
  let timedOut = false;
  let aborted = false;

  const child = spawn(context.shell.executable, commandArguments(context.shell, input.command), {
    cwd: context.projectDirectory,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const capture = (chunk: Buffer) => {
    fullOutput.write(chunk);
    returnedOutput = Buffer.concat([returnedOutput, chunk]);
    if (returnedOutput.byteLength > MAX_RETURNED_BYTES) {
      returnedOutput = returnedOutput.subarray(returnedOutput.byteLength - MAX_RETURNED_BYTES);
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (force = false) => {
    terminateProcessTree(child, force);
    if (!force && !forceKillTimer) {
      forceKillTimer = setTimeout(() => terminateProcessTree(child, true), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    }
  };
  const onAbort = () => {
    aborted = true;
    stop();
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  timeout.unref();

  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    },
  ).finally(() => {
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    context.signal.removeEventListener("abort", onAbort);
  });
  await new Promise<void>((resolve, reject) => {
    fullOutput.once("error", reject);
    fullOutput.end(resolve);
  });

  return {
    command: input.command,
    shell: context.shell.executable,
    exitCode: result.exitCode,
    signal: result.signal,
    output: returnedOutput.toString("utf8"),
    truncated: fullOutput.bytesWritten > returnedOutput.byteLength,
    fullOutputPath,
    timedOut,
    aborted,
  };
}
