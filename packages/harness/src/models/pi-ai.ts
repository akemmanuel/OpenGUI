import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelThinkingLevel,
  ProviderHeaders,
  SimpleStreamOptions,
  Tool,
  Transport,
} from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import {
  closeOpenAICodexWebSocketSessions,
  streamSimple as streamOpenAiCodexResponses,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { modelToolDefinitionsFor } from "../tools/tool-definitions.ts";
import {
  OpenAiResponsesWebSocketTransport,
  type OpenAiResponsesTransportMode,
  type OpenAiResponsesWebSocketOptions,
  type OpenAiTransportDiagnostic,
} from "./openai-responses-websocket.ts";
import {
  deriveModelCacheKey,
  deriveModelConnectionKey,
  modelImageData,
  modelToolResultContent,
  ModelTransportError,
  normalizeModelError,
  redactProviderText,
  type ModelContextItem,
  type ModelProtocol,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTransport,
  type ModelUsage,
  type ProviderReplayState,
  type ProviderResponseMetadata,
} from "./transport.ts";

export type PiAiProtocol =
  | "openai-chat"
  | "openai-responses"
  | "codex-responses"
  | "anthropic-messages";

/** OpenGUI-owned route material. It is resolved per request and is never persisted by pi-ai. */
export interface PiAiRoute {
  backendId: string;
  providerId?: string;
  label: string;
  protocol: PiAiProtocol;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  headers?: ProviderHeaders;
  authHeader?: boolean;
  reasoning?: boolean;
  reasoningEfforts?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  /** pi-ai transport selection. Codex defaults to safe cached WebSocket with SSE fallback. */
  transport?: Transport;
  websocketConnectTimeoutMs?: number;
}

type PiStream = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface PiAiTransportOptions {
  /** Called only after the Host router has authorized and resolved an offering. */
  resolve: (request: ModelRequest) => PiAiRoute | Promise<PiAiRoute>;
  streams?: Partial<Record<PiAiProtocol, PiStream>>;
  /** Test/diagnostic hook. Must not retain payloads because they can contain prompt content. */
  inspectPayload?: (payload: unknown, route: PiAiRoute) => void;
  now?: () => number;
  /** Maximum number of inactive Codex session sockets retained by this adapter. */
  maxCodexConnections?: number;
  /** Official direct-key Responses transport. Custom endpoints always remain on pi-ai SSE. */
  openAiResponsesTransport?: OpenAiResponsesTransportMode;
  maxOpenAiConnections?: number;
  openAiWebSocketFactory?: OpenAiResponsesWebSocketOptions["websocketFactory"];
  diagnostics?: (event: OpenAiTransportDiagnostic) => void;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

function apiFor(protocol: PiAiProtocol): Api {
  if (protocol === "openai-chat") return "openai-completions";
  if (protocol === "codex-responses") return "openai-codex-responses";
  return protocol;
}

function protocolFor(route: PiAiRoute): ModelProtocol {
  return route.protocol;
}

function selectedReasoning(
  request: ModelRequest,
  route: PiAiRoute,
): ModelThinkingLevel | undefined {
  if (!route.reasoning) return undefined;
  const raw = [...request.context]
    .reverse()
    .find((item) => item.type === "user_message")?.reasoning;
  if (!raw || raw === "none" || raw === "off") return undefined;
  if (raw === "ultra") return "max";
  return ["minimal", "low", "medium", "high", "xhigh", "max"].includes(raw)
    ? (raw as ModelThinkingLevel)
    : undefined;
}

function piUsage(message: AssistantMessage): ModelUsage {
  return {
    input: message.usage.input,
    output: message.usage.output,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    reasoning: message.usage.reasoning,
    total: message.usage.totalTokens,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...ZERO_COST, total: 0 },
  };
}

function replayContent(item: Extract<ModelContextItem, { type: "assistant_message" }>) {
  const replay = item.replay?.items ?? [];
  const thinking = replay.flatMap((state) => {
    if (state.type === "reasoning" && state.encryptedContent) {
      return [
        {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: state.encryptedContent,
        },
      ];
    }
    if (state.type === "thinking" && (state.signature || state.encryptedContent)) {
      return [
        {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: state.encryptedContent ?? state.signature,
          ...(state.encryptedContent ? { redacted: true } : {}),
        },
      ];
    }
    return [];
  });
  const textState = replay.find((state) => state.type === "text" && state.signature);
  return [
    ...thinking,
    { type: "text" as const, text: item.text, textSignature: textState?.signature },
  ];
}

export function toPiContext(request: ModelRequest, model: Model<Api>, timestamp = 0): Context {
  const messages: Context["messages"] = [];
  let pendingToolCalls: Array<Extract<ModelContextItem, { type: "tool_call" }>> = [];
  let pendingToolResults: Array<Extract<ModelContextItem, { type: "tool_result" }>> = [];

  const flushToolExchange = () => {
    if (pendingToolCalls.length > 0) {
      const toolCalls = pendingToolCalls.map((item) => ({
        type: "toolCall" as const,
        id: item.toolCallId,
        name: item.name,
        arguments: (item.input ?? {}) as Record<string, any>,
      }));
      const last = messages.at(-1);
      if (last?.role === "assistant") {
        last.content.push(...toolCalls);
        last.stopReason = "toolUse";
      } else {
        messages.push({
          role: "assistant",
          content: toolCalls,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: "toolUse",
          timestamp,
        });
      }
    }
    for (const item of pendingToolResults) {
      const result = modelToolResultContent(item.output);
      messages.push({
        role: "toolResult",
        toolCallId: item.toolCallId,
        toolName: item.name,
        content: [
          ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
          ...result.images.map((image) => ({
            type: "image" as const,
            data: modelImageData(image),
            mimeType: image.mimeType,
          })),
        ],
        isError: false,
        timestamp,
      });
    }
    pendingToolCalls = [];
    pendingToolResults = [];
  };

  for (const item of request.context) {
    if (item.type === "user_message") {
      flushToolExchange();
      messages.push({ role: "user", content: item.text, timestamp });
      continue;
    }
    if (item.type === "assistant_message") {
      flushToolExchange();
      messages.push({
        role: "assistant",
        content: replayContent(item),
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp,
      });
      continue;
    }
    if (item.type === "tool_call") {
      // A call after results starts a new model turn. Consecutive calls before
      // results are one parallel assistant turn and must remain grouped.
      if (pendingToolResults.length > 0) flushToolExchange();
      pendingToolCalls.push(item);
      continue;
    }
    pendingToolResults.push(item);
  }
  flushToolExchange();
  const tools = modelToolDefinitionsFor(request).map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }) as Tool,
  );
  return { systemPrompt: request.systemPrompt, messages, tools };
}

