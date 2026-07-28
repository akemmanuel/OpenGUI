import WebSocket, { type RawData } from "ws";
import { modelToolDefinitionsFor } from "../tools/tool-definitions.ts";
import { codexInput } from "./codex-responses.ts";
import {
  contentFingerprint,
  deriveModelCacheKey,
  deriveModelConnectionKey,
  ModelTransportError,
  normalizeModelError,
  redactProviderText,
  type ModelContextItem,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type ProviderReplayState,
  type ProviderResponseMetadata,
} from "./transport.ts";

export type OpenAiResponsesTransportMode = "auto" | "websocket" | "sse";

export interface DirectOpenAiResponsesRoute {
  backendId: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  reasoning?: boolean;
  compat?: Record<string, unknown>;
}

export interface OpenAiTransportDiagnostic {
  code: "connected" | "reused" | "fallback" | "closed";
  /** Opaque Session-scoped affinity hash; contains no user or credential material. */
  connection: string;
  detail?: string;
}

interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData | string) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

interface PoolEntry {
  socket: SocketLike;
  active: boolean;
  generation: string;
  openedAt: number;
  responseId?: string;
  contextLength?: number;
  contextPrefix?: string;
}

export interface OpenAiResponsesWebSocketOptions {
  mode?: OpenAiResponsesTransportMode;
  maxConnections?: number;
  connectTimeoutMs?: number;
  now?: () => number;
  websocketFactory?: (url: string, headers: Record<string, string>) => SocketLike;
  /** Owner-process diagnostics only. Payloads, identities, headers, and secrets are never passed. */
  diagnostics?: (event: OpenAiTransportDiagnostic) => void;
}

const OFFICIAL_BASE_URL = "https://api.openai.com/v1";
const MAX_CONNECTION_AGE_MS = 55 * 60_000;
const EXTENDED_RETENTION_MODELS = [
  /^gpt-5\.5(?:-|$)/u,
  /^gpt-5\.4(?:-|$)/u,
  /^gpt-5\.2(?:-|$)/u,
  /^gpt-5\.1(?:-|$)/u,
  /^gpt-5(?:-|$)/u,
  /^gpt-4\.1(?:-|$)/u,
];

function normalizedBaseUrl(value: string) {
  return value.replace(/\/+$/u, "");
}

export function isOfficialOpenAiResponsesRoute(route: DirectOpenAiResponsesRoute) {
  return normalizedBaseUrl(route.baseUrl) === OFFICIAL_BASE_URL && Boolean(route.apiKey?.trim());
}

function supportsBreakpoints(route: DirectOpenAiResponsesRoute) {
  return (
    /^gpt-5\.6(?:-|$)/u.test(route.modelId) || route.compat?.supportsPromptCacheBreakpoints === true
  );
}

function supportsLongRetention(route: DirectOpenAiResponsesRoute) {
  if (route.compat?.supportsLongCacheRetention === false) return false;
  if (route.compat?.supportsLongCacheRetention === true) return true;
  return (
    isOfficialOpenAiResponsesRoute(route) &&
    EXTENDED_RETENTION_MODELS.some((x) => x.test(route.modelId))
  );
}

function selectedReasoning(request: ModelRequest) {
  const effort = request.context.findLast((item) => item.type === "user_message")?.reasoning;
  if (!effort || effort === "none" || effort === "off") return undefined;
  return effort === "ultra" ? "max" : effort;
}

function toolsFor(request: ModelRequest) {
  return modelToolDefinitionsFor(request).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

function developerInput(request: ModelRequest, breakpoint: boolean) {
  return {
    type: "message",
    role: "developer",
    content: [
      {
        type: "input_text",
        text: request.systemPrompt,
        ...(breakpoint ? { prompt_cache_breakpoint: { mode: "explicit" } } : {}),
      },
    ],
  };
}

function newContinuationContext(entry: PoolEntry, request: ModelRequest) {
  if (
    !entry.responseId ||
    entry.contextLength === undefined ||
    !entry.contextPrefix ||
    contentFingerprint(request.context.slice(0, entry.contextLength)) !== entry.contextPrefix
  ) {
    return undefined;
  }
  const suffix = request.context
    .slice(entry.contextLength)
    .filter(
      (item): item is Extract<ModelContextItem, { type: "user_message" | "tool_result" }> =>
        item.type === "user_message" || item.type === "tool_result",
    );
  return suffix.length > 0 ? suffix : undefined;
}

/** Deterministic official Responses request shape shared by WebSocket tests and transport. */
export function openAiResponsesWebSocketRequest(
  request: ModelRequest,
  route: DirectOpenAiResponsesRoute,
  cacheKey: string | undefined,
  continuation?: { responseId: string; context: ModelContextItem[] },
) {
  const cacheEnabled = request.cache?.mode === "session" && request.cache.retention !== "none";
  const breakpoint = cacheEnabled && supportsBreakpoints(route);
  const input = continuation
    ? codexInput(continuation.context)
    : [developerInput(request, breakpoint), ...codexInput(request.context)];
  const promptCacheOptions = supportsBreakpoints(route)
    ? request.cache?.mode === "off" || request.cache?.retention === "none"
      ? { mode: "explicit" }
      : { mode: "implicit", ttl: "30m" }
    : undefined;
  return {
    type: "response.create",
    model: route.modelId,
    store: false,
    input,
    tools: toolsFor(request),
    ...(continuation ? { previous_response_id: continuation.responseId } : {}),
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(promptCacheOptions ? { prompt_cache_options: promptCacheOptions } : {}),
    ...(request.cache?.retention === "long" &&
    supportsLongRetention(route) &&
    !supportsBreakpoints(route)
      ? { prompt_cache_retention: "24h" }
      : {}),
    ...(route.reasoning && selectedReasoning(request)
      ? {
          reasoning: { effort: selectedReasoning(request), summary: "auto" },
          include: ["reasoning.encrypted_content"],
        }
      : {}),
  };
}

function parseArguments(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { raw: value };
  }
}

