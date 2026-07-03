import { type ReactNode, useCallback, useMemo, useReducer, useRef } from "react";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import { useAgentSessionActivation } from "@/hooks/agent-session-activation";
import {
  useActiveSessionTranscriptOrchestration,
  type TranscriptOrchestrationDispatch,
} from "@/features/session-transcript/use-active-session-transcript-orchestration";
import { useVariant } from "@/hooks/use-agent-variant-core";
import { initialAgentState } from "@/hooks/agent-initial-state";
import { reducer } from "@/hooks/agent-reducer";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import { useAgentProjectBootstrap } from "@/features/agent-bootstrap";
import { useAgentProjectOrchestration } from "@/features/agent-projects";
import { useAgentResourceCatalog, useAgentResourceRouting } from "@/features/agent-resources";
import { useAgentTranscriptBackendEvents } from "@/features/agent-events";
import { AgentProviderShell } from "./AgentProviderShell";
import { useAgentProviderActionsAssembly } from "./useAgentProviderActionsAssembly";
import { useAgentProviderContextSlices } from "./buildAgentProviderContextSlices";
import { useAgentProviderTrackingRefs } from "./useAgentProviderTrackingRefs";
import { useAgentHarnessPreference } from "./useAgentHarnessPreference";
import { useAgentProviderPersistenceEffects } from "./useAgentProviderPersistenceEffects";
import { useAgentClearDefaultChatDirectory } from "./useAgentClearDefaultChatDirectory";
import {
  useAgentActiveSessionMetaSync,
  useAgentDesktopNotifications,
  useAgentEmptyTranscriptReload,
  useAgentPromptTargetActions,
  useAgentSendAndInteractionActions,
  useAgentSessionLifecycleActions,
  useAgentSessionMutationActions,
  useAgentSessionTitleOrchestration,
} from "@/features/agent-sessions";
import { useAgentWorkspaceScope, useAgentWorkspaceAdmin } from "@/features/agent-workspaces";
import { normalizeProjectPath } from "@/lib/utils";

