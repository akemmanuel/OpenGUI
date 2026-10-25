/**
 * Renders the chat message list for the active session.
 */

import { MessageListTranscript } from "@/components/message-list/MessageListTranscript";
import { MessageListViewportShell } from "@/components/message-list/MessageListViewportShell";
import { useMessageListModel } from "@/components/message-list/useMessageListModel";
import { useActions } from "@/hooks/use-agent-state";

export function MessageList() {
  const model = useMessageListModel();
  const { selectSession } = useActions();
  const activeSessionId = model.activeSessionId;

  return (
    <MessageListViewportShell
      viewport={model.viewport}
      directory={model.projectDirectory}
      onRetry={activeSessionId ? () => void selectSession(activeSessionId) : undefined}
    >
      <MessageListTranscript model={model} />
    </MessageListViewportShell>
  );
}
