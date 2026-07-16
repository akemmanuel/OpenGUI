import type {
  ModelContextItem,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from "./transport.ts";

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
    pendingToolCalls = [];
    pendingToolResults = [];
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
      pendingToolResults.push({
        role: "tool",
        tool_call_id: item.toolCallId,
        content:
          typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
      });
    }
  }
  flushToolExchange();
  return messages;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file. Absolute or Project-relative paths are allowed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create or replace a text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          createParents: { type: "boolean" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Apply an exact text replacement in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run one non-interactive shell command in the Project directory. Output is limited to 5 KiB; when truncated, the result identifies the file containing the full output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["command"],
      },
    },
  },
] as const;

function parseArguments(raw: string) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
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
  #defaultConnectionId: string | null = null;

  constructor(options: OpenAiChatTransportOptions = {}) {
    this.#options = options;
  }

  setConnections(connections: OpenAiCompatibleConnection[], defaultConnectionId?: string | null) {
    this.#connections.clear();
    for (const connection of connections) this.#connections.set(connection.id, connection);
    this.#defaultConnectionId = defaultConnectionId ?? connections[0]?.id ?? null;
  }

  listConnections() {
    return [...this.#connections.values()];
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const selected = [...request.context].reverse().find((item) => item.type === "user_message");
    const connectionId = selected?.model.connectionId ?? this.#defaultConnectionId;
    if (!connectionId) throw new Error("No model connection is configured");
    const connection = this.#connections.get(connectionId);
    if (!connection) throw new Error(`Unknown model connection: ${connectionId}`);
    const modelId = selected?.model.modelId ?? connection.defaultModelId ?? connection.modelIds[0];
    if (!modelId) throw new Error(`No model configured for connection ${connectionId}`);

    if (connection.modelRoutes?.[modelId] === "anthropic-messages") {
      yield* this.#streamAnthropic(connection, modelId, request, signal);
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
        ...toChatMessages(request.context),
      ],
      tools: TOOLS,
    });

    let response: Response | undefined;
    const maxAttempts = 5;
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
      if (attempt === maxAttempts - 1 || !shouldRetryChatCompletion(response.status, text)) {
        throw new Error(text || `Model request failed (${response.status})`);
      }
      await waitForRetry(500 * 2 ** attempt, signal);
    }
    if (!response?.body) throw new Error("Model response did not include a body");

    const decoder = new TextDecoder();
    let buffer = "";
    const toolBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data) as {
          choices?: Array<{
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
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        for (const event of chatDeltaEvents(delta)) yield event;
        for (const toolCall of delta.tool_calls ?? []) {
          const index = toolCall.index ?? 0;
          const existing = toolBuffers.get(index) ?? { id: "", name: "", arguments: "" };
          if (toolCall.id) existing.id = toolCall.id;
          if (toolCall.function?.name) existing.name = toolCall.function.name;
          if (toolCall.function?.arguments) existing.arguments += toolCall.function.arguments;
          toolBuffers.set(index, existing);
        }
      }
    }

    for (const toolCall of toolBuffers.values()) {
      yield {
        type: "tool_call",
        id: toolCall.id || `tool_${toolCall.name}`,
        name: toolCall.name,
        input: parseArguments(toolCall.arguments),
      };
    }
    yield { type: "completed" };
  }

  async *#streamAnthropic(
    connection: OpenAiCompatibleConnection,
    modelId: string,
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
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
          system: request.systemPrompt,
          messages: toAnthropicMessages(request.context),
          tools: TOOLS.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          })),
        }),
      },
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `Model request failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const raw = frame
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim();
        if (!raw) continue;
        const event = JSON.parse(raw) as Record<string, any>;
        const index = typeof event.index === "number" ? event.index : 0;
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolInputs.set(index, {
            id: event.content_block.id,
            name: event.content_block.name,
            json: "",
          });
        } else if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text)
            yield { type: "text_delta", delta: event.delta.text };
          if (event.delta?.type === "thinking_delta" && event.delta.thinking)
            yield { type: "reasoning_delta", delta: event.delta.thinking };
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
      }
    }
    yield { type: "completed" };
  }
}

function toAnthropicMessages(context: ModelContextItem[]) {
  return context.flatMap((item): Array<Record<string, unknown>> => {
    if (item.type === "user_message") return [{ role: "user", content: item.text }];
    if (item.type === "assistant_message") return [{ role: "assistant", content: item.text }];
    if (item.type === "tool_call")
      return [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: item.toolCallId, name: item.name, input: item.input ?? {} },
          ],
        },
      ];
    return [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: item.toolCallId,
            content:
              typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
          },
        ],
      },
    ];
  });
}
