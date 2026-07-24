export type ModelContextItem =
  | {
      type: "user_message";
      text: string;
      model: { connectionId: string; modelId: string };
      reasoning: string;
    }
  | { type: "assistant_message"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; output: unknown };

export type ModelToolName = "read" | "write" | "edit" | "shell";

export interface ModelRequest {
  projectDirectory: string;
  context: ModelContextItem[];
  /** Full system prompt for this turn (skills catalog, env, tool summary). */
  systemPrompt: string;
  /** Tools available for this turn. Omitted by legacy callers to mean all tools. */
  tools?: readonly ModelToolName[];
}

export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "completed" };

export interface ModelTransport {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
