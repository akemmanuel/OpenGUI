import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { QuestionPanel } from "@/components/message-list/QuestionPanel";
import { Button } from "@/components/ui/button";
import type {
  PermissionInteractionRequest,
  QuestionInteractionAnswer,
  QuestionInteractionRequest,
} from "@/protocol/session-transcript";

export function InteractionRequestsView({
  permission,
  question,
  onRespondPermission,
  onReplyQuestion,
  onRejectQuestion,
}: {
  permission: PermissionInteractionRequest | null;
  question: QuestionInteractionRequest | null;
  onRespondPermission: (response: "once" | "always" | "reject") => void;
  onReplyQuestion: (answers: QuestionInteractionAnswer[]) => void;
  onRejectQuestion: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      {permission && (
        <div className="border rounded-lg p-4 bg-amber-500/10 border-amber-500/30 space-y-3 mt-4">
          <div className="flex items-start gap-2">
            <ShieldAlert className="size-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {t("permissionPanel.title", { permission: permission.permission })}
              </p>
              {permission.patterns.length > 0 && (
                <p className="text-xs text-muted-foreground">{permission.patterns.join(", ")}</p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="default" onClick={() => onRespondPermission("once")}>
              {t("permissionPanel.allowOnce")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onRespondPermission("always")}>
              {t("permissionPanel.alwaysAllow")}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => onRespondPermission("reject")}>
              {t("permissionPanel.reject")}
            </Button>
          </div>
        </div>
      )}

      {question && (
        <QuestionPanel
          questions={question.questions}
          onSubmit={onReplyQuestion}
          onDismiss={onRejectQuestion}
        />
      )}
    </>
  );
}
