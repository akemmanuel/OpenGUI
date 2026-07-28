import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { contentFingerprint, type AgentToolSource } from "@opengui/harness";

export interface McpActorScope {
  actorId: string;
  sessionId: string;
}

export interface McpToolRef {
  connectionId: string;
  toolName: string;
}

export interface McpStdioConnection {
  id: string;
  label: string;
  transport: {
    kind: "stdio";
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
}

export interface McpHttpConnection {
  id: string;
  label: string;
  transport: {
    kind: "http";
    url: string;
    bearerToken?: string;
  };
}

export type McpConnection = McpStdioConnection | McpHttpConnection;

export interface McpCatalogTool {
  ref: McpToolRef;
  modelName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  fingerprint: string;
}

export interface McpCatalogSnapshot {
  generation: string;
  tools: McpCatalogTool[];
}

export type McpResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  status: "ok" | "error";
  summary: string;
  content: McpResultContent[];
  attachments?: Array<{ type: "image"; data: string; mimeType: string }>;
  structured?: unknown;
}

export interface McpBroker {
  catalog(scope: McpActorScope): Promise<McpCatalogSnapshot>;
  call(
    scope: McpActorScope,
    ref: McpToolRef,
    input: unknown,
    signal: AbortSignal,
  ): Promise<McpToolResult>;
  replaceConnections(connections: readonly McpConnection[]): Promise<void>;
  close(): Promise<void>;
}

interface Runtime {
  client: Client;
  close(): Promise<void>;
}

const MAX_CATALOG_TOOLS = 500;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_PAGES = 100;

function safeSegment(value: string, fallback: string) {
  const segment = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 20);
  return segment || fallback;
}

function modelName(ref: McpToolRef) {
  const suffix = contentFingerprint(ref).slice(0, 8);
  return `mcp__${safeSegment(ref.connectionId, "server")}__${safeSegment(ref.toolName, "tool")}__${suffix}`;
}

function runtimeKey(scope: McpActorScope, connectionId: string) {
  return `${scope.actorId}\u0000${scope.sessionId}\u0000${connectionId}`;
}

function normalizedContent(content: unknown): McpResultContent[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap<McpResultContent>((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "text", text: block.text }];
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    }
    return [];
  });
}

class DefaultMcpBroker implements McpBroker {
  readonly #connections: Map<string, McpConnection>;
  readonly #runtimes = new Map<string, Promise<Runtime>>();

  constructor(connections: readonly McpConnection[]) {
    this.#connections = this.#connectionMap(connections);
  }