function replayFrom(message: AssistantMessage): ProviderReplayState | undefined {
  const items: NonNullable<ProviderReplayState["items"]> = [];
  for (const block of message.content) {
    if (block.type === "thinking" && block.thinkingSignature) {
      if (message.api === "openai-responses" || message.api === "openai-codex-responses") {
        items.push({ type: "reasoning", encryptedContent: block.thinkingSignature });
      } else {
        items.push(
          block.redacted
            ? { type: "thinking", encryptedContent: block.thinkingSignature }
            : { type: "thinking", signature: block.thinkingSignature },
        );
      }
    } else if (block.type === "text" && block.textSignature) {
      items.push({ type: "text", signature: block.textSignature });
    }
  }
  return items.length > 0 ? { items } : undefined;
}

function responseMetadata(input: {
  request: ModelRequest;
  route: PiAiRoute;
  message: AssistantMessage;
  started: number;
  completed: number;
  firstDeltaMs?: number;
}): ProviderResponseMetadata {
  const usage = piUsage(input.message);
  return {
    responseId: input.message.responseId,
    provider: input.route.backendId,
    api: input.message.api,
    model: input.route.modelId,
    responseModel: input.message.responseModel,
    protocol: protocolFor(input.route),
    usage,
    stopReason: input.message.stopReason === "toolUse" ? "tool_use" : input.message.stopReason,
    replay: replayFrom(input.message),
    cache: {
      key: input.request.cache?.key,
      generation: input.request.cache?.generation ?? "legacy",
      readTokens: usage.cacheRead,
      writeTokens: usage.cacheWrite,
    },
    timing: {
      startedAt: new Date(input.started).toISOString(),
      firstDeltaMs: input.firstDeltaMs,
      completedMs: input.completed - input.started,
      attempts: 1,
    },
    diagnostics: input.message.diagnostics?.map((item) => ({
      code: item.type,
      message: redactProviderText(item.error?.message ?? item.type),
    })),
  };
}

