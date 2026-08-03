import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ExecutionPolicyResolver, ModelTransport, ShellToolExecutor } from "@opengui/harness";
import { OpenGuiHost } from "./opengui-host.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("OpenGuiHost restricted shell", () => {
  test("passes the configured sandbox executor through to restricted model tool calls", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-host-sandbox-shell-"));
    temporaryDirectories.push(dataDirectory);
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const resolveExecutionPolicy: ExecutionPolicyResolver = async () => ({
      restricted: true,
      revision: 1,
      shellAllowed: true,
      grants: [{ root: projectDirectory, access: "write" }],
      async authorizePath() {
        return { allowed: true, canonicalPath: projectDirectory };
      },
    });
    const shellExecutor: ShellToolExecutor = vi.fn(async () => ({
      exitCode: 0,
      output: projectDirectory,
    }));
    const model: ModelTransport = {
      async *stream(request) {
        const result = request.context.findLast((item) => item.type === "tool_result");
        if (!result) {
          yield { type: "tool_call", id: "pwd", name: "shell", input: { command: "pwd" } };
        } else {
          yield { type: "text_delta", delta: "Finished" };
        }
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(dataDirectory, {
      model,
      resolveExecutionPolicy,
      shellExecutor,
    });
    await host.start();
    const session = await host.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });

    await host.prompt(session.id, {
      text: "Run pwd",
      actor: { type: "user", id: "member", displayName: "Member" },
    });
    await host.waitForIdle(session.id);

    expect(shellExecutor).toHaveBeenCalledOnce();
    expect((await host.readSession(session.id)).entries).toContainEqual(
      expect.objectContaining({
        kind: "tool_result",
        payload: expect.objectContaining({ output: expect.objectContaining({ exitCode: 0 }) }),
      }),
    );
    await host.close();
  });
});
