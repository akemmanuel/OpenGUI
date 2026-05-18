import { AlertCircle, ChevronDown, ChevronUp, ExternalLink, GitMerge, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MergeDialog } from "@/components/MergeDialog";
import { QueueList } from "@/components/QueueList";
import { UpdateDialog } from "@/components/UpdateDialog";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { WorktreeCleanupDialog } from "@/components/WorktreeCleanupDialog";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import {
  AgentBackendProvider,
  type QueueMode,
  resolveServerDefaultModel,
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
import { POST_MERGE_DELAY_MS, STORAGE_KEYS } from "@/lib/constants";
import { storageGet } from "@/lib/safe-storage";
import { OpenGuiClientProvider } from "@/protocol/provider";
import {
  buildPRUrl,
  computeTokenTotal,
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

type ContextInfo = {
  percent: number | null;
  tokens: number | null;
  cost: number | null;
  contextLimit: number | null;
};

function useContextInfo({
  activeSessionId,
  messages,
  providers,
  selectedModel,
  providerDefaults,
}: {
  activeSessionId: string | null;
  messages: ReturnType<typeof useMessages>["messages"];
  providers: ReturnType<typeof useModelState>["providers"];
  selectedModel: ReturnType<typeof useModelState>["selectedModel"];
  providerDefaults: ReturnType<typeof useModelState>["providerDefaults"];
}): ContextInfo {
  return useMemo(() => {
    const none: ContextInfo = {
      percent: null,
      tokens: null,
      cost: null,
      contextLimit: null,
    };
    if (!activeSessionId) return none;

    type TokenSnapshot = {
      providerID: string;
      modelID: string;
      total: number;
      cost: number | null;
    };
    let last: TokenSnapshot | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]?.info;
      if (msg?.role === "assistant" && "providerID" in msg && "modelID" in msg) {
        const t = "tokens" in msg ? msg.tokens : undefined;
        let total = t ? computeTokenTotal(t) : 0;
        const msgCost = "cost" in msg && typeof msg.cost === "number" ? msg.cost : null;

        if (total <= 0) {
          const parts = messages[i]?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.type === "step-finish" && "tokens" in part) {
                total += computeTokenTotal(part.tokens);
              }
            }
          }
        }

        if (total > 0) {
          last = {
            providerID: msg.providerID,
            modelID: msg.modelID,
            total,
            cost: msgCost,
          };
          break;
        }
      }
    }

    let provID = last?.providerID ?? selectedModel?.providerID;
    let modID = last?.modelID ?? selectedModel?.modelID;
    if (!provID || !modID) {
      const fallback = resolveServerDefaultModel(providers, providerDefaults);
      if (fallback) {
        provID = fallback.providerID;
        modID = fallback.modelID;
      }
    }
    if (!provID || !modID) return none;

    const provider = providers.find((p) => p.id === provID);
    if (!provider) return none;
    const model = provider.models[modID];
    if (!model?.limit?.context) return none;
    const contextLimit = model.limit.context;

    if (!last) return { percent: 0, tokens: null, cost: null, contextLimit };

    return {
      percent: Math.min(100, Math.max(0, Math.round((last.total / contextLimit) * 100))),
      tokens: last.total,
      cost: last.cost,
      contextLimit,
    };
  }, [activeSessionId, messages, providers, selectedModel, providerDefaults]);
}

