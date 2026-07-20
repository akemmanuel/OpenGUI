import type { MessageEntry } from "@/hooks/use-agent-state";
import type { SessionMeta } from "@/lib/persistence/session";
import type { TranscriptPart } from "@/protocol/session-transcript";
import {
  buildMessageIndexById,
  getRevertCutIndex,
  isBeforeRevertPoint,
} from "@/components/message-list/message-revert";

const RENDERABLE_TYPES = new Set(["text", "reasoning", "tool", "file"]);

function isRenderablePart(part: TranscriptPart): boolean {
  if (!RENDERABLE_TYPES.has(part.type)) return false;
  if (part.type === "text" && !part.text?.trim()) return false;
  return true;
}

/** Message has renderable parts, an assistant error, or is still loading (no parts yet). */
export function hasVisibleContent(entry: MessageEntry): boolean {
  if (entry.parts.some(isRenderablePart)) return true;
  if (entry.info.role === "assistant" && entry.info.error) return true;
  if (entry.parts.length === 0) return true;
  return false;
}

export function buildVisibleMessages(
  messages: MessageEntry[],
  options: {
    sessionMeta?: SessionMeta;
    revertMessageID?: string;
  },
): MessageEntry[] {
  let rendered = messages.filter(hasVisibleContent);

  const revertMessageID = options.revertMessageID;
  if (!revertMessageID) return rendered;

  const cut = getRevertCutIndex(messages, revertMessageID);
  if (cut === null) return rendered;

  const indexById = buildMessageIndexById(messages);
  return rendered.filter((entry) =>
    isBeforeRevertPoint(messages, entry.info.id, revertMessageID, indexById),
  );
}

export function countRevertedVisibleMessages(
  messages: MessageEntry[],
  revertMessageID: string,
): number {
  const cut = getRevertCutIndex(messages, revertMessageID);
  if (cut === null) return 0;
  const indexById = buildMessageIndexById(messages);
  return messages.filter((m) => {
    if (!hasVisibleContent(m)) return false;
    return !isBeforeRevertPoint(messages, m.info.id, revertMessageID, indexById);
  }).length;
}
