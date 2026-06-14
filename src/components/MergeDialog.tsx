import { AlertTriangle, Check, GitBranch, GitMerge, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/DialogShell";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { getErrorMessage, getProjectName } from "@/lib/utils";
import { useOpenGuiClient } from "@/protocol/provider";

type MergeState =
  | { step: "confirm" }
  | { step: "merging" }
  | { step: "success" }
  | { step: "conflicts"; files: string[] }
  | { step: "error"; message: string };

interface MergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The main project directory (merge target). */
  mainDirectory: string;
  /** The branch name to merge. */
  branch: string;
  /** Called after successful merge. If deleteWorktree was checked, pass true. */
  onMerged: (deleteWorktree: boolean) => void;
  /** Called when user clicks "Fix with AI". */
  onFixWithAI: (conflicts: string[]) => void;
}

export function MergeDialog({
  open,
  onOpenChange,
  mainDirectory,
  branch,
  onMerged,
  onFixWithAI,
}: MergeDialogProps) {
  const { t } = useTranslation();
  const client = useOpenGuiClient();
  const [mergeState, setMergeState] = useState<MergeState>({ step: "confirm" });
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const mergeInFlightRef = useRef(false);

  const repoName = getProjectName(mainDirectory);

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Reset state on close
        setMergeState({ step: "confirm" });
        setDeleteWorktree(false);
        mergeInFlightRef.current = false;
        onOpenChange(false);
      }
    },
    [onOpenChange],
  );

  const handleMerge = useCallback(async () => {
    if (mergeInFlightRef.current) return;
    mergeInFlightRef.current = true;
    setMergeState({ step: "merging" });
    try {
      const res = await client.git.merge(mainDirectory, branch);
      if (res.success) {
        setMergeState({ step: "success" });
        onMerged(deleteWorktree);
      } else if (res.conflicts && res.conflicts.length > 0) {
        setMergeState({ step: "conflicts", files: res.conflicts });
      } else {
        setMergeState({
          step: "error",
          message: res.error ?? t("mergeDialog.failed"),
        });
      }
    } catch (err) {
      setMergeState({
        step: "error",
        message: getErrorMessage(err, t("mergeDialog.failed")),
      });
    } finally {
      mergeInFlightRef.current = false;
    }
  }, [branch, client, deleteWorktree, mainDirectory, onMerged, t]);

  const handleAbort = useCallback(async () => {
    await client.git.mergeAbort(mainDirectory);
    handleClose(false);
  }, [client, handleClose, mainDirectory]);

  const handleFixWithAI = useCallback(() => {
    if (mergeState.step === "conflicts") {
      onFixWithAI(mergeState.files);
      handleClose(false);
    }
  }, [mergeState, onFixWithAI, handleClose]);

  if (mergeState.step === "merging") {
    return (
      <DialogShell
        open={open}
        onOpenChange={handleClose}
        className="sm:max-w-md"
        icon={<Loader2 className="size-5 animate-spin" />}
        title={t("mergeDialog.merging")}
        description={t("mergeDialog.mergingDescription", { branch })}
      />
    );
  }

  if (mergeState.step === "success") {
    return (
      <DialogShell
        open={open}
        onOpenChange={handleClose}
        className="sm:max-w-md"
        icon={<Check className="size-5" />}
        title={t("mergeDialog.success")}
        titleClassName="text-green-600"
        description={t(
          deleteWorktree
            ? "mergeDialog.successDescriptionDelete"
            : "mergeDialog.successDescription",
          { branch },
        )}
        footer={<Button onClick={() => handleClose(false)}>{t("common.done")}</Button>}
      />
    );
  }

  if (mergeState.step === "conflicts") {
    return (
      <DialogShell
        open={open}
        onOpenChange={handleClose}
        className="sm:max-w-md"
        icon={<AlertTriangle className="size-5" />}
        title={t("mergeDialog.conflicts")}
        titleClassName="text-amber-500"
        description={t("mergeDialog.conflictsDescription", {
          branch,
          count: mergeState.files.length,
        })}
        footerClassName="gap-2 sm:gap-0"
        footer={
          <>
            <Button variant="outline" onClick={handleAbort}>
              {t("mergeDialog.abort")}
            </Button>
            <Button onClick={handleFixWithAI}>{t("mergeDialog.fixWithAI")}</Button>
          </>
        }
      >
        <div className="max-h-48 overflow-y-auto rounded-md border bg-muted/50 p-2">
          {mergeState.files.map((file) => (
            <div
              key={file}
              className="flex items-center gap-2 py-1 px-2 text-xs font-mono text-muted-foreground"
            >
              <GitBranch className="size-3 shrink-0" />
              {file}
            </div>
          ))}
        </div>
      </DialogShell>
    );
  }

  if (mergeState.step === "error") {
    return (
      <DialogShell
        open={open}
        onOpenChange={handleClose}
        className="sm:max-w-md"
        icon={<AlertTriangle className="size-5" />}
        title={t("mergeDialog.failed")}
        titleClassName="text-destructive"
        description={mergeState.message}
        footer={
          <Button variant="outline" onClick={() => handleClose(false)}>
            {t("common.close")}
          </Button>
        }
      />
    );
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={handleClose}
      className="sm:max-w-md"
      icon={<GitMerge className="size-5" />}
      title={t("mergeDialog.title")}
      description={t("mergeDialog.description", { branch, repoName })}
      footer={
        <>
          <Button variant="outline" onClick={() => handleClose(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleMerge}>{t("projectMenu.merge")}</Button>
        </>
      }
    >
      <div className="py-2">
        <ToggleSwitch
          checked={deleteWorktree}
          onCheckedChange={setDeleteWorktree}
          label={t("mergeDialog.deleteWorktreeLabel")}
          description={t("mergeDialog.deleteWorktreeDescription")}
        />
      </div>
    </DialogShell>
  );
}