  #connectionMap(connections: readonly McpConnection[]) {
    const result = new Map(connections.map((connection) => [connection.id, connection]));
    if (result.size !== connections.length) throw new Error("MCP connection IDs must be unique");
    return result;
  }

  async #runtime(scope: McpActorScope, connection: McpConnection) {
    const key = runtimeKey(scope, connection.id);
    let pending = this.#runtimes.get(key);
    if (!pending) {
      pending = this.#connect(connection, key).catch((error) => {
        this.#runtimes.delete(key);
        throw error;
      });
      this.#runtimes.set(key, pending);
    }
    return pending;
  }

  async #connect(connection: McpConnection, key: string): Promise<Runtime> {
    const client = new Client({ name: "OpenGUI", version: "0.0.0" });
    const transport =
      connection.transport.kind === "stdio"
        ? new StdioClientTransport({
            command: connection.transport.command,
            args: connection.transport.args,
            cwd: connection.transport.cwd,
            env: connection.transport.env
              ? { ...getDefaultEnvironment(), ...connection.transport.env }
              : undefined,
            stderr: "pipe",
          })
        : new StreamableHTTPClientTransport(new URL(connection.transport.url), {
            requestInit: connection.transport.bearerToken
              ? { headers: { authorization: `Bearer ${connection.transport.bearerToken}` } }
              : undefined,
          });
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", () => undefined);
    }
    transport.onclose = () => {
      this.#runtimes.delete(key);
    };
    await client.connect(transport);
    return {
      client,
      close: async () => {
        await client.close();
      },
    };
  }

  async catalog(scope: McpActorScope): Promise<McpCatalogSnapshot> {
    const tools: McpCatalogTool[] = [];
    let catalogBytes = 0;
    for (const connection of this.#connections.values()) {
      const runtime = await this.#runtime(scope, connection);
      let cursor: string | undefined;
      const cursors = new Set<string>();
      let pages = 0;
      do {
        pages += 1;
        if (pages > MAX_CATALOG_PAGES) throw new Error("MCP tool catalog has too many pages");
        const page = await runtime.client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          if (tools.length >= MAX_CATALOG_TOOLS) throw new Error("MCP tool catalog is too large");
          const ref = { connectionId: connection.id, toolName: tool.name };
          const inputSchema = tool.inputSchema as Record<string, unknown>;
          const description = tool.description?.trim() || "";
          catalogBytes +=
            Buffer.byteLength(JSON.stringify(inputSchema)) + Buffer.byteLength(description);
          if (catalogBytes > MAX_CATALOG_BYTES) throw new Error("MCP tool catalog is too large");
          tools.push({
            ref,
            modelName: modelName(ref),
            title: tool.title?.trim() || tool.annotations?.title?.trim() || tool.name,
            description,
            inputSchema,
            fingerprint: contentFingerprint({ ref, inputSchema, description: tool.description }),
          });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("MCP tool catalog repeated a cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    return {
      generation: contentFingerprint(
        tools.map(({ ref, fingerprint }) => ({ ref, fingerprint })),
      ).slice(0, 24),
      tools,
    };
  }

  async call(
    scope: McpActorScope,
    ref: McpToolRef,
    input: unknown,
    signal: AbortSignal,
  ): Promise<McpToolResult> {
    const connection = this.#connections.get(ref.connectionId);
    if (!connection) throw new Error(`Unknown MCP connection: ${ref.connectionId}`);
    const runtime = await this.#runtime(scope, connection);
    const result = await runtime.client.callTool(
      {
        name: ref.toolName,
        arguments:
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {},
      },
      undefined,
      { signal },
    );
    if (!("content" in result)) {
      return { status: "ok", summary: JSON.stringify(result.toolResult ?? null), content: [] };
    }
    const content = normalizedContent(result.content);
    const summary = content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n")
      .trim();
    return {
      status: result.isError ? "error" : "ok",
      summary: summary || (result.isError ? "MCP tool returned an error" : "MCP tool completed"),
      content,
      ...(content.some((item) => item.type === "image")
        ? {
            attachments: content.flatMap((item) => (item.type === "image" ? [item] : [])),
          }
        : {}),
      ...(result.structuredContent === undefined ? {} : { structured: result.structuredContent }),
    };
  }

  async close() {
    await this.#closeRuntimes();
  }

  async replaceConnections(connections: readonly McpConnection[]) {
    const next = this.#connectionMap(connections);
    await this.#closeRuntimes();
    this.#connections.clear();
    for (const [id, connection] of next) this.#connections.set(id, connection);
  }

  async #closeRuntimes() {
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    await Promise.allSettled(
      runtimes.map(async (runtime) => {
        await (await runtime).close();
      }),
    );
  }
}

export function createMcpBroker(input: { connections: readonly McpConnection[] }): McpBroker {
  return new DefaultMcpBroker(input.connections);
}

/** Adapt Host-owned MCP capabilities to the Harness's protocol-neutral tool seam. */
const MCP_DISCOVERY_DEFINITIONS = [
  {
    name: "mcp_search_tools",
    title: "Search connected tools",
    description: "Search connected MCP tools by capability. Returns compact tool references.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Capability or action to find." },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "mcp_get_tool",
    title: "Inspect connected tool",
    description: "Inspect the complete input schema for one MCP tool reference.",
    parameters: {
      type: "object",
      properties: { toolRef: { type: "string" } },
      required: ["toolRef"],
    },
  },
  {
    name: "mcp_call_tool",
    title: "Use connected tool",
    description: "Call an MCP tool after finding and inspecting it.",
    parameters: {
      type: "object",
      properties: {
        toolRef: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["toolRef", "arguments"],
    },
  },
] as const;

