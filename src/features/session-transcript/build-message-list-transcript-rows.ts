import { useMemo } from "react";
import { buildTurnFooterByMessageId } from "@/components/message-list/turn-footers";
import { buildVisibleMessages } from "@/components/message-list/visible-transcript";
import { buildTranscriptRows } from "@/features/session-transcript/transcript-row-model";
import type { MessageEntry, TurnRun } from "@/hooks/agent-state-types";
import type { SessionMeta } from "@/hooks/agent-state-persistence";

export function useMessageListTranscriptRows(input: {
  messages: MessageEntry[];
  sessionMetaForActive: SessionMeta | undefined;
  revertMessageID: string | undefined;
  turnRuns: Record<string, TurnRun>;
  capabilities: { fork?: boolean; revert?: boolean } | null;
  forkFromMessage: (messageId: string) => void;
  revertToMessage: (messageId: string) => void;
}) {
  const visibleMessages = useMemo(
    () =>
      buildVisibleMessages(input.messages, {
        sessionMeta: input.sessionMetaForActive,
        revertMessageID: input.revertMessageID,
      }),
    [input.messages, input.sessionMetaForActive, input.revertMessageID],
  );

  const turnFooterByMessageId = useMemo(
    () => buildTurnFooterByMessageId(visibleMessages, input.turnRuns),
    [visibleMessages, input.turnRuns],
  );

  const firstUserMessageIndex = useMemo(
    () => visibleMessages.findIndex((message) => message.info.role === "user"),
    [visibleMessages],
  );

  const rows = useMemo(
    () =>
      buildTranscriptRows({
        visibleMessages,
        turnFooterByMessageId,
        firstUserMessageIndex,
        capabilities: input.capabilities,
        forkFromMessage: input.forkFromMessage,
        revertToMessage: input.revertToMessage,
      }),
    [
      input.capabilities,
      input.forkFromMessage,
      input.revertToMessage,
      firstUserMessageIndex,
      turnFooterByMessageId,
      visibleMessages,
    ],
  );

  return { rows, visibleMessages };
}
