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
  problems: McpConnectionProblem[];
  checkedAt: Record<string, string>;
}

export interface McpConnectionProblem {
  connectionId: string;
  stage: "connect" | "discover" | "invoke";
  code: "timeout" | "authentication" | "permission" | "unavailable" | "protocol" | "unknown";
  retryable: boolean;
  message: string;
}

export type McpResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  status: "ok" | "error";
  summary: string;
  content: McpResultContent[];
  error?: { code: McpConnectionProblem["code"]; retryable: boolean };
  attachments?: Array<{ type: "image"; data: string; mimeType: string }>;
  structured?: unknown;
}

export interface McpBroker {
  /** Returns cached capabilities only. This method never performs remote I/O. */
  catalog(scope: McpActorScope): Promise<McpCatalogSnapshot>;
  /** Refreshes one or all remote catalogs without discarding last-known-good capabilities. */
  refresh(
    scope: McpActorScope,
    connectionId?: string,
    signal?: AbortSignal,
  ): Promise<McpCatalogSnapshot>;
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

interface PendingRuntime {
  controller: AbortController;
  promise: Promise<Runtime>;
}

const MAX_CATALOG_TOOLS = 500;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_PAGES = 100;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

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

function connectionFingerprint(connection: McpConnection | undefined) {
  return contentFingerprint(connection ?? null);
}

function runtimeKey(scope: McpActorScope, connectionId: string) {
  return `${scope.actorId}\u0000${scope.sessionId}\u0000${connectionId}`;
}

function cacheKey(scope: McpActorScope, connectionId: string) {
  return runtimeKey(scope, connectionId);
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
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

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    chain.push(record);
    current = record.cause;
  }
  return chain;
}

function mcpConnectionProblem(
  connectionId: string,
  error: unknown,
  stage: McpConnectionProblem["stage"] = "discover",
): McpConnectionProblem {
  const chain = errorChain(error);
  const text = chain
    .flatMap((item) => (typeof item.message === "string" ? [item.message] : []))
    .join(" ");
  const codes = new Set(
    chain.flatMap((item) => (typeof item.code === "string" ? [item.code] : [])),
  );
  const status = chain.find((item) => typeof item.status === "number")?.status;
  const rpcStatus = chain.find((item) => typeof item.code === "number")?.code;
  if (status === 401 || rpcStatus === 401 || /(?:HTTP\s*)?401\b/iu.test(text)) {
    return {
      connectionId,
      stage,
      code: "authentication",
      retryable: false,
      message: "MCP authentication failed",
    };
  }
  if (status === 403 || rpcStatus === 403 || /(?:HTTP\s*)?403\b/iu.test(text)) {
    return {
      connectionId,
      stage,
      code: "permission",
      retryable: false,
      message: "MCP server denied access",
    };
  }
  const timeoutCodes = ["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"];
  if (timeoutCodes.some((code) => codes.has(code)) || /timed? ?out|timeout/iu.test(text)) {
    return {
      connectionId,
      stage,
      code: "timeout",
      retryable: true,
      message: "MCP connection timed out",
    };
  }
  if (/protocol|parse|json|invalid response|malformed/iu.test(text)) {
    return {
      connectionId,
      stage,
      code: "protocol",
      retryable: false,
      message: "MCP server returned an invalid response",
    };
  }
  const unavailableCodes = [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_SOCKET",
  ];
  if (
    unavailableCodes.some((code) => codes.has(code)) ||
    /fetch failed|connect|socket|network|unavailable/iu.test(text)
  ) {
    return {
      connectionId,
      stage,
      code: "unavailable",
      retryable: true,
      message: "MCP server is unavailable",
    };
  }
  return {
    connectionId,
    stage,
    code: "unknown",
    retryable: false,
    message: "MCP tool discovery failed",
  };
}

class DefaultMcpBroker implements McpBroker {
  readonly #connections: Map<string, McpConnection>;
  readonly #runtimes = new Map<string, PendingRuntime>();
  readonly #catalogs = new Map<string, McpCatalogTool[]>();
  readonly #problems = new Map<string, McpConnectionProblem>();
  readonly #checkedAt = new Map<string, string>();
  readonly #refreshRevisions = new Map<string, number>();
  readonly #discoveryTimeoutMs: number;

