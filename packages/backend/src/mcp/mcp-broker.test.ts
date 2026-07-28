import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createOpenGuiHarness } from "@opengui/harness";
import { FakeModel } from "@opengui/harness/test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createMcpAgentToolSource, createMcpBroker } from "./mcp-broker.ts";

const fixture = fileURLToPath(new URL("./test-fixtures/stdio-tool-server.mjs", import.meta.url));

describe("McpBroker", () => {
  test("discovers and invokes a configured stdio tool through one actor-scoped interface", async () => {
    const broker = createMcpBroker({
      connections: [
        {
          id: "fixture",
          label: "Fixture server",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: [fixture],
          },
        },
      ],
    });
    const scope = { actorId: "local:test", sessionId: "session-test" };

    try {
      const catalog = await broker.catalog(scope);
      expect(catalog.tools).toEqual([
        expect.objectContaining({
          ref: { connectionId: "fixture", toolName: "echo" },
          title: "Echo",
          description: "Return the supplied message.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        }),
      ]);
      expect(catalog.tools[0]?.modelName).toMatch(/^mcp__fixture__echo__[a-f0-9]{8}$/u);
      expect(catalog.generation).toMatch(/^[a-f0-9]{24}$/u);

      await expect(
        broker.call(
          scope,
          { connectionId: "fixture", toolName: "echo" },
          { message: "hello" },
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        status: "ok",
        summary: "echo:hello",
        content: [{ type: "text", text: "echo:hello" }],
      });
    } finally {
      await broker.close();
    }
  });

  test("runs a stdio MCP tool through the Harness and durable Session transcript", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-mcp-harness-"));
    const broker = createMcpBroker({
      connections: [
        {
          id: "fixture",
          label: "Fixture server",
          transport: { kind: "stdio", command: process.execPath, args: [fixture] },
        },
      ],
    });
    const toolName = (
      await broker.catalog({ actorId: "local:legacy", sessionId: "catalog-inspection" })
    ).tools[0]!.modelName;
    const model = new FakeModel([
      {
        toolCalls: [
          {
            id: "mcp-call",
            name: toolName,
            input: { message: "durable" },
          },
        ],
      },
      { text: "Finished" },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      agentTools: createMcpAgentToolSource(broker),
    });

    try {
      const session = await harness.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "fake", modelId: "fake" },
        reasoning: "none",
      });
      for await (const _event of session.run({ text: "Echo durable" })) {
        // Drain the Run.
      }

      expect(
        (await session.read()).entries.find((entry) => entry.kind === "tool_result")?.payload,
      ).toMatchObject({
        name: toolName,
        output: { status: "ok", summary: "echo:durable" },
      });
    } finally {
      await harness.close();
      await broker.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  test("replaces configured connections and drops their actor-scoped runtimes", async () => {
    const broker = createMcpBroker({
      connections: [
        {
          id: "fixture",
          label: "Fixture server",
          transport: { kind: "stdio", command: process.execPath, args: [fixture] },
        },
      ],
    });
    const scope = { actorId: "local:test", sessionId: "session-test" };

    try {
      expect((await broker.catalog(scope)).tools).toHaveLength(1);
      await broker.replaceConnections([]);
      expect(await broker.catalog(scope)).toEqual({
        generation: expect.stringMatching(/^[a-f0-9]{24}$/u),
        tools: [],
      });
    } finally {
      await broker.close();
    }
  });

  test("discovers and invokes a bearer-authenticated Streamable HTTP tool", async () => {
    const app = new Hono();
    app.all("/mcp", async (context) => {
      if (context.req.header("authorization") !== "Bearer fixture-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport();
      const server = new Server(
        { name: "HTTP fixture", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "greet",
            title: "Greet",
            description: "Greet a person.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [
          {
            type: "text",
            text: `Hello ${typeof request.params.arguments?.name === "string" ? request.params.arguments.name : ""}`,
          },
        ],
      }));
      await server.connect(transport);
      return transport.handleRequest(context.req.raw);
    });
    const httpServer = serve({ fetch: app.fetch, port: 0 });
    if (!httpServer.listening) await once(httpServer, "listening");
    const port = (httpServer.address() as AddressInfo).port;
    const broker = createMcpBroker({
      connections: [
        {
          id: "http-fixture",
          label: "HTTP fixture",
          transport: {
            kind: "http",
            url: `http://127.0.0.1:${port}/mcp`,
            bearerToken: "fixture-token",
          },
        },
      ],
    });
    const scope = { actorId: "local:test", sessionId: "http-session" };

    try {
      const tool = (await broker.catalog(scope)).tools[0]!;
      await expect(
        broker.call(scope, tool.ref, { name: "Ada" }, new AbortController().signal),
      ).resolves.toMatchObject({ status: "ok", summary: "Hello Ada" });
    } finally {
      await broker.close();
      httpServer.close();
    }
  });
});
