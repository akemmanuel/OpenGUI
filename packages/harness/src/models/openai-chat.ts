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
}

function toChatMessages(context: ModelContextItem[]) {
  const messages: Array<Record<string, unknown>> = [];
  for (const item of context) {
    if (item.type === "user_message") {
      messages.push({ role: "user", content: item.text });
      continue;
    }
    if (item.type === "assistant_message") {
      messages.push({ role: "assistant", content: item.text });
      continue;
    }
    if (item.type === "tool_call") {
      const last = messages.at(-1);
      const toolCall = {
        id: item.toolCallId,
        type: "function",
        function: {
          name: item.name,
          arguments: JSON.stringify(item.input ?? {}),
        },
      };
      if (last && last.role === "assistant") {
        const existing = Array.isArray(last.tool_calls) ? last.tool_calls : [];
        last.tool_calls = [...existing, toolCall];
        if (typeof last.content !== "string") last.content = null;
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }
    if (item.type === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: item.toolCallId,
        content:
          typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
      });
    }
  }
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
      description: "Run one non-interactive shell command in the Project directory.",
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
  readonly #connections = new Map<string, OpenAiCompatibleConnection>();
  #defaultConnectionId: string | null = null;

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
    const modelId = selected?.model.modelId ?? connection.modelIds[0];
    if (!modelId) throw new Error(`No model configured for connection ${connectionId}`);

    const baseUrl = connection.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        stream: true,
        ...(selected?.reasoning && selected.reasoning !== "none"
          ? { reasoning_effort: selected.reasoning }
          : {}),
        messages: [
          {
            role: "system",
            content:
              "You are OpenGUI's local general-purpose agent. Use read, write, edit, and shell when needed. Prefer concise answers.",
          },
          ...toChatMessages(request.context),
        ],
        tools: TOOLS,
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `Model request failed (${response.status})`);
    }

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
}