function AppContent({ detachedProject }: { detachedProject?: string }) {
  const lastEscapeAtRef = useRef(0);
  const [queueMode, setQueueMode] = useState<QueueMode>("queue");
  const [activeView, setActiveView] = useState<"chat" | "settings">("chat");
  const leftSidebar = useSidebar();
  const {
    sendPrompt,
    abortSession,
    clearError,
    getQueuedPrompts,
    removeFromQueue,
    reorderQueue,
    updateQueuedPrompt,
    sendQueuedNow,
    cycleVariant,
    revertVariant,
    startDraftSession,
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
    draftSessionDirectory,
  } = useSessionState();
  const { messages } = useMessages();
  const { providers, selectedModel, providerDefaults } = useModelState();
  const capabilities = useBackendCapabilities();
  const { bootState, bootError, bootLogs, lastError, worktreeParents, defaultChatDirectory } =
    useConnectionState();
  const [logsExpanded, setLogsExpanded] = useState(false);
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
    activeSession?._projectDir ?? activeSession?.directory ?? draftSessionDirectory ?? null;
  const activeWorktreeInfo = useMemo(() => {
    if (!activeSessionDirectory) return null;
    const meta = worktreeParents[activeSessionDirectory];
    if (!meta) return null;
    return {
      mainDir: meta.parentDir,
      branch: meta.branch,
      worktreePath: activeSessionDirectory,
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
    let cancelled = false;
    const git = window.electronAPI?.git;
    const mainDir = activeWorktreeInfo?.mainDir;
    if (!git || !mainDir) {
      setActiveWorktreeRemoteUrl(null);
      return;
    }
    void git.getRemoteUrl(mainDir).then((res) => {
      if (cancelled) return;
      setActiveWorktreeRemoteUrl(res.success && res.data ? (res.data ?? "") : null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorktreeInfo?.mainDir]);

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

            {/* Error banner */}
            {!isBooting && (bootState === "error" || lastError) && (
              <div className="border-b border-destructive/20 bg-destructive/10">
                <div className="flex items-center gap-2 px-4 py-2 text-sm text-destructive">
                  <AlertCircle className="size-4 shrink-0" />
                  <span className="flex-1 truncate">
                    {bootState === "error" ? bootError : lastError}
                  </span>
                  {bootState === "error" && bootLogs && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                      onClick={() => setLogsExpanded((v) => !v)}
                    >
                      {logsExpanded ? (
                        <>
                          Hide logs <ChevronUp className="size-3 ml-1" />
                        </>
                      ) : (
                        <>
                          Show logs <ChevronDown className="size-3 ml-1" />
                        </>
                      )}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => {
                      clearError();
                      setLogsExpanded(false);
                    }}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
                {logsExpanded && normalizedBootLogs && (
                  <pre className="terminal-output w-full min-w-0 max-w-full px-4 pb-3 text-destructive/80 max-h-48 overflow-y-auto overflow-x-hidden select-text">
                    {normalizedBootLogs}
                  </pre>
                )}
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
                <MessageList detachedProject={detachedProject} />

                {/* Queue list + Prompt input */}
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
                      disabled={
                        isBooting ||
                        isLoadingMessages ||
                        (!activeSessionId && !draftSessionDirectory && !defaultChatDirectory)
                      }
                      isLoading={isBusy}
                      contextPercent={contextPercent}
                      contextTokens={contextInfo.tokens}
                      contextCost={contextInfo.cost}
                      contextLimit={contextInfo.contextLimit}
                      queueMode={queueMode}
                      onQueueModeChange={setQueueMode}
                      onSubmit={(message, images, mode) => {
                        return sendPrompt(message, images, mode);
                      }}
                      onStop={() => abortSession()}
                    />
                  </div>
                </div>
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
            await window.electronAPI?.git?.removeWorktree(
              mergeInfo.mainDir,
              mergeInfo.worktreePath,
            );
          }
          if (activeWorktreeInfo?.mainDir === mergeInfo.mainDir) {
            const remoteRes = await window.electronAPI?.git?.getRemoteUrl(mergeInfo.mainDir);
            setActiveWorktreeRemoteUrl(
              remoteRes?.success && remoteRes.data ? (remoteRes.data ?? "") : null,
            );
          }
        }}
        onFixWithAI={(conflicts) => {
          if (!mergeInfo) return;
          startDraftSession(mergeInfo.mainDir);
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
  const detachedProject = window.electronAPI?.getDetachedProject() ?? undefined;

  const [showWizard, setShowWizard] = useState(
    () => storageGet(STORAGE_KEYS.SETUP_COMPLETE) !== "true",
  );

  return (
    <OpenGuiClientProvider>
      <AgentBackendProvider detachedProject={detachedProject}>
        <SidebarProvider className="!h-dvh">
          <AppContent detachedProject={detachedProject} />
          {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
        </SidebarProvider>
      </AgentBackendProvider>
    </OpenGuiClientProvider>
  );
}
