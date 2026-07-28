import { modelToolDefinitionsFor } from "../tools/tool-definitions.ts";
import { CodexResponsesTransport } from "./codex-responses.ts";
import type {
  ModelContextItem,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from "./transport.ts";
import {
  deriveModelCacheKey,
  redactProviderText,
  isPossibleImageInputRejection,
  modelContextHasImages,
  modelToolResultContent,
  withoutModelContextImages,
} from "./transport.ts";
import type { ModelProtocol, ModelUsage, ProviderReplayState } from "./transport.ts";

export interface OpenAiCompatibleConnection {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  modelIds: string[];
  defaultModelId?: string;
  modelRoutes?: Record<string, "openai-chat" | "anthropic-messages" | "responses">;
  modelCapabilities?: Record<
    string,
    {
      displayName?: string;
      context?: number;
      reasoning: boolean;
      reasoningEfforts?: string[];
    }
  >;
}

export interface OpenAiChatTransportOptions {
  fetchImpl?: typeof fetch;
}

export function toChatMessages(context: ModelContextItem[]) {
  const messages: Array<Record<string, unknown>> = [];
  let pendingToolCalls: Array<Record<string, unknown>> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];
  let pendingImages: Array<{ type: "image_url"; image_url: { url: string } }> = [];

  const flushToolExchange = () => {
    if (pendingToolCalls.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      const existing = Array.isArray(last.tool_calls) ? last.tool_calls : [];
      last.tool_calls = [...existing, ...pendingToolCalls];
      if (typeof last.content !== "string") last.content = null;
    } else {
      messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
    }
    messages.push(...pendingToolResults);
    if (pendingImages.length > 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...pendingImages],
      });
    }
    pendingToolCalls = [];
    pendingToolResults = [];
    pendingImages = [];
  };

  for (const item of context) {
    if (item.type === "user_message") {
      flushToolExchange();
      messages.push({ role: "user", content: item.text });
      continue;
    }
    if (item.type === "assistant_message") {
      flushToolExchange();
      messages.push({ role: "assistant", content: item.text });
      continue;
    }
    if (item.type === "tool_call") {
      // Session store writes parallel tools as tool_call* then tool_result*, and
      // sequential turns as tool_call/tool_result pairs. Starting a new tool call
      // after results means a new model turn — flush so we do not rewrite sequential
      // history into one parallel tool_calls block (OpenCode/DeepSeek rejects that).
      if (pendingToolResults.length > 0) flushToolExchange();
      const toolCall = {
        id: item.toolCallId,
        type: "function",
        function: {
          name: item.name,
          arguments: JSON.stringify(item.input ?? {}),
        },
      };
      pendingToolCalls.push(toolCall);
      continue;
    }
    if (item.type === "tool_result") {
      const result = modelToolResultContent(item.output);
      pendingToolResults.push({
        role: "tool",
        tool_call_id: item.toolCallId,
        content:
          result.text || (result.images.length > 0 ? "(see attached image)" : "(no tool output)"),
      });
      pendingImages.push(
        ...result.images.map((image) => ({
          type: "image_url" as const,
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        })),
      );
    }
  }
  flushToolExchange();
  return messages;
}

function toolsForRequest(request: ModelRequest) {
  return modelToolDefinitionsFor(request).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function parseArguments(raw: string) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

function safeProviderError(body: string, status: number, apiKey?: string) {
  const redacted = redactProviderText(body, apiKey ? [apiKey] : []);
  return redacted || `Model request failed (${status})`;
}

export function shouldRetryChatCompletion(status: number, body: string) {
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    /upstream request failed|temporarily unavailable|overloaded/i.test(body)
  );
}

