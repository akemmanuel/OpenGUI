import type { Command } from "@opencode-ai/sdk/v2/client";
import {
  ArrowUp,
  Check,
  GitBranch,
  ListEnd,
  Loader2,
  Paperclip,
  Plus,
  Square,
  Wrench,
  X,
  Minimize2,
} from "lucide-react";
import * as React from "react";
import { AgentSelector } from "@/components/AgentSelector";
import { FileMentionPopover } from "@/components/FileMentionPopover";
import { McpDialog } from "@/components/McpDialog";
import { ModelSelector } from "@/components/ModelSelector";
import { SlashCommandPopover, useFilteredCommands } from "@/components/SlashCommandPopover";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VariantSelector } from "@/components/VariantSelector";
import { WorktreeDialog } from "@/components/WorktreeDialog";
import { WorktreeSetupDialog } from "@/components/WorktreeSetupDialog";
import { useOpenGuiClient } from "@/protocol/provider";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import { useListKeyboardNavigation } from "@/hooks/use-list-keyboard-navigation";
import { usePromptHistoryNavigation } from "@/hooks/use-prompt-history-navigation";
import {
  type QueueMode,
  useActions,
  useConnectionState,
  useMessages,
  useModelState,
  useSessionState,
} from "@/hooks/use-agent-state";
import { MAX_TEXTAREA_HEIGHT_PX } from "@/lib/constants";
import { compressImage } from "@/lib/image-compression";
import {
  getSessionDraftImages,
  getSessionDraftKey,
  persistSessionDraftImages,
} from "@/lib/session-drafts";
import { shouldShowStopButton } from "@/lib/session-controls";
import {
  compareWorktreesByLabel,
  getWorktreeLabel,
  getWorkspaceRootProjectDirectory,
  isRootWorktreePath,
} from "@/lib/worktree-placement";
import { cn, getPrimaryAgents, normalizeProjectPath } from "@/lib/utils";
import type { GitWorktree } from "@/types/electron";

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
    const [value, setValue] = React.useState("");
    const [imagePreviews, setImagePreviews] = React.useState<string[]>([]);
    const [isDragging, setIsDragging] = React.useState(false);
    const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false);
    const [worktreeDialogDir, setWorktreeDialogDir] = React.useState<string | null>(null);
    const [setupWorktreePath, setSetupWorktreePath] = React.useState<string | null>(null);
    const [discoveredWorktrees, setDiscoveredWorktrees] = React.useState<GitWorktree[]>([]);
    const [worktreeDiscoveryState, setWorktreeDiscoveryState] = React.useState<
      "hidden" | "ready" | "error"
    >("hidden");

    const [isCompacting, setIsCompacting] = React.useState(false);

    const isDisabled = Boolean(props.disabled);

    const {
      setAgent,
      sendCommand,
      summarizeSession,
      findFiles,
      setDraftDirectory,
      setSessionDraft,
      clearSessionDraft,
      registerWorktree,
      connectToProject,
    } = useActions();
    const { commands, agents, selectedAgent } = useModelState();
    const capabilities = useBackendCapabilities();
    const canManageMcp = Boolean(capabilities?.mcp);
    const { sessions, activeSessionId, draftSessionDirectory, sessionDrafts } = useSessionState();
    const { messages } = useMessages();

    // Detect if compaction is in-progress: session is busy AND message immediately
    // before current running message is summary marker.
    const isCompactingInProgress = React.useMemo(() => {
      if (!isLoading || messages.length < 2) return false;
      const lastMsg = messages.at(-1);
      const prevMsg = messages.at(-2);
      if (!lastMsg || !prevMsg) return false;
      return (
        lastMsg.info.role === "user" &&
        prevMsg.info.role === "assistant" &&
        "summary" in prevMsg.info &&
        prevMsg.info.summary === true
      );
    }, [isLoading, messages]);

    const { activeWorkspaceId, worktreeParents, isLocalWorkspace } = useConnectionState();
    const worktreeParentsRef = React.useRef(worktreeParents);
    const registerWorktreeRef = React.useRef(registerWorktree);
    const syncingDraftRef = React.useRef(false);
    const syncingImageDraftRef = React.useRef(false);
    const sessionDraftsRef = React.useRef(sessionDrafts);
    const sessionDraftImagesRef = React.useRef(getSessionDraftImages());
    const activeSession = React.useMemo(
      () => sessions.find((session) => session.id === activeSessionId) ?? null,
      [sessions, activeSessionId],
    );
    const selectedWorktreeDirectory = React.useMemo(
      () =>
        normalizeProjectPath(
          activeSession?._projectDir ?? activeSession?.directory ?? draftSessionDirectory ?? "",
        ) || null,
      [activeSession, draftSessionDirectory],
    );
    const projectDir = React.useMemo(() => {
      if (!selectedWorktreeDirectory) return null;
      return getWorkspaceRootProjectDirectory(selectedWorktreeDirectory, worktreeParents);
    }, [selectedWorktreeDirectory, worktreeParents]);
    const isDraftWorktreeSelection = !activeSessionId && Boolean(draftSessionDirectory);

    // Slash command popover state
    const [showSlash, setShowSlash] = React.useState(false);
    const [slashFilter, setSlashFilter] = React.useState("");
    const [slashActiveIndex, setSlashActiveIndex] = React.useState(0);
    const filteredSlashCommands = useFilteredCommands(commands, slashFilter);

    // @file mention popover state
    const [showFileMention, setShowFileMention] = React.useState(false);
    const [fileMentionResults, setFileMentionResults] = React.useState<string[]>([]);
    const [fileMentionActiveIndex, setFileMentionActiveIndex] = React.useState(0);
    const [fileMentionLoading, setFileMentionLoading] = React.useState(false);
    const [fileMentionEmptyMessage, setFileMentionEmptyMessage] = React.useState<string | null>(
      null,
    );
    // Position of the "@" character that triggered the popover
    const fileMentionAnchorRef = React.useRef(-1);
    const fileMentionDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Clear pending debounce timeout on unmount
    React.useEffect(() => {
      return () => {
        if (fileMentionDebounceRef.current !== null) {
          clearTimeout(fileMentionDebounceRef.current);
          fileMentionDebounceRef.current = null;
        }
      };
    }, []);

    const primaryAgents = React.useMemo(
      () => getPrimaryAgents(agents).map((a) => a.name),
      [agents],
    );

    const currentDraftKey = React.useMemo(
      () =>
        getSessionDraftKey({
          sessionId: activeSessionId,
          directory: activeSessionId ? null : draftSessionDirectory,
          workspaceId: activeWorkspaceId,
        }),
      [activeSessionId, draftSessionDirectory, activeWorkspaceId],
    );

    const { handleHistoryKeyDown, noteManualInput, resetHistory } = usePromptHistoryNavigation({
      messages,
      value,
      setValue,
      imageCount: imagePreviews.length,
      draftKey: currentDraftKey,
      textareaRef: internalTextareaRef,
    });

    React.useEffect(() => {
      sessionDraftsRef.current = sessionDrafts;
    }, [sessionDrafts]);

    React.useEffect(() => {
      worktreeParentsRef.current = worktreeParents;
    }, [worktreeParents]);

    React.useEffect(() => {
      registerWorktreeRef.current = registerWorktree;
    }, [registerWorktree]);

    const client = useOpenGuiClient();

    React.useEffect(() => {
      if (!projectDir || !isLocalWorkspace) {
        setDiscoveredWorktrees([]);
        setWorktreeDiscoveryState("hidden");
        return;
      }

      let cancelled = false;

      void Promise.all([client.git.isRepo(projectDir), client.git.listWorktrees(projectDir)])
        .then(([isRepo, worktrees]) => {
          if (cancelled) return;
          if (!isRepo) {
            setDiscoveredWorktrees([]);
            setWorktreeDiscoveryState("hidden");
            return;
          }
          const normalizedWorktrees = worktrees.map((worktree) => ({
            ...worktree,
            path: normalizeProjectPath(worktree.path),
          }));
          for (const worktree of normalizedWorktrees) {
            if (worktree.path === projectDir || worktreeParentsRef.current[worktree.path]) continue;
            registerWorktreeRef.current(worktree.path, projectDir, worktree.branch ?? "unknown");
          }
          setDiscoveredWorktrees(normalizedWorktrees);
          setWorktreeDiscoveryState("ready");
        })
        .catch(() => {
          if (cancelled) return;
          setDiscoveredWorktrees([]);
          setWorktreeDiscoveryState("error");
        });

      return () => {
        cancelled = true;
      };
    }, [client, projectDir, isLocalWorkspace]);

    const worktreeOptions = React.useMemo(() => {
      if (worktreeDiscoveryState !== "ready" || !projectDir) return [];
      const byPath = new Map<string, GitWorktree>();
      for (const worktree of discoveredWorktrees) {
        const normalizedPath = normalizeProjectPath(worktree.path);
        if (!normalizedPath) continue;
        byPath.set(normalizedPath, {
          ...worktree,
          path: normalizedPath,
        });
      }
      if (selectedWorktreeDirectory && !byPath.has(selectedWorktreeDirectory)) {
        byPath.set(selectedWorktreeDirectory, {
          path: selectedWorktreeDirectory,
          branch: worktreeParents[selectedWorktreeDirectory]?.branch,
        });
      }
      if (!Array.from(byPath.keys()).some((path) => isRootWorktreePath(path, projectDir))) {
        byPath.set(projectDir, {
          path: projectDir,
          branch: worktreeParents[projectDir]?.branch,
        });
      }
      return Array.from(byPath.values())
        .sort((left, right) => {
          const leftIsRoot = isRootWorktreePath(left.path, projectDir);
          const rightIsRoot = isRootWorktreePath(right.path, projectDir);
          if (leftIsRoot !== rightIsRoot) return leftIsRoot ? -1 : 1;
          return compareWorktreesByLabel(left, right, projectDir);
        })
        .map((worktree) => ({
          ...worktree,
          isRoot: isRootWorktreePath(worktree.path, projectDir),
          label: getWorktreeLabel({ ...worktree, rootDirectory: projectDir }),
        }));
    }, [
      discoveredWorktrees,
      projectDir,
      selectedWorktreeDirectory,
      worktreeDiscoveryState,
      worktreeParents,
    ]);

    const selectedWorktreeOption = React.useMemo(
      () => worktreeOptions.find((option) => option.path === selectedWorktreeDirectory) ?? null,
      [worktreeOptions, selectedWorktreeDirectory],
    );

    const shouldShowWorktreeSelector =
      Boolean(projectDir) && isLocalWorkspace && worktreeDiscoveryState === "ready";

    React.useEffect(() => {
      syncingDraftRef.current = true;
      syncingImageDraftRef.current = true;
      setValue(currentDraftKey ? (sessionDraftsRef.current[currentDraftKey] ?? "") : "");
      setImagePreviews(
        currentDraftKey ? [...(sessionDraftImagesRef.current[currentDraftKey] ?? [])] : [],
      );
      setShowSlash(false);
      setShowFileMention(false);
      setFileMentionResults([]);
      setFileMentionEmptyMessage(null);
      fileMentionAnchorRef.current = -1;
    }, [currentDraftKey]);

    React.useEffect(() => {
      if (!currentDraftKey) return;
      if (syncingDraftRef.current) {
        syncingDraftRef.current = false;
        return;
      }
      const existingDraft = sessionDrafts[currentDraftKey] ?? "";
      if (value.trim().length === 0) {
        if (existingDraft) clearSessionDraft(currentDraftKey);
        return;
      }
      if (existingDraft !== value) {
        setSessionDraft(currentDraftKey, value);
      }
    }, [clearSessionDraft, currentDraftKey, sessionDrafts, setSessionDraft, value]);

    React.useEffect(() => {
      if (!currentDraftKey) return;
      if (syncingImageDraftRef.current) {
        syncingImageDraftRef.current = false;
        return;
      }
      const existingImages = sessionDraftImagesRef.current[currentDraftKey] ?? [];
      const unchanged =
        existingImages.length === imagePreviews.length &&
        existingImages.every((image, index) => image === imagePreviews[index]);
      if (unchanged) return;
      const next = { ...sessionDraftImagesRef.current };
      if (imagePreviews.length === 0) {
        delete next[currentDraftKey];
      } else {
        next[currentDraftKey] = [...imagePreviews];
      }
      sessionDraftImagesRef.current = next;
      persistSessionDraftImages(next);
    }, [currentDraftKey, imagePreviews]);

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

    const appendImages = React.useCallback(
      async (files: FileList | File[]) => {
        if (isDisabled) return;
        const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
        if (imageFiles.length === 0) return;
        const results = await Promise.all(imageFiles.map(compressImage));
        setImagePreviews((prev) => [...prev, ...results]);
      },
      [isDisabled],
    );

    // Helper to determine which project directory to search
    const getActiveDirectory = React.useCallback((): string | null => {
      if (activeSessionId) {
        const activeSession = sessions.find((s) => s.id === activeSessionId);
        return activeSession?._projectDir ?? activeSession?.directory ?? null;
      }
      return draftSessionDirectory;
    }, [activeSessionId, sessions, draftSessionDirectory]);

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setValue(newValue);
      if (props.onChange) props.onChange(e);

      noteManualInput();

      // Detect slash command input: "/" at start with no spaces
      const slashMatch = newValue.match(/^\/(\S*)$/);
      if (capabilities?.commands && slashMatch) {
        setSlashFilter(slashMatch[1] ?? "");
        setSlashActiveIndex(0);
        setShowSlash(true);
      } else {
        setShowSlash(false);
      }

      // Detect @file mention: scan backward from cursor for "@"
      const cursorPos = e.target.selectionStart;
      const textBeforeCursor = newValue.slice(0, cursorPos);

      // Find the last "@" that is at start or preceded by whitespace
      let atIndex = -1;
      for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
        const ch = textBeforeCursor[i];
        // If we hit whitespace before finding @, stop (no active mention)
        if (ch === " " || ch === "\n" || ch === "\t") break;
        if (ch === "@") {
          // Valid if at start or preceded by whitespace
          if (i === 0 || /\s/.test(textBeforeCursor[i - 1] ?? "")) {
            atIndex = i;
          }
          break;
        }
      }

      if (atIndex >= 0) {
        const query = textBeforeCursor.slice(atIndex + 1);
        fileMentionAnchorRef.current = atIndex;
        setFileMentionActiveIndex(0);
        setShowFileMention(true);

        // Debounce the API call
        if (fileMentionDebounceRef.current) {
          clearTimeout(fileMentionDebounceRef.current);
        }
        if (query.trim().length === 0) {
          setFileMentionLoading(false);
          setFileMentionResults([]);
          setFileMentionEmptyMessage("Type to search files");
          return;
        }
        setFileMentionEmptyMessage(null);
        setFileMentionLoading(true);
        fileMentionDebounceRef.current = setTimeout(async () => {
          try {
            const activeDir = getActiveDirectory();
            const results = await findFiles(activeDir, query);
            setFileMentionResults(results.slice(0, 20));
            setFileMentionEmptyMessage(results.length === 0 ? "No matching files" : null);
          } catch {
            setFileMentionResults([]);
            setFileMentionEmptyMessage("File search failed");
          } finally {
            setFileMentionLoading(false);
          }
        }, 150);
      } else {
        setShowFileMention(false);
        setFileMentionResults([]);
        setFileMentionEmptyMessage(null);
        fileMentionAnchorRef.current = -1;
        if (fileMentionDebounceRef.current) {
          clearTimeout(fileMentionDebounceRef.current);
          fileMentionDebounceRef.current = null;
        }
      }
    };

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      if (isDisabled) return;
      if (event.target.files) {
        void appendImages(event.target.files);
      }
      event.target.value = "";
    };

    const handleRemoveImage = (index: number, e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setImagePreviews((prev) => prev.filter((_, i) => i !== index));
    };

    const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isDisabled) return;
      setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isDisabled) return;
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        void appendImages(e.dataTransfer.files);
      }
    };

    const handlePaste = (e: React.ClipboardEvent) => {
      if (isDisabled) return;
      const items = Array.from(e.clipboardData.items);
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        void appendImages(imageFiles);
      }
    };

    const hasValue = value.trim().length > 0 || imagePreviews.length > 0;

    const handleFileMentionSelect = React.useCallback(
      (filePath: string) => {
        const anchor = fileMentionAnchorRef.current;
        if (anchor < 0) return;
        const textarea = internalTextareaRef.current;
        const cursorPos = textarea?.selectionStart ?? value.length;

        // Replace @query with @filepath + trailing space
        const before = value.slice(0, anchor);
        const after = value.slice(cursorPos);
        const insertion = `@${filePath} `;
        const newValue = before + insertion + after;

        setValue(newValue);
        setShowFileMention(false);
        setFileMentionResults([]);
        setFileMentionEmptyMessage(null);
        fileMentionAnchorRef.current = -1;

        // Move cursor to after the inserted mention
        const newCursorPos = before.length + insertion.length;
        requestAnimationFrame(() => {
          textarea?.focus();
          textarea?.setSelectionRange(newCursorPos, newCursorPos);
        });
      },
      [value],
    );

    const handleSlashSelect = React.useCallback((cmd: Command) => {
      // Prefill the input with the command name + space for arguments
      const text = `/${cmd.name} `;
      setValue(text);
      setShowSlash(false);
      internalTextareaRef.current?.focus();
    }, []);

    const dismissFileMention = React.useCallback(() => {
      setShowFileMention(false);
      setFileMentionResults([]);
      fileMentionAnchorRef.current = -1;
    }, []);

    const handleFileMentionKeyboard = useListKeyboardNavigation({
      open: showFileMention,
      items: fileMentionResults,
      activeIndex: fileMentionActiveIndex,
      setActiveIndex: setFileMentionActiveIndex,
      onSelect: handleFileMentionSelect,
      onDismiss: dismissFileMention,
    });

    const handleSlashKeyboard = useListKeyboardNavigation({
      open: Boolean(capabilities?.commands && showSlash),
      items: filteredSlashCommands,
      activeIndex: slashActiveIndex,
      setActiveIndex: setSlashActiveIndex,
      onSelect: handleSlashSelect,
      onDismiss: () => setShowSlash(false),
    });

    const submittingRef = React.useRef(false);

    const handleSubmit = async () => {
      if (submittingRef.current) return;
      if (isDisabled) return;
      if (!hasValue) return;
      submittingRef.current = true;

      // Intercept slash commands
      if (capabilities?.commands && value.startsWith("/")) {
        const trimmed = value.trim();
        const spaceIndex = trimmed.indexOf(" ");
        const commandName = spaceIndex > 0 ? trimmed.slice(1, spaceIndex) : trimmed.slice(1);
        const args = spaceIndex > 0 ? trimmed.slice(spaceIndex + 1) : "";

        const cmd = commands.find((c) => c.name === commandName);
        if (cmd) {
          try {
            if (currentDraftKey) clearSessionDraft(currentDraftKey);
            setValue("");
            setImagePreviews([]);
            setShowSlash(false);
            resetHistory();
            await sendCommand(commandName, args);
          } finally {
            submittingRef.current = false;
          }
          return;
        }
      }

      try {
        const images = imagePreviews.length > 0 ? imagePreviews : undefined;
        await onSubmit?.(value, images, isLoading ? queueMode : undefined);
        if (currentDraftKey) {
          clearSessionDraft(currentDraftKey);
          const next = { ...sessionDraftImagesRef.current };
          delete next[currentDraftKey];
          sessionDraftImagesRef.current = next;
          persistSessionDraftImages(next);
        }
        setValue("");
        setImagePreviews([]);
        resetHistory();
      } finally {
        submittingRef.current = false;
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleFileMentionKeyboard(e)) return;
      if (handleSlashKeyboard(e)) return;

      if (handleHistoryKeyDown(e)) return;

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isDisabled) return;
        void handleSubmit();
      }
      if (capabilities?.agents && e.key === "Tab" && primaryAgents.length > 1) {
        e.preventDefault();
        const effective = selectedAgent ?? "build";
        const currentIndex = primaryAgents.indexOf(effective);
        const idx = currentIndex === -1 ? 0 : currentIndex;
        const next = e.shiftKey
          ? (idx - 1 + primaryAgents.length) % primaryAgents.length
          : (idx + 1) % primaryAgents.length;
        const nextAgent = primaryAgents[next];
        setAgent(nextAgent === "build" ? null : (nextAgent ?? null));
      }
    };

    return (
      <section
        ref={containerRef}
        aria-label="Message input"
        data-slot="prompt-box"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex flex-col bg-background px-2 pt-2 shadow-xs transition-colors cursor-text border rounded-xl",
          isDragging && "border-ring ring-ring/50 ring-[3px]",
          className,
        )}
        onClick={() => internalTextareaRef.current?.focus()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) {
            internalTextareaRef.current?.focus();
          }
        }}
      >
        {showFileMention &&
          (fileMentionResults.length > 0 || fileMentionLoading || fileMentionEmptyMessage) && (
            <div className="relative">
              <FileMentionPopover
                files={fileMentionResults}
                activeIndex={fileMentionActiveIndex}
                onSelect={handleFileMentionSelect}
                onHover={setFileMentionActiveIndex}
                loading={fileMentionLoading}
                emptyMessage={fileMentionEmptyMessage}
              />
            </div>
          )}

        {capabilities?.commands && showSlash && filteredSlashCommands.length > 0 && (
          <div className="relative">
            <SlashCommandPopover
              commands={commands}
              filter={slashFilter}
              activeIndex={slashActiveIndex}
              onSelect={handleSlashSelect}
              onHover={setSlashActiveIndex}
            />
          </div>
        )}

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
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
                  onClick={(e) => handleRemoveImage(idx, e)}
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
          onPaste={handlePaste}
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
            setDraftDirectory(worktreePath);
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
              {isDraftWorktreeSelection ? (
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
                          setDraftDirectory(option.path);
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
              <Popover>
                <PopoverTrigger asChild>
                  <div className="flex">
                    <button
                      type="button"
                      className={cn(
                        "flex items-center gap-1 text-[11px] tabular-nums select-none cursor-pointer rounded-md px-1.5 py-0.5 hover:bg-accent transition-colors",
                        (isCompacting || isCompactingInProgress) && "animate-pulse",
                        contextPercent >= 90
                          ? "text-destructive hover:text-destructive"
                          : contextPercent >= 70
                            ? "text-amber-500 hover:text-amber-600"
                            : "text-muted-foreground/70 hover:text-foreground",
                      )}
                    >
                      {isCompacting || isCompactingInProgress ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 20 20"
                          className="shrink-0 -rotate-90"
                          aria-hidden="true"
                        >
                          <circle
                            cx="10"
                            cy="10"
                            r="8"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            opacity="0.2"
                          />
                          <circle
                            cx="10"
                            cy="10"
                            r="8"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeDasharray={`${Math.max(contextPercent, 0) * 0.5027} 50.27`}
                          />
                        </svg>
                      )}
                      {isCompacting || isCompactingInProgress
                        ? "Compacting"
                        : contextPercent === 0
                          ? "0%"
                          : contextPercent < 1
                            ? "<1%"
                            : `${contextPercent}%`}
                    </button>
                  </div>
                </PopoverTrigger>
                <PopoverContent side="top" align="center" className="w-48 p-3 text-xs z-50">
                  <div className="font-semibold mb-2">Context window</div>
                  {contextTokens != null && contextLimit != null ? (
                    <div className="text-muted-foreground mb-1">
                      {contextTokens.toLocaleString()} / {contextLimit.toLocaleString()} tokens
                    </div>
                  ) : contextTokens != null ? (
                    <div className="text-muted-foreground mb-1">
                      {contextTokens.toLocaleString()} tokens
                    </div>
                  ) : null}
                  {contextCost != null && contextCost > 0 && (
                    <div className="text-muted-foreground mb-2">
                      Cost: ${contextCost < 0.01 ? contextCost.toFixed(6) : contextCost.toFixed(4)}
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full mt-2 gap-2"
                    disabled={isLoading || isDisabled || isCompactingInProgress}
                    onClick={async () => {
                      setIsCompacting(true);
                      try {
                        await summarizeSession();
                      } finally {
                        setIsCompacting(false);
                      }
                    }}
                  >
                    <Minimize2 className="size-3" />
                    Compact
                  </Button>
                </PopoverContent>
              </Popover>
            )}
            {shouldShowStopButton({ isLoading, isCompactingInProgress }) ? (
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
                disabled={isDisabled || !hasValue}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleSubmit();
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
