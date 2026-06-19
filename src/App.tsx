import { ExternalLink, GitMerge } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MergeDialog } from "@/components/MergeDialog";
import { QueueList } from "@/components/QueueList";
import { UpdateDialog } from "@/components/UpdateDialog";
import {
  NoProjectConnected,
  NoSessionSelected,
  NoWorkspaceConfigured,
} from "@/components/EmptyChatStates";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { WorktreeCleanupDialog } from "@/components/WorktreeCleanupDialog";
import {
  useActiveTranscriptContextMessages,
  useActiveTranscriptMessageOrder,
} from "@/features/session-transcript/active-session-transcript-provider";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import {
  HarnessProvider,
  useActions,
  useConnectionState,
  useModelState,
  useSessionState,
} from "@/hooks/use-agent-state";
import { useUpdateCheck } from "@/hooks/use-update-check";
import { useContextInfo } from "@/hooks/use-context-info";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet } from "@/lib/safe-storage";
import { OpenGuiClientProvider, useOpenGuiClient } from "@/protocol/provider";
import { getDesktopShellClient } from "@/runtime/clients";
import { DesktopShellProvider } from "@/shell/provider";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useMobileBackButton } from "@/shell/useMobileBackButton";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";
import { notifyError, notifyErrorDeduped, resetNotifyErrorDedup } from "@/lib/notify";
import { normalizeTerminalOutput } from "@/lib/utils";
import { useAppKeyboardShortcuts } from "@/features/app-shell/useAppKeyboardShortcuts";
import { useActiveSessionQueue } from "@/features/session/useActiveSessionQueue";
import { useChatSessionSurface } from "@/features/session/useChatSessionSurface";
import { useActiveWorktreeMerge } from "@/features/worktree/useActiveWorktreeMerge";
import { AppSidebar } from "./components/AppSidebar";
import { SettingsView } from "./components/ConnectionPanel";
import { findLastUserMessageBeforeRevert } from "@/components/message-list/message-revert";
import { MessageList } from "./components/MessageList";
import { ProjectHarnessStatusBanner } from "./components/ProjectHarnessStatusBanner";
import { PromptBox } from "./components/PromptBox";
import { PromptSessionStatus } from "./components/PromptSessionStatus";
import { SetupWizard } from "./components/SetupWizard";
import { TitleBar } from "./components/TitleBar";
import "./index.css";