function waitForRetry(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

export function chatDeltaEvents(delta: Record<string, any>): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [];
  const reasoning =
    typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta.reasoning === "string"
        ? delta.reasoning
        : Array.isArray(delta.reasoning_details)
          ? delta.reasoning_details
              .map((part: Record<string, any>) =>
                typeof part?.text === "string"
                  ? part.text
                  : typeof part?.delta === "string"
                    ? part.delta
                    : "",
              )
              .join("")
          : "";
  if (reasoning) events.push({ type: "reasoning_delta", delta: reasoning });
  if (typeof delta.content === "string" && delta.content) {
    events.push({ type: "text_delta", delta: delta.content });
  }
  return events;
}

export class OpenAiChatTransport implements ModelTransport {
  readonly #options: OpenAiChatTransportOptions;
  readonly #connections = new Map<string, OpenAiCompatibleConnection>();
  readonly #imageUnsupportedModels = new Set<string>();
  #defaultConnectionId: string | null = null;

  constructor(options: OpenAiChatTransportOptions = {}) {
    this.#options = options;
  }

  setConnections(connections: OpenAiCompatibleConnection[], defaultConnectionId?: string | null) {
    this.#connections.clear();
    this.#imageUnsupportedModels.clear();
    for (const connection of connections) this.#connections.set(connection.id, connection);
    this.#defaultConnectionId = defaultConnectionId ?? connections[0]?.id ?? null;
  }

