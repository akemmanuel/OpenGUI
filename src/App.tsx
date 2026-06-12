import { ExternalLink, GitMerge } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MergeDialog } from "@/components/MergeDialog";
import { QueueList } from "@/components/QueueList";
import { UpdateDialog } from "@/components/UpdateDialog";
import { NoProjectConnected, NoSessionSelected } from "@/components/EmptyChatStates";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { WorktreeCleanupDialog } from "@/components/WorktreeCleanupDialog";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import {
  HarnessProvider,
  type QueueMode,
  useActions,
  useConnectionState,
  useMessages,
  useModelState,
  useSessionState,
} from "@/hooks/use-agent-state";
import {
  isEditableTarget,
  isInDialog,
  isModKey,
  useKeyboardShortcuts,
  type KeyboardShortcut,
} from "@/hooks/use-keyboard-shortcuts";
import { useUpdateCheck } from "@/hooks/use-update-check";
import { useContextInfo } from "@/hooks/use-context-info";
import { POST_MERGE_DELAY_MS, STORAGE_KEYS } from "@/lib/constants";
import { getChatSurfaceState, hasProjectConnectedPrompt } from "@/lib/chat-surface";
import { parseProjectKey } from "@/hooks/agent-session-utils";
import { storageGet } from "@/lib/safe-storage";
import { OpenGuiClientProvider, useOpenGuiClient } from "@/protocol/provider";
import { getDesktopShellClient } from "@/runtime/clients";
import { DesktopShellProvider } from "@/shell/provider";
import { getDirectoryPlacementInfo, getWorktreePlacementMeta } from "@/lib/worktree-placement";
import {
  buildPRUrl,
  normalizeProjectPath,
  normalizeTerminalOutput,
  openExternalLink,
} from "@/lib/utils";
import { AppSidebar } from "./components/AppSidebar";
import { SettingsView } from "./components/ConnectionPanel";
import { MessageList } from "./components/MessageList";
import { PromptBox } from "./components/PromptBox";
import { SetupWizard } from "./components/SetupWizard";
import { TitleBar } from "./components/TitleBar";
import "./index.css";

