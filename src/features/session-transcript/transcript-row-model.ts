import type { TurnFooter } from "@/components/message-list/types";
import type { MessageEntry } from "@/hooks/agent-state-types";
import type { TranscriptMessageEntry } from "@/protocol/session-transcript";

export type TranscriptMessageRowActions = {
  onFork?: () => void;
  onRevert?: () => void;
};

export function messageBubbleSpacingClass(
  index: number,
  entry: MessageEntry,
  prevRole: string | null,
): string {
  if (index === 0) return "";
  const isConsecutive = prevRole !== null && prevRole === entry.info.role;
  return isConsecutive ? "mt-1" : "mt-4";
}

export type TranscriptRow = {
  kind: "message";
  id: string;
  entry: TranscriptMessageEntry;
  spacing: string;
  footer?: TurnFooter;
  actions: TranscriptMessageRowActions;
};

export function buildTranscriptRows(input: {
  visibleMessages: MessageEntry[];
  turnFooterByMessageId: Map<string, TurnFooter>;
  firstUserMessageIndex: number;
  capabilities: { fork?: boolean; revert?: boolean } | null;
  forkFromMessage: (messageId: string) => void;
  revertToMessage: (messageId: string) => void;
}): TranscriptRow[] {
  const rows: TranscriptRow[] = [];

  input.visibleMessages.forEach((entry, idx) => {
    const prevRole = idx > 0 ? (input.visibleMessages[idx - 1]?.info.role ?? null) : null;
    const spacing = messageBubbleSpacingClass(idx, entry, prevRole);
    const isFirstUserMsg = entry.info.role === "user" && input.firstUserMessageIndex === idx;
    const canFork = input.capabilities?.fork && entry.info.role === "user" && !isFirstUserMsg;
    const canRevert = input.capabilities?.revert && entry.info.role === "user";

    rows.push({
      kind: "message",
      id: entry.info.id,
      entry: entry as TranscriptMessageEntry,
      spacing,
      footer: input.turnFooterByMessageId.get(entry.info.id),
      actions: {
        onFork: canFork ? () => input.forkFromMessage(entry.info.id) : undefined,
        onRevert: canRevert ? () => input.revertToMessage(entry.info.id) : undefined,
      },
    });
  });

  return rows;
}