  listConnections() {
    return [...this.#connections.values()];
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const started = Date.now();
    let firstDeltaMs: number | undefined;
    const selected = [...request.context].reverse().find((item) => item.type === "user_message");
    const connectionId = selected?.model.connectionId ?? this.#defaultConnectionId;
    if (!connectionId) throw new Error("No model connection is configured");
    const connection = this.#connections.get(connectionId);
    if (!connection) throw new Error(`Unknown model connection: ${connectionId}`);
    const modelId = selected?.model.modelId ?? connection.defaultModelId ?? connection.modelIds[0];
    if (!modelId) throw new Error(`No model configured for connection ${connectionId}`);
    const modelKey = `${connectionId}/${modelId}`;
    const effectiveRequest = this.#imageUnsupportedModels.has(modelKey)
      ? { ...request, context: withoutModelContextImages(request.context) }
      : request;
    const configuredRoute = connection.modelRoutes?.[modelId];
    const protocol: ModelProtocol =
      configuredRoute === "anthropic-messages"
        ? "anthropic-messages"
        : configuredRoute === "responses"
          ? "openai-responses"
          : "openai-chat";
    const cacheKey = deriveModelCacheKey(request, {
      backendId: connectionId,
      upstreamModelId: modelId,
      protocol,
    });
    effectiveRequest.cache = request.cache ? { ...request.cache, key: cacheKey } : undefined;

    if (configuredRoute === "responses") {
      const responses = new CodexResponsesTransport({
        endpoint: `${connection.baseUrl.replace(/\/+$/, "")}/responses`,
        requestLabel: connection.label,
        getCredential: async () => ({ accessToken: connection.apiKey ?? "", accountId: "" }),
        fetchImpl: this.#options.fetchImpl,
        protocol: "openai-responses",
        providerId: connection.id,
        apiId: "openai-responses",
      });
      for await (const event of responses.stream(effectiveRequest, signal)) {
        if (event.type === "completed" && event.response) {
          yield {
            ...event,
            response: {
              ...event.response,
              provider: connection.id,
              api: "openai-responses",
              protocol: "openai-responses",
            },
          };
        } else yield event;
      }
      return;
    }

    if (connection.modelRoutes?.[modelId] === "anthropic-messages") {
      yield* this.#streamAnthropic(connection, modelId, effectiveRequest, signal);
      return;
    }

    const baseUrl = connection.baseUrl.replace(/\/+$/, "");
    const body = JSON.stringify({
      model: modelId,
      stream: true,
      ...(selected?.reasoning && selected.reasoning !== "none"
        ? { reasoning_effort: selected.reasoning }
        : {}),
      messages: [
        {
          role: "system",
          content: request.systemPrompt,
        },
        ...toChatMessages(effectiveRequest.context),
      ],
      tools: toolsForRequest(request),
      ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    });

    let response: Response | undefined;
    const maxAttempts = (request.delivery?.maxRetries ?? 2) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      response = await (this.#options.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body,
        signal,
      });
      if (response.ok && response.body) break;
      const text = await response.text().catch(() => "");
      if (
        isPossibleImageInputRejection(response.status) &&
        modelContextHasImages(effectiveRequest.context)
      ) {
        this.#imageUnsupportedModels.add(modelKey);
        yield* this.stream(request, signal);
        return;
      }
      if (attempt === maxAttempts - 1 || !shouldRetryChatCompletion(response.status, text)) {
        const error = new Error(safeProviderError(text, response.status, connection.apiKey));
        Object.assign(error, { status: response.status });
        throw error;
      }
      await waitForRetry(
        Math.min(500 * 2 ** attempt, request.delivery?.maxRetryDelayMs ?? 60_000),
        signal,
      );
    }
    if (!response?.body) throw new Error("Model response did not include a body");

    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    let stopReason: "stop" | "length" | "tool_use" = "stop";
    let responseId: string | undefined;
    let responseModel: string | undefined;
    let usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const toolBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      if (done) buffer = "";
      else buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          completed = true;
          continue;
        }
        const parsed = JSON.parse(data) as {
          id?: string;
          model?: string;
          usage?: Record<string, any>;
          choices?: Array<{
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              reasoning?: string | null;
              reasoning_content?: string | null;
              reasoning_details?: Array<Record<string, unknown>>;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        responseId ||= parsed.id;
        responseModel ||= parsed.model;
        if (parsed.usage) usage = chatUsage(parsed.usage);
        const choice = parsed.choices?.[0];
        if (typeof choice?.finish_reason === "string") {
          completed = true;
          stopReason =
            choice.finish_reason === "length"
              ? "length"
              : choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call"
                ? "tool_use"
                : "stop";
        }
        const delta = choice?.delta;
        if (!delta) continue;
        for (const event of chatDeltaEvents(delta)) {
          firstDeltaMs ??= Date.now() - started;
          yield event;
        }
        for (const toolCall of delta.tool_calls ?? []) {
          const index = toolCall.index ?? 0;
          const existing = toolBuffers.get(index) ?? { id: "", name: "", arguments: "" };
          if (toolCall.id) existing.id = toolCall.id;
          if (toolCall.function?.name) existing.name = toolCall.function.name;
          if (toolCall.function?.arguments) existing.arguments += toolCall.function.arguments;
          toolBuffers.set(index, existing);
        }
      }
      if (done) break;
    }

    if (!completed) throw new Error("Model stream ended before completion");

    for (const toolCall of toolBuffers.values()) {
      yield {
        type: "tool_call",
        id: toolCall.id || `tool_${toolCall.name}`,
        name: toolCall.name,
        input: parseArguments(toolCall.arguments),
      };
    }
    yield request.identity && request.cache
      ? {
          type: "completed",
          response: responseMetadata({
            request: effectiveRequest,
            connection,
            modelId,
            protocol,
            responseId,
            responseModel,
            usage,
            stopReason: toolBuffers.size > 0 ? "tool_use" : stopReason,
            started,
            firstDeltaMs,
            attempts: 1,
          }),
        }
      : { type: "completed" };
  }

  async *#streamAnthropic(
    connection: OpenAiCompatibleConnection,
    modelId: string,
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const started = Date.now();
    let firstDeltaMs: number | undefined;
    let responseId: string | undefined;
    let usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let stopReason: "stop" | "length" | "tool_use" = "stop";
    const replayItems: NonNullable<ProviderReplayState["items"]> = [];
    const toolInputs = new Map<number, { id: string; name: string; json: string }>();
    const response = await (this.#options.fetchImpl ?? fetch)(
      `${connection.baseUrl.replace(/\/+$/, "")}/messages`,
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(connection.apiKey ? { "x-api-key": connection.apiKey } : {}),
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 16_384,
          stream: true,
          system:
            request.cache?.mode === "session"
              ? [
                  {
                    type: "text",
                    text: request.systemPrompt,
                    cache_control: {
                      type: "ephemeral",
                      ...(request.cache.retention === "long" ? { ttl: "1h" } : {}),
                    },
                  },
                ]
              : request.systemPrompt,
          messages: anthropicMessagesWithCache(request),
          tools: toolsForRequest(request).map((tool, index, tools) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
            ...(request.cache?.mode === "session" && index === tools.length - 1
              ? {
                  cache_control: {
                    type: "ephemeral",
                    ...(request.cache.retention === "long" ? { ttl: "1h" } : {}),
                  },
                }
              : {}),
          })),
        }),
      },
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      if (
        isPossibleImageInputRejection(response.status) &&
        modelContextHasImages(request.context)
      ) {
        this.#imageUnsupportedModels.add(`${connection.id}/${modelId}`);
        yield* this.stream(request, signal);
        return;
      }
      const error = new Error(safeProviderError(text, response.status, connection.apiKey));
      Object.assign(error, { status: response.status });
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      if (done) buffer = "";
      else buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const raw = frame
          .split(/\r?\n/)
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim();
        if (!raw) continue;
        const event = JSON.parse(raw) as Record<string, any>;
        if (event.type === "message_start") {
          responseId = event.message?.id;
          usage = anthropicUsage(event.message?.usage);
        }
        if (event.type === "message_delta") {
          usage = anthropicUsage(event.usage, usage);
          stopReason =
            event.delta?.stop_reason === "max_tokens"
              ? "length"
              : event.delta?.stop_reason === "tool_use"
                ? "tool_use"
                : "stop";
        }
        if (event.type === "message_stop") completed = true;
        const index = typeof event.index === "number" ? event.index : 0;
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolInputs.set(index, {
            id: event.content_block.id,
            name: event.content_block.name,
            json: "",
          });
        } else if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text) {
            firstDeltaMs ??= Date.now() - started;
            yield { type: "text_delta", delta: event.delta.text };
          }
          if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
            firstDeltaMs ??= Date.now() - started;
            yield { type: "reasoning_delta", delta: event.delta.thinking };
          }
          if (event.delta?.type === "signature_delta" && event.delta.signature) {
            const current = replayItems.at(-1);
            if (current?.type === "thinking")
              current.signature = `${current.signature ?? ""}${event.delta.signature}`;
          }
          const tool = toolInputs.get(index);
          if (tool && event.delta?.type === "input_json_delta")
            tool.json += event.delta.partial_json ?? "";
        } else if (event.type === "content_block_stop") {
          const tool = toolInputs.get(index);
          if (tool) {
            yield {
              type: "tool_call",
              id: tool.id,
              name: tool.name,
              input: parseArguments(tool.json),
            };
            toolInputs.delete(index);
          }
        }
        if (
          event.type === "content_block_start" &&
          (event.content_block?.type === "thinking" ||
            event.content_block?.type === "redacted_thinking")
        ) {
          replayItems.push({
            type: "thinking",
            ...(event.content_block.data ? { encryptedContent: event.content_block.data } : {}),
          });
        }
      }
      if (done) break;
    }
    if (!completed) throw new Error("Model stream ended before completion");
    yield request.identity && request.cache
      ? {
          type: "completed",
          response: responseMetadata({
            request,
            connection,
            modelId,
            protocol: "anthropic-messages",
            responseId,
            usage,
            stopReason,
            replay: replayItems.length ? { items: replayItems } : undefined,
            started,
            firstDeltaMs,
            attempts: 1,
          }),
        }
      : { type: "completed" };
  }
}

