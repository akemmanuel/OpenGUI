import {
  ArrowUp,
  Check,
  GitBranch,
  ListEnd,
  Paperclip,
  Plus,
  Square,
  Wrench,
  X,
} from "lucide-react";
import * as React from "react";
import { AgentSelector } from "@/components/AgentSelector";
import { FileMentionPopover } from "@/components/FileMentionPopover";
import { McpDialog } from "@/components/McpDialog";
import { ModelSelector } from "@/components/ModelSelector";
import { PromptContextStatus } from "@/components/PromptContextStatus";
import { SlashCommandPopover } from "@/components/SlashCommandPopover";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VariantSelector } from "@/components/VariantSelector";
import { WorktreeDialog } from "@/components/WorktreeDialog";
import { WorktreeSetupDialog } from "@/components/WorktreeSetupDialog";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import { useFileMention } from "@/hooks/use-file-mention";
import { useListKeyboardNavigation } from "@/hooks/use-list-keyboard-navigation";
import { usePromptHistoryNavigation } from "@/hooks/use-prompt-history-navigation";
import { usePromptCompaction } from "@/hooks/use-prompt-compaction";
import { usePromptDraft } from "@/hooks/use-prompt-draft";
import { getNextPrimaryAgent } from "@/hooks/use-primary-agent-cycle";
import { usePromptImages } from "@/hooks/use-prompt-images";
import { usePromptSubmit } from "@/hooks/use-prompt-submit";
import { usePromptWorktreeSelector } from "@/hooks/use-prompt-worktree-selector";
import { useSlashCommandInput } from "@/hooks/use-slash-command-input";
import {
  type QueueMode,
  useActions,
  useConnectionState,
  useMessages,
  useModelState,
  useSessionState,
} from "@/hooks/use-agent-state";
import { MAX_TEXTAREA_HEIGHT_PX } from "@/lib/constants";
import { getSessionDraftKey } from "@/lib/session-drafts";
import { shouldShowStopButton } from "@/lib/session-controls";
import { cn, getPrimaryAgents } from "@/lib/utils";

interface PromptBoxProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onSubmit"
> {
  onSubmit?: (message: string, images?: string[], mode?: QueueMode) => void | Promise<void>;
  onStop?: () => void;
  isLoading?: boolean;
  autoFocus?: boolean;
  /** Percentage of context window consumed (0-100), null if unknown */
  contextPercent?: number | null;
  /** Total tokens in the context window */
  contextTokens?: number | null;
  /** Cost of the last assistant message in USD */
  contextCost?: number | null;
  /** Maximum context window size in tokens */
  contextLimit?: number | null;
  /** Current queue mode (controlled from parent) */
  queueMode: QueueMode;
  /** Callback to update queue mode */
  onQueueModeChange: (mode: QueueMode) => void;
}

