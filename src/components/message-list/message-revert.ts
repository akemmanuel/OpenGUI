import type { MessageEntry } from "@/hooks/use-agent-state";

/** Index of the revert cut in the session's ordered transcript, or null if not reverting / unknown id. */
export function getRevertCutIndex(
  messages: MessageEntry[],
  revertMessageID: string | undefined,
): number | null {
  if (!revertMessageID) return null;
  const idx = messages.findIndex((m) => m.info.id === revertMessageID);
  return idx >= 0 ? idx : null;
}

export function isBeforeRevertPoint(
  messages: MessageEntry[],
  messageId: string,
  revertMessageID: string,
  messageIndexById?: ReadonlyMap<string, number>,
): boolean {
  const cut = getRevertCutIndex(messages, revertMessageID);
  if (cut === null) return true;
  const idx =
    messageIndexById?.get(messageId) ?? messages.findIndex((m) => m.info.id === messageId);
  if (idx < 0) return true;
  return idx < cut;
}

export function buildMessageIndexById(messages: MessageEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  messages.forEach((m, index) => map.set(m.info.id, index));
  return map;
}

/** Last user message strictly before the revert cut (for undo keybind). */
export function findLastUserMessageBeforeRevert(
  messages: MessageEntry[],
  revertMessageID: string | undefined,
): MessageEntry | undefined {
  const userMessages = messages.filter((m) => m.info.role === "user");
  if (!revertMessageID) return userMessages.at(-1);
  return [...userMessages]
    .reverse()
    .find((m) => isBeforeRevertPoint(messages, m.info.id, revertMessageID));
}
