import type { Part } from "@/protocol/harness-types";
import type { MessageEntry } from "@/hooks/agent-state-types";

export const MESSAGE_PAGE_SIZE = 30;

export function getMessageText(entry: MessageEntry): string {
  return entry.parts
    .flatMap((part) => {
      const record = part as Record<string, unknown>;
      return part.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
}

export function getChildSessionId(part: Part): string | undefined {
  if (
    part.type === "tool" &&
    part.tool.toLowerCase() === "task" &&
    "metadata" in part.state &&
    part.state.metadata
  ) {
    const meta = part.state.metadata as Record<string, unknown>;
    if (typeof meta.sessionId === "string") return meta.sessionId;
  }
  return undefined;
}
