import * as React from "react";
import { useFileMention } from "@/hooks/use-file-mention";
import { useListKeyboardNavigation } from "@/hooks/use-list-keyboard-navigation";
import { getNextPrimaryAgent } from "@/hooks/use-primary-agent-cycle";
import { usePromptSubmit } from "@/hooks/use-prompt-submit";
import { useSlashCommandInput } from "@/hooks/use-slash-command-input";

export function usePromptInputInteractions({
  value,
  setValue,
  textareaRef,
  findFiles,
  activeSessionId,
  sessions,
  activeTargetDirectory,
  activeWorkspaceId,
  workspaceServerUrl,
  capabilities,
  commands,
  propsOnChange,
  noteManualInput,
  promptFiles,
  isDisabled,
  isLoading,
  queueMode,
  sendCommand,
  onSubmit,
  clearPromptDraft,
  resetHistory,
  handleHistoryKeyDown,
  primaryAgents,
  selectedAgent,
  setAgent,
}: any) {
  const getActiveTarget = React.useCallback(() => {
    if (activeSessionId) {
      const activeSession = sessions.find((s: any) => s.id === activeSessionId);
      return {
        directory: activeSession?._projectDir ?? activeSession?.directory ?? undefined,
        workspaceId: activeSession?._workspaceId ?? activeWorkspaceId ?? undefined,
        baseUrl: workspaceServerUrl ?? undefined,
      };
    }
    return {
      directory: activeTargetDirectory ?? undefined,
      workspaceId: activeWorkspaceId ?? undefined,
      baseUrl: workspaceServerUrl ?? undefined,
    };
  }, [activeSessionId, sessions, activeTargetDirectory, activeWorkspaceId, workspaceServerUrl]);

  const fileMention = useFileMention({ value, setValue, textareaRef, findFiles, getActiveTarget });
  const slashCommand = useSlashCommandInput({
    enabled: Boolean(capabilities?.commands),
    commands,
    setValue,
    textareaRef,
  });

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    propsOnChange?.(e);
    noteManualInput();
    slashCommand.updateForInput(newValue);
    fileMention.updateForInput(newValue, e.target.selectionStart);
  };

  const promptSubmit = usePromptSubmit({
    value,
    isUploading: promptFiles.isUploading,
    disabled: isDisabled,
    isLoading,
    queueMode,
    parseSlashCommand: slashCommand.parse,
    sendCommand,
    onSubmit,
    clearPromptDraft,
    resetSlashCommand: slashCommand.reset,
    resetHistory,
  });

  const handleFileMentionKeyboard = useListKeyboardNavigation({
    open: fileMention.open,
    items: fileMention.results,
    activeIndex: fileMention.activeIndex,
    setActiveIndex: fileMention.setActiveIndex,
    onSelect: fileMention.select,
    onDismiss: fileMention.dismiss,
  });

  const handleSlashKeyboard = useListKeyboardNavigation({
    open: slashCommand.open,
    items: slashCommand.filteredCommands,
    activeIndex: slashCommand.activeIndex,
    setActiveIndex: slashCommand.setActiveIndex,
    onSelect: slashCommand.select,
    onDismiss: slashCommand.reset,
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleFileMentionKeyboard(e)) return;
    if (handleSlashKeyboard(e)) return;
    if (handleHistoryKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isDisabled) void promptSubmit.submit();
    }
    if (capabilities?.agents && e.key === "Tab" && primaryAgents.length > 1) {
      e.preventDefault();
      setAgent(getNextPrimaryAgent({ primaryAgents, selectedAgent, shiftKey: e.shiftKey }));
    }
  };

  return { fileMention, slashCommand, promptSubmit, handleInputChange, handleKeyDown };
}