function chatUsage(raw: Record<string, any>): ModelUsage {
  const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
  const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, (raw.prompt_tokens ?? 0) - cacheRead - cacheWrite);
  const output = raw.completion_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: raw.completion_tokens_details?.reasoning_tokens,
    total: raw.total_tokens ?? input + output + cacheRead + cacheWrite,
  };
}

function anthropicUsage(raw: Record<string, any> | undefined, previous?: ModelUsage): ModelUsage {
  const input = raw?.input_tokens ?? previous?.input ?? 0;
  const output = raw?.output_tokens ?? previous?.output ?? 0;
  const cacheRead = raw?.cache_read_input_tokens ?? previous?.cacheRead ?? 0;
  const cacheWrite = raw?.cache_creation_input_tokens ?? previous?.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: raw?.output_tokens_details?.thinking_tokens ?? previous?.reasoning,
    total: input + output + cacheRead + cacheWrite,
  };
}

function responseMetadata(input: {
  request: ModelRequest;
  connection: OpenAiCompatibleConnection;
  modelId: string;
  protocol: ModelProtocol;
  responseId?: string;
  responseModel?: string;
  usage: ModelUsage;
  stopReason: "stop" | "length" | "tool_use";
  replay?: ProviderReplayState;
  started: number;
  firstDeltaMs?: number;
  attempts: number;
}): import("./transport.ts").ProviderResponseMetadata {
  return {
    responseId: input.responseId,
    provider: input.connection.id,
    api: input.protocol === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
    model: input.modelId,
    responseModel: input.responseModel,
    protocol: input.protocol,
    usage: input.usage,
    stopReason: input.stopReason,
    replay: input.replay,
    cache: {
      key: input.request.cache?.key,
      generation: input.request.cache?.generation ?? "legacy",
      readTokens: input.usage.cacheRead,
      writeTokens: input.usage.cacheWrite,
    },
    timing: {
      startedAt: new Date(input.started).toISOString(),
      firstDeltaMs: input.firstDeltaMs,
      completedMs: Date.now() - input.started,
      attempts: input.attempts,
    },
  };
}

