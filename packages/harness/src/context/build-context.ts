import type { SessionEntry } from "../harness.ts";
import type { ModelContextItem } from "../models/transport.ts";

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function buildModelContext(entries: SessionEntry[]): ModelContextItem[] {
  const context: ModelContextItem[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "user_message":
        context.push({
          type: "user_message",
          text: text(entry.payload.text),
          model: entry.payload.model as { connectionId: string; modelId: string },
          reasoning: text(entry.payload.reasoning, "none"),
        });
        break;
      case "assistant_message":
        context.push({
          type: "assistant_message",
          text: text(entry.payload.text),
        });
        break;
      case "tool_call":
        context.push({
          type: "tool_call",
          toolCallId: text(entry.payload.toolCallId),
          name: text(entry.payload.name),
          input: entry.payload.input,
        });
        break;
      case "tool_result":
        context.push({
          type: "tool_result",
          toolCallId: text(entry.payload.toolCallId),
          name: text(entry.payload.name),
          output: entry.payload.output,
        });
        break;
      default:
        break;
    }
  }
  return context;
}
