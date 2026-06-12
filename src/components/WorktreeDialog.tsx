import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/ButtonGroup";
import { DialogShell } from "@/components/ui/DialogShell";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/input";
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
  const { t } = useTranslation();
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
        setUnknownError(err, t("worktree.createWorktree"));
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
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-md"
      icon={<GitBranch className="size-5" />}
      title={t("worktree.newWorktree")}
      description={
        <>
          {t("worktree.createFor")} <span className="font-medium text-foreground">{repoName}</span>
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!effectiveBranch || !worktreePath.trim() || creating}
          >
            {creating ? t("worktree.creating") : t("worktree.createWorktree")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 py-2">
        {/* Mode toggle */}
        <FormField label={t("worktree.branch")}>
          <ButtonGroup stretch>
            <Button
              variant={mode === "new" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("new")}
            >
              {t("worktree.newBranch")}
            </Button>
            <Button
              variant={mode === "existing" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("existing")}
            >
              {t("worktree.existingBranch")}
            </Button>
          </ButtonGroup>
        </FormField>

        {/* Branch input/selector */}
        {mode === "new" ? (
          <FormField label={t("worktree.branchName")} htmlFor="new-branch">
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
          </FormField>
        ) : (
          <FormField label={t("worktree.selectBranch")}>
            {loadingBranches ? (
              <div className="text-sm text-muted-foreground py-2">
                {t("worktree.loadingBranches")}
              </div>
            ) : (
              <Select value={existingBranch} onValueChange={setExistingBranch}>
                <SelectTrigger>
                  <SelectValue placeholder={t("worktree.chooseBranch")} />
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
          </FormField>
        )}

        {/* Path */}
        <FormField
          label={t("worktree.path")}
          htmlFor="wt-path"
          description={t("worktree.pathHelp")}
        >
          <Input
            id="wt-path"
            value={worktreePath}
            onChange={(e) => setWorktreePath(e.target.value)}
            placeholder={t("worktree.pathPlaceholder")}
            className="text-xs font-mono"
          />
        </FormField>
      </div>
    </DialogShell>
  );
}