function extractTerminalCommand(message: string | null) {
  if (!message) return null;
  const match = message.match(/\bRun\s+['"`]([^'"`]+)['"`]\s+in\s+(?:your\s+)?terminal/i);
  return match?.[1]?.trim() || null;
}

function AppContent({
  detachedProject,
  suppressBootErrors,
  onDismissSetup,
}: {
  detachedProject?: string;
  suppressBootErrors?: boolean;
  onDismissSetup?: () => void;
}) {
  const { t } = useTranslation();
  const client = useOpenGuiClient();
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
    activeTargetDirectory,
    sessionMeta,
    sessionErrors,
  } = useSessionState();
  const messageOrder = useActiveTranscriptMessageOrder();
  const contextMessages = useActiveTranscriptContextMessages();
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
    workspaces,
    supportsMultipleWorkspaces,
    activeWorkspaceId,
  } = useConnectionState();
  const normalizedBootLogs = useMemo(
    () => (bootLogs ? normalizeTerminalOutput(bootLogs) : null),
    [bootLogs],
  );
  const activeSessionId = sessionActiveId;
  const activeSessionError = activeSessionId ? (sessionErrors[activeSessionId] ?? null) : null;
  const activeSessionErrorCommand = useMemo(
    () => extractTerminalCommand(activeSessionError),
    [activeSessionError],
  );

  const {
    activeSession,
    activeSessionDirectory,
    chatSurfaceState,
    hasConnectedProjects,
    showPromptBox,
  } = useChatSessionSurface({
    sessions,
    activeSessionId,
    activeTargetDirectory,
    sessionMeta,
    connections,
    defaultChatDirectory,
  });
  const {
    activeWorktreeInfo,
    activeWorktreeRemoteUrl,
    mergeInfo,
    setMergeInfo,
    openPullRequest,
    handleMerged,
    handleFixWithAI,
  } = useActiveWorktreeMerge({
    activeSessionDirectory,
    worktreeParents,
    client,
    sendPrompt,
    setActiveTarget,
    removeProject,
    unregisterWorktree,
  });

  // Find the last user message (for undo keybind), respecting revert state
  const revertToLastMessage = useCallback(() => {
    if (!capabilities?.revert) return;
    const target = findLastUserMessageBeforeRevert(messageOrder, activeSession?.revert?.messageID);
    if (target) void revertToMessage(target.info.id);
  }, [capabilities?.revert, activeSession?.revert?.messageID, messageOrder, revertToMessage]);

  const { queueMode, setQueueMode } = useAppKeyboardShortcuts({
    capabilities,
    isBusy,
    abortSession,
    cycleVariant,
    revertVariant,
    unrevert,
    revertToLastMessage,
  });
  const { queuedPrompts, queueHandlers } = useActiveSessionQueue({
    activeSessionId,
    getQueuedPrompts,
    removeFromQueue,
    reorderQueue,
    updateQueuedPrompt,
    sendQueuedNow,
  });

  const isBooting = bootState === "checking-server" || bootState === "starting-server";

  useEffect(() => {
    if (suppressBootErrors) return;
    if (isBooting) return;
    const message = bootState === "error" ? bootError : lastError;
    if (!message) return;
    notifyError(message, {
      description: bootState === "error" && normalizedBootLogs ? normalizedBootLogs : undefined,
    });
  }, [bootState, bootError, isBooting, lastError, normalizedBootLogs, suppressBootErrors]);

  const contextInfo = useContextInfo({
    activeSessionId,
    messages: contextMessages,
    providers,
    selectedModel,
    providerDefaults,
  });

  const contextPercent = contextInfo.percent;

  const openTerminalForSessionError = useCallback(() => {
    if (!activeSessionDirectory) return;
    void getDesktopShellClient()
      .system.openInTerminal(activeSessionDirectory)
      .catch((error) => console.error(error));
  }, [activeSessionDirectory]);

  useEffect(() => {
    const dedupeKey =
      activeSessionId && activeSessionError ? `${activeSessionId}:${activeSessionError}` : null;
    if (!dedupeKey) {
      resetNotifyErrorDedup();
      return;
    }

    const descriptionParts = [activeSessionError];
    if (activeSessionErrorCommand) {
      descriptionParts.push(`${t("sessionError.nextStep")}\n${activeSessionErrorCommand}`);
    }

    notifyErrorDeduped(dedupeKey, t("sessionError.title"), {
      description: descriptionParts.join("\n\n"),
      ...(activeSessionErrorCommand && activeSessionDirectory
        ? {
            action: {
              label: t("sessionError.openTerminal"),
              onClick: () => openTerminalForSessionError(),
            },
          }
        : {}),
    });
  }, [
    activeSessionDirectory,
    activeSessionError,
    activeSessionErrorCommand,
    activeSessionId,
    openTerminalForSessionError,
    t,
  ]);

  // Check for app updates on startup
  const updateCheck = useUpdateCheck();

  const handleMobileBackFromSettings = useCallback(() => {
    setActiveView("chat");
    return true;
  }, []);
  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.SETTINGS_VIEW,
    activeView === "settings",
    handleMobileBackFromSettings,
  );

  const handleMobileBackFromMerge = useCallback(() => {
    setMergeInfo(null);
    return true;
  }, [setMergeInfo]);
  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.MERGE,
    mergeInfo !== null,
    handleMobileBackFromMerge,
  );

  useEffect(() => {
    const openSettings = () => {
      onDismissSetup?.();
      setActiveView("settings");
    };
    window.addEventListener("opengui:open-settings", openSettings);
    return () => window.removeEventListener("opengui:open-settings", openSettings);
  }, [onDismissSetup]);

  return (
    <>
      <AppSidebar
        detachedProject={detachedProject}
        highlightedSessionId={activeView === "chat" ? sessionActiveId : null}
        onOpenSettings={() => {
          onDismissSetup?.();
          setActiveView("settings");
        }}
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
                    ? t("startup.checkingLocalServer")
                    : t("startup.startingLocalServer")}
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
                        {t("projectMenu.merge")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!activeWorktreeRemoteUrl}
                        onClick={openPullRequest}
                      >
                        <ExternalLink className="size-4" />
                        {t("projectMenu.createPullRequest")}
                      </Button>
                    </div>
                  </div>
                )}
                {workspaces.length === 0 && supportsMultipleWorkspaces ? (
                  <NoWorkspaceConfigured />
                ) : chatSurfaceState.kind === "no-project" ||
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
                  <MessageList />
                )}

                <ProjectHarnessStatusBanner
                  activeSessionDirectory={activeSessionDirectory}
                  activeWorkspaceId={activeWorkspaceId}
                />

                {/* Queue list + Prompt input */}
                {showPromptBox && !(workspaces.length === 0 && supportsMultipleWorkspaces) && (
                  <div className="shrink-0 px-0 md:px-4 app-safe-bottom-inset-prompt">
                    <div className="w-full md:max-w-2xl md:mx-auto">
                      {queuedPrompts.length > 0 && (
                        <div className="mb-1.5">
                          <QueueList
                            items={queuedPrompts}
                            onRemove={queueHandlers.remove}
                            onMoveUp={queueHandlers.moveUp}
                            onMoveDown={queueHandlers.moveDown}
                            onMoveToTop={queueHandlers.moveToTop}
                            onMoveToBottom={queueHandlers.moveToBottom}
                            onEdit={queueHandlers.edit}
                            onSendNow={queueHandlers.sendNow}
                            onReorder={queueHandlers.reorder}
                          />
                        </div>
                      )}
                      <PromptSessionStatus
                        contextPercent={contextPercent}
                        contextTokens={contextInfo.tokens}
                        contextCost={contextInfo.cost}
                        contextLimit={contextInfo.contextLimit}
                        isLoading={isBusy}
                      />
                      <PromptBox
                        autoFocus
                        isLoading={isBusy}
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
        onMerged={handleMerged}
        onFixWithAI={handleFixWithAI}
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

  useMobileBackButton();

  return (
    <DesktopShellProvider>
      <OpenGuiClientProvider>
        <HarnessProvider detachedProject={detachedProject}>
          <SidebarProvider className="!h-dvh">
            <AppContent
              detachedProject={detachedProject}
              suppressBootErrors={showWizard}
              onDismissSetup={() => setShowWizard(false)}
            />
            {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
            <Toaster richColors closeButton />
          </SidebarProvider>
        </HarnessProvider>
      </OpenGuiClientProvider>
    </DesktopShellProvider>
  );
}
