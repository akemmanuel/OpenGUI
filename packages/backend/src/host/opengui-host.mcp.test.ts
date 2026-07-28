import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
    expect(host.listMcpConnections()).toEqual([
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
    expect(reopened.listMcpConnections()).toHaveLength(1);
    await reopened.close();
  });
});
