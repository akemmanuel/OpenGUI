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
  const latestRef = React.useRef({
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
  });

  latestRef.current = {
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
  };

  const hasValue = value.trim().length > 0;

  const submit = React.useCallback(async () => {
    const latest = latestRef.current;
    const currentValue = latest.value;
    if (submittingRef.current) return;
    if (latest.disabled || latest.isUploading) return;
    if (currentValue.trim().length === 0) return;
    submittingRef.current = true;

    const decision = decidePromptSubmit({
      value: currentValue,
      disabled: latest.disabled,
      isUploading: latest.isUploading,
      isLoading: latest.isLoading,
      queueMode: latest.queueMode,
      slashInvocation: latest.parseSlashCommand(currentValue),
    });

    if (decision.type === "skip") {
      submittingRef.current = false;
      return;
    }

    try {
      if (decision.type === "command") {
        latest.clearPromptDraft();
        latest.resetSlashCommand();
        latest.resetHistory();
        await latest.sendCommand(decision.commandName, decision.args);
        return;
      }

      const submission = Promise.resolve(latest.onSubmit?.(decision.text, decision.mode));
      latest.clearPromptDraft();
      latest.onAfterSubmit?.();
      latest.resetHistory();
      submission.catch((error) => {
        console.error("Failed to submit prompt", error);
      });
    } finally {
      submittingRef.current = false;
    }
  }, []);

  return { hasValue, submit };
}
