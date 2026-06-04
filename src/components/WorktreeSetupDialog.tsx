import { Loader2, Play, SkipForward, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BaseDialog } from "@/components/ui/base-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAsyncDialogOperation, useDialogError } from "@/hooks/use-dialog-state";
import { getProjectName } from "@/lib/utils";
import { useOpenGuiClient } from "@/protocol/provider";

interface WorktreeSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktreePath: string;
}

type SetupStep = "detecting" | "prompt" | "running" | "done" | "error";

export function WorktreeSetupDialog({
  open,
  onOpenChange,
  worktreePath,
}: WorktreeSetupDialogProps) {
  const client = useOpenGuiClient();
  const [step, setStep] = useState<SetupStep>("detecting");
  const [command, setCommand] = useState("");
  const [detectedFile, setDetectedFile] = useState("");
  const { setError, clearError, setUnknownError } = useDialogError();
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear auto-close timeout on unmount
  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current !== null) {
        clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
    };
  }, []);

  // Detect setup command when dialog opens
  useEffect(() => {
    if (!open || !worktreePath) return;
    let cancelled = false;
    setStep("detecting");
    clearError();
    setCommand("");
    setDetectedFile("");

    client.worktree
      .detectSetup(worktreePath)
      .then((result) => {
        if (cancelled) return;
        if (result.detected && result.command) {
          setCommand(result.command);
          setDetectedFile(result.file ?? "");
          setStep("prompt");
        } else {
          // Nothing detected, close silently
          onOpenChange(false);
        }
      })
      .catch(() => {
        if (cancelled) return;
        onOpenChange(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, open, worktreePath, onOpenChange, clearError]);

  const { execute: handleRun } = useAsyncDialogOperation(
    useCallback(async () => {
      if (!command.trim()) return;
      setStep("running");
      clearError();
      try {
        await client.worktree.runSetup(worktreePath, command.trim());
        setStep("done");
        // Auto-close after a brief pause
        autoCloseTimerRef.current = setTimeout(() => onOpenChange(false), 1200);
      } catch (err) {
        setUnknownError(err, "Setup command failed");
        setStep("error");
      }
    }, [client, command, worktreePath, onOpenChange, clearError, setError, setUnknownError]),
  );

  const handleSkip = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const isRunning = step === "running";
  const projectName = getProjectName(worktreePath);

  return (
    <BaseDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2">
          <Terminal className="size-4" />
          Worktree Setup
        </span>
      }
      description={
        <>
          {step === "detecting" && "Detecting project setup..."}
          {step === "prompt" && (
            <>
              Detected <code className="rounded bg-muted px-1 text-xs">{detectedFile}</code> in{" "}
              <strong>{projectName}</strong>. Run setup?
            </>
          )}
          {step === "running" && "Running setup command..."}
          {step === "done" && "Setup completed successfully."}
          {step === "error" && "Setup command failed."}
        </>
      }
      footer={
        (step === "prompt" || step === "error") && (
          <>
            <Button variant="ghost" onClick={handleSkip} disabled={isRunning}>
              <SkipForward className="mr-1.5 size-3.5" />
              Skip
            </Button>
            <Button onClick={handleRun} disabled={isRunning || !command.trim()}>
              <Play className="mr-1.5 size-3.5" />
              Run
            </Button>
          </>
        )
      }
    >
      {(step === "prompt" || step === "error") && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="setup-command" className="text-xs font-medium text-muted-foreground">
              Detected command
            </label>
            <Input
              id="setup-command"
              value={command}
              readOnly
              placeholder="pnpm install"
              className="font-mono text-sm"
            />
          </div>
        </div>
      )}

      {step === "detecting" && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {step === "running" && (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="size-4 animate-spin" />
          <code className="text-sm text-muted-foreground">{command}</code>
        </div>
      )}

      {step === "done" && (
        <p className="py-2 text-sm text-green-600 dark:text-green-400">
          Setup finished - worktree is ready.
        </p>
      )}
    </BaseDialog>
  );
}
