import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMessageListExpansion } from "@/components/message-list/useMessageListExpansion";
import { buildTurnFooterByMessageId } from "@/components/message-list/turn-footers";
import {
  buildVisibleMessages,
  countRevertedVisibleMessages,
} from "@/components/message-list/visible-transcript";
import {
  resolveMessageListViewport,
  type MessageListViewportState,
} from "@/components/message-list/message-list-viewport";
import { useActiveTranscriptSnapshot } from "@/features/session-transcript/active-session-transcript-provider";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import { useConnectionState, useMessages, useSessionState } from "@/hooks/use-agent-state";

export type { MessageListViewportState as MessageListViewport };

export function useMessageListModel() {
  const capabilities = useBackendCapabilities();
  const transcript = useActiveTranscriptSnapshot();
  const { attachmentBaseUrl } = useConnectionState();
  const {
    isBusy,
    pendingPermissions,
    pendingQuestions,
    activeSessionId,
    sessions,
    sessionMeta,
    sessionErrors,
  } = useSessionState();
  const messages = transcript.messages;
  const transcriptRevision = transcript.revision;
  const messageHistoryHasMore = transcript.hasOlder;
  const isLoadingOlderMessages = transcript.loadingOlder;
  const isLoadingMessages =
    transcript.scope?.sessionId === activeSessionId && transcript.phase === "loading";
  const imageBaseDirectory = transcript.scope?.directory ?? null;
  const { turnRuns } = useMessages();
  const { t } = useTranslation();

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId],
  );

  const revertMessageID = activeSession?.revert?.messageID;
  const sessionMetaForActive = activeSessionId ? sessionMeta[activeSessionId] : undefined;

  const visibleMessages = useMemo(
    () =>
      buildVisibleMessages(messages, {
        sessionMeta: sessionMetaForActive,
        revertMessageID,
      }),
    [messages, sessionMetaForActive, revertMessageID],
  );

  const revertedCount = useMemo(() => {
    if (!revertMessageID) return 0;
    return countRevertedVisibleMessages(messages, revertMessageID);
  }, [messages, revertMessageID]);

  const turnFooterByMessageId = useMemo(
    () => buildTurnFooterByMessageId(visibleMessages, turnRuns),
    [visibleMessages, turnRuns],
  );

  const firstUserMessageIndex = useMemo(
    () => visibleMessages.findIndex((message) => message.info.role === "user"),
    [visibleMessages],
  );

  const pendingPermission = activeSessionId ? (pendingPermissions[activeSessionId] ?? null) : null;
  const pendingQuestion = activeSessionId ? (pendingQuestions[activeSessionId] ?? null) : null;

  const activeLoadError = activeSessionId ? (sessionErrors[activeSessionId] ?? null) : null;
  const activeLoadErrorText =
    activeLoadError && activeLoadError.startsWith("sessionError.")
      ? t(activeLoadError)
      : activeLoadError;

  const viewport = useMemo(
    () =>
      resolveMessageListViewport({
        visibleCount: visibleMessages.length,
        isBusy,
        isLoadingMessages,
        activeSessionId,
        activeLoadError,
        activeLoadErrorText,
      }),
    [
      activeLoadError,
      activeLoadErrorText,
      activeSessionId,
      isBusy,
      isLoadingMessages,
      visibleMessages.length,
    ],
  );

  const expansion = useMessageListExpansion(activeSessionId);

  return {
    capabilities,
    activeSessionId,
    isBusy,
    transcriptRevision,
    imageBaseDirectory,
    attachmentBaseUrl,
    visibleMessages,
    turnFooterByMessageId,
    firstUserMessageIndex,
    revertMessageID,
    revertedCount,
    pendingPermission,
    pendingQuestion,
    messageHistoryHasMore,
    isLoadingOlderMessages,
    viewport,
    ...expansion,
  };
}
