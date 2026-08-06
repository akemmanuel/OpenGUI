import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createOpenGuiHarness, type AgentToolSource } from "./index.ts";
import { FakeModel } from "./test/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("AgentToolSet", () => {
  test("exposes, invokes, and durably records an additional tool through the Harness interface", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-agent-tools-"));
    temporaryDirectories.push(dataDirectory);
    const modelName = "mcp__fixture__echo__12345678";
    const invoke = vi.fn(async () => ({ status: "ok", summary: "echo:hello" }));
    const resolve = vi.fn(async () => ({
      generation: "catalog-generation",
      definitions: [
        {
          name: modelName,
          description: "Return the supplied message.",
          parameters: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
      invoke,
    }));
    const agentTools: AgentToolSource = {
      resolve,
    };
    const model = new FakeModel([
      { toolCalls: [{ id: "mcp-call", name: modelName, input: { message: "hello" } }] },
      { text: "Complete" },
    ]);
    const harness = createOpenGuiHarness({ dataDirectory, model, agentTools });

    try {
      const session = await harness.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "fake", modelId: "fake-model" },
        reasoning: "none",
      });
      for await (const _event of session.run({ text: "Use the echo integration" })) {
        // Drain the Run.
      }

      expect(model.requests[0]?.toolDefinitions).toContainEqual(
        expect.objectContaining({ name: modelName }),
      );
      expect(invoke).toHaveBeenCalledWith(
        { name: modelName, input: { message: "hello" } },
        expect.any(AbortSignal),
      );
      expect(resolve).toHaveBeenCalledTimes(1);
      const entries = (await session.read()).entries;
      expect(entries.find((entry) => entry.kind === "tool_call")?.payload).toMatchObject({
        name: modelName,
        input: { message: "hello" },
      });
      expect(entries.find((entry) => entry.kind === "tool_result")?.payload).toMatchObject({
        name: modelName,
        output: { status: "ok", summary: "echo:hello" },
      });
    } finally {
      await harness.close();
    }
  });

  test("bounds additional tool output before model replay and durable persistence", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-agent-tool-output-"));
    temporaryDirectories.push(dataDirectory);
    const modelName = "mcp__fixture__large__12345678";
    const model = new FakeModel([
      { toolCalls: [{ id: "large-call", name: modelName, input: {} }] },
      { text: "Complete" },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      agentTools: {
        async resolve() {
          return {
            generation: "large-catalog",
            definitions: [
              {
                name: modelName,
                description: "Return a large result.",
                parameters: { type: "object", properties: {} },
              },
            ],
            async invoke() {
              return { content: "x".repeat(10_000) };
            },
          };
        },
      },
    });

    try {
      const session = await harness.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "fake", modelId: "fake-model" },
        reasoning: "none",
      });
      for await (const _event of session.run({ text: "Use the large integration" })) {
        // Drain the Run.
      }

      expect(
        (await session.read()).entries.find((entry) => entry.kind === "tool_result")?.payload
          .output,
      ).toMatchObject({ truncated: true });
      expect(model.requests[1]?.context.at(-1)).toMatchObject({
        type: "tool_result",
        output: { truncated: true },
      });
    } finally {
      await harness.close();
    }
  });

  test("returns connected tool failures to the model instead of failing the run", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-agent-tool-failure-"));
    temporaryDirectories.push(dataDirectory);
    const model = new FakeModel([
      { toolCalls: [{ id: "stale-call", name: "mcp_call_tool", input: {} }] },
      { text: "Continued without the unavailable tool" },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      agentTools: {
        async resolve() {
          return {
            generation: "catalog-generation",
            definitions: [
              {
                name: "mcp_call_tool",
                description: "Call a connected tool.",
                parameters: { type: "object", properties: {} },
              },
            ],
            async invoke() {
              throw new Error("Unknown MCP connection: exa");
            },
          };
        },
      },
    });

    try {
      const session = await harness.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "fake", modelId: "fake-model" },
        reasoning: "none",
      });
      for await (const _event of session.run({ text: "Use the stale tool" })) {
        // Drain the Run.
      }

      const snapshot = await session.read();
      expect(snapshot.entries.find((entry) => entry.kind === "tool_result")?.payload).toMatchObject(
        {
          output: { status: "error", summary: "Unknown MCP connection: exa" },
        },
      );
      expect(snapshot.entries.some((entry) => entry.kind === "run_failed")).toBe(false);
      expect(snapshot.entries.at(-2)).toMatchObject({
        kind: "assistant_message",
        payload: { text: "Continued without the unavailable tool" },
      });
    } finally {
      await harness.close();
    }
  });
});
