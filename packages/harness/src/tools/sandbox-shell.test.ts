import { describe, expect, test, vi } from "vitest";
import { executeTool, type ToolExecutionContext } from "./execute-tool.ts";

function context(): ToolExecutionContext {
  return {
    projectDirectory: "/workspace/site",
    dataDirectory: "/tmp/opengui-test",
    sessionId: "session",
    toolCallId: "call",
    shell: { executable: "/bin/sh", family: "posix" },
    signal: new AbortController().signal,
    executionPolicy: {
      restricted: true,
      revision: 4,
      shellAllowed: true,
      grants: [{ root: "/workspace/site", access: "write" }],
      async authorizePath() {
        return { allowed: false };
      },
    },
  };
}

describe("restricted shell execution", () => {
  test("delegates to the embedding sandbox instead of the native shell", async () => {
    const shellExecutor = vi.fn(async () => ({ exitCode: 0, output: "sandboxed" }));
    const toolContext = { ...context(), shellExecutor };

    await expect(executeTool(toolContext, "shell", { command: "pwd" })).resolves.toMatchObject({
      exitCode: 0,
      output: "sandboxed",
    });
    expect(shellExecutor).toHaveBeenCalledWith(toolContext, { command: "pwd" });
  });

  test("fails closed when no sandbox executor is configured", async () => {
    await expect(executeTool(context(), "shell", { command: "pwd" })).resolves.toMatchObject({
      denied: true,
      reason: "sandbox_not_configured",
    });
  });
});
