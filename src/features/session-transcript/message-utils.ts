import type { Part } from "@/protocol/harness-types";
import type { MessageEntry } from "@/hooks/agent-state-types";

export const MESSAGE_PAGE_SIZE = 30;

/**
 * Keep a generous active-session window so long local transcripts do not appear truncated.
 * Rendering is virtualized, so the DOM cost stays bounded while we avoid discarding history early.
 */
const MAX_MESSAGE_WINDOW = 1000;

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

export function limitMessageWindow(messages: MessageEntry[]): MessageEntry[] {
  if (messages.length <= MAX_MESSAGE_WINDOW) return messages;
  return messages.slice(messages.length - MAX_MESSAGE_WINDOW);
}
