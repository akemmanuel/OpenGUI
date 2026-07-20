import { MessageListTrailing } from "@/components/message-list/MessageListTrailing";
import type { useMessageListModel } from "@/components/message-list/useMessageListModel";
import { useMessageListTranscriptRows } from "@/features/session-transcript/build-message-list-transcript-rows";
import { TranscriptMessageRow } from "@/features/session-transcript/transcript-rows";
import { TranscriptViewport } from "@/features/session-transcript/transcript-viewport";
import { useActions } from "@/hooks/use-agent-state";

type MessageListModel = ReturnType<typeof useMessageListModel>;

export function MessageListTranscript({ model }: { model: MessageListModel }) {
  const {
    respondPermission,
    replyQuestion,
    rejectQuestion,
    forkFromMessage,
    revertToMessage,
    unrevert,
    loadOlderMessages,
  } = useActions();

  const {
    capabilities,
    activeSessionId,
    isBusy,
    transcriptRevision,
    messages,
    sessionMetaForActive,
    revertMessageID,
    revertedCount,
    pendingPermission,
    pendingQuestion,
    messageHistoryHasMore,
    isLoadingOlderMessages,
    olderMessagesError,
    expandedUserMessages,
    expandedToolCalls,
    toggleUserMessage,
    setToolCallExpanded,
    imageBaseDirectory,
    attachmentBaseUrl,
  } = model;

  const { rows, visibleMessages } = useMessageListTranscriptRows({
    messages,
    sessionMetaForActive,
    revertMessageID,
    isBusy,
    capabilities,
    forkFromMessage,
    revertToMessage,
  });

  const contentKey = `${activeSessionId ?? ""}:${transcriptRevision}:${visibleMessages.length}:${isBusy ? 1 : 0}`;

  const trailingContent = (
    <MessageListTrailing
      capabilities={capabilities}
      revertMessageID={revertMessageID}
      revertedCount={revertedCount}
      onRestore={unrevert}
      pendingPermission={pendingPermission}
      pendingQuestion={pendingQuestion}
      onRespondPermission={respondPermission}
      onReplyQuestion={replyQuestion}
      onRejectQuestion={rejectQuestion}
    />
  );

  return (
    <TranscriptViewport
      sessionId={activeSessionId}
      contentKey={contentKey}
      pinWhenNearBottom={isBusy}
      isLoadingOlder={isLoadingOlderMessages}
      loadOlderError={olderMessagesError}
      onLoadOlder={loadOlderMessages}
      showLoadOlderRow={messageHistoryHasMore}
      trailingContent={trailingContent}
    >
      {rows.map((row) => (
        <TranscriptMessageRow
          key={row.id}
          row={row}
          imageBaseDirectory={imageBaseDirectory}
          attachmentBaseUrl={attachmentBaseUrl}
          expandedUserMessages={expandedUserMessages}
          expandedToolCalls={expandedToolCalls}
          onToggleUserMessage={toggleUserMessage}
          onSetToolCallExpanded={setToolCallExpanded}
        />
      ))}
    </TranscriptViewport>
  );
}
