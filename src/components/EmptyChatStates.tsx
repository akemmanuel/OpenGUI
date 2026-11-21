import { FolderOpen } from "lucide-react";
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
  onOpenProject,
}: {
  canStartChat: boolean;
  onStartChat: () => void;
  shareOnly?: boolean;
  onOpenProject?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="w-full max-w-sm py-8">
        <FolderOpen
          aria-hidden="true"
          className="mb-5 size-7 text-muted-foreground"
          strokeWidth={1.65}
        />
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            {t(onOpenProject ? "emptyStates.openProjectTitle" : "emptyStates.noProjectTitle")}
          </h2>
          {!onOpenProject && (
            <p className="text-sm leading-6 text-muted-foreground">
              {shareOnly
                ? t("emptyStates.noSharedProjects")
                : canStartChat
                  ? t("emptyStates.noProjectCanStart")
                  : t("emptyStates.noProjectConnect")}
            </p>
          )}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {onOpenProject && (
            <Button type="button" size="lg" onClick={() => void onOpenProject()}>
              {t("emptyStates.openProject")}
            </Button>
          )}
          {canStartChat && (
            <Button
              type="button"
              size="lg"
              variant={onOpenProject ? "outline" : "default"}
              onClick={onStartChat}
            >
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
