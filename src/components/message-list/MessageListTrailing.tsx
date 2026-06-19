import { InteractionRequestsView } from "@/components/message-list/interactions/InteractionRequestsView";
import { RevertBanner } from "@/components/message-list/RevertBanner";
import type { useBackendCapabilities } from "@/hooks/use-agent-backend";
import type {
  PermissionInteractionRequest,
  QuestionInteractionAnswer,
  QuestionInteractionRequest,
} from "@/protocol/session-transcript";

type Capabilities = ReturnType<typeof useBackendCapabilities>;

export function MessageListTrailing({
  capabilities,
  revertMessageID,
  revertedCount,
  onRestore,
  pendingPermission,
  pendingQuestion,
  onRespondPermission,
  onReplyQuestion,
  onRejectQuestion,
}: {
  capabilities: Capabilities;
  revertMessageID?: string;
  revertedCount: number;
  onRestore: () => void;
  pendingPermission: PermissionInteractionRequest | null;
  pendingQuestion: QuestionInteractionRequest | null;
  onRespondPermission: (response: "once" | "always" | "reject") => void;
  onReplyQuestion: (answers: QuestionInteractionAnswer[]) => void;
  onRejectQuestion: () => void;
}) {
  return (
    <>
      {capabilities?.revert && revertMessageID && revertedCount > 0 && (
        <RevertBanner revertedCount={revertedCount} onRestore={onRestore} />
      )}

      <InteractionRequestsView
        permission={capabilities?.permissions ? pendingPermission : null}
        question={capabilities?.questions ? pendingQuestion : null}
        onRespondPermission={onRespondPermission}
        onReplyQuestion={onReplyQuestion}
        onRejectQuestion={onRejectQuestion}
      />
    </>
  );
}
