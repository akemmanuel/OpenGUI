import { GitBranch, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";
import { useTranslation } from "react-i18next";
import { BaseDialog } from "@/components/ui/base-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useActions, useConnectionState } from "@/hooks/use-agent-state";
import { getProjectName } from "@/lib/utils";
import { useOpenGuiClient } from "@/protocol/provider";

export function WorktreeCleanupDialog() {
  const { t } = useTranslation();
  const client = useOpenGuiClient();
  const { pendingWorktreeCleanup, worktreeParents } = useConnectionState();
  const { unregisterWorktree, removeProject, clearWorktreeCleanup } = useActions();

  const [deleteFromDisk, setDeleteFromDisk] = useState(true);
  const [removing, setRemoving] = useState(false);

  const isOpen = pendingWorktreeCleanup !== null;
  const worktreeDir = pendingWorktreeCleanup?.worktreeDir ?? "";
  const parentDir = pendingWorktreeCleanup?.parentDir ?? "";
  const meta = worktreeDir ? worktreeParents[worktreeDir] : undefined;

  const handleKeep = useCallback(() => {
    clearWorktreeCleanup();
  }, [clearWorktreeCleanup]);

  const handleMobileBackWorktreeCleanup = useCallback(() => {
    handleKeep();
    return true;
  }, [handleKeep]);
  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.WORKTREE_CLEANUP,
    isOpen,
    handleMobileBackWorktreeCleanup,
  );

  const handleRemove = useCallback(async () => {
    if (!worktreeDir || !parentDir) return;
    setRemoving(true);
    try {
      // Unregister from state + disconnect project
      unregisterWorktree(worktreeDir);
      await removeProject(worktreeDir);

      // Optionally remove the git worktree from disk
      if (deleteFromDisk) {
        await client.git.removeWorktree(parentDir, worktreeDir);
      }
    } finally {
      setRemoving(false);
      clearWorktreeCleanup();
    }
  }, [
    client,
    worktreeDir,
    parentDir,
    deleteFromDisk,
    unregisterWorktree,
    removeProject,
    clearWorktreeCleanup,
  ]);

  return (
    <BaseDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleKeep();
      }}
      title={
        <span className="flex items-center gap-2">
          <GitBranch className="size-4" />
          {t("worktreeCleanup.title")}
        </span>
      }
      description={
        <>
          {t("worktreeCleanup.descriptionPrefix")} <strong>{getProjectName(worktreeDir)}</strong>
          {meta?.branch && meta.branch !== "unknown" && (
            <>
              {" "}
              ({t("worktreeCleanup.branch")}{" "}
              <code className="rounded bg-muted px-1 text-xs">{meta.branch}</code>)
            </>
          )}{" "}
          {t("worktreeCleanup.descriptionSuffix")}
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={handleKeep} disabled={removing}>
            {t("worktreeCleanup.keep")}
          </Button>
          <Button variant="destructive" onClick={handleRemove} disabled={removing}>
            <Trash2 className="mr-1.5 size-3.5" />
            {removing ? t("worktreeCleanup.removing") : t("worktreeCleanup.remove")}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 py-2">
        <Checkbox
          id="delete-from-disk"
          checked={deleteFromDisk}
          onCheckedChange={(checked) => setDeleteFromDisk(checked === true)}
        />
        <label htmlFor="delete-from-disk" className="cursor-pointer text-sm">
          {t("worktreeCleanup.deleteFromDisk")}
        </label>
      </div>
    </BaseDialog>
  );
}