export function toAnthropicMessages(context: ModelContextItem[]) {
  return context.flatMap((item): Array<Record<string, unknown>> => {
    if (item.type === "user_message") return [{ role: "user", content: item.text }];
    if (item.type === "assistant_message") {
      const replay = (item.replay?.items ?? []).flatMap<Record<string, unknown>>((state) => {
        if (state.type !== "thinking") return [];
        if (state.encryptedContent)
          return [{ type: "redacted_thinking", data: state.encryptedContent }];
        if (state.signature)
          return [{ type: "thinking", thinking: "", signature: state.signature }];
        return [];
      });
      return [
        {
          role: "assistant",
          content: replay.length > 0 ? [...replay, { type: "text", text: item.text }] : item.text,
        },
      ];
    }
    if (item.type === "tool_call")
      return [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: item.toolCallId, name: item.name, input: item.input ?? {} },
          ],
        },
      ];
    const result = modelToolResultContent(item.output);
    return [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: item.toolCallId,
            content: [
              ...(result.text ? [{ type: "text", text: result.text }] : []),
              ...result.images.map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mimeType, data: image.data },
              })),
            ],
          },
        ],
      },
    ];
  });
}

function anthropicMessagesWithCache(request: ModelRequest) {
  const messages = toAnthropicMessages(request.context);
  if (request.cache?.mode !== "session" || messages.length === 0) return messages;
  const cacheControl = {
    type: "ephemeral",
    ...(request.cache.retention === "long" ? { ttl: "1h" } : {}),
  };
  const message = messages.at(-1)!;
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
  } else if (Array.isArray(message.content)) {
    const last = message.content.at(-1) as Record<string, unknown> | undefined;
    if (last) last.cache_control = cacheControl;
  }
  return messages;
}
