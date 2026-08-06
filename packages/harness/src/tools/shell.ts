import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedShell } from "./shell-resolution.ts";

// Leave room for command/status metadata so the shared 5 KiB tool-result limiter
// does not wrap an already-bounded shell result and discard exit information.
const MAX_RETURNED_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 5_000;
const FORCE_KILL_DELAY_MS = 500;

interface ShellToolInput {
  command: string;
  timeout?: number;
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
  if (
    input.timeout !== undefined &&
    (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0)
  )
    return null;
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

function utf8Tail(buffer: Buffer, maximumBytes: number) {
  let tail = buffer.subarray(Math.max(0, buffer.byteLength - maximumBytes));
  while (tail.byteLength > 0 && (tail[0]! & 0xc0) === 0x80) tail = tail.subarray(1);
  return tail;
}

export async function executeShellTool(context: ShellToolContext, rawInput: unknown) {
  const input = parseInput(rawInput);
  if (!input)
    return { error: "shell requires a non-empty command and optional timeout in seconds" };
  const timeoutMs = Math.min(MAX_TIMEOUT_SECONDS, input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
  const outputDirectory = join(
    context.dataDirectory,
    "tool-output",
    safePathSegment(context.sessionId),
  );
  await mkdir(outputDirectory, { recursive: true });
  const fullOutputPath = join(outputDirectory, `${safePathSegment(context.toolCallId)}.log`);
  const fullOutput = createWriteStream(fullOutputPath, { flags: "w" });
  let returnedOutput: Buffer = Buffer.alloc(0);
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
      returnedOutput = utf8Tail(returnedOutput, MAX_RETURNED_BYTES);
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (force = false) => {
    terminateProcessTree(child, force);
    if (!force && !forceKillTimer) {
      forceKillTimer = setTimeout(() => terminateProcessTree(child, true), FORCE_KILL_DELAY_MS);
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

  const truncated = fullOutput.bytesWritten > returnedOutput.byteLength;
  const truncationNotice = `\nThe full output has been saved to ${fullOutputPath}.`;
  const output = truncated
    ? Buffer.concat([
        utf8Tail(returnedOutput, MAX_RETURNED_BYTES - Buffer.byteLength(truncationNotice)),
        Buffer.from(truncationNotice),
      ]).toString("utf8")
    : returnedOutput.toString("utf8");

  return {
    command: input.command,
    shell: context.shell.executable,
    exitCode: result.exitCode,
    signal: result.signal,
    output,
    truncated,
    fullOutputPath,
    timedOut,
    aborted,
  };
}