export const PromptBox = React.forwardRef<HTMLTextAreaElement, PromptBoxProps>(
  (
    {
      className,
      onSubmit,
      onStop,
      isLoading,
      autoFocus,
      contextPercent,
      contextTokens,
      contextCost,
      contextLimit,
      queueMode,
      onQueueModeChange,
      ...props
    },
    ref,
  ) => {
    const internalTextareaRef = React.useRef<HTMLTextAreaElement>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false);
    const [worktreeDialogDir, setWorktreeDialogDir] = React.useState<string | null>(null);
    const [setupWorktreePath, setSetupWorktreePath] = React.useState<string | null>(null);

    const isDisabled = Boolean(props.disabled);

    const {
      setAgent,
      sendCommand,
      summarizeSession,
      findFiles,
      setActiveTargetDirectory,
      setSessionDraft,
      clearSessionDraft,
      registerWorktree,
      connectToProject,
    } = useActions();
    const { commands, agents, selectedAgent } = useModelState();
    const capabilities = useBackendCapabilities();
    const canManageMcp = Boolean(capabilities?.mcp);
    const { sessions, activeSessionId, activeTargetDirectory, sessionDrafts } = useSessionState();
    const { messages } = useMessages();

    const promptCompaction = usePromptCompaction({
      isLoading,
      messages,
      summarizeSession,
    });

    const { activeWorkspaceId, workspaceServerUrl, worktreeParents, isLocalWorkspace } =
      useConnectionState();
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
    const selectedWorktreeDirectory = worktreeSelector.selectedDirectory;
    const projectDir = worktreeSelector.projectDir;

    // Slash command popover state

    const primaryAgents = React.useMemo(
      () => getPrimaryAgents(agents).map((a) => a.name),
      [agents],
    );

    const currentDraftKey = React.useMemo(
      () =>
        getSessionDraftKey({
          sessionId: activeSessionId,
          directory: activeSessionId ? null : activeTargetDirectory,
          workspaceId: activeWorkspaceId,
        }),
      [activeSessionId, activeTargetDirectory, activeWorkspaceId],
    );

    const { value, setValue, imagePreviews, setImagePreviews, clearPromptDraft } = usePromptDraft({
      draftKey: currentDraftKey,
      sessionDrafts,
      setSessionDraft,
      clearSessionDraft,
    });

    const { handleHistoryKeyDown, noteManualInput, resetHistory } = usePromptHistoryNavigation({
      messages,
      value,
      setValue,
      imageCount: imagePreviews.length,
      draftKey: currentDraftKey,
      textareaRef: internalTextareaRef,
    });

    const worktreeOptions = worktreeSelector.options;
    const selectedWorktreeOption = worktreeSelector.selectedOption;
    const shouldShowWorktreeSelector = worktreeSelector.shouldShowSelector;

    React.useImperativeHandle(ref, () => internalTextareaRef.current as HTMLTextAreaElement, []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: value is needed to trigger textarea auto-resize on content change
    React.useLayoutEffect(() => {
      const textarea = internalTextareaRef.current;
      if (textarea) {
        textarea.style.height = "auto";
        const newHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
        textarea.style.height = `${newHeight}px`;
      }
    }, [value]);

    React.useEffect(() => {
      if (autoFocus && !props.disabled) {
        internalTextareaRef.current?.focus();
      }
    }, [autoFocus, activeSessionId, props.disabled]);

    // Helper to determine which backend target to search.
    const getActiveTarget = React.useCallback(() => {
      if (activeSessionId) {
        const activeSession = sessions.find((s) => s.id === activeSessionId);
        const directory = activeSession?._projectDir ?? activeSession?.directory ?? undefined;
        const workspaceId = activeSession?._workspaceId ?? activeWorkspaceId ?? undefined;
        return {
          directory,
          workspaceId,
          baseUrl: workspaceServerUrl ?? undefined,
        };
      }
      return {
        directory: activeTargetDirectory ?? undefined,
        workspaceId: activeWorkspaceId ?? undefined,
        baseUrl: workspaceServerUrl ?? undefined,
      };
    }, [activeSessionId, sessions, activeTargetDirectory, activeWorkspaceId, workspaceServerUrl]);

    const fileMention = useFileMention({
      value,
      setValue,
      textareaRef: internalTextareaRef,
      findFiles,
      getActiveTarget,
    });
    const slashCommand = useSlashCommandInput({
      enabled: Boolean(capabilities?.commands),
      commands,
      setValue,
      textareaRef: internalTextareaRef,
    });

    React.useEffect(() => {
      fileMention.reset();
      slashCommand.reset();
    }, [currentDraftKey, fileMention.reset, slashCommand.reset]);

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setValue(newValue);
      if (props.onChange) props.onChange(e);

      noteManualInput();

      slashCommand.updateForInput(newValue);
      fileMention.updateForInput(newValue, e.target.selectionStart);
    };

    const promptImages = usePromptImages({
      disabled: isDisabled,
      setImagePreviews,
    });

    const promptSubmit = usePromptSubmit({
      value,
      imagePreviews,
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
        if (isDisabled) return;
        void promptSubmit.submit();
      }
      if (capabilities?.agents && e.key === "Tab" && primaryAgents.length > 1) {
        e.preventDefault();
        setAgent(
          getNextPrimaryAgent({
            primaryAgents,
            selectedAgent,
            shiftKey: e.shiftKey,
          }),
        );
      }
    };

    return (
      <section
        ref={containerRef}
        aria-label="Message input"
        data-slot="prompt-box"
        onDragOver={promptImages.handleDragOver}
        onDragLeave={promptImages.handleDragLeave}
        onDrop={promptImages.handleDrop}
        className={cn(
          "flex flex-col bg-background px-2 pt-2 shadow-xs transition-colors cursor-text border rounded-xl",
          promptImages.isDragging && "border-ring ring-ring/50 ring-[3px]",
          className,
        )}
        onClick={() => internalTextareaRef.current?.focus()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) {
            internalTextareaRef.current?.focus();
          }
        }}
      >
        {fileMention.open &&
          (fileMention.results.length > 0 || fileMention.loading || fileMention.emptyMessage) && (
            <div className="relative">
              <FileMentionPopover
                files={fileMention.results}
                activeIndex={fileMention.activeIndex}
                onSelect={fileMention.select}
                onHover={fileMention.setActiveIndex}
                loading={fileMention.loading}
                emptyMessage={fileMention.emptyMessage}
              />
            </div>
          )}

        {slashCommand.open && slashCommand.filteredCommands.length > 0 && (
          <div className="relative">
            <SlashCommandPopover
              commands={commands}
              filter={slashCommand.filter}
              activeIndex={slashCommand.activeIndex}
              onSelect={slashCommand.select}
              onHover={slashCommand.setActiveIndex}
            />
          </div>
        )}

        <input
          type="file"
          ref={fileInputRef}
          onChange={promptImages.handleFileChange}
          className="hidden"
          accept="image/*"
          multiple
        />

        {imagePreviews.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1.5 pt-1.5">
            {imagePreviews.map((img, idx) => (
              <div key={`img-${img.slice(-20)}-${idx}`} className="relative">
                <img
                  src={img}
                  alt={`Preview ${idx + 1}`}
                  className="size-14 rounded-md object-cover"
                />
                <Button
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -right-1.5 -top-1.5"
                  onClick={(e) => promptImages.removeImage(idx, e)}
                  aria-label="Remove image"
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={internalTextareaRef}
          data-slot="prompt-box-textarea"
          rows={1}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={promptImages.handlePaste}
          placeholder={
            isDisabled
              ? "Select or create a session..."
              : isLoading
                ? queueMode === "interrupt"
                  ? "Interrupt and send..."
                  : queueMode === "after-part"
                    ? "Steer the model into a direction..."
                    : "Queue a message..."
                : "Message..."
          }
          className="w-full resize-none border-0 bg-transparent px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:ring-0 focus-visible:outline-none min-h-10 disabled:cursor-not-allowed disabled:opacity-50"
          {...props}
        />

        <McpDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />
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

        <div className="flex min-w-0 items-center gap-1 px-1.5 pb-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Add"
                disabled={isDisabled}
                onClick={(e) => e.stopPropagation()}
              >
                <Plus />
                <span className="sr-only">Add</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              {capabilities?.images && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                >
                  <Paperclip className="size-4" />
                  Add file
                </DropdownMenuItem>
              )}
              {canManageMcp && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    setMcpDialogOpen(true);
                  }}
                >
                  <Wrench className="size-4" />
                  MCPs
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <ModelSelector />
          <AgentSelector />
          <VariantSelector />

          {shouldShowWorktreeSelector && selectedWorktreeOption && (
            <div className="flex min-w-0 items-center gap-1">
              {worktreeSelector.isPendingTargetSelection ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="!h-7 w-auto max-w-[220px] gap-1.5 border-none bg-transparent px-2 py-0 text-xs text-muted-foreground shadow-none hover:text-foreground focus:ring-0"
                    >
                      <GitBranch className="size-3.5 shrink-0" />
                      <span className="truncate">{selectedWorktreeOption.label}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-80 w-56">
                    {worktreeOptions.map((option) => (
                      <DropdownMenuItem
                        key={option.path}
                        onClick={() => {
                          if (option.path !== projectDir && !worktreeParents[option.path]) {
                            registerWorktree(option.path, projectDir!, option.branch ?? "unknown");
                          }
                          setActiveTargetDirectory(option.path);
                        }}
                        className="text-xs"
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-1.5">
                          <span className="truncate">{option.label}</span>
                        </span>
                        {option.path === selectedWorktreeDirectory && (
                          <Check className="ml-auto size-3 shrink-0" />
                        )}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setWorktreeDialogDir(projectDir)}
                      className="text-xs"
                    >
                      <Plus className="size-3.5" />
                      <span>New worktree</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : selectedWorktreeOption.isRoot ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title="Current branch of the root worktree."
                  className="!h-7 w-auto max-w-[220px] cursor-default gap-1.5 border-none bg-transparent px-2 py-0 text-xs text-muted-foreground shadow-none hover:bg-transparent hover:text-muted-foreground focus:ring-0"
                  onClick={(event) => event.stopPropagation()}
                >
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="truncate">{selectedWorktreeOption.label}</span>
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="!h-7 w-auto max-w-[220px] cursor-default gap-1.5 border-none bg-transparent px-2 py-0 text-xs text-muted-foreground shadow-none hover:bg-transparent hover:text-muted-foreground focus:ring-0"
                  onClick={(event) => event.stopPropagation()}
                >
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="truncate">{selectedWorktreeOption.label}</span>
                </Button>
              )}
            </div>
          )}

          {isLoading && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title={
                queueMode === "after-part"
                  ? "Steer: wait for current part to finish, then send (Ctrl/Cmd+D to toggle)"
                  : "Queue: wait for full response, then send (Ctrl/Cmd+D to toggle)"
              }
              className="!h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onQueueModeChange(queueMode === "queue" ? "after-part" : "queue");
              }}
            >
              <ListEnd className="size-3.5 shrink-0" />
              <span className="truncate max-w-[100px]">
                {queueMode === "after-part" ? "Steer" : "Queue"}
              </span>
            </Button>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {capabilities?.compact && contextPercent != null && contextPercent >= 0 && (
              <PromptContextStatus
                contextPercent={contextPercent}
                contextTokens={contextTokens}
                contextCost={contextCost}
                contextLimit={contextLimit}
                isLoading={isLoading}
                isDisabled={isDisabled}
                isCompacting={promptCompaction.isCompacting}
                isCompactingInProgress={promptCompaction.isCompactingInProgress}
                onCompact={promptCompaction.compact}
              />
            )}
            {shouldShowStopButton({
              isLoading,
              isCompactingInProgress: promptCompaction.isCompactingInProgress,
            }) ? (
              <Button
                type="button"
                size="icon-sm"
                variant="default"
                title="Stop"
                onClick={(e) => {
                  e.stopPropagation();
                  onStop?.();
                }}
              >
                <Square className="size-3.5 fill-current" />
                <span className="sr-only">Stop generating</span>
              </Button>
            ) : (
              <Button
                type="button"
                size="icon-sm"
                variant="default"
                title={isLoading ? (queueMode === "after-part" ? "Steer" : "Queue") : "Send"}
                disabled={isDisabled || !promptSubmit.hasValue}
                onClick={(e) => {
                  e.stopPropagation();
                  void promptSubmit.submit();
                }}
              >
                <ArrowUp />
                <span className="sr-only">
                  {isLoading
                    ? queueMode === "after-part"
                      ? "Steer"
                      : "Queue message"
                    : "Send message"}
                </span>
              </Button>
            )}
          </div>
        </div>
      </section>
    );
  },
);
PromptBox.displayName = "PromptBox";