function usageFrom(raw: Record<string, any> | undefined): ModelUsage {
  const cacheRead = raw?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = raw?.input_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, (raw?.input_tokens ?? 0) - cacheRead - cacheWrite);
  const output = raw?.output_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: raw?.output_tokens_details?.reasoning_tokens,
    total: raw?.total_tokens ?? input + output + cacheRead + cacheWrite,
  };
}

function errorFromEvent(event: Record<string, any>) {
  const error = new Error(
    redactProviderText(
      event.error?.message ?? event.response?.error?.message ?? "OpenAI Responses WebSocket error",
    ),
  );
  const status = event.status ?? event.response?.error?.status;
  if (typeof status === "number") Object.assign(error, { status });
  Object.assign(error, {
    providerCode: event.error?.code ?? event.response?.error?.code ?? "provider_error",
  });
  return error;
}

function socketText(raw: RawData | string) {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

function terminalMetadata(input: {
  request: ModelRequest;
  route: DirectOpenAiResponsesRoute;
  event: Record<string, any>;
  cacheKey?: string;
  replay: ProviderReplayState["items"];
  started: number;
  firstDeltaMs?: number;
  now: number;
  toolUse: boolean;
}): ProviderResponseMetadata {
  const usage = usageFrom(input.event.response?.usage);
  return {
    responseId: input.event.response?.id,
    provider: input.route.backendId,
    api: "openai-responses-websocket",
    model: input.route.modelId,
    responseModel: input.event.response?.model,
    protocol: "openai-responses",
    usage,
    stopReason: input.toolUse
      ? "tool_use"
      : input.event.response?.status === "incomplete"
        ? "length"
        : "stop",
    replay: input.replay?.length ? { items: input.replay } : undefined,
    cache: {
      key: input.cacheKey,
      generation: input.request.cache?.generation ?? "legacy",
      readTokens: usage.cacheRead,
      writeTokens: usage.cacheWrite,
    },
    timing: {
      startedAt: new Date(input.started).toISOString(),
      firstDeltaMs: input.firstDeltaMs,
      completedMs: input.now - input.started,
      attempts: 1,
    },
  };
}

export class OpenAiResponsesWebSocketTransport {
  readonly #options: OpenAiResponsesWebSocketOptions;
  readonly #pool = new Map<string, PoolEntry>();

  constructor(options: OpenAiResponsesWebSocketOptions = {}) {
    this.#options = options;
  }

  close() {
    for (const [key, entry] of this.#pool) this.#closeEntry(key, entry, "transport_close");
  }

  #closeEntry(key: string, entry: PoolEntry, detail: string) {
    if (this.#pool.get(key) === entry) this.#pool.delete(key);
    try {
      entry.socket.close(1000, detail.slice(0, 120));
    } catch {
      entry.socket.terminate?.();
    }
    this.#options.diagnostics?.({ code: "closed", connection: key, detail });
  }

  async #connect(key: string, route: DirectOpenAiResponsesRoute, generation: string) {
    const factory =
      this.#options.websocketFactory ??
      ((url: string, headers: Record<string, string>) => new WebSocket(url, { headers }));
    const socket = factory("wss://api.openai.com/v1/responses", {
      authorization: `Bearer ${route.apiKey}`,
      "user-agent": "OpenGUI/1.0",
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate?.();
        reject(new Error("OpenAI WebSocket connection timed out"));
      }, this.#options.connectTimeoutMs ?? 15_000);
      const opened = () => {
        clearTimeout(timeout);
        socket.off("error", failed);
        resolve();
      };
      const failed = (error: Error) => {
        clearTimeout(timeout);
        socket.off("open", opened);
        reject(error);
      };
      socket.on("open", opened);
      socket.on("error", failed);
    });
    const entry: PoolEntry = {
      socket,
      active: true,
      generation,
      openedAt: (this.#options.now ?? Date.now)(),
    };
    this.#pool.set(key, entry);
    this.#options.diagnostics?.({ code: "connected", connection: key });
    return entry;
  }

  async #acquire(request: ModelRequest, route: DirectOpenAiResponsesRoute) {
    const key = deriveModelConnectionKey(request, {
      backendId: route.backendId,
      upstreamModelId: route.modelId,
      protocol: "openai-responses",
    });
    if (!key) return undefined;
    const now = (this.#options.now ?? Date.now)();
    const generation = request.cache?.generation ?? "legacy";
    let entry = this.#pool.get(key);
    if (
      entry &&
      (entry.generation !== generation ||
        now - entry.openedAt >= MAX_CONNECTION_AGE_MS ||
        entry.socket.readyState !== WebSocket.OPEN)
    ) {
      this.#closeEntry(key, entry, "stale");
      entry = undefined;
    }
    if (entry?.active) return undefined;
    if (!entry) {
      const limit = Math.max(1, this.#options.maxConnections ?? 32);
      if (this.#pool.size >= limit) {
        const idle = [...this.#pool].find(([, candidate]) => !candidate.active);
        if (!idle) return undefined;
        this.#closeEntry(idle[0], idle[1], "pool_evict");
      }
      entry = await this.#connect(key, route, generation);
    } else {
      entry.active = true;
      this.#pool.delete(key);
      this.#pool.set(key, entry);
      this.#options.diagnostics?.({ code: "reused", connection: key });
    }
    return { key, entry };
  }

  /** Returns false when the route/mode/pool requires the caller's pi-ai SSE fallback. */
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    route: DirectOpenAiResponsesRoute,
  ): AsyncGenerator<ModelStreamEvent, boolean> {
    signal.throwIfAborted();
    if (this.#options.mode === "sse" || !isOfficialOpenAiResponsesRoute(route)) return false;
    let acquired: { key: string; entry: PoolEntry } | undefined;
    try {
      acquired = await this.#acquire(request, route);
    } catch {
      return false;
    }
    if (!acquired) return false;
    const { key, entry } = acquired;
    const started = (this.#options.now ?? Date.now)();
    const cacheKey = deriveModelCacheKey(request, {
      backendId: route.backendId,
      upstreamModelId: route.modelId,
      protocol: "openai-responses",
    });
    const continuationContext = newContinuationContext(entry, request);
    let continuation =
      continuationContext && entry.responseId
        ? { responseId: entry.responseId, context: continuationContext }
        : undefined;
    let forwarded = false;
    let firstDeltaMs: number | undefined;
    let terminal = false;
    let retriedContinuation = false;
    const replay: NonNullable<ProviderReplayState["items"]> = [];
    const tools = new Map<
      string,
      { id: string; name: string; arguments: string; emitted: boolean }
    >();
    const queued: Array<Record<string, any> | Error> = [];
    let wake: (() => void) | undefined;
    const push = (value: Record<string, any> | Error) => {
      queued.push(value);
      wake?.();
      wake = undefined;
    };
    const onMessage = (raw: RawData | string) => {
      try {
        push(JSON.parse(socketText(raw)) as Record<string, any>);
      } catch {
        push(new Error("OpenAI WebSocket returned malformed JSON"));
      }
    };
    const onClose = (code: number) => push(new Error(`OpenAI WebSocket closed (${code})`));
    const onError = (error: Error) => push(error);
    const abort = () => {
      push(
        signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
      );
      entry.socket.terminate?.();
    };
    entry.socket.on("message", onMessage);
    entry.socket.on("close", onClose);
    entry.socket.on("error", onError);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      entry.socket.send(
        JSON.stringify(openAiResponsesWebSocketRequest(request, route, cacheKey, continuation)),
      );
      while (!terminal) {
        if (queued.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        const next = queued.shift();
        if (!next) continue;
        if (next instanceof Error) throw next;
        if (
          next.type === "error" ||
          next.type === "response.failed" ||
          next.type === "response.incomplete"
        ) {
          if (
            next.error?.code === "previous_response_not_found" &&
            continuation &&
            !retriedContinuation &&
            !forwarded
          ) {
            retriedContinuation = true;
            continuation = undefined;
            entry.responseId = undefined;
            entry.socket.send(
              JSON.stringify(openAiResponsesWebSocketRequest(request, route, cacheKey)),
            );
            continue;
          }
          throw errorFromEvent(next);
        }
        const toolKey = String(next.item_id ?? next.item?.id ?? next.output_index ?? "0");
        if (next.type === "response.output_item.added" && next.item?.type === "function_call") {
          tools.set(toolKey, {
            id: next.item.call_id ?? next.item.id ?? toolKey,
            name: next.item.name ?? "",
            arguments: next.item.arguments ?? "",
            emitted: false,
          });
        } else if (next.type === "response.function_call_arguments.delta") {
          const tool = tools.get(toolKey) ?? {
            id: toolKey,
            name: next.name ?? "",
            arguments: "",
            emitted: false,
          };
          if (typeof next.delta === "string") tool.arguments += next.delta;
          tools.set(toolKey, tool);
          forwarded = true;
          firstDeltaMs ??= (this.#options.now ?? Date.now)() - started;
          yield { type: "tool_call_delta", id: tool.id, name: tool.name, delta: next.delta ?? "" };
        } else if (
          next.type === "response.function_call_arguments.done" ||
          (next.type === "response.output_item.done" && next.item?.type === "function_call")
        ) {
          const item = next.item ?? next;
          const tool = tools.get(toolKey) ?? {
            id: item.call_id ?? item.id ?? toolKey,
            name: "",
            arguments: "",
            emitted: false,
          };
          tool.id = item.call_id ?? item.id ?? tool.id;
          tool.name = item.name ?? tool.name;
          if (typeof item.arguments === "string") tool.arguments = item.arguments;
          tools.set(toolKey, tool);
          if (!tool.emitted) {
            tool.emitted = true;
            forwarded = true;
            yield {
              type: "tool_call",
              id: tool.id,
              name: tool.name,
              input: parseArguments(tool.arguments),
            };
          }
        } else if (next.type === "response.output_text.delta" && typeof next.delta === "string") {
          forwarded = true;
          firstDeltaMs ??= (this.#options.now ?? Date.now)() - started;
          yield { type: "text_delta", delta: next.delta };
        } else if (
          (next.type === "response.reasoning_text.delta" ||
            next.type === "response.reasoning_summary_text.delta" ||
            next.type === "response.reasoning_summary.delta") &&
          typeof next.delta === "string"
        ) {
          forwarded = true;
          firstDeltaMs ??= (this.#options.now ?? Date.now)() - started;
          yield { type: "reasoning_delta", delta: next.delta };
        } else if (
          next.type === "response.output_item.done" &&
          next.item?.type === "reasoning" &&
          next.item.encrypted_content
        ) {
          replay.push({
            type: "reasoning",
            id: next.item.id,
            encryptedContent: next.item.encrypted_content,
          });
        } else if (next.type === "response.completed") {
          terminal = true;
          const completed = (this.#options.now ?? Date.now)();
          entry.responseId = next.response?.id;
          entry.contextLength = request.context.length;
          entry.contextPrefix = contentFingerprint(request.context);
          yield {
            type: "completed",
            response: terminalMetadata({
              request,
              route,
              event: next,
              cacheKey,
              replay,
              started,
              firstDeltaMs,
              now: completed,
              toolUse: tools.size > 0,
            }),
          };
        }
      }
      return true;
    } catch (error) {
      this.#closeEntry(
        key,
        entry,
        signal.aborted ? "abort" : forwarded ? "drop_after_output" : "drop_before_output",
      );
      if (!signal.aborted && !forwarded && !(error as { providerCode?: string }).providerCode) {
        this.#options.diagnostics?.({ code: "fallback", connection: key, detail: "before_output" });
        return false;
      }
      const normalized = normalizeModelError(error, signal);
      throw new ModelTransportError(normalized, {
        provider: route.backendId,
        api: "openai-responses-websocket",
        model: route.modelId,
        protocol: "openai-responses",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        stopReason: normalized.code === "aborted" ? "aborted" : "error",
        cache: {
          key: cacheKey,
          generation: request.cache?.generation ?? "legacy",
          readTokens: 0,
          writeTokens: 0,
        },
        timing: {
          startedAt: new Date(started).toISOString(),
          firstDeltaMs,
          completedMs: (this.#options.now ?? Date.now)() - started,
          attempts: 1,
        },
        diagnostics: [{ code: normalized.code, message: normalized.message }],
      });
    } finally {
      signal.removeEventListener("abort", abort);
      entry.socket.off("message", onMessage as (...args: any[]) => void);
      entry.socket.off("close", onClose as (...args: any[]) => void);
      entry.socket.off("error", onError as (...args: any[]) => void);
      if (this.#pool.get(key) === entry) entry.active = false;
    }
  }
}
