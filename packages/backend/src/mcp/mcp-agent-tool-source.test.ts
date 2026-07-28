import { describe, expect, test, vi } from "vitest";
import { createMcpAgentToolSource, type McpBroker, type McpCatalogSnapshot } from "./mcp-broker.ts";

function catalog(): McpCatalogSnapshot {
  return {
    generation: "large-generation",
    tools: [
      {
        ref: { connectionId: "crm", toolName: "find_customer" },
        modelName: "mcp__crm__find_customer__11111111",
        title: "Find customer",
        description: `Look up a customer.${" details".repeat(100)}`,
        inputSchema: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
        },
        fingerprint: "one",
      },
      {
        ref: { connectionId: "crm", toolName: "update_customer" },
        modelName: "mcp__crm__update_customer__22222222",
        title: "Update customer",
        description: `Update customer details.${" details".repeat(100)}`,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id"],
        },
        fingerprint: "two",
      },
    ],
  };
}

describe("MCP AgentToolSource", () => {
  test("uses stable search, inspect, and call tools when direct schemas exceed the budget", async () => {
    const call = vi.fn(async () => ({ status: "ok" as const, summary: "updated", content: [] }));
    const broker: McpBroker = {
      catalog: async () => catalog(),
      call,
      replaceConnections: async () => undefined,
      close: async () => undefined,
    };
    const source = createMcpAgentToolSource(broker, { maxDirectSchemaBytes: 100 });
    const tools = await source.resolve(
      { sessionId: "session", runId: "run", projectDirectory: "/project" },
      new AbortController().signal,
    );

    expect(tools.definitions.map((tool) => tool.name)).toEqual([
      "mcp_search_tools",
      "mcp_get_tool",
      "mcp_call_tool",
    ]);
    await expect(
      tools.invoke(
        { name: "mcp_search_tools", input: { query: "update customer", limit: 1 } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ matches: [{ toolRef: "mcp__crm__update_customer__22222222" }] });
    await expect(
      tools.invoke(
        {
          name: "mcp_get_tool",
          input: { toolRef: "mcp__crm__update_customer__22222222" },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      name: "mcp__crm__update_customer__22222222",
      inputSchema: { type: "object" },
    });
    await tools.invoke(
      {
        name: "mcp_call_tool",
        input: {
          toolRef: "mcp__crm__update_customer__22222222",
          arguments: { id: "customer-1", name: "Ada" },
        },
      },
      new AbortController().signal,
    );
    expect(call).toHaveBeenCalledWith(
      { actorId: "local:legacy", sessionId: "session" },
      { connectionId: "crm", toolName: "update_customer" },
      { id: "customer-1", name: "Ada" },
      expect.any(AbortSignal),
    );
  });
});