function errorFromPi(
  message: AssistantMessage,
  signal: AbortSignal,
  secret?: string,
  responseStatus?: number,
) {
  const error = new Error(
    redactProviderText(message.errorMessage ?? "Model provider error", secret ? [secret] : []),
  );
  const status =
    responseStatus ??
    Number(/(?:^|\D)(401|403|408|409|422|429|5\d\d)(?:\D|$)/u.exec(error.message)?.[1]);
  if (Number.isFinite(status) && status > 0) Object.assign(error, { status });
  return normalizeModelError(error, signal);
}

function applyCurrentOpenAiCacheFields(payload: unknown, request: ModelRequest, route: PiAiRoute) {
  if (route.protocol !== "openai-responses" || !payload || typeof payload !== "object") {
    return payload;
  }
  const body = payload as Record<string, any>;
  const official = route.baseUrl.replace(/\/+$/u, "") === "https://api.openai.com/v1";
  const breakpoints =
    /^gpt-5\.6(?:-|$)/u.test(route.modelId) ||
    route.compat?.supportsPromptCacheBreakpoints === true;
  const cacheEnabled = request.cache?.mode === "session" && request.cache.retention !== "none";

  if (breakpoints) {
    delete body.prompt_cache_retention;
    body.prompt_cache_options = cacheEnabled
      ? { mode: "implicit", ttl: "30m" }
      : { mode: "explicit" };
    if (cacheEnabled && Array.isArray(body.input)) {
      const stableMessage = body.input.find(
        (item: Record<string, any>) => item?.role === "developer" || item?.role === "system",
      );
      if (stableMessage && typeof stableMessage.content === "string") {
        stableMessage.content = [{ type: "input_text", text: stableMessage.content }];
      }
      const block = Array.isArray(stableMessage?.content)
        ? stableMessage.content.findLast((item: Record<string, any>) => item?.type === "input_text")
        : undefined;
      if (block) block.prompt_cache_breakpoint = { mode: "explicit" };
    }
    return body;
  }

  const knownExtendedModel = [
    /^gpt-5\.5(?:-|$)/u,
    /^gpt-5\.4(?:-|$)/u,
    /^gpt-5\.2(?:-|$)/u,
    /^gpt-5\.1(?:-|$)/u,
    /^gpt-5(?:-|$)/u,
    /^gpt-4\.1(?:-|$)/u,
  ].some((pattern) => pattern.test(route.modelId));
  if (
    request.cache?.retention !== "long" ||
    route.compat?.supportsLongCacheRetention === false ||
    (!official && route.compat?.supportsLongCacheRetention !== true) ||
    (official && !knownExtendedModel && route.compat?.supportsLongCacheRetention !== true)
  ) {
    delete body.prompt_cache_retention;
  }
  if (!official && route.compat?.supportsExplicitPromptCacheMode !== true) {
    delete body.prompt_cache_options;
  }
  return body;
}

export class PiAiTransport implements ModelTransport {
  readonly #options: PiAiTransportOptions;
  readonly #codexConnections = new Map<string, { generation: string; active: number }>();
  readonly #openAiResponses: OpenAiResponsesWebSocketTransport;

