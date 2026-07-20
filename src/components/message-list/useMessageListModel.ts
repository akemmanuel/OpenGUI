import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMessageListExpansion } from "@/components/message-list/useMessageListExpansion";
import {
  resolveActiveTranscriptLoading,
  resolveMessageListChrome,
} from "@/features/session-transcript/message-list-viewport-state";
import { useActiveTranscriptSnapshot } from "@/features/session-transcript/active-session-transcript-provider";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import { useSessionState, useWorkspaceState } from "@/hooks/use-agent-state";

export type { MessageListViewport } from "@/features/session-transcript/message-list-viewport-state";

export function useMessageListModel() {
  const capabilities = useBackendCapabilities();
  const transcript = useActiveTranscriptSnapshot();
  const { attachmentBaseUrl } = useWorkspaceState();
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
  const olderMessagesError = transcript.olderError;
  const isLoadingMessages = resolveActiveTranscriptLoading(transcript, activeSessionId);
  const imageBaseDirectory = transcript.scope?.directory ?? null;
  const { t } = useTranslation();

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId],
  );

  const revertMessageID = activeSession?.revert?.messageID;
  const sessionMetaForActive = activeSessionId ? sessionMeta[activeSessionId] : undefined;

  const pendingPermission = activeSessionId ? (pendingPermissions[activeSessionId] ?? null) : null;
  const pendingQuestion = activeSessionId ? (pendingQuestions[activeSessionId] ?? null) : null;

  const activeLoadError = activeSessionId ? (sessionErrors[activeSessionId] ?? null) : null;
  const activeLoadErrorText =
    activeLoadError && activeLoadError.startsWith("sessionError.")
      ? t(activeLoadError)
      : activeLoadError;

  const { revertedCount, viewport } = useMemo(
    () =>
      resolveMessageListChrome({
        messages,
        sessionMetaForActive,
        revertMessageID,
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
      messages,
      revertMessageID,
      sessionMetaForActive,
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
    messages,
    sessionMetaForActive,
    revertMessageID,
    revertedCount,
    pendingPermission,
    pendingQuestion,
    messageHistoryHasMore,
    isLoadingOlderMessages,
    olderMessagesError,
    viewport,
    ...expansion,
  };
}
