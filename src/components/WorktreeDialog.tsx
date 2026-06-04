import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAsyncDialogOperation, useDialogError } from "@/hooks/use-dialog-state";
import { getProjectName, normalizeProjectPath } from "@/lib/utils";
import { useOpenGuiClient } from "@/protocol/provider";

interface WorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string;
  defaultMode?: "existing" | "new";
  defaultBranch?: string;
  onCreated: (worktreePath: string, branch: string) => void;
}

type BranchMode = "existing" | "new";

export function WorktreeDialog({
  open,
  onOpenChange,
  directory,
  defaultMode = "new",
  defaultBranch = "",
  onCreated,
}: WorktreeDialogProps) {
  const client = useOpenGuiClient();
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const { setError, clearError, setUnknownError } = useDialogError();

  const [mode, setMode] = useState<BranchMode>(defaultMode);
  const [existingBranch, setExistingBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [worktreePath, setWorktreePath] = useState("");

  const repoName = getProjectName(directory);
  const effectiveBranch = useMemo(
    () => (mode === "new" ? newBranch.trim() : existingBranch),
    [mode, newBranch, existingBranch],
  );

  // Auto-generate path when branch changes
  useEffect(() => {
    if (effectiveBranch) {
      const safeName = effectiveBranch.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-");
      setWorktreePath(`${directory}/.worktrees/${safeName}`);
    }
  }, [effectiveBranch, directory]);

  // Load branches when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    clearError();
    setLoadingBranches(true);
    setMode(defaultMode);

    if (defaultMode === "new") {
      setNewBranch(defaultBranch);
      setExistingBranch("");
    } else {
      setNewBranch("");
      setExistingBranch(defaultBranch);
    }

    client.git
      .listBranches(directory)
      .then((nextBranches) => {
        if (!cancelled) setBranches(nextBranches);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingBranches(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, open, directory, defaultBranch, defaultMode, clearError, setError]);

  const { loading: creating, execute: handleCreate } = useAsyncDialogOperation(
    useCallback(async () => {
      const normalizedWorktreePath = normalizeProjectPath(worktreePath);
      if (!effectiveBranch || !normalizedWorktreePath) return;
      clearError();
      try {
        await client.git.addWorktree(
          directory,
          normalizedWorktreePath,
          effectiveBranch,
          mode === "new",
        );
        onCreated(normalizedWorktreePath, effectiveBranch);
        onOpenChange(false);
      } catch (err) {
        setUnknownError(err, "Failed to create worktree");
      }
    }, [
      client,
      effectiveBranch,
      worktreePath,
      directory,
      mode,
      onCreated,
      onOpenChange,
      clearError,
      setError,
      setUnknownError,
    ]),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-5" />
            New Worktree
          </DialogTitle>
          <DialogDescription>
            Create a new git worktree for{" "}
            <span className="font-medium text-foreground">{repoName}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Mode toggle */}
          <div className="grid gap-2">
            <Label>Branch</Label>
            <div className="flex gap-1">
              <Button
                variant={mode === "new" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("new")}
                className="flex-1"
              >
                New branch
              </Button>
              <Button
                variant={mode === "existing" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("existing")}
                className="flex-1"
              >
                Existing branch
              </Button>
            </div>
          </div>

          {/* Branch input/selector */}
          {mode === "new" ? (
            <div className="grid gap-2">
              <Label htmlFor="new-branch">Branch name</Label>
              <Input
                id="new-branch"
                placeholder="feature/my-feature"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && effectiveBranch && worktreePath) {
                    void handleCreate();
                  }
                }}
              />
            </div>
          ) : (
            <div className="grid gap-2">
              <Label>Select branch</Label>
              {loadingBranches ? (
                <div className="text-sm text-muted-foreground py-2">Loading branches...</div>
              ) : (
                <Select value={existingBranch} onValueChange={setExistingBranch}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a branch..." />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Path */}
          <div className="grid gap-2">
            <Label htmlFor="wt-path">Worktree path</Label>
            <Input
              id="wt-path"
              value={worktreePath}
              onChange={(e) => setWorktreePath(e.target.value)}
              placeholder="/path/to/worktree"
              className="text-xs font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              A new directory will be created at this path.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!effectiveBranch || !worktreePath.trim() || creating}
          >
            {creating ? "Creating..." : "Create worktree"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
