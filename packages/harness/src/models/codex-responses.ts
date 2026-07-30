import { modelToolDefinitionsFor } from "../tools/tool-definitions.ts";
import type {
  ModelContextItem,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from "./transport.ts";
import {
  deriveModelCacheKey,
  isPossibleImageInputRejection,
  modelContextHasImages,
  modelImageData,
  modelToolResultContent,
  withoutModelContextImages,
} from "./transport.ts";
import type { ModelUsage, ProviderReplayState } from "./transport.ts";

export interface CodexCredential {
  accessToken: string;
  accountId: string;
}
export interface CodexResponsesOptions {
  /** `forceRefresh` is requested once after an otherwise unexpected inference 401. */
  getCredential: (forceRefresh?: boolean) => Promise<CodexCredential>;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  headers?: Record<string, string>;
  requestLabel?: string;
  unauthorizedMessage?: string;
  protocol?: "codex-responses" | "openai-responses";
  providerId?: string;
  apiId?: string;
}

function responseError(label: string, status: number, unauthorized?: string) {
  if (status === 401)
    return unauthorized ?? "Provider authorization expired. Reconnect it in Providers.";
  if (status === 403)
    return `${label} denied this request. Check account entitlement and organization policy.`;
  if (status === 400)
    return `${label} rejected the request. Check the selected model and request compatibility.`;
  if (status === 404)
    return `${label} could not find this endpoint or model. Check the configured model.`;
  if (status === 429) return `${label} rate limit reached. Wait and try again.`;
  if (status >= 500) return `${label} is temporarily unavailable (${status}). Try again later.`;
  return `${label} request failed (${status}).`;
}

function toolsForRequest(request: ModelRequest) {
  return modelToolDefinitionsFor(request).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

export function codexInput(context: ModelContextItem[]) {
  return context.flatMap<Record<string, unknown>>((item) => {
    if (item.type === "user_message")
      return [
        { type: "message", role: "user", content: [{ type: "input_text", text: item.text }] },
      ];
    if (item.type === "assistant_message")
      return [
        ...(item.replay?.items ?? []).flatMap<Record<string, unknown>>((replay) =>
          replay.type === "reasoning" && replay.encryptedContent
            ? [{ type: "reasoning", id: replay.id, encrypted_content: replay.encryptedContent }]
            : [],
        ),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: item.text }],
        },
      ];
    if (item.type === "tool_call")
      return [
        {
          type: "function_call",
          call_id: item.toolCallId,
          name: item.name,
          arguments: JSON.stringify(item.input ?? {}),
        },
      ];
    const result = modelToolResultContent(item.output);
    return [
      {
        type: "function_call_output",
        call_id: item.toolCallId,
        output:
          result.images.length === 0
            ? result.text
            : [
                ...(result.text ? [{ type: "input_text", text: result.text }] : []),
                ...result.images.map((image) => ({
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${image.mimeType};base64,${modelImageData(image)}`,
                })),
              ],
      },
    ];
  });
}

function parseArguments(raw: string) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

export function codexResponseEvents(event: Record<string, any>): ModelStreamEvent[] {
  if (event.type === "response.output_text.delta" && typeof event.delta === "string")
    return [{ type: "text_delta", delta: event.delta }];
  if (
    (event.type === "response.reasoning_text.delta" ||
      event.type === "response.reasoning_summary.delta" ||
      event.type === "response.reasoning_summary_text.delta") &&
    typeof event.delta === "string"
  )
    return [{ type: "reasoning_delta", delta: event.delta }];
  if (event.type === "response.output_item.done" && event.item?.type === "reasoning") {
    const text = reasoningItemText(event.item);
    return text ? [{ type: "reasoning_delta", delta: text }] : [];
  }
  if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
    const text = event.response.output
      .filter((item: Record<string, any>) => item?.type === "reasoning")
      .map(reasoningItemText)
      .filter(Boolean)
      .join("\n\n");
    return text ? [{ type: "reasoning_delta", delta: text }] : [];
  }
  if (event.type === "response.output_item.done" && event.item?.type === "function_call")
    return [
      {
        type: "tool_call",
        id: event.item.call_id ?? event.item.id,
        name: event.item.name,
        input: parseArguments(event.item.arguments || "{}"),
      },
    ];
  return [];
}

function reasoningItemText(item: Record<string, any>): string {
  const parts = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

export class CodexResponsesTransport implements ModelTransport {
  readonly #options: CodexResponsesOptions;
  readonly #imageUnsupportedModels = new Set<string>();
  constructor(options: CodexResponsesOptions) {
    this.#options = options;
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const started = Date.now();
    let firstDeltaMs: number | undefined;
    let attempts = 1;
    const selected = [...request.context].reverse().find((x) => x.type === "user_message");
    if (!selected || selected.type !== "user_message")
      throw new Error("Codex request has no user message");
    const modelKey = selected.model.modelId;
    const effectiveRequest = this.#imageUnsupportedModels.has(modelKey)
      ? { ...request, context: withoutModelContextImages(request.context) }
      : request;
    const cacheKey = deriveModelCacheKey(request, {
      backendId: selected.model.connectionId,
      upstreamModelId: selected.model.modelId,
      protocol: this.#options.protocol ?? "codex-responses",
    });
    effectiveRequest.cache = request.cache ? { ...request.cache, key: cacheKey } : undefined;
    const requestWithCredential = async (forceRefresh = false) => {
      const credential = await this.#options.getCredential(forceRefresh);
      return await (this.#options.fetchImpl ?? fetch)(
        this.#options.endpoint ?? "https://chatgpt.com/backend-api/codex/responses",
        {
          method: "POST",
          signal,
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            ...(credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}),
            originator: "opengui",
            "user-agent": "OpenGUI/1.0",
            ...this.#options.headers,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: selected.model.modelId,
            stream: true,
            store: false,
            instructions: request.systemPrompt,
            input: codexInput(effectiveRequest.context),
            tools: toolsForRequest(request),
            ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
            reasoning:
              selected.reasoning === "none"
                ? undefined
                : { effort: selected.reasoning, summary: "auto" },
          }),
        },
      );
    };
    let response = await requestWithCredential();
    // One forced refresh-and-retry is safe for this POST: a 401 cannot have
    // started a successful response stream, and the retry count is bounded.
    if (response.status === 401) {
      attempts += 1;
      response = await requestWithCredential(true);
    }
    for (
      let retry = 0;
      !response.ok &&
      response.status !== 401 &&
      (response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500) &&
      retry < (request.delivery?.maxRetries ?? 2);
      retry += 1
    ) {
      const delay = Math.min(500 * 2 ** retry, request.delivery?.maxRetryDelayMs ?? 60_000);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
      attempts += 1;
      response = await requestWithCredential();
    }
    if (
      isPossibleImageInputRejection(response.status) &&
      !response.ok &&
      modelContextHasImages(effectiveRequest.context)
    ) {
      this.#imageUnsupportedModels.add(modelKey);
      yield* this.stream(request, signal);
      return;
    }
    if (!response.ok || !response.body) {
      const error = new Error(
        responseError(
          this.#options.requestLabel ?? "Codex",
          response.status,
          this.#options.unauthorizedMessage,
        ),
      );
      Object.assign(error, { status: response.status });
      throw error;
    }
    const reader = response.body.getReader();
    const abortReader = () => void reader.cancel(signal.reason).catch(() => undefined);
    signal.addEventListener("abort", abortReader, { once: true });
    const decoder = new TextDecoder();
    let buffer = "";
    let textEmitted = false;
    let reasoningEmitted = false;
    let completed = false;
    let responseId: string | undefined;
    let responseModel: string | undefined;
    let usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let stopReason: "stop" | "length" | "tool_use" = "stop";
    const replayItems: NonNullable<ProviderReplayState["items"]> = [];
    const toolCalls = new Map<
      string,
      { id: string; name: string; arguments: string; emitted: boolean }
    >();
    const toolKey = (event: Record<string, any>) =>
      String(event.item_id ?? event.item?.id ?? event.output_index ?? "0");
    const eventsFor = (event: Record<string, any>): ModelStreamEvent[] => {
      if (event.type === "response.incomplete")
        throw new Error("Model response was incomplete. Retry the request.");
      if (event.type === "error") throw new Error("Model provider reported a streaming error.");
      if (event.type === "response.completed") {
        completed = true;
        responseId = event.response?.id;
        responseModel = event.response?.model;
        usage = responsesUsage(event.response?.usage);
        stopReason = event.response?.status === "incomplete" ? "length" : "stop";
        const output = Array.isArray(event.response?.output) ? event.response.output : [];
        const fallback: ModelStreamEvent[] = [];
        for (const item of output) {
          if (item?.type === "message" && !textEmitted && Array.isArray(item.content)) {
            const text = item.content
              .map((part: Record<string, any>) =>
                part?.type === "output_text" && typeof part.text === "string" ? part.text : "",
              )
              .filter(Boolean)
              .join("");
            if (text) {
              textEmitted = true;
              fallback.push({ type: "text_delta", delta: text });
            }
          }
          if (item?.type === "function_call") {
            stopReason = "tool_use";
            const key = String(item.id ?? item.call_id ?? fallback.length);
            const existing = toolCalls.get(key);
            if (!existing?.emitted) {
              if (existing) existing.emitted = true;
              fallback.push({
                type: "tool_call",
                id: item.call_id ?? item.id ?? key,
                name: item.name ?? existing?.name ?? "",
                input: parseArguments(item.arguments ?? existing?.arguments ?? ""),
              });
            }
          }
          if (item?.type === "reasoning" && item.encrypted_content) {
            replayItems.push({
              type: "reasoning",
              id: item.id,
              encryptedContent: item.encrypted_content,
            });
          }
        }
        const reasoning = codexResponseEvents(event).filter(
          (parsed) => parsed.type === "reasoning_delta" && !reasoningEmitted,
        );
        if (reasoning.length > 0) reasoningEmitted = true;
        return [...reasoning, ...fallback];
      }

      const key = toolKey(event);
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        toolCalls.set(key, {
          id: event.item.call_id ?? event.item.id ?? key,
          name: event.item.name ?? "",
          arguments: event.item.arguments ?? "",
          emitted: false,
        });
        return [];
      }
      if (event.type === "response.function_call_arguments.delta") {
        const tool = toolCalls.get(key) ?? { id: key, name: "", arguments: "", emitted: false };
        if (typeof event.delta === "string") tool.arguments += event.delta;
        toolCalls.set(key, tool);
        return [];
      }
      if (event.type === "response.function_call_arguments.done") {
        const tool = toolCalls.get(key) ?? { id: key, name: "", arguments: "", emitted: false };
        if (typeof event.name === "string") tool.name = event.name;
        if (typeof event.arguments === "string") tool.arguments = event.arguments;
        toolCalls.set(key, tool);
        if (tool.emitted || !tool.name) return [];
        tool.emitted = true;
        return [
          {
            type: "tool_call",
            id: tool.id,
            name: tool.name,
            input: parseArguments(tool.arguments),
          },
        ];
      }

      const item = event.item;
      if (event.type === "response.output_item.done" && item?.type === "function_call") {
        const tool = toolCalls.get(key) ?? {
          id: item.call_id ?? item.id ?? key,
          name: "",
          arguments: "",
          emitted: false,
        };
        tool.id = item.call_id ?? item.id ?? tool.id;
        tool.name = item.name ?? tool.name;
        if (typeof item.arguments === "string") tool.arguments = item.arguments;
        toolCalls.set(key, tool);
        if (tool.emitted) return [];
        tool.emitted = true;
        return [
          {
            type: "tool_call",
            id: tool.id,
            name: tool.name,
            input: parseArguments(tool.arguments),
          },
        ];
      }

      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        firstDeltaMs ??= Date.now() - started;
        textEmitted = true;
        return [{ type: "text_delta", delta: event.delta }];
      }
      if (event.type === "response.output_text.done" && typeof event.text === "string") {
        if (textEmitted) return [];
        textEmitted = true;
        return [{ type: "text_delta", delta: event.text }];
      }
      if (
        (event.type === "response.reasoning_text.delta" ||
          event.type === "response.reasoning_summary.delta" ||
          event.type === "response.reasoning_summary_text.delta") &&
        typeof event.delta === "string"
      ) {
        firstDeltaMs ??= Date.now() - started;
        reasoningEmitted = true;
        return [{ type: "reasoning_delta", delta: event.delta }];
      }
      if (
        (event.type === "response.reasoning_text.done" ||
          event.type === "response.reasoning_summary_text.done") &&
        typeof (event.text ?? event.summary_text) === "string"
      ) {
        if (reasoningEmitted) return [];
        reasoningEmitted = true;
        return [{ type: "reasoning_delta", delta: event.text ?? event.summary_text }];
      }

      const projected = codexResponseEvents(event);
      return projected.filter((parsed) => {
        if (parsed.type !== "reasoning_delta") return parsed.type !== "tool_call";
        if (reasoningEmitted) return false;
        reasoningEmitted = true;
        return true;
      });
    };
    const parseFrame = (frame: string) => {
      const raw = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!raw) return [];
      if (raw === "[DONE]") {
        completed = true;
        return [];
      }
      try {
        const event = JSON.parse(raw) as Record<string, any>;
        return eventsFor(event);
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new Error("Model returned a malformed event stream.");
        throw error;
      }
    };
    try {
      while (true) {
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        const chunk = await reader.read();
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        if (chunk.done) buffer = "";
        else buffer = frames.pop() ?? "";
        for (const frame of frames) for (const event of parseFrame(frame)) yield event;
        if (chunk.done) break;
      }
    } finally {
      signal.removeEventListener("abort", abortReader);
      reader.releaseLock();
    }
    if (!completed) throw new Error("Model stream ended before completion");
    yield request.identity && request.cache
      ? {
          type: "completed",
          response: {
            responseId,
            provider: this.#options.providerId ?? selected.model.connectionId,
            api: this.#options.apiId ?? "openai-codex-responses",
            model: selected.model.modelId,
            responseModel,
            protocol: this.#options.protocol ?? "codex-responses",
            usage,
            stopReason: toolCalls.size > 0 ? "tool_use" : stopReason,
            replay: replayItems.length ? { items: replayItems } : undefined,
            cache: {
              key: cacheKey,
              generation: request.cache?.generation ?? "legacy",
              readTokens: usage.cacheRead,
              writeTokens: usage.cacheWrite,
            },
            timing: {
              startedAt: new Date(started).toISOString(),
              firstDeltaMs,
              completedMs: Date.now() - started,
              attempts,
            },
          },
        }
      : { type: "completed" };
  }
}

function responsesUsage(raw: Record<string, any> | undefined): ModelUsage {
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
