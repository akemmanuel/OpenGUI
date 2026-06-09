import * as React from "react";
import type { QueueMode } from "@/hooks/agent-state-types";
import type { parseSlashCommand } from "@/hooks/use-slash-command-input";

type SlashInvocation = ReturnType<typeof parseSlashCommand>;

export type PromptSubmitDecision =
  | { type: "skip" }
  | { type: "command"; commandName: string; args: string }
  | { type: "prompt"; text: string; mode?: QueueMode };

export function decidePromptSubmit({
  value,
  disabled,
  isUploading,
  isLoading,
  queueMode,
  slashInvocation,
}: {
  value: string;
  disabled: boolean;
  isUploading?: boolean;
  isLoading?: boolean;
  queueMode: QueueMode;
  slashInvocation: SlashInvocation;
}): PromptSubmitDecision {
  const hasValue = value.trim().length > 0;
  if (disabled || isUploading || !hasValue) return { type: "skip" };
  if (slashInvocation) {
    return {
      type: "command",
      commandName: slashInvocation.commandName,
      args: slashInvocation.args,
    };
  }
  return {
    type: "prompt",
    text: value,
    mode: isLoading ? queueMode : undefined,
  };
}

export function usePromptSubmit({
  value,
  disabled,
  isUploading,
  isLoading,
  queueMode,
  parseSlashCommand,
  sendCommand,
  onSubmit,
  clearPromptDraft,
  onAfterSubmit,
  resetSlashCommand,
  resetHistory,
}: {
  value: string;
  disabled: boolean;
  isUploading?: boolean;
  isLoading?: boolean;
  queueMode: QueueMode;
  parseSlashCommand: (value: string) => SlashInvocation;
  sendCommand: (command: string, args: string) => Promise<void>;
  onSubmit?: (message: string, mode?: QueueMode) => void | Promise<void>;
  clearPromptDraft: () => void;
  onAfterSubmit?: () => void;
  resetSlashCommand: () => void;
  resetHistory: () => void;
}) {
  const submittingRef = React.useRef(false);
  const hasValue = value.trim().length > 0;

  const submit = React.useCallback(async () => {
    if (submittingRef.current) return;
    if (disabled || isUploading) return;
    if (!hasValue) return;
    submittingRef.current = true;

    const decision = decidePromptSubmit({
      value,
      disabled,
      isUploading,
      isLoading,
      queueMode,
      slashInvocation: parseSlashCommand(value),
    });

    if (decision.type === "skip") {
      submittingRef.current = false;
      return;
    }

    try {
      if (decision.type === "command") {
        clearPromptDraft();
        resetSlashCommand();
        resetHistory();
        await sendCommand(decision.commandName, decision.args);
        return;
      }

      await onSubmit?.(decision.text, decision.mode);
      clearPromptDraft();
      onAfterSubmit?.();
      resetHistory();
    } finally {
      submittingRef.current = false;
    }
  }, [
    clearPromptDraft,
    disabled,
    hasValue,
    isUploading,
    isLoading,
    onSubmit,
    onAfterSubmit,
    parseSlashCommand,
    queueMode,
    resetHistory,
    resetSlashCommand,
    sendCommand,
    value,
  ]);

  return { hasValue, submit };
}
