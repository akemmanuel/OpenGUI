import * as React from "react";
import type { QueueMode } from "@/hooks/agent-state-types";
import type { parseSlashCommand } from "@/hooks/use-slash-command-input";

type SlashInvocation = ReturnType<typeof parseSlashCommand>;

export type PromptSubmitDecision =
  | { type: "skip" }
  | { type: "command"; commandName: string; args: string }
  | { type: "prompt"; text: string; images?: string[]; mode?: QueueMode };

export function decidePromptSubmit({
  value,
  imagePreviews,
  disabled,
  isLoading,
  queueMode,
  slashInvocation,
}: {
  value: string;
  imagePreviews: string[];
  disabled: boolean;
  isLoading?: boolean;
  queueMode: QueueMode;
  slashInvocation: SlashInvocation;
}): PromptSubmitDecision {
  const hasValue = value.trim().length > 0 || imagePreviews.length > 0;
  if (disabled || !hasValue) return { type: "skip" };
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
    images: imagePreviews.length > 0 ? imagePreviews : undefined,
    mode: isLoading ? queueMode : undefined,
  };
}

export function usePromptSubmit({
  value,
  imagePreviews,
  disabled,
  isLoading,
  queueMode,
  parseSlashCommand,
  sendCommand,
  onSubmit,
  clearPromptDraft,
  resetSlashCommand,
  resetHistory,
}: {
  value: string;
  imagePreviews: string[];
  disabled: boolean;
  isLoading?: boolean;
  queueMode: QueueMode;
  parseSlashCommand: (value: string) => SlashInvocation;
  sendCommand: (command: string, args: string) => Promise<void>;
  onSubmit?: (message: string, images?: string[], mode?: QueueMode) => void | Promise<void>;
  clearPromptDraft: () => void;
  resetSlashCommand: () => void;
  resetHistory: () => void;
}) {
  const submittingRef = React.useRef(false);
  const hasValue = value.trim().length > 0 || imagePreviews.length > 0;

  const submit = React.useCallback(async () => {
    if (submittingRef.current) return;
    if (disabled) return;
    if (!hasValue) return;
    submittingRef.current = true;

    const decision = decidePromptSubmit({
      value,
      imagePreviews,
      disabled,
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

      await onSubmit?.(decision.text, decision.images, decision.mode);
      clearPromptDraft();
      resetHistory();
    } finally {
      submittingRef.current = false;
    }
  }, [
    clearPromptDraft,
    disabled,
    hasValue,
    imagePreviews,
    isLoading,
    onSubmit,
    parseSlashCommand,
    queueMode,
    resetHistory,
    resetSlashCommand,
    sendCommand,
    value,
  ]);

  return { hasValue, submit };
}
