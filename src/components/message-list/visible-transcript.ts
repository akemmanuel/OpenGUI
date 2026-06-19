import type { MessageEntry } from "@/hooks/use-agent-state";
import type { SessionMeta } from "@/hooks/agent-state-persistence";
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

const SYSTEM_APPEND_RE = /^\s*<SYSTEM-APPEND>[\s\S]*?<\/SYSTEM-APPEND>\s*/;

function stripLeadingSystemAppend(entry: MessageEntry): MessageEntry {
  if (entry.info.role !== "user") return entry;
  let stripped = false;
  const parts = entry.parts.map((part) => {
    if (stripped || part.type !== "text" || typeof part.text !== "string") {
      return part;
    }
    const nextText = part.text.replace(SYSTEM_APPEND_RE, "");
    if (nextText === part.text) return part;
    stripped = true;
    return { ...part, text: nextText };
  });
  return stripped ? { ...entry, parts } : entry;
}

export function buildVisibleMessages(
  messages: MessageEntry[],
  options: {
    sessionMeta?: SessionMeta;
    revertMessageID?: string;
  },
): MessageEntry[] {
  let rendered = messages.filter(hasVisibleContent);

  if (options.sessionMeta?.hideSystemAppendBlocks) {
    rendered = rendered.map(stripLeadingSystemAppend);
  }

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

export function messageBubbleSpacingClass(
  index: number,
  entry: MessageEntry,
  prevRole: string | null,
): string {
  if (index === 0) return "";
  const isConsecutive = prevRole !== null && prevRole === entry.info.role;
  return isConsecutive ? "mt-1" : "mt-4";
}
