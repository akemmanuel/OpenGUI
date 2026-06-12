import { AlertTriangle, Check, GitBranch, GitMerge, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
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
  const client = useOpenGuiClient();
  const [mergeState, setMergeState] = useState<MergeState>({ step: "confirm" });
  const [deleteWorktree, setDeleteWorktree] = useState(false);

  const repoName = getProjectName(mainDirectory);

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Reset state on close
        setMergeState({ step: "confirm" });
        setDeleteWorktree(false);
        onOpenChange(false);
      }
    },
    [onOpenChange],
  );

  const handleMerge = useCallback(async () => {
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
          message: res.error ?? "Merge failed",
        });
      }
    } catch (err) {
      setMergeState({
        step: "error",
        message: getErrorMessage(err, "Merge failed"),
      });
    }
  }, [branch, client, deleteWorktree, mainDirectory, onMerged]);

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
        title="Merging..."
        description={
          <>
            Merging <span className="font-medium text-foreground">{branch}</span> into the current
            branch
          </>
        }
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
        title="Merge successful"
        titleClassName="text-green-600"
        description={
          <>
            <span className="font-medium text-foreground">{branch}</span> has been merged
            successfully.
            {deleteWorktree && " The worktree will be removed."}
          </>
        }
        footer={<Button onClick={() => handleClose(false)}>Done</Button>}
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
        title="Merge conflicts"
        titleClassName="text-amber-500"
        description={
          <>
            Merging <span className="font-medium text-foreground">{branch}</span> produced conflicts
            in {mergeState.files.length} file
            {mergeState.files.length !== 1 ? "s" : ""}:
          </>
        }
        footerClassName="gap-2 sm:gap-0"
        footer={
          <>
            <Button variant="outline" onClick={handleAbort}>
              Abort merge
            </Button>
            <Button onClick={handleFixWithAI}>Fix with AI</Button>
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
        title="Merge failed"
        titleClassName="text-destructive"
        description={mergeState.message}
        footer={
          <Button variant="outline" onClick={() => handleClose(false)}>
            Close
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
      title="Merge branch"
      description={
        <>
          Merge <span className="font-medium text-foreground">{branch}</span> into the current
          branch of <span className="font-medium text-foreground">{repoName}</span>
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button onClick={handleMerge}>Merge</Button>
        </>
      }
    >
      <div className="py-2">
        <ToggleSwitch
          checked={deleteWorktree}
          onCheckedChange={setDeleteWorktree}
          label="Delete worktree after successful merge"
          description="Removes the worktree directory and disconnects it from the project"
        />
      </div>
    </DialogShell>
  );
}
