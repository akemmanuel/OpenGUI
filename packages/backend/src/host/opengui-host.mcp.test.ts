import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { vi } from "vitest";
import type { ModelTransport } from "@opengui/harness";
import { OpenGuiHost } from "./opengui-host.ts";

const fixture = fileURLToPath(
  new URL("../mcp/test-fixtures/stdio-tool-server.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function mcpCallingModel(): ModelTransport {
  return {
    async *stream(request) {
      const result = request.context.findLast((item) => item.type === "tool_result");
      if (!result) {
        const tool = request.toolDefinitions?.find((item) => item.name.startsWith("mcp__"));
        if (!tool) throw new Error("MCP tool was not exposed to the model");
        yield {
          type: "tool_call" as const,
          id: "mcp-call",
          name: tool.name,
          input: { message: "host" },
        };
      } else {
        yield { type: "text_delta" as const, delta: "Finished" };
      }
      yield { type: "completed" as const };
    },
  };
}

describe("OpenGUI Host MCP connections", () => {
  test("an unavailable MCP connection does not prevent a model Run", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-host-mcp-unavailable-"));
    temporaryDirectories.push(dataDirectory);
    const modelCalled = vi.fn();
    const model: ModelTransport = {
      async *stream(request) {
        modelCalled(request.toolDefinitions?.map((tool) => tool.name) ?? []);
        yield { type: "text_delta" as const, delta: "MCP is optional" };
        yield { type: "completed" as const };
      },
    };
    const host = new OpenGuiHost(dataDirectory, { model });
    await host.start();

    await host.upsertMcpConnection({
      id: "offline",
      label: "Offline server",
      enabled: true,
      transport: { kind: "http", url: "http://127.0.0.1:1/mcp" },
    });
    const session = await host.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });

    await host.prompt(session.id, { text: "Continue without MCP" });
    await host.waitForIdle(session.id);

    const snapshot = await host.readSession(session.id);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.entries.some((entry) => entry.kind === "run_failed")).toBe(false);
    expect(modelCalled).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.stringMatching(/^mcp__/u)]),
    );
    expect(await host.listMcpConnections()).toEqual([
      expect.objectContaining({
        id: "offline",
        status: expect.objectContaining({
          state: "offline",
          toolCount: 0,
          problem: expect.objectContaining({ code: "unavailable", retryable: true }),
        }),
      }),
    ]);
    await host.close();
  });

  test("persists a stdio connection, keeps environment values secret, and runs its tool", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-host-mcp-"));
    temporaryDirectories.push(dataDirectory);
    const host = new OpenGuiHost(dataDirectory, { model: mcpCallingModel() });
    await host.start();

    await host.upsertMcpConnection({
      id: "fixture",
      label: "Fixture server",
      enabled: true,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { FIXTURE_SECRET: "hidden-value" },
      },
    });
    await host.inspectMcpConnection("fixture");
    expect(await host.listMcpConnections()).toEqual([
      {
        id: "fixture",
        label: "Fixture server",
        enabled: true,
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: [fixture],
          envKeys: ["FIXTURE_SECRET"],
        },
        status: {
          state: "ready",
          toolCount: 1,
          lastCheckedAt: expect.any(String),
        },
      },
    ]);

    const session = await host.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    await host.prompt(session.id, { text: "Use MCP" });
    await host.waitForIdle(session.id);
    expect(
      (await host.readSession(session.id)).entries.find((entry) => entry.kind === "tool_result")
        ?.payload.output,
    ).toMatchObject({ status: "ok", summary: "echo:host" });
    await host.close();

    const reopened = new OpenGuiHost(dataDirectory, { model: mcpCallingModel() });
    await reopened.start();
    expect(await reopened.listMcpConnections()).toHaveLength(1);
    await reopened.close();
  });
});