  constructor(options: PiAiTransportOptions) {
    this.#options = options;
    this.#openAiResponses = new OpenAiResponsesWebSocketTransport({
      mode: options.openAiResponsesTransport ?? "auto",
      maxConnections: options.maxOpenAiConnections,
      websocketFactory: options.openAiWebSocketFactory,
      diagnostics: options.diagnostics,
      now: options.now,
    });
  }

  close() {
    this.#openAiResponses.close();
    for (const key of this.#codexConnections.keys()) closeOpenAICodexWebSocketSessions(key);
    this.#codexConnections.clear();
  }

  #acquireCodexConnection(request: ModelRequest, route: PiAiRoute) {
    if (route.protocol !== "codex-responses" || request.cache?.mode !== "session") return undefined;
    const key = deriveModelConnectionKey(request, {
      backendId: route.backendId,
      upstreamModelId: route.modelId,
      protocol: "codex-responses",
    });
    if (!key) return undefined;
    const generation = request.cache?.generation ?? "legacy";
    const existing = this.#codexConnections.get(key);
    if (existing && existing.generation !== generation) {
      closeOpenAICodexWebSocketSessions(key);
      this.#codexConnections.delete(key);
    }
    let entry = this.#codexConnections.get(key);
    const limit = Math.max(1, this.#options.maxCodexConnections ?? 32);
    if (!entry && this.#codexConnections.size >= limit) {
      const idle = [...this.#codexConnections].find(([, value]) => value.active === 0);
      if (!idle) return undefined;
      closeOpenAICodexWebSocketSessions(idle[0]);
      this.#codexConnections.delete(idle[0]);
    }
    entry ??= { generation, active: 0 };
    entry.active += 1;
    this.#codexConnections.delete(key);
    this.#codexConnections.set(key, entry);
    return {
      key,
      release: () => {
        const current = this.#codexConnections.get(key);
        if (current) current.active = Math.max(0, current.active - 1);
      },
    };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const now = this.#options.now ?? Date.now;
    const started = now();
    // This is the authority boundary: no model or credential is materialized before resolution.
    const route = await this.#options.resolve(request);
    if (
      route.protocol === "openai-responses" &&
      (this.#options.openAiWebSocketFactory || !this.#options.streams?.["openai-responses"]) &&
      !this.#options.inspectPayload
    ) {
      const delivered = yield* this.#openAiResponses.stream(request, signal, route);
      if (delivered) return;
    }
    const codexConnection = this.#acquireCodexConnection(request, route);
    const api = apiFor(route.protocol);
    const headers: ProviderHeaders = { ...route.headers };
    if (route.authHeader === false) headers.authorization = null;
    if (
      route.authHeader &&
      route.apiKey &&
      !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
    ) {
      headers.authorization = `Bearer ${route.apiKey}`;
    }
    const model = {
      id: route.modelId,
      name: route.label,
      api,
      provider: route.providerId ?? route.backendId,
      baseUrl: route.baseUrl.replace(/\/+$/u, ""),
      reasoning: route.reasoning ?? false,
      input: ["text", "image"],
      contextWindow: route.contextWindow ?? 128_000,
      maxTokens: route.maxTokens ?? 16_384,
      cost: ZERO_COST,
      headers: Object.fromEntries(
        Object.entries(headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : [],
        ),
      ),
      compat: route.compat,
    } as Model<Api>;
    const key = deriveModelCacheKey(request, {
      backendId: route.backendId,
      upstreamModelId: route.modelId,
      protocol: protocolFor(route),
    });
    const effectiveRequest = request.cache
      ? { ...request, cache: { ...request.cache, key } }
      : request;
    const context = toPiContext(effectiveRequest, model);
    const streams = this.#options.streams;
    const streamImpl = (streams?.[route.protocol] ??
      (route.protocol === "openai-chat"
        ? streamOpenAiCompletions
        : route.protocol === "codex-responses"
          ? streamOpenAiCodexResponses
          : route.protocol === "openai-responses"
            ? streamOpenAiResponses
            : streamAnthropic)) as PiStream;
    const cacheRetention =
      effectiveRequest.cache?.mode === "session" ? effectiveRequest.cache.retention : "none";
    let firstDeltaMs: number | undefined;
    let responseStatus: number | undefined;
    const piStream = streamImpl(model, context, {
      signal,
      // Some OpenAI-compatible endpoints allow anonymous requests. The SDK still
      // requires a placeholder key; an explicit null Authorization header above
      // removes the header it would otherwise generate.
      apiKey: route.apiKey || "unused",
      headers,
      reasoning: selectedReasoning(effectiveRequest, route) as any,
      sessionId: codexConnection?.key ?? key,
      cacheRetention,
      transport:
        route.protocol === "codex-responses"
          ? codexConnection
            ? (route.transport ?? "auto")
            : "sse"
          : route.transport,
      websocketConnectTimeoutMs: route.websocketConnectTimeoutMs,
      timeoutMs: effectiveRequest.delivery?.timeoutMs,
      // OpenGUI owns Codex credential refresh and request replay. Keeping the
      // provider's SSE retry loop at zero prevents repeated stale-token POSTs;
      // WebSocket reconnect/continuation recovery remains inside pi-ai.
      maxRetries: route.protocol === "codex-responses" ? 0 : effectiveRequest.delivery?.maxRetries,
      maxRetryDelayMs: effectiveRequest.delivery?.maxRetryDelayMs,
      onResponse: (response) => {
        responseStatus = response.status;
      },
      onPayload: (payload) => {
        const effectivePayload = applyCurrentOpenAiCacheFields(payload, effectiveRequest, route);
        this.#options.inspectPayload?.(effectivePayload, route);
        return effectivePayload;
      },
    });

    let terminal = false;
    try {
      for await (const event of piStream) {
        if (event.type === "text_delta") {
          firstDeltaMs ??= now() - started;
          yield { type: "text_delta", delta: event.delta };
        } else if (event.type === "thinking_delta") {
          firstDeltaMs ??= now() - started;
          yield { type: "reasoning_delta", delta: event.delta };
        } else if (event.type === "toolcall_delta") {
          firstDeltaMs ??= now() - started;
          const block = event.partial.content[event.contentIndex];
          yield {
            type: "tool_call_delta",
            id: block?.type === "toolCall" ? block.id : "",
            name: block?.type === "toolCall" ? block.name : "",
            delta: event.delta,
          };
        } else if (event.type === "toolcall_end") {
          yield {
            type: "tool_call",
            id: event.toolCall.id,
            name: event.toolCall.name,
            input: event.toolCall.arguments,
          };
        } else if (event.type === "done") {
          terminal = true;
          yield {
            type: "completed",
            response: responseMetadata({
              request: effectiveRequest,
              route,
              message: event.message,
              started,
              completed: now(),
              firstDeltaMs,
            }),
          };
        } else if (event.type === "error") {
          terminal = true;
          const completed = now();
          const normalized = errorFromPi(event.error, signal, route.apiKey, responseStatus);
          throw new ModelTransportError(normalized, {
            ...responseMetadata({
              request: effectiveRequest,
              route,
              message: event.error,
              started,
              completed,
              firstDeltaMs,
            }),
            stopReason: normalized.code === "aborted" ? "aborted" : "error",
            diagnostics: [{ code: normalized.code, message: normalized.message }],
          });
        }
      }
    } finally {
      codexConnection?.release();
    }
    if (!terminal) {
      const normalized = normalizeModelError(
        new Error("Model stream ended before completion"),
        signal,
      );
      throw new ModelTransportError(normalized, {
        provider: route.backendId,
        api,
        model: route.modelId,
        protocol: protocolFor(route),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        stopReason: normalized.code === "aborted" ? "aborted" : "error",
        cache: {
          key,
          generation: effectiveRequest.cache?.generation ?? "legacy",
          readTokens: 0,
          writeTokens: 0,
        },
        timing: {
          startedAt: new Date(started).toISOString(),
          firstDeltaMs,
          completedMs: now() - started,
          attempts: 1,
        },
        diagnostics: [{ code: normalized.code, message: normalized.message }],
      });
    }
  }
}

/** Tiny deterministic benchmark used by tests to catch accidental pre-stream buffering. */
export function benchmarkPiSerialization(
  request: ModelRequest,
  route: PiAiRoute,
  iterations = 100,
) {
  const model = {
    id: route.modelId,
    name: route.label,
    api: apiFor(route.protocol),
    provider: route.providerId ?? route.backendId,
    baseUrl: route.baseUrl,
    reasoning: route.reasoning ?? false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: route.contextWindow ?? 128_000,
    maxTokens: route.maxTokens ?? 16_384,
  } as Model<Api>;
  const started = performance.now();
  let bytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    bytes += JSON.stringify(toPiContext(request, model)).length;
  }
  return { iterations, bytes, elapsedMs: performance.now() - started };
}
