/**
 * Renders the chat message list for the active session.
 */

import { MessageListTranscript } from "@/components/message-list/MessageListTranscript";
import { MessageListViewportShell } from "@/components/message-list/MessageListViewportShell";
import { useMessageListModel } from "@/components/message-list/useMessageListModel";

export function MessageList() {
  const model = useMessageListModel();

  return (
    <MessageListViewportShell viewport={model.viewport}>
      <MessageListTranscript model={model} />
    </MessageListViewportShell>
  );
}
