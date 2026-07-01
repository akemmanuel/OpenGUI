import {
  resolveMessageListViewport,
  type MessageListViewportState,
} from "@/components/message-list/message-list-viewport";
import type { MessageEntry } from "@/hooks/agent-state-types";
import type { SessionMeta } from "@/hooks/agent-state-persistence";
import {
  buildVisibleMessages,
  countRevertedVisibleMessages,
} from "@/components/message-list/visible-transcript";
import type { ActiveTranscriptSnapshot } from "@/features/session-transcript/transcript-input";

export type { MessageListViewportState as MessageListViewport };

export function resolveActiveTranscriptLoading(
  transcript: ActiveTranscriptSnapshot,
  activeSessionId: string | null,
): boolean {
  return transcript.scope?.sessionId === activeSessionId && transcript.phase === "loading";
}

export function resolveMessageListChrome(input: {
  messages: MessageEntry[];
  sessionMetaForActive: SessionMeta | undefined;
  revertMessageID: string | undefined;
  isBusy: boolean;
  isLoadingMessages: boolean;
  activeSessionId: string | null;
  activeLoadError: string | null;
  activeLoadErrorText: string | null;
}): {
  visibleMessageCount: number;
  revertedCount: number;
  viewport: MessageListViewportState;
} {
  const revertedCount =
    input.revertMessageID != null
      ? countRevertedVisibleMessages(input.messages, input.revertMessageID)
      : 0;

  const visibleMessages = buildVisibleMessages(input.messages, {
    sessionMeta: input.sessionMetaForActive,
    revertMessageID: input.revertMessageID,
  });

  const viewport = resolveMessageListViewport({
    visibleCount: visibleMessages.length,
    isBusy: input.isBusy,
    isLoadingMessages: input.isLoadingMessages,
    activeSessionId: input.activeSessionId,
    activeLoadError: input.activeLoadError,
    activeLoadErrorText: input.activeLoadErrorText,
  });

  return {
    visibleMessageCount: visibleMessages.length,
    revertedCount,
    viewport,
  };
}
