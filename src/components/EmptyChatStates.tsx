import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { openAddWorkspaceDialog } from "@/hooks/workspace-guards";

export function NoWorkspaceConfigured() {
  const { t } = useTranslation();

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-md text-center space-y-4">
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold tracking-tight">
            {t("emptyStates.noWorkspaceTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("emptyStates.noWorkspaceDescription")}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={() => openAddWorkspaceDialog()}>
            {t("emptyStates.addWorkspace")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NoProjectConnected({
  canStartChat,
  onStartChat,
  shareOnly = false,
}: {
  canStartChat: boolean;
  onStartChat: () => void;
  shareOnly?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-md text-center space-y-4">
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold tracking-tight">
            {t("emptyStates.noProjectTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {shareOnly
              ? t("emptyStates.noSharedProjects")
              : canStartChat
                ? t("emptyStates.noProjectCanStart")
                : t("emptyStates.noProjectConnect")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canStartChat && (
            <Button type="button" onClick={onStartChat}>
              {t("emptyStates.startChat")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function NoSessionSelected() {
  const { t } = useTranslation();

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-md text-center space-y-1.5">
        <h2 className="text-lg font-semibold tracking-tight">{t("emptyStates.noSessionTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("emptyStates.noSessionDescription")}</p>
      </div>
    </div>
  );
}