function AppContent({
  detachedProject,
  suppressBootErrors,
}: {
  detachedProject?: string;
  suppressBootErrors?: boolean;
}) {
  const client = useOpenGuiClient();
  const lastEscapeAtRef = useRef(0);
  const [queueMode, setQueueMode] = useState<QueueMode>("queue");
  const [activeView, setActiveView] = useState<"chat" | "settings">("chat");
  const leftSidebar = useSidebar();
  const {
    sendPrompt,
    abortSession,
    getQueuedPrompts,
    removeFromQueue,
    reorderQueue,
    updateQueuedPrompt,
    sendQueuedNow,
    cycleVariant,
    revertVariant,
    startNewChat,
    setActiveTarget,
    removeProject,
    unregisterWorktree,
    revertToMessage,
    unrevert,
  } = useActions();
  const {
    sessions,
    activeSessionId: sessionActiveId,
    isBusy,
    isLoadingMessages,
    activeTargetDirectory,
  } = useSessionState();
  const { messages } = useMessages();
  const { providers, selectedModel, providerDefaults } = useModelState();
  const capabilities = useBackendCapabilities();
  const {
    bootState,
    bootError,
    bootLogs,
    lastError,
    worktreeParents,
    defaultChatDirectory,
    connections,
  } = useConnectionState();
  const [mergeInfo, setMergeInfo] = useState<{
    mainDir: string;
    branch: string;
    worktreePath: string;
  } | null>(null);
  const [activeWorktreeRemoteUrl, setActiveWorktreeRemoteUrl] = useState<string | null>(null);
  const normalizedBootLogs = useMemo(
    () => (bootLogs ? normalizeTerminalOutput(bootLogs) : null),
    [bootLogs],
  );
  const fixWithAiTimeoutRef = useRef<number | null>(null);

  // Find the active session object (for revert state)
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === sessionActiveId),
    [sessions, sessionActiveId],
  );

  const activeSessionDirectory =
    activeSession?._projectDir ?? activeSession?.directory ?? activeTargetDirectory ?? null;
  const connectedTargetDirectories = useMemo(
    () =>
      Object.entries(connections)
        .filter(([, status]) => status.state === "connected")
        .map(([projectKey]) => normalizeProjectPath(parseProjectKey(projectKey).directory)),
    [connections],
  );
  const connectedProjectDirectories = useMemo(
    () =>
      Object.entries(connections)
        .filter(([, status]) => status.state === "connected" && status.kind !== "chat-infra")
        .map(([projectKey]) => normalizeProjectPath(parseProjectKey(projectKey).directory)),
    [connections],
  );
  const connectedActiveTargetDirectory = (() => {
    if (!activeTargetDirectory) return null;
    const normalizedActiveTarget = normalizeProjectPath(activeTargetDirectory);
    if (connectedTargetDirectories.includes(normalizedActiveTarget)) return activeTargetDirectory;
    if (normalizedActiveTarget === normalizeProjectPath(defaultChatDirectory ?? "")) {
      return activeTargetDirectory;
    }
    return null;
  })();
  const chatSurfaceState = useMemo(
    () =>
      getChatSurfaceState({
        activeSessionId: sessionActiveId,
        activeTargetDirectory: connectedActiveTargetDirectory,
        defaultChatDirectory,
      }),
    [connectedActiveTargetDirectory, defaultChatDirectory, sessionActiveId],
  );
  const hasConnectedProjects = connectedProjectDirectories.length > 0;
  const showPromptBox = hasProjectConnectedPrompt(chatSurfaceState);
  const activeWorktreeInfo = useMemo(() => {
    const placement = getDirectoryPlacementInfo(activeSessionDirectory, worktreeParents);
    if (!placement?.isKnownWorktree) return null;
    return {
      mainDir: placement.rootDirectory,
      branch:
        getWorktreePlacementMeta(activeSessionDirectory, worktreeParents)?.branch ?? "unknown",
      worktreePath: placement.executionDirectory,
    };
  }, [activeSessionDirectory, worktreeParents]);

  // Find the last user message (for undo keybind), respecting revert state
  const revertToLastMessage = useCallback(() => {
    if (!capabilities?.revert) return;
    const revertMsgId = activeSession?.revert?.messageID;
    const userMessages = messages.filter((m) => m.info.role === "user");
    // Find the last user message before the current revert point (or the very last)
    const target = revertMsgId
      ? [...userMessages].reverse().find((m) => m.info.id < revertMsgId)
      : userMessages[userMessages.length - 1];
    if (target) void revertToMessage(target.info.id);
  }, [capabilities?.revert, activeSession, messages, revertToMessage]);

  useEffect(() => {
    return () => {
      if (fixWithAiTimeoutRef.current !== null) {
        window.clearTimeout(fixWithAiTimeoutRef.current);
        fixWithAiTimeoutRef.current = null;
      }
    };
  }, []);

  const keyboardShortcuts = useMemo<KeyboardShortcut[]>(
    () => [
      (e) => {
        if (!capabilities?.revert) return;
        if (e.key.toLowerCase() !== "z" || !isModKey(e)) return;
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) void unrevert();
        else revertToLastMessage();
        return true;
      },
      (e) => {
        if (!capabilities?.models) return;
        if (e.key.toLowerCase() !== "t" || !isModKey(e)) return;
        e.preventDefault();
        if (e.shiftKey) revertVariant();
        else cycleVariant();
        return true;
      },
      (e) => {
        if (e.key.toLowerCase() !== "k" || !isModKey(e)) return;
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("focus-sidebar-search"));
        return true;
      },
      (e) => {
        if (e.key !== "Escape" || e.repeat) return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (isInDialog(e.target)) return;

        const now = Date.now();
        const isDoubleEscape = now - lastEscapeAtRef.current <= 450;
        lastEscapeAtRef.current = now;
        if (!isDoubleEscape || !isBusy) return;

        e.preventDefault();
        void abortSession();
        return true;
      },
      (e) => {
        if (e.key !== "d" || !isModKey(e)) return;
        if (!isBusy || isInDialog(e.target)) return;
        e.preventDefault();
        setQueueMode((prev) => (prev === "queue" ? "after-part" : "queue"));
        return true;
      },
    ],
    [
      capabilities?.models,
      capabilities?.revert,
      revertToLastMessage,
      unrevert,
      cycleVariant,
      revertVariant,
      abortSession,
      isBusy,
    ],
  );
  useKeyboardShortcuts(keyboardShortcuts);

  // Ctrl+X then M (within 2s): open model selector
  useEffect(() => {
    let chordActive = false;
    let chordTimer: ReturnType<typeof setTimeout> | null = null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!capabilities?.models) return;
      if (e.key === "x" && (e.ctrlKey || e.metaKey)) {
        // Let native cut work when text is selected
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        e.preventDefault();
        chordActive = true;
        if (chordTimer) clearTimeout(chordTimer);
        chordTimer = setTimeout(() => {
          chordActive = false;
          chordTimer = null;
        }, 2000);
      } else if (chordActive && e.key.toLowerCase() === "m") {
        e.preventDefault();
        chordActive = false;
        if (chordTimer) {
          clearTimeout(chordTimer);
          chordTimer = null;
        }
        window.dispatchEvent(new CustomEvent("open-model-selector"));
      } else if (chordActive) {
        chordActive = false;
        if (chordTimer) {
          clearTimeout(chordTimer);
          chordTimer = null;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (chordTimer) clearTimeout(chordTimer);
    };
  }, [capabilities?.models]);

  const activeSessionId = sessionActiveId;
  const queuedPrompts = activeSessionId ? getQueuedPrompts(activeSessionId) : [];

  const isBooting = bootState === "checking-server" || bootState === "starting-server";

  useEffect(() => {
    if (suppressBootErrors) return;
    if (isBooting) return;
    const message = bootState === "error" ? bootError : lastError;
    if (!message) return;
    toast.error(message, {
      description: bootState === "error" && normalizedBootLogs ? normalizedBootLogs : undefined,
      duration: 8000,
    });
  }, [bootState, bootError, isBooting, lastError, normalizedBootLogs, suppressBootErrors]);

  useEffect(() => {
    let cancelled = false;
    const mainDir = activeWorktreeInfo?.mainDir;
    if (!mainDir) {
      setActiveWorktreeRemoteUrl(null);
      return;
    }
    void client.git
      .getRemoteUrl(mainDir)
      .then((remoteUrl) => {
        if (!cancelled) setActiveWorktreeRemoteUrl(remoteUrl || null);
      })
      .catch(() => {
        if (!cancelled) setActiveWorktreeRemoteUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorktreeInfo?.mainDir, client]);

  const contextInfo = useContextInfo({
    activeSessionId,
    messages,
    providers,
    selectedModel,
    providerDefaults,
  });

  const contextPercent = contextInfo.percent;

  // Check for app updates on startup
  const updateCheck = useUpdateCheck();

  return (
    <>
      <AppSidebar
        detachedProject={detachedProject}
        onOpenSettings={() => setActiveView("settings")}
        onOpenChat={() => setActiveView("chat")}
        settingsActive={activeView === "settings"}
      />
      <SidebarInset className="overflow-hidden">
        <div className="flex flex-col h-full">
          {/* Title bar spans full width */}
          <TitleBar onToggleLeftSidebar={detachedProject ? undefined : leftSidebar.toggleSidebar} />

          <div className="flex-1 flex flex-col min-w-0 min-h-0 select-none">
            {/* Startup banner */}
            {isBooting && (
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border text-sm text-muted-foreground bg-muted/30">
                <Spinner className="size-4 shrink-0" />
                <span>
                  {bootState === "checking-server"
                    ? "Checking local server..."
                    : "Starting local server..."}
                </span>
              </div>
            )}

            {activeView === "settings" ? (
              <SettingsView onBack={() => setActiveView("chat")} />
            ) : (
              <>
                {/* Chat area */}
                {activeWorktreeInfo && (
                  <div className="border-b border-border bg-muted/20">
                    <div className="mx-auto flex max-w-2xl items-center justify-end gap-2 px-4 py-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setMergeInfo(activeWorktreeInfo)}
                      >
                        <GitMerge className="size-4" />
                        Merge
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!activeWorktreeRemoteUrl}
                        onClick={() => {
                          if (!activeWorktreeRemoteUrl) return;
                          const url = buildPRUrl(
                            activeWorktreeRemoteUrl,
                            activeWorktreeInfo.branch,
                          );
                          if (url) openExternalLink(url);
                        }}
                      >
                        <ExternalLink className="size-4" />
                        Create PR
                      </Button>
                    </div>
                  </div>
                )}
                {chatSurfaceState.kind === "no-project" ||
                chatSurfaceState.kind === "default-chat" ? (
                  hasConnectedProjects ? (
                    <NoSessionSelected />
                  ) : (
                    <NoProjectConnected
                      canStartChat={chatSurfaceState.kind === "default-chat"}
                      onStartChat={() => {
                        void startNewChat();
                      }}
                    />
                  )
                ) : (
                  <MessageList detachedProject={detachedProject} />
                )}

                {/* Queue list + Prompt input */}
                {showPromptBox && (
                  <div className="shrink-0 px-4 pb-3">
                    <div className="max-w-2xl mx-auto">
                      {queuedPrompts.length > 0 && (
                        <div className="mb-1.5">
                          <QueueList
                            items={queuedPrompts}
                            onRemove={(id) => {
                              if (!activeSessionId) return;
                              removeFromQueue(activeSessionId, id);
                            }}
                            onMoveUp={(index) => {
                              if (!activeSessionId) return;
                              reorderQueue(activeSessionId, index, index - 1);
                            }}
                            onMoveDown={(index) => {
                              if (!activeSessionId) return;
                              reorderQueue(activeSessionId, index, index + 1);
                            }}
                            onMoveToTop={(index) => {
                              if (!activeSessionId) return;
                              reorderQueue(activeSessionId, index, 0);
                            }}
                            onMoveToBottom={(index) => {
                              if (!activeSessionId) return;
                              reorderQueue(activeSessionId, index, queuedPrompts.length - 1);
                            }}
                            onEdit={(id, newText) => {
                              if (!activeSessionId) return;
                              updateQueuedPrompt(activeSessionId, id, newText);
                            }}
                            onSendNow={(id) => {
                              if (!activeSessionId) return;
                              void sendQueuedNow(activeSessionId, id);
                            }}
                            onReorder={(fromIndex, toIndex) => {
                              if (!activeSessionId) return;
                              reorderQueue(activeSessionId, fromIndex, toIndex);
                            }}
                          />
                        </div>
                      )}
                      <PromptBox
                        autoFocus
                        disabled={isBooting || isLoadingMessages}
                        isLoading={isBusy}
                        contextPercent={contextPercent}
                        contextTokens={contextInfo.tokens}
                        contextCost={contextInfo.cost}
                        contextLimit={contextInfo.contextLimit}
                        queueMode={queueMode}
                        onQueueModeChange={setQueueMode}
                        onSubmit={(message, mode) => {
                          return sendPrompt(message, mode);
                        }}
                        onStop={() => abortSession()}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </SidebarInset>
      <MergeDialog
        open={mergeInfo !== null}
        onOpenChange={(open) => {
          if (!open) setMergeInfo(null);
        }}
        mainDirectory={mergeInfo?.mainDir ?? ""}
        branch={mergeInfo?.branch ?? ""}
        onMerged={async (deleteWt) => {
          if (!mergeInfo) return;
          if (deleteWt) {
            unregisterWorktree(mergeInfo.worktreePath);
            await removeProject(mergeInfo.worktreePath);
            await client.git.removeWorktree(mergeInfo.mainDir, mergeInfo.worktreePath);
          }
          if (activeWorktreeInfo?.mainDir === mergeInfo.mainDir) {
            try {
              const remoteUrl = await client.git.getRemoteUrl(mergeInfo.mainDir);
              setActiveWorktreeRemoteUrl(remoteUrl || null);
            } catch {
              setActiveWorktreeRemoteUrl(null);
            }
          }
        }}
        onFixWithAI={(conflicts) => {
          if (!mergeInfo) return;
          setActiveTarget(mergeInfo.mainDir);
          if (fixWithAiTimeoutRef.current !== null) {
            window.clearTimeout(fixWithAiTimeoutRef.current);
          }
          fixWithAiTimeoutRef.current = window.setTimeout(() => {
            const fileList = conflicts.map((f) => `- ${f}`).join("\n");
            void sendPrompt(
              `There are git merge conflicts from merging branch "${mergeInfo.branch}" into the current branch.\n\nThe following files have unresolved conflicts:\n${fileList}\n\nPlease resolve all merge conflicts in these files. Remove all conflict markers (<<<<<<, ======, >>>>>>) and produce the correct merged code. After resolving all conflicts, stage the resolved files with \`git add\` for each file.`,
            );
            fixWithAiTimeoutRef.current = null;
          }, POST_MERGE_DELAY_MS);
        }}
      />
      <UpdateDialog update={updateCheck} />
      <WorktreeCleanupDialog />
    </>
  );
}

export function App() {
  const detachedProject = getDesktopShellClient().detachedProjects.getCurrent() ?? undefined;

  const [showWizard, setShowWizard] = useState(
    () => storageGet(STORAGE_KEYS.SETUP_COMPLETE) !== "true",
  );

  return (
    <DesktopShellProvider>
      <OpenGuiClientProvider>
        <HarnessProvider detachedProject={detachedProject}>
          <SidebarProvider className="!h-dvh capacitor-safe-area">
            <AppContent detachedProject={detachedProject} suppressBootErrors={showWizard} />
            {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
            <Toaster richColors closeButton />
          </SidebarProvider>
        </HarnessProvider>
      </OpenGuiClientProvider>
    </DesktopShellProvider>
  );
}
