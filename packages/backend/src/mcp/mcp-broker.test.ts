import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
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
const raceFixture = fileURLToPath(
  new URL("./test-fixtures/stdio-race-server.mjs", import.meta.url),
);

describe("McpBroker", () => {
  test("bounds discovery time and reports a safe timeout problem", async () => {
    const broker = createMcpBroker({
      discoveryTimeoutMs: 200,
      connections: [
        {
          id: "hanging",
          label: "Hanging server",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: ["-e", "process.stdin.resume()"],
          },
        },
      ],
    });

    try {
      const catalog = await broker.refresh({ actorId: "local:test", sessionId: "timeout" });
      expect(catalog.tools).toEqual([]);
      expect(catalog.problems).toEqual([
        {
          connectionId: "hanging",
          stage: "connect",
          code: "timeout",
          retryable: true,
          message: "MCP connection timed out",
        },
      ]);
    } finally {
      await broker.close();
    }
  });

  test("reports a timeout after initialization as a discovery failure", async () => {
    const broker = createMcpBroker({
      // Leave enough time for a cold CI process to complete the MCP handshake; only tools/list
      // hangs in this fixture, so the assertion must not race process startup.
      discoveryTimeoutMs: 1_000,
      connections: [
        {
          id: "hanging-list",
          label: "Hanging list",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: [fixture],
            env: { MCP_HANG_LIST: "1" },
          },
        },
      ],
    });
    try {
      await expect(
        broker.refresh({ actorId: "local:test", sessionId: "discover-timeout" }),
      ).resolves.toMatchObject({
        problems: [expect.objectContaining({ stage: "discover", code: "timeout" })],
      });
    } finally {
      await broker.close();
    }
  });

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
      await broker.refresh(scope);
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

  test("keeps healthy tools when another MCP connection is unavailable", async () => {
    const broker = createMcpBroker({
      connections: [
        {
          id: "fixture",
          label: "Fixture server",
          transport: { kind: "stdio", command: process.execPath, args: [fixture] },
        },
        {
          id: "offline",
          label: "Offline server",
          transport: { kind: "http", url: "http://127.0.0.1:1/mcp" },
        },
      ],
    });

    try {
      const catalog = await broker.refresh({ actorId: "local:test", sessionId: "partial" });
      expect(catalog.tools.map((tool) => tool.ref.connectionId)).toEqual(["fixture"]);
      expect(catalog.problems).toEqual([
        expect.objectContaining({
          connectionId: "offline",
          code: "unavailable",
          retryable: true,
        }),
      ]);
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
      await broker.refresh({ actorId: "local:legacy", sessionId: "catalog-inspection" })
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
      await broker.refresh(scope);
      expect((await broker.catalog(scope)).tools).toHaveLength(1);
      await broker.replaceConnections([]);
      expect(await broker.catalog(scope)).toEqual({
        generation: expect.stringMatching(/^[a-f0-9]{24}$/u),
        tools: [],
        problems: [],
        checkedAt: {},
      });
    } finally {
      await broker.close();
    }
  });

  test("isolates catalogs between actor and Session runtimes", async () => {
    const broker = createMcpBroker({
      connections: [
        {
          id: "scoped",
          label: "Scoped fixture",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: [fixture],
            env: { MCP_PID_TOOL: "1" },
          },
        },
      ],
    });
    const first = { actorId: "account:first", sessionId: "one" };
    const second = { actorId: "account:second", sessionId: "two" };
    try {
      const firstCatalog = await broker.refresh(first);
      const secondCatalog = await broker.refresh(second);
      expect(firstCatalog.tools[0]?.ref.toolName).not.toBe(secondCatalog.tools[0]?.ref.toolName);
      expect((await broker.catalog(first)).tools).toEqual(firstCatalog.tools);
      expect((await broker.catalog(second)).tools).toEqual(secondCatalog.tools);
    } finally {
      await broker.close();
    }
  });

  test("does not let an older overlapping refresh replace a newer catalog", async () => {
    const broker = createMcpBroker({
      connections: [
        {
          id: "race",
          label: "Race fixture",
          transport: { kind: "stdio", command: process.execPath, args: [raceFixture] },
        },
      ],
    });
    const scope = { actorId: "local:test", sessionId: "race" };
    try {
      const oldRefresh = broker.refresh(scope);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const newRefresh = broker.refresh(scope);
      await Promise.all([oldRefresh, newRefresh]);
      expect((await broker.catalog(scope)).tools.map((tool) => tool.ref.toolName)).toEqual([
        "new_tool",
      ]);
    } finally {
      await broker.close();
    }
  });

  test("does not let an older failure degrade a newer successful refresh", async () => {
    const broker = createMcpBroker({
      connections: [
        {
          id: "race-failure",
          label: "Race failure fixture",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: [raceFixture],
            env: { MCP_FIRST_LIST_ERROR: "1" },
          },
        },
      ],
    });
    const scope = { actorId: "local:test", sessionId: "race-failure" };
    try {
      const oldRefresh = broker.refresh(scope);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const newRefresh = broker.refresh(scope);
      await Promise.all([oldRefresh, newRefresh]);
      expect(await broker.catalog(scope)).toMatchObject({
        tools: [
          expect.objectContaining({ ref: { connectionId: "race-failure", toolName: "new_tool" } }),
        ],
        problems: [],
      });
    } finally {
      await broker.close();
    }
  });

  test("bounds the combined catalog across connections", async () => {
    const connections = ["one", "two"].map((id) => ({
      id,
      label: id,
      transport: {
        kind: "stdio" as const,
        command: process.execPath,
        args: [fixture],
        env: { MCP_TOOL_COUNT: "300" },
      },
    }));
    const broker = createMcpBroker({ connections });
    try {
      const catalog = await broker.refresh({ actorId: "local:test", sessionId: "bounded" });
      expect(catalog.tools).toHaveLength(500);
      expect(catalog.problems).toContainEqual(
        expect.objectContaining({ connectionId: "two", code: "protocol" }),
      );
    } finally {
      await broker.close();
    }
  });

  test("does not record an aborted first refresh as a completed health check", async () => {
    const broker = createMcpBroker({
      connections: [
        {
          id: "hanging",
          label: "Hanging",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: ["-e", "process.stdin.resume()"],
          },
        },
      ],
    });
    const scope = { actorId: "local:test", sessionId: "aborted" };
    const controller = new AbortController();
    controller.abort(new Error("Run canceled"));
    try {
      await expect(broker.refresh(scope, undefined, controller.signal)).rejects.toThrow(
        "Run canceled",
      );
      expect((await broker.catalog(scope)).checkedAt).toEqual({});
    } finally {
      await broker.close();
    }
  });

  test("cancels a caller waiting for connection establishment", async () => {
    const broker = createMcpBroker({
      discoveryTimeoutMs: 2_000,
      connections: [
        {
          id: "hanging",
          label: "Hanging",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: ["-e", "process.stdin.resume()"],
          },
        },
      ],
    });
    const controller = new AbortController();
    const call = broker.call(
      { actorId: "local:test", sessionId: "call" },
      { connectionId: "hanging", toolName: "stale" },
      {},
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("Run canceled")), 50);
    try {
      await expect(call).rejects.toThrow("Run canceled");
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
      const tool = (await broker.refresh(scope)).tools[0]!;
      await expect(
        broker.call(scope, tool.ref, { name: "Ada" }, new AbortController().signal),
      ).resolves.toMatchObject({ status: "ok", summary: "Hello Ada" });
      (httpServer as HttpServer).closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      const degraded = await broker.refresh(scope);
      expect(degraded.tools.map((item) => item.ref.toolName)).toEqual(["greet"]);
      expect(degraded.problems).toEqual([
        expect.objectContaining({ connectionId: "http-fixture", retryable: true }),
      ]);
    } finally {
      await broker.close();
      if (httpServer.listening) httpServer.close();
    }
  });

  test("fails closed when authentication is revoked after healthy discovery", async () => {
    let authorized = true;
    const app = new Hono();
    app.all("/mcp", async (context) => {
      if (!authorized) return new Response("Unauthorized", { status: 401 });
      const transport = new WebStandardStreamableHTTPServerTransport();
      const server = new Server(
        { name: "Revocation fixture", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "private_tool", inputSchema: { type: "object" } }],
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
          id: "private",
          label: "Private",
          transport: { kind: "http", url: `http://127.0.0.1:${port}/mcp` },
        },
      ],
    });
    const scope = { actorId: "local:test", sessionId: "revocation" };
    try {
      expect((await broker.refresh(scope)).tools).toHaveLength(1);
      authorized = false;
      const revoked = await broker.refresh(scope);
      expect(revoked.tools).toEqual([]);
      expect(revoked.problems).toEqual([
        expect.objectContaining({ code: "authentication", retryable: false }),
      ]);
    } finally {
      await broker.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
