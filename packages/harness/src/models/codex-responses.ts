import type {
  ModelContextItem,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from "./transport.ts";

export interface CodexCredential {
  accessToken: string;
  accountId: string;
}
export interface CodexResponsesOptions {
  getCredential: () => Promise<CodexCredential>;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  headers?: Record<string, string>;
}

const tools = ["read", "write", "edit", "shell"].map((name) => ({
  type: "function",
  name,
  description: `${name} using OpenGUI's Project tools`,
  parameters: { type: "object", additionalProperties: true },
  strict: false,
}));

export function codexInput(context: ModelContextItem[]) {
  return context.map((item) => {
    if (item.type === "user_message")
      return { type: "message", role: "user", content: [{ type: "input_text", text: item.text }] };
    if (item.type === "assistant_message")
      return {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: item.text }],
      };
    if (item.type === "tool_call")
      return {
        type: "function_call",
        call_id: item.toolCallId,
        name: item.name,
        arguments: JSON.stringify(item.input ?? {}),
      };
    return {
      type: "function_call_output",
      call_id: item.toolCallId,
      output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
    };
  });
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
        input: JSON.parse(event.item.arguments || "{}"),
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
  constructor(options: CodexResponsesOptions) {
    this.#options = options;
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const selected = [...request.context].reverse().find((x) => x.type === "user_message");
    if (!selected || selected.type !== "user_message")
      throw new Error("Codex request has no user message");
    const credential = await this.#options.getCredential();
    const response = await (this.#options.fetchImpl ?? fetch)(
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
          instructions:
            "You are OpenGUI's general-purpose agent. Use the available Project tools when needed.",
          input: codexInput(request.context),
          tools,
          reasoning:
            selected.reasoning === "none"
              ? undefined
              : { effort: selected.reasoning, summary: "auto" },
        }),
      },
    );
    if (!response.ok || !response.body)
      throw new Error(
        response.status === 401
          ? "ChatGPT sign-in expired or was revoked. Sign in again in Providers."
          : `Codex request failed (${response.status})`,
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reasoningEmitted = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((x) => x.startsWith("data:"));
        if (!line) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        const event = JSON.parse(raw) as Record<string, any>;
        for (const parsed of codexResponseEvents(event)) {
          if (parsed.type === "reasoning_delta") {
            const isCompletedFallback =
              event.type === "response.output_item.done" || event.type === "response.completed";
            if (isCompletedFallback && reasoningEmitted) continue;
            reasoningEmitted = true;
          }
          yield parsed;
        }
      }
    }
    yield { type: "completed" };
  }
}
