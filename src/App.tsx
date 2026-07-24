import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { QueueList } from "@/components/QueueList";
import { UpdateDialog } from "@/components/UpdateDialog";
import {
  NoProjectConnected,
  NoSessionSelected,
  NoWorkspaceConfigured,
} from "@/components/EmptyChatStates";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import {
  useActiveTranscriptContextMessages,
  useActiveTranscriptMessageOrder,
} from "@/features/session-transcript/active-session-transcript-provider";
import { HostProvider } from "@/features/host-provider/HostProvider";
import { IdentityGate } from "@/features/identity/IdentityGate";
import { SessionShareDialog } from "@/features/identity/SessionShareDialog";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import {
  useActions,
  useModelState,
  useSessionState,
  useWorkspaceState,
} from "@/hooks/use-agent-state";
import { useUpdateCheck } from "@/hooks/use-update-check";
import { useContextInfo } from "@/hooks/use-context-info";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/persistence/storage";
import { getDesktopShellClient } from "@/runtime/clients";
import { DesktopShellProvider } from "@/shell/provider";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useMobileBackButton } from "@/shell/useMobileBackButton";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";
import { notifyError, notifyErrorDeduped, resetNotifyErrorDedup } from "@/lib/notify";
import { normalizeTerminalOutput } from "@/lib/terminal-output";
import { useAppKeyboardShortcuts } from "@/features/app-shell/useAppKeyboardShortcuts";
import { useActiveSessionQueue } from "@/features/session/useActiveSessionQueue";
import { useChatSessionSurface } from "@/features/session/useChatSessionSurface";
import { AppSidebar } from "./components/AppSidebar";
import { SettingsView } from "./components/ConnectionPanel";
import { findLastUserMessageBeforeRevert } from "@/components/message-list/message-revert";
import { MessageList } from "./components/MessageList";
import { PromptBox } from "./components/PromptBox";
import { SetupWizard } from "./components/SetupWizard";
import { TitleBar } from "./components/TitleBar";
import "./index.css";

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
  const identityActor = useIdentityActor();
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
    defaultChatDirectory,
    connections,
    workspaces,
    supportsMultipleWorkspaces,
  } = useWorkspaceState();
  const normalizedBootLogs = useMemo(
    () => (bootLogs ? normalizeTerminalOutput(bootLogs) : null),
    [bootLogs],
  );
  const activeSessionId = sessionActiveId;
  const activeSessionError = activeSessionId ? (sessionErrors[activeSessionId] ?? null) : null;

  const { activeSession, chatSurfaceState, hasConnectedProjects, showPromptBox } =
    useChatSessionSurface({
      sessions,
      activeSessionId,
      activeTargetDirectory,
      sessionMeta,
      connections,
      defaultChatDirectory,
    });

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

  useEffect(() => {
    const dedupeKey =
      activeSessionId && activeSessionError ? `${activeSessionId}:${activeSessionError}` : null;
    if (!dedupeKey) {
      resetNotifyErrorDedup();
      return;
    }
    notifyErrorDeduped(dedupeKey, t("sessionError.title"), {
      description: activeSessionError,
    });
  }, [activeSessionError, activeSessionId, t]);

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
          <TitleBar onToggleLeftSidebar={detachedProject ? undefined : leftSidebar.toggleSidebar} />

          <div className="flex-1 flex flex-col min-w-0 min-h-0 select-none">
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
                {workspaces.length === 0 && supportsMultipleWorkspaces ? (
                  <NoWorkspaceConfigured />
                ) : chatSurfaceState.kind === "no-project" ||
                  chatSurfaceState.kind === "default-chat" ? (
                  hasConnectedProjects ? (
                    <NoSessionSelected />
                  ) : (
                    <NoProjectConnected
                      canStartChat={chatSurfaceState.kind === "default-chat"}
                      shareOnly={identityActor?.type === "user"}
                      onStartChat={() => {
                        void startNewChat();
                      }}
                    />
                  )
                ) : (
                  <MessageList />
                )}

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
                      <PromptBox
                        autoFocus
                        isLoading={isBusy}
                        queueMode={queueMode}
                        onQueueModeChange={setQueueMode}
                        contextInfo={contextInfo}
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
      <SessionShareDialog />
      <UpdateDialog update={updateCheck} />
    </>
  );
}

export function App() {
  const detachedProject = getDesktopShellClient().detachedProjects.getCurrent() ?? undefined;

  const [showWizard, setShowWizard] = useState(
    () => storageGet(STORAGE_KEYS.SETUP_COMPLETE) !== "true",
  );
  const dismissSetup = useCallback(() => {
    storageSet(STORAGE_KEYS.SETUP_COMPLETE, "true");
    setShowWizard(false);
  }, []);

  useMobileBackButton();

  return (
    <DesktopShellProvider>
      <IdentityGate>
        <HostProvider detachedProject={detachedProject}>
          <SidebarProvider className="!h-dvh">
            <AppContent
              detachedProject={detachedProject}
              suppressBootErrors={showWizard}
              onDismissSetup={dismissSetup}
            />
            {showWizard && <SetupWizard onComplete={dismissSetup} />}
            <Toaster richColors closeButton />
          </SidebarProvider>
        </HostProvider>
      </IdentityGate>
    </DesktopShellProvider>
  );
}
