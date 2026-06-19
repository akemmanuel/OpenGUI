import { memo } from "react";
import { MessageBubble } from "@/components/message-list/MessageBubble";
import type { TranscriptRow } from "@/features/session-transcript/transcript-row-model";

export const TranscriptMessageRow = memo(function TranscriptMessageRow({
  row,
  imageBaseDirectory,
  attachmentBaseUrl,
  expandedUserMessages,
  expandedToolCalls,
  onToggleUserMessage,
  onSetToolCallExpanded,
}: {
  row: Extract<TranscriptRow, { kind: "message" }>;
  imageBaseDirectory: string | null;
  attachmentBaseUrl: string | null;
  expandedUserMessages?: ReadonlySet<string>;
  expandedToolCalls?: ReadonlySet<string>;
  onToggleUserMessage?: (messageId: string) => void;
  onSetToolCallExpanded?: (partId: string, expanded: boolean) => void;
}) {
  return (
    <div className={row.spacing} style={{ contentVisibility: "auto" }}>
      <MessageBubble
        entry={row.entry}
        imageBaseDirectory={imageBaseDirectory}
        attachmentBaseUrl={attachmentBaseUrl}
        turnFooter={row.footer}
        onFork={row.actions.onFork}
        onRevert={row.actions.onRevert}
        expandedUserMessages={expandedUserMessages}
        expandedToolCalls={expandedToolCalls}
        onToggleUserMessage={onToggleUserMessage}
        onSetToolCallExpanded={onSetToolCallExpanded}
      />
    </div>
  );
});
