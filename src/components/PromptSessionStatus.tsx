import * as React from "react";
import { PromptContextStatus } from "@/components/PromptContextStatus";
import { PromptWorktreeSelector } from "@/components/PromptWorktreeSelector";
import { WorktreeDialog } from "@/components/WorktreeDialog";
import { WorktreeSetupDialog } from "@/components/WorktreeSetupDialog";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import { useActiveTranscriptCompactionTail } from "@/features/session-transcript/active-session-transcript-provider";
import { usePromptCompaction } from "@/hooks/use-prompt-compaction";
import { usePromptWorktreeSelector } from "@/hooks/use-prompt-worktree-selector";
import { useActions, useConnectionState, useSessionState } from "@/hooks/use-agent-state";
import { cn } from "@/lib/utils";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";

export function PromptSessionStatus({
  contextPercent,
  contextTokens,
  contextCost,
  contextLimit,
  isLoading,
  isDisabled = false,
  className,
}: {
  contextPercent?: number | null;
  contextTokens?: number | null;
  contextCost?: number | null;
  contextLimit?: number | null;
  isLoading?: boolean;
  isDisabled?: boolean;
  className?: string;
}) {
  const [worktreeDialogDir, setWorktreeDialogDir] = React.useState<string | null>(null);
  const [setupWorktreePath, setSetupWorktreePath] = React.useState<string | null>(null);

  const handleMobileBackWorktreeSetup = React.useCallback(() => {
    setSetupWorktreePath(null);
    return true;
  }, []);
  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.WORKTREE_PROMPT + 1,
    setupWorktreePath !== null,
    handleMobileBackWorktreeSetup,
  );

  const handleMobileBackWorktreeDialog = React.useCallback(() => {
    setWorktreeDialogDir(null);
    return true;
  }, []);
  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.WORKTREE_PROMPT,
    worktreeDialogDir !== null,
    handleMobileBackWorktreeDialog,
  );

  const capabilities = useBackendCapabilities();
  const compactionTailMessages = useActiveTranscriptCompactionTail();
  const { summarizeSession, setActiveTargetDirectory, registerWorktree, connectToProject } =
    useActions();
  const { sessions, activeSessionId, activeTargetDirectory } = useSessionState();
  const { worktreeParents, isLocalWorkspace } = useConnectionState();

  const activeSession = React.useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const worktreeSelector = usePromptWorktreeSelector({
    activeSession,
    activeSessionId,
    activeTargetDirectory,
    worktreeParents,
    isLocalWorkspace,
    registerWorktree,
  });
  const promptCompaction = usePromptCompaction({
    isLoading,
    messages: compactionTailMessages,
    summarizeSession,
  });

  const canShowWorktree = worktreeSelector.shouldShowSelector && worktreeSelector.selectedOption;
  const canShowContext = Boolean(
    capabilities?.compact && contextPercent != null && contextPercent >= 0,
  );

  if (!canShowWorktree && !canShowContext) return null;

  return (
    <>
      <div
        className={cn(
          "mb-2 flex min-w-0 flex-wrap items-center justify-between gap-1.5 px-1 text-xs text-muted-foreground",
          className,
        )}
      >
        {canShowWorktree && (
          <div className="min-w-0 max-w-full overflow-hidden rounded-lg bg-muted/35 dark:bg-muted/25">
            <PromptWorktreeSelector
              shouldShow={worktreeSelector.shouldShowSelector}
              selectedOption={worktreeSelector.selectedOption}
              isPendingTargetSelection={worktreeSelector.isPendingTargetSelection}
              options={worktreeSelector.options}
              selectedDirectory={worktreeSelector.selectedDirectory}
              projectDir={worktreeSelector.projectDir}
              worktreeParents={worktreeParents}
              registerWorktree={registerWorktree}
              setActiveTargetDirectory={setActiveTargetDirectory}
              onNewWorktree={() => setWorktreeDialogDir(worktreeSelector.projectDir)}
            />
          </div>
        )}

        {canShowContext && (
          <div className="ml-auto rounded-lg bg-muted/35 dark:bg-muted/25">
            <PromptContextStatus
              contextPercent={contextPercent as number}
              contextTokens={contextTokens}
              contextCost={contextCost}
              contextLimit={contextLimit}
              isLoading={isLoading}
              isDisabled={isDisabled}
              isCompacting={promptCompaction.isCompacting}
              isCompactingInProgress={promptCompaction.isCompactingInProgress}
              onCompact={promptCompaction.compact}
            />
          </div>
        )}
      </div>

      <WorktreeDialog
        open={worktreeDialogDir !== null}
        onOpenChange={(open) => {
          if (!open) setWorktreeDialogDir(null);
        }}
        directory={worktreeDialogDir ?? ""}
        onCreated={async (worktreePath, branch) => {
          if (!worktreeDialogDir) return;
          registerWorktree(worktreePath, worktreeDialogDir, branch);
          await connectToProject(worktreePath);
          setActiveTargetDirectory(worktreePath);
          setSetupWorktreePath(worktreePath);
          setWorktreeDialogDir(null);
        }}
      />
      <WorktreeSetupDialog
        open={setupWorktreePath !== null}
        onOpenChange={(open) => {
          if (!open) setSetupWorktreePath(null);
        }}
        worktreePath={setupWorktreePath ?? ""}
      />
    </>
  );
}
