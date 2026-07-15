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

type PresentationMessage = {
  entry: MessageEntry;
  footerMessageId: string;
};

/** Present the model-loop messages in one assistant turn without changing transcript truth. */
function buildPresentationMessages(messages: MessageEntry[]): PresentationMessage[] {
  const presented: PresentationMessage[] = [];

  for (const entry of messages) {
    const previous = presented.at(-1);
    const canJoinPrevious =
      entry.info.role === "assistant" &&
      entry.info.summary !== true &&
      previous?.entry.info.role === "assistant" &&
      previous.entry.info.summary !== true;

    if (!canJoinPrevious || !previous) {
      presented.push({ entry, footerMessageId: entry.info.id });
      continue;
    }

    const first = previous.entry;
    previous.entry = {
      info: {
        ...entry.info,
        id: first.info.id,
        sessionID: first.info.sessionID,
        time: {
          created: first.info.time.created,
          completed: entry.info.time.completed,
        },
        error: entry.info.error ?? first.info.error,
      },
      parts: [...first.parts, ...entry.parts],
    };
    previous.footerMessageId = entry.info.id;
  }

  return presented;
}

export function buildTranscriptRows(input: {
  visibleMessages: MessageEntry[];
  turnFooterByMessageId: Map<string, TurnFooter>;
  firstUserMessageIndex: number;
  capabilities: { fork?: boolean; revert?: boolean } | null;
  forkFromMessage: (messageId: string) => void;
  revertToMessage: (messageId: string) => void;
}): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const presentationMessages = buildPresentationMessages(input.visibleMessages);
  const firstUserMessageId = input.visibleMessages[input.firstUserMessageIndex]?.info.id;

  presentationMessages.forEach(({ entry, footerMessageId }, idx) => {
    const prevRole = idx > 0 ? (presentationMessages[idx - 1]?.entry.info.role ?? null) : null;
    const spacing = messageBubbleSpacingClass(idx, entry, prevRole);
    const isFirstUserMsg = entry.info.role === "user" && entry.info.id === firstUserMessageId;
    const canFork = input.capabilities?.fork && entry.info.role === "user" && !isFirstUserMsg;
    const canRevert = input.capabilities?.revert && entry.info.role === "user";

    rows.push({
      kind: "message",
      id: entry.info.id,
      entry: entry as TranscriptMessageEntry,
      spacing,
      footer: input.turnFooterByMessageId.get(footerMessageId),
      actions: {
        onFork: canFork ? () => input.forkFromMessage(entry.info.id) : undefined,
        onRevert: canRevert ? () => input.revertToMessage(entry.info.id) : undefined,
      },
    });
  });

  return rows;
}