export function InternalAgentProviderBody({
  children,
  detachedProject,
}: {
  children: ReactNode;
  detachedProject?: string;
}) {
  const [state, dispatch] = useReducer(reducer, initialAgentState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const getState = useCallback(() => stateRef.current, []);
  const shellWorkspacePolicy = useMemo(() => getShellWorkspacePolicy(), []);
  const {
    preferredHarnessId,
    setPreferredHarnessId,
    openGuiClient,
    allHarnesses,
    backendsById,
    discoveryHarnessIds,
  } = useAgentHarnessPreference();

  const activeSession = state.activeSessionId
    ? (state.sessions.find((session) => session.id === state.activeSessionId) ?? null)
    : null;
  const activeSessionHarnessRoute = resolveSessionHarnessRoute(activeSession);
  const activeSessionHarnessId = activeSessionHarnessRoute.harnessId;
  const {
    selectSessionRequestRef,
    cleanupSessionRefs,
    titleTracking,
    noteSessionSelection,
    consumePreservePromptBoxSelection,
  } = useAgentProviderTrackingRefs();

  useAgentProviderPersistenceEffects(state);

  const {
    workspaceStateReady,
    pendingStartupSessionRestoreRef,
    activeWorkspace,
    workspacePresentation,
    workspaceDirectory,
    activeWorkspaceSessions: scopedActiveWorkspaceSessions,
    visibleWorkspaceConnections,
  } = useAgentWorkspaceScope({
    state,
    dispatch,
    openGuiClient,
    shellWorkspacePolicy,
  });

  const {
    currentVariant,
    setModel,
    setAgent,
    cycleVariant: doCycleVariant,
    revertVariant: doRevertVariant,
  } = useVariant({
    selectedModel: state.selectedModel,
    providers: state.providers,
    agents: state.agents,
    selectedAgent: state.selectedAgent,
    variantSelections: state.variantSelections,
    workspaceId: state.activeWorkspaceId,
    dispatch,
  });

  useAgentActiveSessionMetaSync({ state, currentVariant, dispatch });

  const {
    loadServerResources,
    loadedResourceProjectKeyRef,
    loadedResourceHarnessIdRef,
    clearResourceLoadDedupe,
  } = useAgentResourceCatalog({ openGuiClient, dispatch, getState });

  const clearDefaultChatDirectory = useAgentClearDefaultChatDirectory({ stateRef, dispatch });

  const {
    expectedDirectoriesRef,
    updateProjectHydration,
    ensureDirectoryConnection,
    restartHarnesses,
    removeProject,
    loadSessionIndex,
    connectToProject,
  } = useAgentProjectOrchestration({
    openGuiClient,
    dispatch,
    getState,
    allHarnesses,
    discoveryHarnessIds,
    backendsById,
    preferredHarnessId,
    cleanupSessionRefs,
    clearDefaultChatDirectory,
  });

  useAgentProjectBootstrap({
    openGuiClient,
    workspaceStateReady,
    allHarnesses,
    detachedProject,
    discoveryHarnessIds,
    preferredHarnessId,
    shellWorkspacePolicy,
    dispatch,
    getState,
    expectedDirectoriesRef,
    updateProjectHydration,
    loadServerResources,
    loadSessionIndex,
  });

  const { activeResourceHarnessId, activeResourceDirectory, resourceHarness, runtime } =
    useAgentResourceRouting({
      state,
      dispatch,
      activeSession,
      workspaceDirectory,
      preferredHarnessId,
      backendsById,
      openGuiClient,
      detachedProject,
    });

  const { resolveCurrentSessionId, forceSessionTitle, applyGeneratedSessionTitle } =
    useAgentSessionTitleOrchestration({
      dispatch,
      getState,
      openGuiClient,
      tracking: titleTracking,
    });

  const transcriptDispatch = useCallback<TranscriptOrchestrationDispatch>(
    (action) => {
      dispatch(action as never);
    },
    [dispatch],
  );

  const { selectSession } = useAgentSessionActivation({
    dispatch,
    stateRef,
    noteSessionSelection,
  });

  const {
    ingestLiveEvent,
    ingestProjectedTranscriptEvent,
    loadOlderMessages: loadOlderFromTranscript,
    reloadActiveTranscript,
    getTranscriptSnapshot,
  } = useActiveSessionTranscriptOrchestration({
    activeSessionId: state.activeSessionId,
    stateRef,
    dispatch: transcriptDispatch,
    openGuiClient,
    selectSessionRequestRef,
    expectedProjectKeysRef: expectedDirectoriesRef,
    consumePreservePromptBoxSelection,
  });

  useAgentTranscriptBackendEvents({
    allHarnessesCount: allHarnesses.length,
    cleanupSessionRefs,
    dispatch,
    openGuiClient,
    workspaces: state.workspaces,
    expectedProjectKeys: expectedDirectoriesRef,
    titleTracking,
    ingestLiveEvent,
    ingestProjectedTranscriptEvent,
  });

  const scheduleSessionMessageReconcile = useCallback(
    (sessionId: string, _projectTarget?: { directory?: string; workspaceId?: string }) => {
      void reloadActiveTranscript(sessionId);
    },
    [reloadActiveTranscript],
  );

  const refreshActiveSessionMessages = useCallback(
    (sessionId: string, _projectTarget?: { directory?: string; workspaceId?: string }) =>
      reloadActiveTranscript(sessionId),
    [reloadActiveTranscript],
  );

  const {
    activeWorkspaceSessions,
    connectionContextSlice,
    openDirectory,
    createWorkspace,
    updateWorkspace,
    removeWorkspace,
    switchWorkspace,
    reorderWorkspaces,
    reorderVisibleProjects,
  } = useAgentWorkspaceAdmin({
    state,
    dispatch,
    getState,
    openGuiClient,
    shellWorkspacePolicy,
    workspaceStateReady,
    pendingStartupSessionRestoreRef,
    activeWorkspace,
    workspacePresentation,
    workspaceDirectory,
    activeWorkspaceSessions: scopedActiveWorkspaceSessions,
    visibleWorkspaceConnections,
    activeResourceDirectory,
    activeResourceHarnessId,
    resourceHarness,
    loadServerResources,
    loadedResourceProjectKeyRef,
    loadedResourceHarnessIdRef,
    selectSession,
  });

  useAgentEmptyTranscriptReload({
    activeSessionId: state.activeSessionId,
    getTranscriptSnapshot,
    reloadActiveTranscript,
  });

  const isChatDirectory = useCallback((directory?: string | null) => {
    const normalizedDirectory = directory ? normalizeProjectPath(directory) : null;
    const defaultChatDirectory = stateRef.current.defaultChatDirectory;
    if (!normalizedDirectory || !defaultChatDirectory) return false;
    return normalizedDirectory === normalizeProjectPath(defaultChatDirectory);
  }, []);

  const loadOlderMessages = useCallback(async (): Promise<boolean> => {
    return loadOlderFromTranscript();
  }, [loadOlderFromTranscript]);

  const { createSession, deleteSession, renameSession } = useAgentSessionLifecycleActions({
    dispatch,
    getState,
    openGuiClient,
    preferredHarnessId,
    ensureDirectoryConnection,
    selectSession,
    isChatDirectory,
    cleanupSessionRefs,
    tracking: titleTracking,
  });

  const {
    sendPrompt,
    sendCommand,
    sendQueuedNow,
    justIdledMap,
    summarizeSession,
    abortSession,
    respondPermission,
    replyQuestion,
    rejectQuestion,
    getQueuedPrompts,
    removeFromQueue,
    reorderQueue,
    updateQueuedPrompt,
  } = useAgentSendAndInteractionActions({
    state,
    stateRef,
    runtime,
    openGuiClient,
    preferredHarnessId,
    currentVariant,
    dispatch,
    createSession,
    scheduleSessionMessageReconcile,
    refreshActiveSessionMessages,
    resolveCurrentSessionId,
    reloadActiveTranscript,
    titleTracking,
    applyGeneratedSessionTitle,
  });

  useAgentDesktopNotifications({
    justIdledMap,
    state,
    selectSession: (id) => selectSession(id),
  });

  const promptTarget = useAgentPromptTargetActions({
    state,
    dispatch,
    getState,
    openGuiClient,
    runtime,
    activeSessionHarnessId: activeSessionHarnessId ?? undefined,
    preferredHarnessId,
    setPreferredHarnessId,
    setModel,
    ensureDirectoryConnection,
    activeResourceDirectory,
    activeResourceHarnessId,
    activeWorkspaceId: activeWorkspace?.id,
    loadServerResources,
    clearResourceLoadDedupe,
    loadedResourceProjectKeyRef,
  });

  const sessionMutations = useAgentSessionMutationActions({
    state,
    dispatch,
    getState,
    openGuiClient,
    runtime,
    selectSession,
    ensureDirectoryConnection,
    reloadActiveTranscript,
    forceSessionTitle,
  });

  const actionsCtx = useAgentProviderActionsAssembly({
    removeProject,
    selectSession,
    loadOlderMessages,
    deleteSession,
    renameSession,
    sendPrompt,
    findFiles: promptTarget.findFiles,
    sendCommand,
    summarizeSession,
    abortSession,
    respondPermission,
    replyQuestion,
    rejectQuestion,
    setModel: promptTarget.setModelWithHarnessPersistence,
    setPromptBoxSelection: promptTarget.setPromptBoxSelection,
    setAgent,
    cycleVariant: doCycleVariant,
    revertVariant: doRevertVariant,
    clearError: promptTarget.clearError,
    refreshProviders: promptTarget.refreshProviders,
    restartHarnesses,
    getQueuedPrompts,
    removeFromQueue,
    reorderQueue,
    updateQueuedPrompt,
    sendQueuedNow,
    setSessionDraft: promptTarget.setSessionDraft,
    clearSessionDraft: promptTarget.clearSessionDraft,
    openDirectory,
    connectToProject,
    startNewChat: promptTarget.startNewChat,
    setActiveTarget: promptTarget.setActiveTarget,
    setDefaultChatDirectory: promptTarget.setDefaultChatDirectory,
    setActiveTargetDirectory: promptTarget.setActiveTargetDirectory,
    revertToMessage: sessionMutations.revertToMessage,
    unrevert: sessionMutations.unrevert,
    forkFromMessage: sessionMutations.forkFromMessage,
    setSessionColor: sessionMutations.setSessionColor,
    setSessionTags: sessionMutations.setSessionTags,
    setSessionPinned: sessionMutations.setSessionPinned,
    moveSessionToProject: sessionMutations.moveSessionToProject,
    removeSessionFromProject: sessionMutations.removeSessionFromProject,
    setProjectPinned: sessionMutations.setProjectPinned,
    registerWorktree: sessionMutations.registerWorktree,
    unregisterWorktree: sessionMutations.unregisterWorktree,
    clearWorktreeCleanup: sessionMutations.clearWorktreeCleanup,
    createWorkspace,
    updateWorkspace,
    removeWorkspace,
    switchWorkspace,
    reorderWorkspaces,
    reorderVisibleProjects,
  });

  const providerSlices = useAgentProviderContextSlices({
    state,
    activeWorkspaceSessions,
    currentVariant,
    connectionContextSlice,
    actions: actionsCtx,
  });

  return (
    <AgentProviderShell
      sessionCtx={providerSlices.sessionCtx}
      messagesCtx={providerSlices.messagesCtx}
      modelCtx={providerSlices.modelCtx}
      connectionCtx={providerSlices.connectionCtx}
      actionsCtx={providerSlices.actionsCtx}
    >
      {children}
    </AgentProviderShell>
  );
}
