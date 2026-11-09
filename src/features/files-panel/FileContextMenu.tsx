import { File, FolderOpen } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { STORAGE_KEYS } from "@/lib/constants";
import { hostParent } from "@/lib/host-files";
import { notifyError } from "@/lib/notify";
import { storageGet } from "@/lib/persistence/storage";
import { useDesktopShell } from "@/shell/provider";

/** File actions shared by transcript links, folder listings, and search results. */
export function FileContextMenu({
  path,
  folder = false,
  onOpen,
  children,
}: {
  path: string;
  folder?: boolean;
  onOpen: () => void;
  children: ReactElement;
}) {
  const { t } = useTranslation();
  const shell = useDesktopShell();
  const { isLocalWorkspace, supportsNativeDirectoryPicker } = useWorkspaceState();
  const canOpenFileBrowser =
    shell.runtime.isElectron && isLocalWorkspace && supportsNativeDirectoryPicker;

  const openFileBrowser = async () => {
    try {
      await shell.system.openInFileBrowser(
        folder ? path : hostParent(path),
        storageGet(STORAGE_KEYS.FILE_MANAGER) ?? "",
      );
    } catch {
      notifyError(t("filesPanel.fileBrowserFailed"));
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <File />
          {t("filesPanel.open")}
        </ContextMenuItem>
        {canOpenFileBrowser && (
          <ContextMenuItem onClick={() => void openFileBrowser()}>
            <FolderOpen />
            {t("filesPanel.openInFileBrowser")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