function recordInput(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function searchCatalog(catalog: McpCatalogSnapshot, query: string, limit: number) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return catalog.tools
    .map((tool, index) => {
      const name = `${tool.ref.connectionId} ${tool.ref.toolName} ${tool.title}`.toLowerCase();
      const description = tool.description.toLowerCase();
      const score = terms.reduce(
        (total, term) =>
          total + (name.includes(term) ? 4 : 0) + (description.includes(term) ? 1 : 0),
        0,
      );
      return { tool, index, score };
    })
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ tool }) => ({
      toolRef: tool.modelName,
      server: tool.ref.connectionId,
      name: tool.ref.toolName,
      title: tool.title,
      description:
        tool.description.length > 240 ? `${tool.description.slice(0, 237)}...` : tool.description,
    }));
}

export function createMcpAgentToolSource(
  broker: McpBroker,
  options: {
    maxDirectSchemaBytes?: number;
    authorize?: (scope: Parameters<AgentToolSource["resolve"]>[0]) => Promise<boolean>;
  } = {},
): AgentToolSource {
  return {
    async resolve(scope) {
      if (options.authorize && !(await options.authorize(scope))) {
        return {
          generation: contentFingerprint({ denied: true, actor: scope.actor?.id }).slice(0, 24),
          definitions: [],
          async invoke() {
            throw new Error("MCP tools are not authorized for this actor");
          },
        };
      }
      const brokerScope = {
        actorId: scope.actor ? `${scope.actor.type}:${scope.actor.id}` : "local:legacy",
        sessionId: scope.sessionId,
      };
      const catalog = await broker.catalog(brokerScope);
      const refsByModelName = new Map(catalog.tools.map((tool) => [tool.modelName, tool.ref]));
      const directDefinitions = catalog.tools.map((tool) => ({
        name: tool.modelName,
        title: tool.title || tool.ref.toolName,
        description: `${tool.title}: ${tool.description}`.replace(/:\s*$/u, ""),
        parameters: tool.inputSchema,
      }));
      const progressive =
        Buffer.byteLength(JSON.stringify(directDefinitions)) >
        (options.maxDirectSchemaBytes ?? 12 * 1024);
      return {
        generation: contentFingerprint({ catalog: catalog.generation, progressive }).slice(0, 24),
        definitions: progressive ? MCP_DISCOVERY_DEFINITIONS : directDefinitions,
        async invoke(call, signal) {
          if (options.authorize && !(await options.authorize(scope))) {
            throw new Error("MCP tools are not authorized for this actor");
          }
          const input = recordInput(call.input);
          if (progressive && call.name === "mcp_search_tools") {
            const query = typeof input.query === "string" ? input.query.trim() : "";
            const limit =
              typeof input.limit === "number" && Number.isSafeInteger(input.limit)
                ? Math.max(1, Math.min(10, input.limit))
                : 5;
            return { matches: searchCatalog(catalog, query, limit) };
          }
          const requestedRef =
            progressive && typeof input.toolRef === "string" ? input.toolRef : call.name;
          const tool = catalog.tools.find((item) => item.modelName === requestedRef);
          if (progressive && call.name === "mcp_get_tool") {
            if (!tool) throw new Error(`Unknown MCP tool reference: ${requestedRef}`);
            return {
              name: tool.modelName,
              server: tool.ref.connectionId,
              tool: tool.ref.toolName,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
            };
          }
          const ref = refsByModelName.get(requestedRef);
          if (!ref) throw new Error(`Unknown MCP model tool: ${call.name}`);
          const argumentsInput = progressive ? input.arguments : call.input;
          return broker.call(brokerScope, ref, argumentsInput, signal);
        },
      };
    },
  };
}
