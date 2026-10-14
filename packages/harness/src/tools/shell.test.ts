import { describe, expect, test } from "vite-plus/test";
import { useTemporaryDirectories } from "../test/temporary-directories.ts";
import { executeShellTool, type ShellToolContext } from "./shell.ts";

const temporaryDirectory = useTemporaryDirectories("opengui-shell-");

async function context(signal = new AbortController().signal): Promise<ShellToolContext> {
  const directory = await temporaryDirectory();
  return {
    projectDirectory: directory,
    dataDirectory: directory,
    sessionId: "session",
    toolCallId: "call",
    shell: { executable: "/bin/sh", family: "posix" },
    signal,
  };
}

describe.skipIf(process.platform === "win32")("shell tool process control", () => {
  test("returns output and exit code of a finished command", async () => {
    const result = await executeShellTool(await context(), { command: "echo hello; exit 3" });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, aborted: false });
    expect((result as { output: string }).output).toContain("hello");
  });

  test("stops a command that outlives its timeout", async () => {
    const started = Date.now();
    const result = await executeShellTool(await context(), { command: "sleep 30", timeout: 0.2 });
    expect(result).toMatchObject({ timedOut: true, aborted: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("escalates to SIGKILL when the command ignores SIGTERM", async () => {
    const result = await executeShellTool(await context(), {
      command: "trap '' TERM; while :; do sleep 0.05; done",
      timeout: 0.2,
    });
    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  test("stops the command when the run is aborted", async () => {
    const controller = new AbortController();
    const pending = executeShellTool(await context(controller.signal), { command: "sleep 30" });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ aborted: true, timedOut: false });
  });
});
