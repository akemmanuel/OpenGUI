import { useTranslation } from "react-i18next";
import { requestProjectPath } from "@/components/ProjectPathDialog";
import { useActions, useWorkspaceState } from "@/hooks/use-agent-state";
import { openAddWorkspaceDialog } from "@/hooks/workspace-guards";
import { notifyInfo, notifyUnknownError } from "@/lib/notify";

export function useOpenProject() {
  const { t } = useTranslation();
  const { connectToProject, openDirectory } = useActions();
  const { canManageProjects, supportsNativeDirectoryPicker, workspaceDirectory, workspaces } =
    useWorkspaceState();

  return async function openProject() {
    if (!canManageProjects) {
      notifyInfo(t("workspace.requiredBeforeProject"));
      if (workspaces.length === 0) openAddWorkspaceDialog();
      return;
    }

    try {
      const directory = supportsNativeDirectoryPicker
        ? await openDirectory()
        : await requestProjectPath(workspaceDirectory ?? undefined);
      if (directory) await connectToProject(directory);
    } catch (error) {
      notifyUnknownError(error);
    }
  };
}