  constructor(connections: readonly McpConnection[], discoveryTimeoutMs: number) {
    this.#connections = this.#connectionMap(connections);
    this.#discoveryTimeoutMs = discoveryTimeoutMs;
  }

  #connectionMap(connections: readonly McpConnection[]) {
    const result = new Map(connections.map((connection) => [connection.id, connection]));
    if (result.size !== connections.length) throw new Error("MCP connection IDs must be unique");
    return result;
  }

  async #runtime(scope: McpActorScope, connection: McpConnection, signal?: AbortSignal) {
    const key = runtimeKey(scope, connection.id);
    let pending = this.#runtimes.get(key);
    if (!pending) {
      const controller = new AbortController();
      const connectSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(this.#discoveryTimeoutMs),
      ]);
      const promise = this.#connect(connection, key, connectSignal).catch((error) => {
        if (this.#runtimes.get(key)?.promise === promise) this.#runtimes.delete(key);
        throw error;
      });
      pending = { controller, promise };
      this.#runtimes.set(key, pending);
    }
    return waitWithSignal(pending.promise, signal);
  }

  async #connect(connection: McpConnection, key: string, signal?: AbortSignal): Promise<Runtime> {
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
    try {
      await client.connect(transport, signal ? { signal } : undefined);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return {
      client,
      close: async () => {
        await client.close();
      },
    };
  }

  async catalog(scope: McpActorScope): Promise<McpCatalogSnapshot> {
    const connectionIds = [...this.#connections.keys()];
    const tools: McpCatalogTool[] = [];
    const aggregateProblems: McpConnectionProblem[] = [];
    let catalogBytes = 0;
    for (const id of connectionIds) {
      const key = cacheKey(scope, id);
      for (const tool of this.#catalogs.get(key) ?? []) {
        const bytes =
          Buffer.byteLength(JSON.stringify(tool.inputSchema)) + Buffer.byteLength(tool.description);
        if (tools.length >= MAX_CATALOG_TOOLS || catalogBytes + bytes > MAX_CATALOG_BYTES) {
          aggregateProblems.push({
            connectionId: id,
            stage: "discover",
            code: "protocol",
            retryable: false,
            message: "MCP aggregate tool catalog is too large",
          });
          break;
        }
        tools.push(tool);
        catalogBytes += bytes;
      }
    }
    return {
      generation: contentFingerprint(
        tools.map(({ ref, fingerprint }) => ({ ref, fingerprint })),
      ).slice(0, 24),
      tools,
      problems: connectionIds
        .flatMap((id) => {
          const problem = this.#problems.get(cacheKey(scope, id));
          return problem ? [problem] : [];
        })
        .concat(aggregateProblems),
      checkedAt: Object.fromEntries(
        connectionIds.flatMap((id) => {
          const checkedAt = this.#checkedAt.get(cacheKey(scope, id));
          return checkedAt ? [[id, checkedAt]] : [];
        }),
      ),
    };
  }

  async #discover(
    scope: McpActorScope,
    connection: McpConnection,
    signal?: AbortSignal,
    onConnected?: () => void,
  ): Promise<McpCatalogTool[]> {
    const tools: McpCatalogTool[] = [];
    let catalogBytes = 0;
    const runtime = await this.#runtime(scope, connection, signal);
    onConnected?.();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_CATALOG_PAGES) throw new Error("MCP tool catalog has too many pages");
      const page = await runtime.client.listTools(
        cursor ? { cursor } : undefined,
        signal ? { signal } : undefined,
      );
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
    return tools;
  }

  async refresh(scope: McpActorScope, connectionId?: string, signal?: AbortSignal) {
    const connections = connectionId
      ? [this.#connections.get(connectionId)].filter(
          (connection): connection is McpConnection => connection !== undefined,
        )
      : [...this.#connections.values()];
    if (connectionId && connections.length === 0) {
      throw new Error(`Unknown MCP connection: ${connectionId}`);
    }
    await Promise.all(
      connections.map(async (connection) => {
        const key = cacheKey(scope, connection.id);
        const revision = (this.#refreshRevisions.get(key) ?? 0) + 1;
        this.#refreshRevisions.set(key, revision);
        const fingerprint = connectionFingerprint(connection);
        const timeoutSignal = AbortSignal.timeout(this.#discoveryTimeoutMs);
        const refreshSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let connected = false;
        try {
          const tools = await this.#discover(scope, connection, refreshSignal, () => {
            connected = true;
          });
          if (
            connectionFingerprint(this.#connections.get(connection.id)) !== fingerprint ||
            this.#refreshRevisions.get(key) !== revision
          )
            return;
          this.#catalogs.set(key, tools);
          this.#problems.delete(key);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (
            connectionFingerprint(this.#connections.get(connection.id)) !== fingerprint ||
            this.#refreshRevisions.get(key) !== revision
          )
            return;
          const problem: McpConnectionProblem = timeoutSignal.aborted
            ? {
                connectionId: connection.id,
                stage: connected ? ("discover" as const) : ("connect" as const),
                code: "timeout",
                retryable: true,
                message: connected ? "MCP tool discovery timed out" : "MCP connection timed out",
              }
            : mcpConnectionProblem(connection.id, error, connected ? "discover" : "connect");
          this.#problems.set(key, problem);
          if (!problem.retryable) this.#catalogs.delete(key);
        } finally {
          if (
            !signal?.aborted &&
            connectionFingerprint(this.#connections.get(connection.id)) === fingerprint &&
            this.#refreshRevisions.get(key) === revision
          ) {
            this.#checkedAt.set(key, new Date().toISOString());
          }
        }
      }),
    );
    return this.catalog(scope);
  }

  async call(
    scope: McpActorScope,
    ref: McpToolRef,
    input: unknown,
    signal: AbortSignal,
  ): Promise<McpToolResult> {
    const connection = this.#connections.get(ref.connectionId);
    if (!connection) throw new Error(`Unknown MCP connection: ${ref.connectionId}`);
    const runtime = await this.#runtime(scope, connection, signal);
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
    const changed = new Set(
      [...new Set([...this.#connections.keys(), ...next.keys()])].filter(
        (id) =>
          connectionFingerprint(this.#connections.get(id)) !== connectionFingerprint(next.get(id)),
      ),
    );
    await this.#closeRuntimes(changed);
    for (const id of changed) {
      for (const key of this.#catalogs.keys()) {
        if (key.endsWith(`\u0000${id}`)) this.#catalogs.delete(key);
      }
      for (const key of this.#problems.keys()) {
        if (key.endsWith(`\u0000${id}`)) this.#problems.delete(key);
      }
      for (const key of this.#checkedAt.keys()) {
        if (key.endsWith(`\u0000${id}`)) this.#checkedAt.delete(key);
      }
      for (const key of this.#refreshRevisions.keys()) {
        if (key.endsWith(`\u0000${id}`)) this.#refreshRevisions.delete(key);
      }
    }
    this.#connections.clear();
    for (const [id, connection] of next) this.#connections.set(id, connection);
  }

  async #closeRuntimes(connectionIds?: ReadonlySet<string>) {
    const runtimes = [...this.#runtimes.entries()].filter(
      ([key]) => !connectionIds || [...connectionIds].some((id) => key.endsWith(`\u0000${id}`)),
    );
    for (const [key] of runtimes) this.#runtimes.delete(key);
    for (const [, pending] of runtimes) pending.controller.abort(new Error("MCP runtime closed"));
    await Promise.allSettled(
      runtimes.map(async ([, pending]) => {
        await (await pending.promise).close();
      }),
    );
  }
}

export function createMcpBroker(input: {
  connections: readonly McpConnection[];
  discoveryTimeoutMs?: number;
}): McpBroker {
  return new DefaultMcpBroker(
    input.connections,
    input.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
  );
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
    async resolve(scope, signal) {
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
      // Discovery used to happen on every AgentToolSource resolution. Keep that behavior while
      // bounding failures per connection and retaining last-known-good tools.
      const catalog = await broker.refresh(brokerScope, undefined, signal);
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
          try {
            return await broker.call(brokerScope, ref, argumentsInput, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            const problem = mcpConnectionProblem(ref.connectionId, error, "invoke");
            if (problem.code === "unknown") throw error;
            return {
              status: "error",
              summary: problem.message,
              content: [],
              error: { code: problem.code, retryable: problem.retryable },
            } satisfies McpToolResult;
          }
        },
      };
    },
  };
}
