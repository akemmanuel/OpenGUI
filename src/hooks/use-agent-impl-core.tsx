/**
 * Central React context + hook for agent backend state.
 *
 * Provides connection lifecycle, session management, messages,
 * variant selection, and real-time backend event handling to entire
 * component tree.
 *
 * Uses v2 SDK types which include variant support on models.
 */

import type { Agent, Provider, QuestionAnswer } from "@opencode-ai/sdk/v2/client";

import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { getAgentBackendIdFromSessionId, type AgentBackendId } from "@/agents";
import { createLocalIntentOrchestrator } from "@/hooks/agent-local-intent";
import { nextNamingRequestId } from "@/hooks/agent-send-state";
import { useAgentSessionActivation } from "@/hooks/agent-session-activation";
import { handleAgentBackendEvent } from "@/hooks/agent-backend-events";
import {
  isCanonicalSessionNotification,
  isQueueEvent,
  toAgentBackendEvent,
  type BackendEventEnvelope,
} from "@/hooks/backend-event-normalization";
import {
  processAfterPartQueueTriggers,
  processBusyToIdleTransitions,
} from "@/hooks/agent-queue-dispatch";
import {
  createLifecycleSession,
  createSessionRenamePlan,
  deleteLifecycleSession,
  forkLifecycleSession,
  refreshLifecycleSession,
} from "@/hooks/agent-session-lifecycle";
import {
  createWorkspaceLifecyclePlan,
  createWorkspaceSelectionSyncPlan,
  createWorkspaceSwitchPlan,
  createWorkspaceUpdatePlan,
} from "@/hooks/agent-workspace-lifecycle";
import {
  updateVariantSelections,
  useVariant,
  type VariantSelections,
  variantKey,
} from "@/hooks/use-agent-variant-core";
import {
  getActiveWorkspaceId,
  getLegacyStoredDefaultChatDirectory,
  getProjectMetaMap,
  getSessionMetaMap,
  getUnreadSessionIds,
  getWorkspaceDefaultChatDirectory,
  getWorkspaceRootDirectory,
  getWorktreeParents,
  initializeBackendWorkspaceState,
  isLocalServer,
  LOCAL_WORKSPACE_ID,
  persistUnreadSessionIds,
  persistWorkspaces,
  persistWorktreeParents,
  type SessionColor,
} from "@/hooks/agent-state-persistence";
import {
  buildBootstrapProjectConfigs,
  createProjectConnectionDescriptor,
  createProjectConnectionStatus,
  createProjectRemovalPlan,
  createWorkspaceConnectionConfig,
  createWorkspaceProjectConnectionPlan,
  resolveConnectionWorkspace,
  shouldPersistLocalConnectionSettings,
  shouldPersistWorkspaceProject,
  shouldSnapshotProjectConnectionForRestart,
} from "@/hooks/agent-project-connection";
import {
  getPendingProjectHydrationBackendIds,
  hasProjectHydrationInFlight,
  runWithConcurrency,
  settleProjectHydration,
  startProjectHydration,
  type ProjectHydrationState,
} from "@/hooks/agent-project-hydration";
import {
  fetchSessionMessagePage,
  hydrateChildSessionMessages,
  loadOlderSessionMessages,
} from "@/hooks/agent-message-loading";
import {
  getSessionBackendId,
  getSessionDirectory,
  getSessionProjectTarget,
  getSessionSelectedAgent,
  getSessionSelectedModel,
  getSessionSelectedVariant,
  getSessionWorkspaceId,
  isHiddenProject,
  makeProjectKey,
  parseProjectKey,
  shouldAutoNameSession,
} from "@/hooks/agent-session-utils";
import { reducer } from "@/hooks/agent-reducer";
import { useDesktopNotification } from "@/hooks/agent-notifications";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import type { InternalAgentState, MessageEntry, Session } from "@/hooks/agent-state-types";
import {
  ActionsContext,
  type ActionsContextValue,
  ConnectionContext,
  type ConnectionContextValue,
  MessagesContext,
  type MessagesContextValue,
  ModelContext,
  type ModelContextValue,
  SessionContext,
  type SessionContextValue,
} from "@/hooks/agent-contexts";
export {
  LOCAL_WORKSPACE_ID,
  NOTIFICATIONS_ENABLED_KEY,
  type SessionColor,
} from "@/hooks/agent-state-persistence";
import { DEFAULT_SERVER_URL, STORAGE_KEYS } from "@/lib/constants";
import {
  onSettingsChange,
  storageGet,
  storageParsed,
  storageRemove,
  storageSet,
  storageSetJSON,
  storageSetOrRemove,
} from "@/lib/safe-storage";
import { createHttpOpenGuiClient } from "@/protocol/http-client";
import { useOpenGuiClient } from "@/protocol/provider";
import { getSessionDrafts, persistSessionDrafts } from "@/lib/session-drafts";
import { generateSessionTitle } from "@/lib/session-namer";
import { getErrorMessage, normalizeProjectPath } from "@/lib/utils";
import type {
  ConnectionConfig,
  ConnectionStatus,
  SelectedModel,
  Workspace,
} from "@/types/electron";

/**
 * Given the list of providers and a `provider -> modelID` default map from the
 * server, resolve the first valid `SelectedModel` that exists.
 */
export function resolveServerDefaultModel(
  providers: Provider[],
  providerDefaults: Record<string, string>,
): SelectedModel | null {
  for (const provider of providers) {
    const modelID = providerDefaults[provider.id];
    if (typeof modelID !== "string") continue;
    if (!(modelID in provider.models)) continue;
    return { providerID: provider.id, modelID };
  }

  for (const raw of Object.values(providerDefaults)) {
    if (typeof raw !== "string") continue;
    const splitIdx = raw.indexOf("/");
    if (splitIdx <= 0 || splitIdx >= raw.length - 1) continue;
    const providerID = raw.slice(0, splitIdx);
    const modelID = raw.slice(splitIdx + 1);
    const provider = providers.find((p) => p.id === providerID);
    if (!provider || !(modelID in provider.models)) continue;
    return { providerID, modelID };
  }

  return null;
}

function isModelAvailable(providers: Provider[], model: SelectedModel | null) {
  if (!model) return false;
  const provider = providers.find((p) => p.id === model.providerID);
  return !!provider && model.modelID in provider.models;
}

function isAgentAvailable(agents: Agent[], agent: string | null | undefined) {
  if (agent == null) return true;
  return agents.some((candidate) => candidate.name === agent);
}

function selectedModelsEqual(
  a: SelectedModel | null | undefined,
  b: SelectedModel | null | undefined,
) {
  return a?.providerID === b?.providerID && a?.modelID === b?.modelID;
}

function selectedVariantsEqual(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? null) === (b ?? null);
}

function resolveAvailableModel({
  providers,
  providerDefaults,
  sessionModel,
  hasSessionModel,
  currentModel,
  workspaceModel,
}: {
  providers: Provider[];
  providerDefaults: Record<string, string>;
  sessionModel?: SelectedModel | null;
  hasSessionModel: boolean;
  currentModel: SelectedModel | null;
  workspaceModel?: SelectedModel | null;
}) {
  if (hasSessionModel && isModelAvailable(providers, sessionModel ?? null)) {
    return sessionModel;
  }
  if (isModelAvailable(providers, currentModel)) return currentModel;
  if (isModelAvailable(providers, workspaceModel ?? null)) {
    return workspaceModel ?? null;
  }
  return resolveServerDefaultModel(providers, providerDefaults);
}

function resolveAvailableAgent({
  agents,
  sessionAgent,
  hasSessionAgent,
  workspaceAgent,
}: {
  agents: Agent[];
  sessionAgent?: string | null;
  hasSessionAgent: boolean;
  workspaceAgent?: string | null;
}) {
  const preferred = hasSessionAgent ? sessionAgent : workspaceAgent;
  return preferred && isAgentAvailable(agents, preferred) ? preferred : null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const initialWorkspaces: Workspace[] = [];

const initialState: InternalAgentState = {
  workspaces: initialWorkspaces,
  activeWorkspaceId: getActiveWorkspaceId(initialWorkspaces),
  projectWorkspaceMap: {},
  connections: {},
  sessions: [],
  activeSessionId: null,
  messages: [],
  messageHistoryHasMore: false,
  messageHistoryCursor: null,
  isLoadingMessages: false,
  isLoadingOlderMessages: false,
  isBusy: false,
  pendingPermissions: {},
  pendingQuestions: {},
  lastError: null,
  bootState: "idle",
  bootError: null,
  bootLogs: null,
  providers: [],
  providerDefaults: {},
  selectedModel: null,
  busySessionIds: new Set(),
  agents: [],
  selectedAgent: null,
  variantSelections: {},
  commands: [],
  queuedPrompts: {},
  defaultChatDirectory: null,
  draftSessionDirectory: null,
  draftSessionBackendId: null,
  namingSessionIds: new Set(),
  unreadSessionIds: getUnreadSessionIds(),
  sessionDrafts: getSessionDrafts(),
  sessionMeta: getSessionMetaMap(),
  projectMeta: getProjectMetaMap(),
  worktreeParents: getWorktreeParents(),
  pendingWorktreeCleanup: null,
  turnRuns: {},
  activeTurnRunBySession: {},
  childSessions: {},
  trackedChildSessionIds: new Set(),
  _pendingSnapshots: [],
  _sessionBuffers: {},
  afterPartPending: new Set(),
  _afterPartTriggered: new Set(),
  _deletedSessionIds: new Set(),
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function InternalAgentProvider({
  children,
  detachedProject,
}: {
  children: ReactNode;
  detachedProject?: string;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [workspaceStateReady, setWorkspaceStateReady] = useState(false);
  const shellWorkspacePolicy = useMemo(() => getShellWorkspacePolicy(), []);
  const [preferredBackendId, setPreferredBackendId] = useState<AgentBackendId>(() => {
    const stored = storageGet(STORAGE_KEYS.AGENT_BACKEND);
    if (stored === "claude-code") return "claude-code";
    if (stored === "pi") return "pi";
    if (stored === "codex") return "codex";
    return "opencode";
  });

  const openGuiClient = useOpenGuiClient();
  const allBackends = useMemo(() => openGuiClient.agentBackends.list(), [openGuiClient]);
  const backendsById = useMemo(
    () =>
      Object.fromEntries(
        allBackends.map((backend) => [backend.id as AgentBackendId, backend]),
      ) as Record<AgentBackendId, (typeof allBackends)[number]>,
    [allBackends],
  );
  const activeSession = state.activeSessionId
    ? (state.sessions.find((session) => session.id === state.activeSessionId) ?? null)
    : null;
  const activeSessionBackendId = getSessionBackendId(activeSession);
  const creationBackendId = state.draftSessionBackendId ?? preferredBackendId;
  const resourceBackendId = activeSessionBackendId ?? creationBackendId;
  const discoveryBackendIds = useMemo(
    () => allBackends.map((backend) => backend.id as AgentBackendId),
    [allBackends],
  );
  const resourceBridge =
    backendsById[resourceBackendId] ?? openGuiClient.agentBackends.get(resourceBackendId);
  const creationBridge =
    backendsById[creationBackendId] ?? openGuiClient.agentBackends.get(creationBackendId);
  const workspaceProfile = resourceBridge?.workspace;
  const runtime = resourceBridge?.runtime;
  const expectedDirectoriesRef = useRef<Set<string>>(new Set());
  const forcedSessionTitlesRef = useRef<Map<string, string>>(new Map());
  const pendingTitlePersistenceRef = useRef<Map<string, string>>(new Map());
  const sessionIdAliasesRef = useRef<Map<string, string>>(new Map());
  const namingRequestIdsRef = useRef<Map<string, number>>(new Map());

  // Keep refs so selectSession can read current values without stale closures
  const selectedModelRef = useRef(state.selectedModel);
  selectedModelRef.current = state.selectedModel;
  const selectSessionRequestRef = useRef(0);
  const childHydrationVersionRef = useRef<Record<string, number>>({});
  const sessionReconcileRequestRef = useRef<Record<string, number>>({});
  const cleanupSessionRefs = useCallback((sessionIds?: Iterable<string>) => {
    if (!sessionIds) {
      forcedSessionTitlesRef.current.clear();
      pendingTitlePersistenceRef.current.clear();
      sessionIdAliasesRef.current.clear();
      namingRequestIdsRef.current.clear();
      childHydrationVersionRef.current = {};
      sessionReconcileRequestRef.current = {};
      return;
    }
    const ids = new Set(sessionIds);
    for (const id of ids) {
      forcedSessionTitlesRef.current.delete(id);
      pendingTitlePersistenceRef.current.delete(id);
      namingRequestIdsRef.current.delete(id);
      delete childHydrationVersionRef.current[id];
      delete sessionReconcileRequestRef.current[id];
    }
    for (const [alias, target] of sessionIdAliasesRef.current.entries()) {
      if (ids.has(alias) || ids.has(target)) {
        sessionIdAliasesRef.current.delete(alias);
      }
    }
  }, []);
  const loadedResourceProjectKeyRef = useRef<string | null>(null);
  const loadedResourceBackendIdRef = useRef<AgentBackendId | null>(null);
  const resourceLoadRequestRef = useRef(0);
  const resourceLoadInFlightKeyRef = useRef<string | null>(null);
  const projectHydrationRef = useRef<Record<string, ProjectHydrationState>>({});
  const updateProjectHydration = useCallback(
    (
      projectKey: string,
      updater: (current: ProjectHydrationState | undefined) => ProjectHydrationState,
    ) => {
      projectHydrationRef.current[projectKey] = updater(projectHydrationRef.current[projectKey]);
      return projectHydrationRef.current[projectKey];
    },
    [],
  );
  const clearProjectHydration = useCallback((projectKey: string) => {
    delete projectHydrationRef.current[projectKey];
  }, []);

  useEffect(() => {
    return onSettingsChange((change) => {
      if (change.key !== STORAGE_KEYS.AGENT_BACKEND) return;
      if (change.value === "claude-code") {
        setPreferredBackendId("claude-code");
        return;
      }
      if (change.value === "pi") {
        setPreferredBackendId("pi");
        return;
      }
      if (change.value === "codex") {
        setPreferredBackendId("codex");
        return;
      }
      setPreferredBackendId("opencode");
    });
  }, []);

  const workspaceBootstrapRef = useRef(false);
  useEffect(() => {
    if (workspaceBootstrapRef.current) return;
    workspaceBootstrapRef.current = true;
    let cancelled = false;

    void initializeBackendWorkspaceState(openGuiClient)
      .then((workspaces) => {
        if (cancelled) return;
        dispatch({ type: "SET_WORKSPACES", payload: workspaces });
        const activeWorkspaceId = getActiveWorkspaceId(workspaces);
        dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: activeWorkspaceId });
        const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
        const legacyDefaultChatDirectory = getLegacyStoredDefaultChatDirectory();
        dispatch({
          type: "SET_ACTIVE_SESSION",
          payload: activeWorkspace?.lastActiveSessionId ?? null,
        });
        dispatch({
          type: "SET_DEFAULT_CHAT_DIRECTORY",
          payload: getWorkspaceDefaultChatDirectory(activeWorkspace) ?? legacyDefaultChatDirectory,
        });
        setWorkspaceStateReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error) || "Failed to load workspaces",
        });
        setWorkspaceStateReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [openGuiClient]);

  const reloadWorkspaceState = useCallback(
    async (preferredWorkspaceId?: string | null) => {
      const workspaces = await initializeBackendWorkspaceState(openGuiClient);
      dispatch({ type: "SET_WORKSPACES", payload: workspaces });
      const nextActiveWorkspaceId =
        preferredWorkspaceId &&
        workspaces.some((workspace) => workspace.id === preferredWorkspaceId)
          ? preferredWorkspaceId
          : getActiveWorkspaceId(workspaces);
      const nextActiveWorkspace =
        workspaces.find((workspace) => workspace.id === nextActiveWorkspaceId) ??
        workspaces[0] ??
        null;
      dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: nextActiveWorkspaceId });
      dispatch({
        type: "SET_DEFAULT_CHAT_DIRECTORY",
        payload: getWorkspaceDefaultChatDirectory(nextActiveWorkspace),
      });
      return {
        workspaces,
        activeWorkspace: nextActiveWorkspace,
      };
    },
    [openGuiClient],
  );

  // --- Backend event handler ---
  const handleBackendEvent = useCallback(
    (event: BackendEventEnvelope) => {
      if (isQueueEvent(event)) {
        if (Array.isArray(event.entries)) {
          dispatch({
            type: "SET_SESSION_QUEUE",
            payload: { sessionID: event.sessionId, prompts: event.entries },
          });
        } else if (event.type === "queue.cleared") {
          dispatch({ type: "QUEUE_CLEAR", payload: { sessionID: event.sessionId } });
        }
        return;
      }
      if (isCanonicalSessionNotification(event)) {
        // Canonical backend session events are notifications, not a reason to resync every
        // Project/Harness scope. Runtime bridge events carry directory/session payloads and
        // are handled below. Explicit refresh/open/send paths do any needed reconciliation.
        return;
      }
      handleAgentBackendEvent({
        event: toAgentBackendEvent(event),
        expectedProjectKeys: expectedDirectoriesRef.current,
        tracking: {
          forcedTitles: forcedSessionTitlesRef.current,
          pendingTitlePersistence: pendingTitlePersistenceRef.current,
          sessionIdAliases: sessionIdAliasesRef.current,
          namingRequestIds: namingRequestIdsRef.current,
        },
        cleanupSessionRefs,
        renameSession: (input) => openGuiClient.sessions.rename(input),
        dispatch,
      });
    },
    [cleanupSessionRefs, openGuiClient, reloadWorkspaceState],
  );

  const remoteWorkspaceEventSources = useMemo(() => {
    const unique = new Map<string, { baseUrl: string; authToken?: string }>();
    for (const workspace of state.workspaces) {
      if (workspace.isLocal || !workspace.serverUrl.trim()) continue;
      const baseUrl = workspace.serverUrl.trim().replace(/\/+$/, "");
      const key = `${baseUrl}\u0000${workspace.authToken ?? ""}`;
      unique.set(key, { baseUrl, authToken: workspace.authToken });
    }
    return [...unique.values()];
  }, [state.workspaces]);

  // Subscribe to backend events for the local/default Backend and every remote
  // Workspace Backend. HTTP calls can target a remote Workspace, so the SSE
  // stream that marks turns idle must target the same remote Backend too.
  useEffect(() => {
    if (allBackends.length === 0) return;
    const unsubscribers = [openGuiClient.agentBackends.subscribe(handleBackendEvent)];
    for (const remote of remoteWorkspaceEventSources) {
      unsubscribers.push(
        createHttpOpenGuiClient({
          baseUrl: remote.baseUrl,
          token: remote.authToken,
        }).agentBackends.subscribe(handleBackendEvent),
      );
    }
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [allBackends.length, handleBackendEvent, openGuiClient, remoteWorkspaceEventSources]);

  useEffect(() => {
    if (!workspaceStateReady) return;
    persistWorkspaces(state.workspaces);
  }, [state.workspaces, workspaceStateReady]);

  // Persist selectedModel to localStorage whenever it changes (covers
  // both explicit setModel calls and implicit updates from the reducer,
  // e.g. when switching sessions or receiving a new assistant message).
  // The ref guards against the initial render (selectedModel = null) wiping
  // the saved value before bootstrap has a chance to restore it.
  const modelInitialized = useRef(false);
  useEffect(() => {
    if (state.selectedModel) {
      modelInitialized.current = true;
      storageSetJSON(STORAGE_KEYS.SELECTED_MODEL, state.selectedModel);
    } else if (modelInitialized.current) {
      storageRemove(STORAGE_KEYS.SELECTED_MODEL);
    }
  }, [state.selectedModel]);

  useEffect(() => {
    const activeId = state.activeWorkspaceId;
    if (!activeId) return;
    const next = createWorkspaceSelectionSyncPlan({
      workspaces: state.workspaces,
      activeWorkspaceId: activeId,
      selection: {
        selectedModel: state.selectedModel,
        selectedAgent: state.selectedAgent,
      },
    });
    if (!next) return;
    dispatch({ type: "SET_WORKSPACES", payload: next });
  }, [state.activeWorkspaceId, state.selectedAgent, state.selectedModel, state.workspaces]);

  useEffect(() => {
    storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, state.activeWorkspaceId);
  }, [state.activeWorkspaceId]);

  // Persist unreadSessionIds to localStorage whenever it changes
  useEffect(() => {
    persistUnreadSessionIds(state.unreadSessionIds);
  }, [state.unreadSessionIds]);

  useEffect(() => {
    persistSessionDrafts(state.sessionDrafts);
  }, [state.sessionDrafts]);

  // Request notification permission on startup
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {
        /* permission denied or unavailable */
      });
    }
  }, []);

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
    dispatch,
  });

  useEffect(() => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    const existing = state.sessionMeta[sessionId] ?? {};
    const nextSelectedVariant = currentVariant ?? null;
    if (
      selectedModelsEqual(existing.selectedModel, state.selectedModel) &&
      existing.selectedAgent === state.selectedAgent &&
      selectedVariantsEqual(existing.selectedVariant, nextSelectedVariant)
    ) {
      return;
    }
    dispatch({
      type: "SET_SESSION_META",
      payload: {
        sessionId,
        meta: {
          selectedModel: state.selectedModel,
          selectedAgent: state.selectedAgent,
          selectedVariant: nextSelectedVariant,
        },
      },
    });
  }, [
    currentVariant,
    dispatch,
    state.activeSessionId,
    state.selectedAgent,
    state.selectedModel,
    state.sessionMeta,
  ]);

  // --- Actions ---

  const loadServerResources = useCallback(
    async (backendId: AgentBackendId, directory?: string | null, workspaceId?: string | null) => {
      const targetDirectory = directory?.trim() || undefined;
      const targetWorkspaceId = workspaceId?.trim() || undefined;
      const projectKey = targetDirectory ? makeProjectKey(targetWorkspaceId, targetDirectory) : "";
      const loadKey = `${backendId}\u0000${projectKey}`;
      if (
        resourceLoadInFlightKeyRef.current === loadKey ||
        (loadedResourceBackendIdRef.current === backendId &&
          loadedResourceProjectKeyRef.current === (targetDirectory ? projectKey : null))
      ) {
        return;
      }
      resourceLoadInFlightKeyRef.current = loadKey;
      const requestId = ++resourceLoadRequestRef.current;
      try {
        const { providersData, agentsData, commandsData } =
          await openGuiClient.agentBackends.loadResources({
            backendId,
            target: {
              directory: targetDirectory,
              workspaceId: targetWorkspaceId,
            },
          });

        if (requestId !== resourceLoadRequestRef.current) return;

        loadedResourceProjectKeyRef.current = targetDirectory ? projectKey : null;
        loadedResourceBackendIdRef.current = backendId;
        dispatch({ type: "SET_PROVIDERS", payload: providersData });

        const activeSessionId = stateRef.current.activeSessionId;
        const activeSession = activeSessionId
          ? stateRef.current.sessions.find((session) => session.id === activeSessionId)
          : null;
        const activeSessionModel = getSessionSelectedModel(activeSession);
        const activeSessionAgent = getSessionSelectedAgent(activeSession);
        const activeSessionMeta = activeSessionId
          ? stateRef.current.sessionMeta[activeSessionId]
          : undefined;
        const activeWorkspace = stateRef.current.workspaces.find(
          (workspace) => workspace.id === stateRef.current.activeWorkspaceId,
        );
        const nextSelection = resolveAvailableModel({
          providers: providersData.providers,
          providerDefaults: providersData.default,
          sessionModel: activeSessionModel ?? activeSessionMeta?.selectedModel,
          hasSessionModel: Boolean(
            activeSessionModel ||
            (activeSessionMeta && Object.hasOwn(activeSessionMeta, "selectedModel")),
          ),
          currentModel: selectedModelRef.current,
          workspaceModel:
            activeWorkspace?.selectedModel ??
            storageParsed<SelectedModel>(STORAGE_KEYS.SELECTED_MODEL),
        });
        dispatch({
          type: "SET_SELECTED_MODEL",
          payload: nextSelection ?? null,
        });

        dispatch({ type: "SET_AGENTS", payload: agentsData });
        const nextAgent = resolveAvailableAgent({
          agents: agentsData,
          sessionAgent: activeSessionAgent ?? activeSessionMeta?.selectedAgent,
          hasSessionAgent: Boolean(
            activeSessionAgent ||
            (activeSessionMeta && Object.hasOwn(activeSessionMeta, "selectedAgent")),
          ),
          workspaceAgent: activeWorkspace?.selectedAgent ?? storageGet(STORAGE_KEYS.SELECTED_AGENT),
        });
        dispatch({ type: "SET_SELECTED_AGENT", payload: nextAgent });

        let nextVariantSelections =
          storageParsed<VariantSelections>(STORAGE_KEYS.VARIANT_SELECTIONS) ??
          stateRef.current.variantSelections;
        const activeSessionVariant = getSessionSelectedVariant(activeSession);
        const hasSessionVariant =
          Boolean(activeSessionModel) ||
          Boolean(activeSessionMeta && Object.hasOwn(activeSessionMeta, "selectedVariant"));
        if (hasSessionVariant && nextSelection) {
          const key = variantKey(nextSelection.providerID, nextSelection.modelID);
          const desiredVariant = activeSessionModel
            ? (activeSessionVariant ??
              (selectedModelsEqual(activeSessionModel, activeSessionMeta?.selectedModel)
                ? (activeSessionMeta?.selectedVariant ?? undefined)
                : undefined))
            : (activeSessionMeta?.selectedVariant ?? undefined);
          if (nextVariantSelections[key] !== desiredVariant) {
            nextVariantSelections = updateVariantSelections(
              nextVariantSelections,
              key,
              desiredVariant,
            );
          }
        }
        if (nextVariantSelections !== stateRef.current.variantSelections) {
          dispatch({
            type: "SET_VARIANT_SELECTIONS",
            payload: nextVariantSelections,
          });
        }

        dispatch({ type: "SET_COMMANDS", payload: commandsData });
      } catch (error) {
        if (requestId !== resourceLoadRequestRef.current) return;
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error),
        });
      } finally {
        if (resourceLoadInFlightKeyRef.current === loadKey) {
          resourceLoadInFlightKeyRef.current = null;
        }
      }
    },
    [openGuiClient],
  );

  const hydrateProjectBackend = useCallback(
    async ({
      config,
      workspaceId,
      projectKey,
      backendId,
      suppressError,
      connectionKind,
    }: {
      config: ConnectionConfig;
      workspaceId: string;
      projectKey: string;
      backendId: AgentBackendId;
      suppressError?: boolean;
      connectionKind?: ConnectionStatus["kind"];
    }) => {
      const connection = createProjectConnectionDescriptor({ config, workspaceId });
      updateProjectHydration(projectKey, (current) => startProjectHydration(current, [backendId]));
      try {
        const connectResult = await openGuiClient.agentBackends.connectProject({
          config: connection.config,
          backendIds: [backendId],
        });
        const connectionError =
          connectResult.connectedBackendIds.length === 0
            ? connectResult.errors[0]?.error || "Connection failed"
            : null;

        dispatch({
          type: "SET_PROJECT_CONNECTION",
          payload: {
            projectKey,
            status: createProjectConnectionStatus(
              connectionError ? "error" : "connected",
              connection.config.baseUrl,
              connectionKind ?? "project",
              connectionError ?? undefined,
            ),
          },
        });

        // History is server data, not a live backend capability.  Desktop and
        // mobile should both show the same sessions for a remote workspace even
        // when a specific agent backend is currently unhealthy/unavailable for
        // new work.  Keep loading the session index after a failed connect and
        // only mark the backend hydration as failed after history has merged.
        const sessionResults = await openGuiClient.agentBackends.listProjectSessions({
          backendIds: [backendId],
          target: connection.target,
        });
        const sessions = sessionResults[0]?.sessions ?? [];
        dispatch({
          type: "MERGE_PROJECT_SESSIONS",
          payload: {
            projectKey,
            directory: connection.directory,
            sessions,
            backendIds: [backendId],
          },
        });

        if (connectionError) {
          updateProjectHydration(projectKey, (current) =>
            settleProjectHydration(current, {
              failedBackends: { [backendId]: connectionError },
            }),
          );
          return { backendId, success: false as const, error: connectionError };
        }

        try {
          const queuedPromptsBySession = await openGuiClient.sessions.queue.listProject({
            backendId,
            target: connection.target,
          });
          for (const [sessionId, prompts] of Object.entries(queuedPromptsBySession)) {
            dispatch({
              type: "SET_SESSION_QUEUE",
              payload: { sessionID: sessionId, prompts },
            });
          }
        } catch {
          /* queue load best effort */
        }

        try {
          const statuses = await openGuiClient.agentBackends.listProjectSessionStatuses({
            backendIds: [backendId],
            target: connection.target,
          });
          dispatch({
            type: "INIT_BUSY_SESSIONS",
            payload: statuses,
          });
        } catch {
          /* ignore – spinner will appear on next backend event */
        }

        updateProjectHydration(projectKey, (current) =>
          settleProjectHydration(current, {
            completedBackendIds: [backendId],
          }),
        );
        return { backendId, success: true as const };
      } catch (error) {
        const errorMessage = getErrorMessage(error) || "Connection failed";
        updateProjectHydration(projectKey, (current) =>
          settleProjectHydration(current, {
            failedBackends: { [backendId]: errorMessage },
          }),
        );
        if (!suppressError) {
          dispatch({ type: "SET_ERROR", payload: errorMessage });
        }
        return { backendId, success: false as const, error: errorMessage };
      }
    },
    [openGuiClient, updateProjectHydration],
  );

  const addProject = useCallback(
    async (
      config: ConnectionConfig,
      options?: {
        suppressError?: boolean;
        hidden?: boolean;
        transient?: boolean;
        backendIds?: AgentBackendId[];
      },
    ) => {
      if (allBackends.length === 0 || !config.directory) return;
      const workspaceId =
        config.workspaceId ?? stateRef.current.activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
      const connection = createProjectConnectionDescriptor({ config, workspaceId });
      const projectKey = connection.projectKey;
      const workspace =
        stateRef.current.workspaces.find((candidate) => candidate.id === connection.workspaceId) ??
        resolveConnectionWorkspace(stateRef.current.workspaces, connection.workspaceId);
      const connectionKind: ConnectionStatus["kind"] =
        options?.transient === true && !workspace.projects.includes(connection.directory)
          ? "chat-infra"
          : "project";
      dispatch({
        type: "SET_PROJECT_META",
        payload: { projectKey, meta: { hidden: options?.hidden === true } },
      });
      dispatch({
        type: "ASSIGN_PROJECT_WORKSPACE",
        payload: { projectKey, workspaceId: connection.workspaceId },
      });
      expectedDirectoriesRef.current.add(projectKey);
      if (!options?.suppressError) {
        dispatch({ type: "SET_ERROR", payload: null });
      }
      dispatch({
        type: "SET_PROJECT_CONNECTION",
        payload: {
          projectKey,
          status: createProjectConnectionStatus(
            "connecting",
            connection.config.baseUrl,
            connectionKind,
          ),
        },
      });
      const currentHydration = projectHydrationRef.current[projectKey];
      const requestedBackendIds = options?.backendIds?.length
        ? options.backendIds
        : discoveryBackendIds;
      const targetBackendIds = options?.backendIds?.length
        ? requestedBackendIds.filter((backendId) => {
            const completed = currentHydration?.completedBackendIds.includes(backendId) ?? false;
            const loading = currentHydration?.loadingBackendIds.includes(backendId) ?? false;
            return !completed && !loading;
          })
        : getPendingProjectHydrationBackendIds(currentHydration, requestedBackendIds);
      if (targetBackendIds.length === 0) {
        return;
      }

      const hydrationResults = await Promise.allSettled(
        targetBackendIds.map(
          async (backendId) =>
            await hydrateProjectBackend({
              config: connection.config,
              workspaceId: connection.workspaceId,
              projectKey,
              backendId,
              suppressError: options?.suppressError,
              connectionKind,
            }),
        ),
      );
      const successfulHydrations = hydrationResults.flatMap((result) =>
        result.status === "fulfilled" && result.value.success ? [result.value] : [],
      );
      const failedHydrations = hydrationResults.flatMap((result) => {
        if (result.status === "rejected") {
          return [{ error: getErrorMessage(result.reason) || "Connection failed" }];
        }
        return result.value.success ? [] : [{ error: result.value.error || "Connection failed" }];
      });
      if (
        successfulHydrations.length === 0 &&
        targetBackendIds.length === discoveryBackendIds.length
      ) {
        expectedDirectoriesRef.current.delete(projectKey);
        const firstError = failedHydrations[0]?.error || "Connection failed";
        const isMissingDirectoryError =
          firstError.includes("ENOENT") ||
          firstError.includes("Path outside OPENGUI_ALLOWED_ROOTS");

        if (isMissingDirectoryError) {
          const normalizedDirectory = connection.directory;
          const normalizedDefaultChatDirectory = normalizeProjectPath(
            stateRef.current.defaultChatDirectory ?? "",
          );

          if (
            normalizedDirectory &&
            normalizedDefaultChatDirectory &&
            normalizedDirectory === normalizedDefaultChatDirectory
          ) {
            setDefaultChatDirectory(null);
            if (stateRef.current.draftSessionDirectory === normalizedDirectory) {
              dispatch({ type: "CLEAR_DRAFT_SESSION" });
            }
          }

          if (workspace.projects.includes(connection.directory) && options?.transient !== true) {
            dispatch({
              type: "REMOVE_PROJECT",
              payload: { projectKey, directory: connection.directory },
            });
            // Removing a Project connection is frontend-local presentation state.
            // Do not delete the backend Project or its shared Sessions when a path
            // temporarily fails to resolve.
          }
        }

        if (!options?.suppressError) {
          dispatch({
            type: "SET_ERROR",
            payload: firstError,
          });
        }
        return;
      }

      const worktreeParentMap = getWorktreeParents();
      const connectionPlan = createWorkspaceProjectConnectionPlan({
        directory: connection.directory,
        workspaceId: connection.workspaceId,
        worktreeParents: worktreeParentMap,
      });
      if (connectionPlan.workspaceProjectDirectory && shouldPersistWorkspaceProject(options)) {
        dispatch({
          type: "ADD_WORKSPACE_PROJECT",
          payload: {
            workspaceId: connection.workspaceId,
            directory: connectionPlan.workspaceProjectDirectory,
            serverUrl: connection.config.baseUrl,
            username: connection.config.username,
            password: connection.config.password,
          },
        });
      }
      if (shouldPersistLocalConnectionSettings(workspace.isLocal, options)) {
        storageSet(STORAGE_KEYS.SERVER_URL, connection.config.baseUrl);
        storageSetOrRemove(STORAGE_KEYS.USERNAME, connection.config.username);
      }
    },
    [allBackends, discoveryBackendIds, hydrateProjectBackend],
  );

  const ensureDirectoryConnection = useCallback(
    async (
      directory: string,
      options?: { hidden?: boolean; transient?: boolean; backendIds?: AgentBackendId[] },
    ) => {
      const normalizedDirectory = normalizeProjectPath(directory);
      if (!normalizedDirectory) return;
      const workspace = resolveConnectionWorkspace(
        stateRef.current.workspaces,
        stateRef.current.activeWorkspaceId,
      );
      const workspaceId = workspace.id;
      const projectKey = makeProjectKey(workspaceId, normalizedDirectory);
      const status = stateRef.current.connections[projectKey];
      const requestedBackendIds = options?.backendIds?.length
        ? options.backendIds
        : discoveryBackendIds;
      const currentHydration = projectHydrationRef.current[projectKey];
      const missingBackendIds = getPendingProjectHydrationBackendIds(
        currentHydration,
        requestedBackendIds,
      );
      const completedRequestedBackends = requestedBackendIds.every(
        (backendId) => currentHydration?.completedBackendIds.includes(backendId) ?? false,
      );
      if (missingBackendIds.length === 0) {
        const hasInFlightHydration = hasProjectHydrationInFlight(
          currentHydration,
          requestedBackendIds,
        );
        if (
          hasInFlightHydration ||
          (completedRequestedBackends &&
            (status?.state === "connected" || status?.state === "connecting"))
        ) {
          return;
        }
      }
      await addProject(
        createWorkspaceConnectionConfig({
          workspace,
          directory: normalizedDirectory,
        }),
        {
          suppressError: true,
          hidden: options?.hidden,
          transient: options?.transient,
          backendIds: missingBackendIds.length > 0 ? missingBackendIds : requestedBackendIds,
        },
      );

      if (options?.backendIds?.length) {
        const nextHydration = projectHydrationRef.current[projectKey];
        const completedExplicitBackends = requestedBackendIds.every(
          (backendId) => nextHydration?.completedBackendIds.includes(backendId) ?? false,
        );
        const stillLoadingExplicitBackends = hasProjectHydrationInFlight(
          nextHydration,
          requestedBackendIds,
        );
        if (!completedExplicitBackends && !stillLoadingExplicitBackends) {
          const firstError = requestedBackendIds
            .map((backendId) => nextHydration?.errors?.[backendId])
            .find((value) => typeof value === "string" && value.length > 0);
          throw new Error(firstError || "Connection failed");
        }
      }
    },
    [addProject, discoveryBackendIds],
  );

  const restartAgentBackends = useCallback(async () => {
    const snapshot = Object.entries(stateRef.current.connections)
      .map(([projectKey, status]) => {
        const { workspaceId, directory } = parseProjectKey(projectKey);
        const workspace =
          stateRef.current.workspaces.find((candidate) => candidate.id === workspaceId) ??
          resolveConnectionWorkspace(stateRef.current.workspaces, workspaceId);
        return { projectKey, workspace, directory, status };
      })
      .filter(({ status, workspace, directory }) =>
        shouldSnapshotProjectConnectionForRestart({ status, workspace, directory }),
      );

    dispatch({ type: "SET_ERROR", payload: null });
    const restartResults = await openGuiClient.agentBackends.restart();
    const failedRestarts = Object.entries(restartResults).filter(([, result]) => !result.success);
    if (failedRestarts.length > 0) {
      const message = failedRestarts
        .map(([backendId, result]) => `${backendId}: ${result.error || "restart failed"}`)
        .join("; ");
      dispatch({ type: "SET_ERROR", payload: message });
      throw new Error(message);
    }
    projectHydrationRef.current = {};

    await Promise.allSettled(
      snapshot.map(async ({ projectKey, workspace, directory }) => {
        const connectionKind = stateRef.current.connections[projectKey]?.kind ?? "project";
        dispatch({
          type: "SET_PROJECT_CONNECTION",
          payload: {
            projectKey,
            status: createProjectConnectionStatus(
              "connecting",
              workspace.serverUrl,
              connectionKind,
            ),
          },
        });
        await addProject(createWorkspaceConnectionConfig({ workspace, directory }), {
          suppressError: true,
          hidden: stateRef.current.projectMeta[projectKey]?.hidden === true,
          backendIds: discoveryBackendIds,
        });
      }),
    );

    const defaultChatDirectory = stateRef.current.defaultChatDirectory;
    if (defaultChatDirectory && !detachedProject) {
      await ensureDirectoryConnection(defaultChatDirectory, { transient: true });
    }
  }, [addProject, detachedProject, discoveryBackendIds, ensureDirectoryConnection, openGuiClient]);

  const ensureDefaultChatConnection = useCallback(async () => {
    const defaultChatDirectory = stateRef.current.defaultChatDirectory;
    if (!defaultChatDirectory || detachedProject) return;
    await ensureDirectoryConnection(defaultChatDirectory, {
      transient: true,
    });
  }, [detachedProject, ensureDirectoryConnection]);

  const removeProject = useCallback(
    async (directory: string) => {
      if (allBackends.length === 0) return;
      const workspaceId = stateRef.current.activeWorkspaceId;
      const worktreeParentMap = getWorktreeParents();
      const { directoriesToRemove } = createProjectRemovalPlan({
        directory,
        worktreeParents: worktreeParentMap,
      });

      for (const dir of directoriesToRemove) {
        const projectKey = makeProjectKey(workspaceId, dir);
        const isExplicitWorkspaceProject = stateRef.current.workspaces.some(
          (workspace) => workspace.id === workspaceId && workspace.projects.includes(dir),
        );
        const removedSessionIds = isExplicitWorkspaceProject
          ? stateRef.current.sessions
              .filter((session) => {
                if (getSessionWorkspaceId(session) !== workspaceId) return false;
                const sessionDir = session._projectDir ?? session.directory;
                if (sessionDir !== dir) return false;
                const meta = stateRef.current.sessionMeta[session.id];
                if (meta?.assignedProjectDir && meta.assignedProjectDir !== dir) return false;
                return true;
              })
              .map((session) => session.id)
          : [];
        cleanupSessionRefs(removedSessionIds);
        expectedDirectoriesRef.current.delete(projectKey);
        clearProjectHydration(projectKey);
        await openGuiClient.agentBackends.disconnectProject({
          target: { directory: dir, workspaceId },
        });
        dispatch({
          type: "REMOVE_PROJECT",
          payload: { projectKey, directory: dir },
        });
      }

      const workspace = stateRef.current.workspaces.find((item) => item.id === workspaceId);
      if (workspace) {
        const hiddenProjects = new Set(
          ((workspace.settings?.hiddenProjects as string[] | undefined) ?? []).filter(Boolean),
        );
        for (const dir of directoriesToRemove) hiddenProjects.add(dir);
        void openGuiClient.workspaces.update(workspaceId, {
          settings: {
            ...workspace.settings,
            hiddenProjects: [...hiddenProjects],
          },
        });
      }

      // If the active session belongs to an explicitly removed project, clear it
      const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
      const removedExplicitProject = stateRef.current.workspaces.some(
        (workspace) => workspace.id === workspaceId && workspace.projects.includes(directory),
      );
      if (
        removedExplicitProject &&
        (activeSession?._projectDir ?? activeSession?.directory) === directory &&
        getSessionWorkspaceId(activeSession) === workspaceId
      ) {
        dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
      }
    },
    [
      allBackends,
      cleanupSessionRefs,
      clearProjectHydration,
      openGuiClient,
      state.sessions,
      state.activeSessionId,
    ],
  );

  const loadSessionIndex = useCallback(
    async (
      projects: Array<{
        workspaceId: string;
        directory: string;
        baseUrl?: string;
        authToken?: string;
      }>,
      harnessIds: AgentBackendId[] = discoveryBackendIds,
    ) => {
      const uniqueProjects = Array.from(
        new Map(
          projects
            .map((project) => ({
              workspaceId: project.workspaceId,
              directory: normalizeProjectPath(project.directory),
              baseUrl: project.baseUrl,
              authToken: project.authToken,
            }))
            .filter((project) => project.directory)
            .map((project) => [makeProjectKey(project.workspaceId, project.directory), project]),
        ).values(),
      );
      if (uniqueProjects.length === 0 || harnessIds.length === 0) return;

      await runWithConcurrency(uniqueProjects, 4, async (project) => {
        const results = await openGuiClient.agentBackends.listProjectSessions({
          backendIds: harnessIds,
          target: {
            directory: project.directory,
            workspaceId: project.workspaceId,
            baseUrl: project.baseUrl,
            authToken: project.authToken,
          },
        });

        for (const item of results) {
          dispatch({
            type: "MERGE_PROJECT_SESSIONS",
            payload: {
              projectKey: makeProjectKey(project.workspaceId, project.directory),
              directory: project.directory,
              sessions: item.sessions,
              backendIds: [item.backendId],
            },
          });
        }
      });
    },
    [discoveryBackendIds, openGuiClient],
  );

  // --- Startup bootstrap: ensure local server, then auto-connect open projects ---
  const startupAttempted = useRef(false);
  useEffect(() => {
    if (!workspaceStateReady || startupAttempted.current) return;
    startupAttempted.current = true;
    let cancelled = false;

    const bootstrap = async () => {
      const localServerBackend =
        allBackends.find((backend) => backend.capabilities.localServer) ?? null;
      const localServerPlatform = localServerBackend?.platform;
      const shouldEnsureLocalServer =
        shellWorkspacePolicy.localWorkspaceMode === "desktop-local" &&
        Boolean(localServerBackend) &&
        isLocalServer();
      if (shouldEnsureLocalServer) {
        dispatch({
          type: "SET_BOOT_STATE",
          payload: { state: "checking-server" },
        });

        if (!localServerPlatform?.server) {
          if (cancelled) return;
          dispatch({
            type: "SET_BOOT_STATE",
            payload: {
              state: "error",
              error: "Backend does not support local server control",
            },
          });
          return;
        }
        let status: { running: boolean };
        try {
          status = await localServerPlatform.server.status();
        } catch (error) {
          if (cancelled) return;
          dispatch({
            type: "SET_BOOT_STATE",
            payload: {
              state: "error",
              error: getErrorMessage(error),
            },
          });
          return;
        }

        if (!status.running) {
          dispatch({
            type: "SET_BOOT_STATE",
            payload: { state: "starting-server" },
          });
          try {
            await localServerPlatform.server.start();
          } catch (error) {
            if (cancelled) return;
            dispatch({
              type: "SET_BOOT_STATE",
              payload: {
                state: "error",
                error: getErrorMessage(error),
              },
            });
            return;
          }
        }
      }

      if (cancelled) return;
      dispatch({ type: "SET_ERROR", payload: null });
      try {
        const worktreeParentMap = getWorktreeParents();
        const { projectConfigs: allProjectConfigs, expectedProjectKeys } =
          buildBootstrapProjectConfigs({
            workspaces: stateRef.current.workspaces,
            detachedProject,
            worktreeParents: worktreeParentMap,
          });
        expectedDirectoriesRef.current = new Set([
          ...expectedDirectoriesRef.current,
          ...expectedProjectKeys,
        ]);

        if (cancelled) return;
        dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });

        for (const item of allProjectConfigs) {
          const projectKey = makeProjectKey(item.workspaceId, item.directory);
          dispatch({
            type: "SET_PROJECT_META",
            payload: { projectKey, meta: { hidden: false } },
          });
          dispatch({
            type: "ASSIGN_PROJECT_WORKSPACE",
            payload: { projectKey, workspaceId: item.workspaceId },
          });
          dispatch({
            type: "SET_PROJECT_CONNECTION",
            payload: {
              projectKey,
              status: createProjectConnectionStatus("connected", item.baseUrl, "project"),
            },
          });
          updateProjectHydration(projectKey, (current) =>
            settleProjectHydration(current, { completedBackendIds: discoveryBackendIds }),
          );
        }

        void loadSessionIndex(allProjectConfigs, discoveryBackendIds).catch(() => {
          /* startup session index is best effort */
        });
      } catch {
        /* ignore localStorage errors */
        if (!cancelled) dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [
    allBackends,
    detachedProject,
    discoveryBackendIds,
    loadSessionIndex,
    updateProjectHydration,
    workspaceStateReady,
    shellWorkspacePolicy.localWorkspaceMode,
  ]);

  useEffect(() => {
    if (allBackends.length === 0 || detachedProject) return;
    if (!state.defaultChatDirectory) return;
    void ensureDefaultChatConnection();
  }, [
    allBackends.length,
    detachedProject,
    ensureDefaultChatConnection,
    state.defaultChatDirectory,
  ]);

  useEffect(() => {
    if (detachedProject) return;
    if (state.activeSessionId || state.draftSessionDirectory) return;
    if (!state.defaultChatDirectory) return;
    dispatch({
      type: "START_DRAFT_SESSION",
      payload: {
        directory: state.defaultChatDirectory,
        backendId: preferredBackendId,
      },
    });
  }, [
    detachedProject,
    preferredBackendId,
    state.activeSessionId,
    state.draftSessionDirectory,
    state.defaultChatDirectory,
  ]);

  const activeWorkspace = useMemo(
    () =>
      state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
      state.workspaces[0] ??
      null,
    [state.workspaces, state.activeWorkspaceId],
  );

  const activeWorkspaceProjectSet = useMemo(() => {
    const directories = new Set<string>();
    if (!activeWorkspace) return directories;
    for (const project of activeWorkspace.projects) {
      directories.add(project);
    }
    for (const [projectKey, workspaceIds] of Object.entries(state.projectWorkspaceMap)) {
      if (workspaceIds?.has(activeWorkspace.id)) {
        directories.add(parseProjectKey(projectKey).directory);
      }
    }
    return directories;
  }, [activeWorkspace, state.projectWorkspaceMap]);

  const activeWorkspaceConnections = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(state.connections).filter(([projectKey]) =>
          state.projectWorkspaceMap[projectKey]?.has(activeWorkspace?.id ?? ""),
        ),
      ),
    [state.connections, state.projectWorkspaceMap, activeWorkspace?.id],
  );

  const visibleWorkspaceConnections = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(activeWorkspaceConnections).filter(([projectKey]) => {
          const { workspaceId, directory } = parseProjectKey(projectKey);
          return (
            activeWorkspace?.projects.includes(directory) &&
            !isHiddenProject(state.projectMeta, workspaceId, directory)
          );
        }),
      ),
    [activeWorkspaceConnections, activeWorkspace?.projects, state.projectMeta],
  );

  const visibleActiveWorkspaceProjectSet = useMemo(() => {
    const directories = new Set<string>();
    for (const directory of activeWorkspaceProjectSet) {
      if (!isHiddenProject(state.projectMeta, activeWorkspace?.id, directory)) {
        directories.add(directory);
      }
    }
    return directories;
  }, [activeWorkspaceProjectSet, activeWorkspace?.id, state.projectMeta]);

  const activeWorkspaceSessions = useMemo(
    () =>
      state.sessions.filter((session) => {
        if (!activeWorkspace) return false;
        const assignedProjectDir = state.sessionMeta[session.id]?.assignedProjectDir;
        if (
          assignedProjectDir &&
          activeWorkspaceProjectSet.has(normalizeProjectPath(assignedProjectDir))
        ) {
          return true;
        }
        if (getSessionWorkspaceId(session)) {
          return getSessionWorkspaceId(session) === activeWorkspace.id;
        }
        const directory = session._projectDir ?? session.directory;
        return activeWorkspaceProjectSet.has(directory);
      }),
    [state.sessions, state.sessionMeta, activeWorkspace, activeWorkspaceProjectSet],
  );

  const workspaceDirectory = useMemo(() => {
    const connectedDirectories = Object.entries(visibleWorkspaceConnections)
      .filter(([, status]) => status.state === "connected")
      .map(([projectKey]) => parseProjectKey(projectKey).directory);
    const rootDirectories = connectedDirectories.filter(
      (directory) => !state.worktreeParents[directory],
    );
    if (rootDirectories.length > 0) return rootDirectories[0] ?? null;
    if (connectedDirectories.length > 0) {
      return getWorkspaceRootDirectory(connectedDirectories[0]!, state.worktreeParents);
    }
    return state.draftSessionDirectory &&
      visibleActiveWorkspaceProjectSet.has(state.draftSessionDirectory)
      ? getWorkspaceRootDirectory(state.draftSessionDirectory, state.worktreeParents)
      : null;
  }, [
    visibleWorkspaceConnections,
    visibleActiveWorkspaceProjectSet,
    state.worktreeParents,
    state.draftSessionDirectory,
  ]);

  const workspaceConnection = useMemo(() => {
    if (workspaceDirectory) {
      const match = Object.entries(visibleWorkspaceConnections).find(
        ([projectKey]) => parseProjectKey(projectKey).directory === workspaceDirectory,
      );
      return match?.[1] ?? null;
    }
    if (!activeWorkspace) return null;
    return {
      state: "idle",
      serverUrl: activeWorkspace.serverUrl,
      serverVersion: null,
      error: null,
      lastEventAt: null,
    } satisfies ConnectionStatus;
  }, [visibleWorkspaceConnections, workspaceDirectory, activeWorkspace]);

  const connectedDirectorySet = useMemo(
    () =>
      new Set(
        Object.keys(state.connections)
          .filter(
            (projectKey) => parseProjectKey(projectKey).workspaceId === (activeWorkspace?.id ?? ""),
          )
          .map((projectKey) => parseProjectKey(projectKey).directory),
      ),
    [state.connections, activeWorkspace?.id],
  );

  const activeResourceSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId),
    [state.sessions, state.activeSessionId],
  );

  const activeResourceDirectory = useMemo(() => {
    const sessionDirectory = getSessionDirectory(activeResourceSession);
    if (sessionDirectory) return sessionDirectory;
    if (state.draftSessionDirectory) return state.draftSessionDirectory;

    return workspaceDirectory;
  }, [activeResourceSession, state.draftSessionDirectory, workspaceDirectory]);
  const activeResourceBackendId =
    getSessionBackendId(activeResourceSession) ?? state.draftSessionBackendId ?? preferredBackendId;

  useEffect(() => {
    if (!resourceBridge || !activeResourceDirectory) return;
    const activeProjectKey = makeProjectKey(activeWorkspace?.id, activeResourceDirectory);
    if (!(activeProjectKey in state.connections)) return;
    if (
      loadedResourceBackendIdRef.current === activeResourceBackendId &&
      loadedResourceProjectKeyRef.current ===
        makeProjectKey(activeWorkspace?.id, activeResourceDirectory)
    )
      return;
    void loadServerResources(activeResourceBackendId, activeResourceDirectory, activeWorkspace?.id);
  }, [
    resourceBridge,
    activeResourceBackendId,
    activeResourceDirectory,
    activeWorkspace?.id,
    loadServerResources,
    state.connections,
  ]);

  const openDirectory = useCallback(async (): Promise<string | null> => {
    if (!(workspaceProfile?.kind === "local-cli" || activeWorkspace?.isLocal)) {
      return null;
    }
    return await openGuiClient.desktop.openDirectory();
  }, [workspaceProfile?.kind, activeWorkspace?.isLocal, openGuiClient]);

  const connectToProject = useCallback(
    async (
      directory: string,
      serverUrl?: string,
      usernameOverride?: string,
      passwordOverride?: string,
    ) => {
      const trimmedDirectory = normalizeProjectPath(directory);
      if (!trimmedDirectory) return;
      const workspace = resolveConnectionWorkspace(
        stateRef.current.workspaces,
        stateRef.current.activeWorkspaceId,
      );
      const url = serverUrl ?? workspace.serverUrl ?? DEFAULT_SERVER_URL;
      const normalizedUrl = url.replace(/\/+$/, "");
      const username = usernameOverride ?? workspace.username ?? undefined;
      const password = passwordOverride ?? workspace.password ?? undefined;
      const authToken = workspace.authToken ?? undefined;
      const workspaceId = workspace.id;
      const localServerApi = backendsById[preferredBackendId]?.platform?.server;
      if (
        workspace.isLocal &&
        localServerApi &&
        (normalizedUrl === DEFAULT_SERVER_URL ||
          normalizedUrl === "http://127.0.0.1:4096" ||
          normalizedUrl === "http://localhost:4096")
      ) {
        await localServerApi.start();
      }
      const worktreeParentMap = getWorktreeParents();
      const connectionPlan = createWorkspaceProjectConnectionPlan({
        directory: trimmedDirectory,
        workspaceId,
        worktreeParents: worktreeParentMap,
        connectedDirectories: connectedDirectorySet,
      });
      const targetWorkspace = connectionPlan.rootDirectory;
      const relatedWorktrees = connectionPlan.relatedWorktrees;
      const activeWorkspaceProjects = new Set(workspace.projects);

      if (activeWorkspaceProjects.has(targetWorkspace)) {
        expectedDirectoriesRef.current = new Set([
          ...expectedDirectoriesRef.current,
          ...connectionPlan.expectedProjectKeys,
        ]);
        const missingDirectories = connectionPlan.missingDirectories;
        await Promise.allSettled(
          missingDirectories.map((dir) =>
            addProject({
              workspaceId,
              baseUrl: url,
              directory: dir,
              username: username || undefined,
              password: password || undefined,
              authToken,
            }),
          ),
        );
        await loadSessionIndex(
          connectionPlan.desiredDirectories.map((dir) => ({
            workspaceId,
            directory: dir,
            baseUrl: url,
            authToken,
          })),
        );
        return;
      }

      expectedDirectoriesRef.current = new Set([
        ...expectedDirectoriesRef.current,
        ...connectionPlan.expectedProjectKeys,
      ]);
      await addProject({
        workspaceId,
        baseUrl: url,
        directory: targetWorkspace,
        username: username || undefined,
        password: password || undefined,
        authToken,
      });

      await Promise.allSettled(
        relatedWorktrees
          .filter((worktreeDir) => worktreeDir !== targetWorkspace)
          .map((worktreeDir) =>
            addProject({
              workspaceId,
              baseUrl: url,
              directory: worktreeDir,
              username: username || undefined,
              password: password || undefined,
              authToken,
            }),
          ),
      );
      if (shouldPersistLocalConnectionSettings(workspace.isLocal)) {
        storageSetOrRemove(STORAGE_KEYS.USERNAME, username);
        storageSet(STORAGE_KEYS.SERVER_URL, url);
      }
    },
    [addProject, backendsById, preferredBackendId, connectedDirectorySet, loadSessionIndex],
  );

  // Single ref to avoid stale closures and prevent unnecessary callback recreation
  const stateRef = useRef(state);
  stateRef.current = state;

  const forceSessionTitle = useCallback(
    (sessionId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      const canonicalSessionId = resolveCurrentSessionId(sessionId);
      forcedSessionTitlesRef.current.set(canonicalSessionId, trimmed);
      const current = stateRef.current.sessions.find(
        (session) => session.id === canonicalSessionId || session.id === sessionId,
      );
      if (current && current.title !== trimmed) {
        dispatch({
          type: "SESSION_UPDATED",
          payload: { ...current, title: trimmed },
        });
      }
      openGuiClient.sessions
        .rename({
          sessionId: canonicalSessionId,
          title: trimmed,
          backendId:
            getSessionBackendId(current) ?? getAgentBackendIdFromSessionId(sessionId) ?? undefined,
          target: (() => {
            const target = getSessionProjectTarget(current);
            const workspaceId = target?.workspaceId ?? stateRef.current.activeWorkspaceId;
            const workspace = workspaceId
              ? stateRef.current.workspaces.find((item) => item.id === workspaceId)
              : null;
            return workspace && !workspace.isLocal
              ? { ...target, workspaceId, baseUrl: workspace.serverUrl }
              : (target ?? undefined);
          })(),
        })
        .then(() => {
          pendingTitlePersistenceRef.current.delete(sessionId);
        })
        .catch((error) => {
          pendingTitlePersistenceRef.current.set(sessionId, trimmed);
          console.warn("[session-title] failed to persist", { sessionId, error });
        });
    },
    [openGuiClient],
  );

  const resolveCurrentSessionId = useCallback((sessionId: string) => {
    let current = sessionId;
    const seen = new Set<string>();
    while (sessionIdAliasesRef.current.has(current) && !seen.has(current)) {
      seen.add(current);
      current = sessionIdAliasesRef.current.get(current) ?? current;
    }
    return current;
  }, []);

  const applyGeneratedSessionTitle = useCallback(
    (sessionId: string, requestId: number, generatedTitle: string) => {
      const currentId = resolveCurrentSessionId(sessionId);
      const activeRequestId =
        namingRequestIdsRef.current.get(currentId) ?? namingRequestIdsRef.current.get(sessionId);
      if (activeRequestId !== requestId) return;
      forceSessionTitle(currentId, generatedTitle);
      dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId: currentId, naming: false } });
      if (currentId !== sessionId) {
        dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId, naming: false } });
      }
    },
    [forceSessionTitle, resolveCurrentSessionId],
  );

  const fetchMessagePage = useCallback(
    async (
      sessionId: string,
      options?: { before?: string; limit?: number },
      projectTarget?: { directory?: string; workspaceId?: string },
    ) => {
      const session = stateRef.current.sessions.find((candidate) => candidate.id === sessionId);
      const workspaceId =
        projectTarget?.workspaceId ?? session?._workspaceId ?? stateRef.current.activeWorkspaceId;
      const workspace = stateRef.current.workspaces.find(
        (candidate) => candidate.id === workspaceId,
      );
      return await fetchSessionMessagePage({
        sessionsClient: openGuiClient.sessions,
        sessions: stateRef.current.sessions,
        sessionId,
        options,
        projectTarget:
          workspace && !workspace.isLocal
            ? { ...projectTarget, baseUrl: workspace.serverUrl, workspaceId }
            : projectTarget,
      });
    },
    [openGuiClient],
  );

  const hydrateChildSessionsForMessages = useCallback(
    (
      messages: MessageEntry[],
      options?: {
        requestId?: number;
        sessionId?: string;
        directory?: string;
        workspaceId?: string;
      },
    ) => {
      hydrateChildSessionMessages({
        messages,
        parentSessionId: options?.sessionId,
        requestId: options?.requestId,
        projectTarget:
          options?.directory || options?.workspaceId
            ? {
                directory: options.directory,
                workspaceId: options.workspaceId,
              }
            : undefined,
        childHydrationVersions: childHydrationVersionRef.current,
        getCurrentSelectSessionRequestId: () => selectSessionRequestRef.current,
        getCurrentActiveSessionId: () => stateRef.current.activeSessionId,
        sessionsClient: openGuiClient.sessions,
        dispatch,
      });
    },
    [openGuiClient],
  );

  const { selectSession, refreshActiveSessionMessages, scheduleSessionMessageReconcile } =
    useAgentSessionActivation({
      fetchMessagePage,
      hydrateChildSessionsForMessages,
      dispatch,
      stateRef,
      selectSessionRequestRef,
      sessionReconcileRequestRef,
    });

  const isChatDirectory = useCallback((directory?: string | null) => {
    const normalizedDirectory = directory ? normalizeProjectPath(directory) : null;
    const defaultChatDirectory = stateRef.current.defaultChatDirectory;
    if (!normalizedDirectory || !defaultChatDirectory) return false;
    return normalizedDirectory === normalizeProjectPath(defaultChatDirectory);
  }, []);

  const loadOlderMessages = useCallback(async (): Promise<boolean> => {
    return await loadOlderSessionMessages({
      state: stateRef.current,
      fetchMessagePage,
      dispatch,
    });
  }, [fetchMessagePage]);

  const createSession = useCallback(
    async (title?: string, directory?: string): Promise<Session | null> => {
      return await createLifecycleSession({
        title,
        directory,
        state: {
          draftSessionBackendId: stateRef.current.draftSessionBackendId,
          sessions: stateRef.current.sessions,
          activeSessionId: stateRef.current.activeSessionId,
          activeWorkspaceId: stateRef.current.activeWorkspaceId,
          activeWorkspaceServerUrl: stateRef.current.workspaces.find(
            (workspace) => workspace.id === stateRef.current.activeWorkspaceId,
          )?.serverUrl,
        },
        preferredBackendId,
        ensureDirectoryConnection,
        sessionsClient: openGuiClient.sessions,
        isChatDirectory,
        selectSession,
        dispatch,
      });
    },
    [openGuiClient, preferredBackendId, selectSession, ensureDirectoryConnection, isChatDirectory],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      const queuedCount = stateRef.current.queuedPrompts[id]?.length ?? 0;
      const confirmQueue =
        queuedCount === 0 ||
        window.confirm(
          `Delete this shared Session and its ${queuedCount} queued prompt${queuedCount === 1 ? "" : "s"}?`,
        );
      if (!confirmQueue) return;
      await deleteLifecycleSession({
        sessionId: id,
        state: {
          sessions: stateRef.current.sessions,
          activeSessionId: stateRef.current.activeSessionId,
          busySessionIds: stateRef.current.busySessionIds,
          worktreeParents: stateRef.current.worktreeParents,
        },
        confirmQueue: queuedCount > 0,
        cleanupSessionRefs,
        selectSession,
        sessionsClient: openGuiClient.sessions,
        dispatch,
      });
    },
    [openGuiClient, cleanupSessionRefs, selectSession],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const plan = createSessionRenamePlan({
        sessionId: id,
        title,
        sessions: stateRef.current.sessions,
        currentRequestId: namingRequestIdsRef.current.get(id),
      });
      namingRequestIdsRef.current.set(id, plan.nextRequestId);
      dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId: id, naming: false } });
      if (!plan.trimmedTitle) return;
      forcedSessionTitlesRef.current.set(id, plan.trimmedTitle);
      if (plan.updatedSession) {
        dispatch({ type: "SESSION_UPDATED", payload: plan.updatedSession });
      }
      openGuiClient.sessions
        .rename({
          sessionId: id,
          title: plan.trimmedTitle,
          backendId: getSessionBackendId(plan.currentSession) ?? undefined,
          target: getSessionProjectTarget(plan.currentSession) ?? undefined,
        })
        .catch(() => {
          /* best-effort rename – backend events will reconcile */
        });
    },
    [openGuiClient],
  );

  // Track which sessions are currently dispatching a queued prompt
  const dispatchingRef = useRef<Set<string>>(new Set());

  // Lock to prevent double session creation from draft
  const draftCreatingRef = useRef(false);

  const requestSessionAutoName = useCallback(
    ({
      sessionId,
      sourceText,
      session,
      force = false,
    }: {
      sessionId: string;
      sourceText: string;
      session?: Session | null;
      force?: boolean;
    }) => {
      if (!force && !shouldAutoNameSession(session)) return;
      dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId, naming: true } });
      const requestId = nextNamingRequestId(namingRequestIdsRef.current.get(sessionId));
      namingRequestIdsRef.current.set(sessionId, requestId);
      void generateSessionTitle(sourceText).then((generatedTitle) => {
        applyGeneratedSessionTitle(sessionId, requestId, generatedTitle);
      });
    },
    [applyGeneratedSessionTitle],
  );

  const localIntent = useMemo(
    () =>
      createLocalIntentOrchestrator({
        getState: () => stateRef.current,
        getCreationBackendId: () => creationBackendId,
        getCreationRuntime: () => creationBridge?.runtime,
        getResourceRuntime: () => runtime,
        getCurrentVariant: () => currentVariant,
        getWorkspaceBaseUrl: (workspaceId) => {
          const workspace = stateRef.current.workspaces.find((item) => item.id === workspaceId);
          return workspace && !workspace.isLocal ? workspace.serverUrl : undefined;
        },
        sessionsClient: openGuiClient.sessions,
        ensureDirectoryConnection,
        createSession,
        selectSession,
        scheduleSessionMessageReconcile,
        requestSessionAutoName,
        isChatDirectory,
        dispatch: (action) => dispatch(action as never),
        dispatchingSessionIds: dispatchingRef.current,
        draftCreatingRef,
      }),
    [
      createSession,
      creationBackendId,
      creationBridge,
      currentVariant,
      ensureDirectoryConnection,
      isChatDirectory,
      openGuiClient,
      requestSessionAutoName,
      runtime,
      scheduleSessionMessageReconcile,
      selectSession,
    ],
  );

  const { sendPrompt, sendCommand, dispatchNextQueued, sendQueuedNow, ensureSessionFromDraft } =
    localIntent;

  const findFiles = useCallback(
    async (directory: string | null, query: string): Promise<string[]> => {
      if (!runtime) return [];
      try {
        return await openGuiClient.files.find({
          target: { directory: directory ?? undefined },
          query,
        });
      } catch (error) {
        console.error("[findFiles] request failed", {
          directory,
          query,
          error,
        });
        return [];
      }
    },
    [openGuiClient, runtime],
  );

  const summarizeSession = useCallback(async () => {
    if (!runtime) return;
    const sessionId = await ensureSessionFromDraft();
    if (!sessionId) return;

    const model = state.selectedModel;
    if (!model) {
      dispatch({
        type: "SET_ERROR",
        payload: "Compaction requires a model to be selected",
      });
      return;
    }

    dispatch({ type: "SET_BUSY", payload: true });
    try {
      const projectTarget = getSessionProjectTarget(
        stateRef.current.sessions.find((session) => session.id === sessionId),
      );
      await runtime.compactSession(sessionId, model, projectTarget ?? undefined);

      // Wait for session to complete (polling state via setInterval to capture updates)
      // eslint-disable-next-line no-await-of-promise
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!stateRef.current.busySessionIds.has(sessionId)) {
            clearInterval(checkInterval);
            resolve(true);
          }
        }, 200);
        // Timeout after 6 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve(true);
        }, 6000);
      });

      // Brief delay to let the SDK server finish message updates
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Re-fetch messages to get updated token counts
      const messages = (
        await openGuiClient.sessions.getMessages({
          sessionId,
          options: { limit: 100 },
        })
      ).messages;
      dispatch({
        type: "SET_MESSAGES",
        payload: { messages, hasMore: false, nextCursor: null },
      });
    } catch (err) {
      dispatch({ type: "SET_ERROR", payload: getErrorMessage(err) });
    }
    // Note: SET_BUSY=false is handled by SESSION_STATUS backend events
  }, [runtime, state.selectedModel, ensureSessionFromDraft, openGuiClient]);

  // Auto-dispatch queued prompts when a session transitions from busy to idle.
  // Builds a synthetic trigger map (sessionID -> true) for newly-idle sessions
  // so the generic useDesktopNotification hook can handle the notification.
  const prevBusyRef = useRef<Set<string>>(new Set());
  const [justIdledMap, setJustIdledMap] = useState<Record<string, true>>({});
  useEffect(() => {
    const nowBusy = state.busySessionIds;
    const next = processBusyToIdleTransitions({
      previousBusySessionIds: prevBusyRef.current,
      currentBusySessionIds: nowBusy,
      activeSessionId: stateRef.current.activeSessionId,
      sessions: stateRef.current.sessions,
      dispatchNextQueued,
      refreshSessionMessages: refreshActiveSessionMessages,
    });
    setJustIdledMap((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length && nextKeys.every((key) => prev[key])) {
        return prev;
      }
      return next;
    });
    prevBusyRef.current = new Set(nowBusy);
  }, [state.busySessionIds, dispatchNextQueued, refreshActiveSessionMessages]);

  // After-part trigger: when the reducer detects a part just finished while
  // an "after-part" prompt is pending, it adds the sessionID to
  // _afterPartTriggered.  This effect picks it up, aborts the session, and
  // the abort causes busy->idle which dispatches the queued prompt above.
  useEffect(() => {
    if (state._afterPartTriggered.size === 0) return;
    processAfterPartQueueTriggers({
      sessionIds: state._afterPartTriggered,
      abortSession: (input) => {
        const session = state.sessions.find((item) => item.id === input.sessionId);
        return openGuiClient.sessions.abort({
          ...input,
          backendId: getSessionBackendId(session) ?? undefined,
          target: getSessionProjectTarget(session) ?? undefined,
        });
      },
      dispatch,
    });
  }, [openGuiClient, state._afterPartTriggered, state.sessions]);

  // Desktop notifications for newly-idle sessions
  useDesktopNotification(
    justIdledMap,
    "Session complete",
    state.activeSessionId,
    state.sessions,
    selectSession,
  );

  // Desktop notification when a question arrives for a non-active session
  useDesktopNotification(
    state.pendingQuestions,
    "Question waiting",
    state.activeSessionId,
    state.sessions,
    selectSession,
  );

  // Desktop notification when a permission is requested for a non-active session
  useDesktopNotification(
    state.pendingPermissions,
    "Permission requested",
    state.activeSessionId,
    state.sessions,
    selectSession,
  );

  const abortSession = useCallback(async () => {
    if (!state.activeSessionId) return;
    const sessionId = resolveCurrentSessionId(state.activeSessionId);
    const activeSession = state.sessions.find(
      (session) => session.id === sessionId || session.id === state.activeSessionId,
    );
    const target = getSessionProjectTarget(activeSession) ?? undefined;
    const workspaceId = target?.workspaceId ?? state.activeWorkspaceId;
    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    await openGuiClient.sessions.abort({
      sessionId,
      backendId:
        getSessionBackendId(activeSession) ??
        getAgentBackendIdFromSessionId(state.activeSessionId) ??
        undefined,
      target:
        workspace && !workspace.isLocal
          ? { ...target, workspaceId, baseUrl: workspace.serverUrl }
          : target,
    });
  }, [
    openGuiClient,
    resolveCurrentSessionId,
    state.activeSessionId,
    state.activeWorkspaceId,
    state.sessions,
    state.workspaces,
  ]);

  const respondPermission = useCallback(
    async (response: "once" | "always" | "reject") => {
      if (!state.activeSessionId) return;
      const pending = state.pendingPermissions[state.activeSessionId];
      if (!pending) return;
      await openGuiClient.sessions.respondPermission({
        sessionId: state.activeSessionId,
        permissionId: pending.id,
        response,
        backendId:
          getSessionBackendId(
            state.sessions.find((session) => session.id === state.activeSessionId),
          ) ?? undefined,
        target:
          getSessionProjectTarget(
            state.sessions.find((session) => session.id === state.activeSessionId),
          ) ?? undefined,
      });
      dispatch({
        type: "SET_PERMISSION",
        payload: { sessionID: state.activeSessionId, clear: true },
      });
    },
    [openGuiClient, state.pendingPermissions, state.activeSessionId, state.sessions],
  );

  const replyQuestion = useCallback(
    async (answers: QuestionAnswer[]) => {
      if (!state.activeSessionId) return;
      const pending = state.pendingQuestions[state.activeSessionId];
      if (!pending) return;
      try {
        await openGuiClient.sessions.replyQuestion({
          requestId: pending.id,
          answers,
          backendId: activeSessionBackendId ?? undefined,
        });
      } catch (error) {
        dispatch({
          type: "SET_ERROR",
          payload: error instanceof Error ? error.message : "Failed to submit question reply",
        });
      }
    },
    [activeSessionBackendId, openGuiClient, state.pendingQuestions, state.activeSessionId],
  );

  const rejectQuestion = useCallback(async () => {
    if (!state.activeSessionId) return;
    const pending = state.pendingQuestions[state.activeSessionId];
    if (!pending) return;
    try {
      await openGuiClient.sessions.rejectQuestion({
        requestId: pending.id,
        backendId: activeSessionBackendId ?? undefined,
      });
    } catch (error) {
      dispatch({
        type: "SET_ERROR",
        payload: error instanceof Error ? error.message : "Failed to dismiss question",
      });
    }
  }, [activeSessionBackendId, openGuiClient, state.pendingQuestions, state.activeSessionId]);

  const setDefaultChatDirectory = useCallback((directory: string | null) => {
    const normalizedDirectory = directory ? normalizeProjectPath(directory) : null;
    storageRemove(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY);
    const workspaceId = stateRef.current.activeWorkspaceId;
    const nextWorkspaces = stateRef.current.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            settings: {
              ...workspace.settings,
              defaultChatDirectory: normalizedDirectory,
            },
          }
        : workspace,
    );
    dispatch({ type: "SET_WORKSPACES", payload: nextWorkspaces });
    dispatch({
      type: "SET_DEFAULT_CHAT_DIRECTORY",
      payload: normalizedDirectory,
    });
  }, []);

  const startDraftSession = useCallback(
    (directory: string) => {
      dispatch({
        type: "START_DRAFT_SESSION",
        payload: {
          directory,
          backendId: getSessionBackendId(activeSession) ?? preferredBackendId,
        },
      });
    },
    [activeSession, preferredBackendId],
  );

  const startNewChat = useCallback(async () => {
    const defaultChatDirectory = stateRef.current.defaultChatDirectory;
    if (!defaultChatDirectory) return;
    await ensureDirectoryConnection(defaultChatDirectory, { transient: true });
    startDraftSession(defaultChatDirectory);
  }, [ensureDirectoryConnection, startDraftSession]);

  const setDraftDirectory = useCallback((directory: string) => {
    dispatch({ type: "SET_DRAFT_DIRECTORY", payload: directory });
  }, []);

  const setDraftBackend = useCallback((backendId: AgentBackendId) => {
    dispatch({ type: "SET_DRAFT_BACKEND", payload: backendId });
  }, []);

  /** Re-fetch providers from the server and update global state. */
  const refreshProviders = useCallback(async () => {
    await loadServerResources(
      activeResourceBackendId,
      activeResourceDirectory ??
        (loadedResourceProjectKeyRef.current
          ? parseProjectKey(loadedResourceProjectKeyRef.current).directory
          : null),
      activeWorkspace?.id,
    );
  }, [activeResourceBackendId, activeResourceDirectory, activeWorkspace?.id, loadServerResources]);

  const clearError = useCallback(() => {
    dispatch({ type: "SET_ERROR", payload: null });
    if (state.bootState === "error") {
      dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
    }
  }, [state.bootState]);

  const getQueuedPrompts = useCallback(
    (sessionId: string) => state.queuedPrompts[sessionId] ?? [],
    [state.queuedPrompts],
  );

  const applyQueueSnapshot = useCallback(
    (sessionId: string, prompts: (typeof state.queuedPrompts)[string]) => {
      dispatch({ type: "SET_SESSION_QUEUE", payload: { sessionID: sessionId, prompts } });
    },
    [],
  );

  const removeFromQueue = useCallback(
    (sessionId: string, promptId: string) => {
      void openGuiClient.sessions.queue
        .remove({ sessionId, entryId: promptId })
        .then((prompts) => applyQueueSnapshot(sessionId, prompts))
        .catch((error) => {
          dispatch({
            type: "SET_ERROR",
            payload: getErrorMessage(error) || "Failed to remove queued prompt",
          });
        });
    },
    [applyQueueSnapshot, openGuiClient],
  );

  const reorderQueue = useCallback(
    (sessionId: string, fromIndex: number, toIndex: number) => {
      const existing = stateRef.current.queuedPrompts[sessionId] ?? [];
      const entryId = existing[fromIndex]?.id;
      if (!entryId) return;
      void openGuiClient.sessions.queue
        .reorder({ sessionId, entryId, index: toIndex })
        .then((prompts) => applyQueueSnapshot(sessionId, prompts))
        .catch((error) => {
          dispatch({
            type: "SET_ERROR",
            payload: getErrorMessage(error) || "Failed to reorder queue",
          });
        });
    },
    [applyQueueSnapshot, openGuiClient],
  );

  const updateQueuedPrompt = useCallback(
    (sessionId: string, promptId: string, text: string) => {
      void openGuiClient.sessions.queue
        .update({ sessionId, entryId: promptId, text })
        .then((prompts) => applyQueueSnapshot(sessionId, prompts))
        .catch((error) => {
          dispatch({
            type: "SET_ERROR",
            payload: getErrorMessage(error) || "Failed to update queued prompt",
          });
        });
    },
    [applyQueueSnapshot, openGuiClient],
  );

  const setSessionDraft = useCallback((key: string, text: string) => {
    dispatch({ type: "SET_SESSION_DRAFT", payload: { key, text } });
  }, []);

  const clearSessionDraft = useCallback((key: string) => {
    dispatch({ type: "CLEAR_SESSION_DRAFT", payload: key });
  }, []);

  const revertToMessage = useCallback(
    async (messageID: string) => {
      if (!runtime || !state.activeSessionId) return;
      // Abort if session is busy before reverting
      if (state.busySessionIds.has(state.activeSessionId)) {
        const activeSession = state.sessions.find(
          (session) => session.id === state.activeSessionId,
        );
        await openGuiClient.sessions.abort({
          sessionId: state.activeSessionId,
          backendId: getSessionBackendId(activeSession) ?? undefined,
          target: getSessionProjectTarget(activeSession) ?? undefined,
        });
      }
      await refreshLifecycleSession({
        sessionId: state.activeSessionId,
        mutateSession: () => runtime.revertSession(state.activeSessionId!, messageID),
        fetchMessagePage,
        dispatch,
        errorMessage: "Failed to revert session",
      });
    },
    [
      runtime,
      fetchMessagePage,
      openGuiClient,
      state.activeSessionId,
      state.busySessionIds,
      state.sessions,
    ],
  );

  const unrevert = useCallback(async () => {
    if (!runtime || !state.activeSessionId) return;
    await refreshLifecycleSession({
      sessionId: state.activeSessionId,
      mutateSession: () => runtime.unrevertSession(state.activeSessionId!),
      fetchMessagePage,
      dispatch,
      errorMessage: "Failed to unrevert session",
    });
  }, [runtime, fetchMessagePage, state.activeSessionId]);

  const forkFromMessage = useCallback(
    async (messageID: string) => {
      if (!runtime || !state.activeSessionId) return;
      await forkLifecycleSession({
        messageId: messageID,
        activeSessionId: state.activeSessionId,
        sessions: stateRef.current.sessions,
        runtime,
        selectSession,
        forceSessionTitle,
        dispatch,
      });
    },
    [runtime, state.activeSessionId, selectSession, forceSessionTitle],
  );

  const setSessionColor = useCallback((sessionId: string, color: SessionColor) => {
    dispatch({
      type: "SET_SESSION_META",
      payload: { sessionId, meta: { color } },
    });
  }, []);

  const setSessionTags = useCallback((sessionId: string, tags: string[]) => {
    dispatch({
      type: "SET_SESSION_META",
      payload: { sessionId, meta: { tags } },
    });
  }, []);

  const setSessionPinned = useCallback((sessionId: string, pinned: boolean) => {
    dispatch({
      type: "SET_SESSION_META",
      payload: {
        sessionId,
        meta: { pinnedAt: pinned ? new Date().toISOString() : undefined },
      },
    });
  }, []);

  const moveSessionToProject = useCallback(
    async (sessionId: string, directory: string) => {
      try {
        const targetDirectory = normalizeProjectPath(directory);
        if (!targetDirectory) return;
        if (stateRef.current.busySessionIds.has(sessionId)) {
          throw new Error("Wait for the session to finish before moving it.");
        }
        const sourceSession = stateRef.current.sessions.find((session) => session.id === sessionId);
        if (!sourceSession) return;
        const sourceDirectory = normalizeProjectPath(
          (sourceSession._projectDir ?? sourceSession.directory) || "",
        );
        if (!sourceDirectory) return;

        await ensureDirectoryConnection(targetDirectory);

        dispatch({
          type: "SET_SESSION_META",
          payload: {
            sessionId,
            meta: {
              originMode: "project",
              assignedProjectDir: sourceDirectory === targetDirectory ? null : targetDirectory,
              assignedProjectMovedAt: sourceDirectory === targetDirectory ? null : Date.now(),
              assignedProjectSourceDir:
                sourceDirectory === targetDirectory ? null : sourceDirectory,
              pendingDirectoryChangeNotice: sourceDirectory !== targetDirectory,
              hideSystemAppendBlocks: sourceDirectory !== targetDirectory,
            },
          },
        });
        await selectSession(sessionId);
      } catch (error) {
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error) || "Failed to move session",
        });
      }
    },
    [ensureDirectoryConnection, selectSession],
  );

  const setProjectPinned = useCallback((directory: string, pinned: boolean) => {
    const workspaceId = stateRef.current.activeWorkspaceId;
    if (!workspaceId) return;
    dispatch({
      type: "SET_PROJECT_META",
      payload: {
        projectKey: makeProjectKey(workspaceId, directory),
        meta: { pinnedAt: pinned ? new Date().toISOString() : undefined },
      },
    });
  }, []);

  const registerWorktree = useCallback((worktreeDir: string, parentDir: string, branch: string) => {
    const normalizedWorktreeDir = normalizeProjectPath(worktreeDir);
    const normalizedParentDir = normalizeProjectPath(parentDir);
    if (!normalizedWorktreeDir || !normalizedParentDir) return;
    const now = new Date().toISOString();
    persistWorktreeParents({
      ...stateRef.current.worktreeParents,
      [normalizedWorktreeDir]: {
        parentDir: normalizedParentDir,
        branch,
        createdAt: stateRef.current.worktreeParents[normalizedWorktreeDir]?.createdAt ?? now,
        lastOpenedAt: now,
      },
    });
    dispatch({
      type: "REGISTER_WORKTREE",
      payload: {
        worktreeDir: normalizedWorktreeDir,
        parentDir: normalizedParentDir,
        branch,
      },
    });
  }, []);

  const unregisterWorktree = useCallback((worktreeDir: string) => {
    const normalizedWorktreeDir = normalizeProjectPath(worktreeDir);
    if (!normalizedWorktreeDir) return;
    const next = { ...stateRef.current.worktreeParents };
    delete next[normalizedWorktreeDir];
    persistWorktreeParents(next);
    dispatch({ type: "UNREGISTER_WORKTREE", payload: normalizedWorktreeDir });
  }, []);

  const clearWorktreeCleanup = useCallback(() => {
    dispatch({ type: "SET_PENDING_WORKTREE_CLEANUP", payload: null });
  }, []);

  const createWorkspace = useCallback(
    (input: { name: string; serverUrl: string; authToken?: string }) => {
      const plan = createWorkspaceLifecyclePlan({
        workspaces: stateRef.current.workspaces,
        input,
      });
      dispatch({ type: "SET_WORKSPACES", payload: plan.nextWorkspaces });
      dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: plan.nextActiveWorkspaceId });
      dispatch({ type: "SET_ACTIVE_SESSION", payload: plan.nextActiveSessionId });
      dispatch({ type: "SET_DEFAULT_CHAT_DIRECTORY", payload: null });
    },
    [],
  );

  const updateWorkspace = useCallback(
    (workspaceId: string, input: Partial<Pick<Workspace, "name" | "serverUrl" | "authToken">>) => {
      const current = stateRef.current.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!current) return;
      const nextWorkspaces = createWorkspaceUpdatePlan({
        workspaces: stateRef.current.workspaces,
        workspaceId,
        input,
      });
      dispatch({ type: "SET_WORKSPACES", payload: nextWorkspaces });
    },
    [],
  );

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      const plan = createWorkspaceSwitchPlan({
        workspaces: stateRef.current.workspaces,
        workspaceId,
      });
      const nextWorkspace = stateRef.current.workspaces.find(
        (workspace) => workspace.id === plan.nextActiveWorkspaceId,
      );
      dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: plan.nextActiveWorkspaceId });
      dispatch({
        type: "SET_DEFAULT_CHAT_DIRECTORY",
        payload: getWorkspaceDefaultChatDirectory(nextWorkspace),
      });
      void selectSession(plan.nextActiveSessionId);
    },
    [selectSession],
  );

  const removeWorkspace = useCallback(
    async (workspaceId: string) => {
      const current = stateRef.current.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!current) return;
      const remaining = stateRef.current.workspaces.filter(
        (workspace) => workspace.id !== workspaceId,
      );
      dispatch({ type: "SET_WORKSPACES", payload: remaining });
      const nextActiveWorkspaceId =
        stateRef.current.activeWorkspaceId === workspaceId
          ? (remaining[0]?.id ?? "")
          : stateRef.current.activeWorkspaceId;
      const nextActiveWorkspace = remaining.find(
        (workspace) => workspace.id === nextActiveWorkspaceId,
      );
      dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: nextActiveWorkspaceId });
      dispatch({
        type: "SET_DEFAULT_CHAT_DIRECTORY",
        payload: getWorkspaceDefaultChatDirectory(nextActiveWorkspace),
      });
      await selectSession(
        remaining.find((workspace) => workspace.id === nextActiveWorkspaceId)
          ?.lastActiveSessionId ?? null,
      );
    },
    [selectSession],
  );

  const reorderWorkspaces = useCallback((fromIndex: number, toIndex: number) => {
    const next = [...stateRef.current.workspaces];
    if (fromIndex < 0 || fromIndex >= next.length) return;
    const clampedTo = Math.max(0, Math.min(toIndex, next.length - 1));
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(clampedTo, 0, moved);
    dispatch({
      type: "REORDER_WORKSPACES",
      payload: { fromIndex, toIndex: clampedTo },
    });
  }, []);

  const reorderVisibleProjects = useCallback((orderedDirectories: string[]) => {
    const workspaceId = stateRef.current.activeWorkspaceId;
    if (!workspaceId) return;
    dispatch({
      type: "REORDER_VISIBLE_WORKSPACE_PROJECTS",
      payload: { workspaceId, orderedDirectories },
    });
    const workspace = stateRef.current.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
  }, []);

  // ----- Split context values (memoised per domain) -----

  const sessionCtx = useMemo<SessionContextValue>(
    () => ({
      sessions: activeWorkspaceSessions,
      activeSessionId:
        state.activeSessionId &&
        activeWorkspaceSessions.some((session) => session.id === state.activeSessionId)
          ? state.activeSessionId
          : null,
      messages: state.messages,
      isBusy: state.isBusy,
      isLoadingMessages: state.isLoadingMessages,
      busySessionIds: state.busySessionIds,
      queuedPrompts: state.queuedPrompts,
      pendingPermissions: state.pendingPermissions,
      pendingQuestions: state.pendingQuestions,
      draftSessionDirectory: state.draftSessionDirectory,
      draftSessionBackendId: state.draftSessionBackendId,
      namingSessionIds: state.namingSessionIds,
      unreadSessionIds: state.unreadSessionIds,
      sessionDrafts: state.sessionDrafts,
      sessionMeta: state.sessionMeta,
      childSessions: state.childSessions,
    }),
    [
      activeWorkspaceSessions,
      state.activeSessionId,
      state.messages,
      state.isBusy,
      state.isLoadingMessages,
      state.busySessionIds,
      state.queuedPrompts,
      state.pendingPermissions,
      state.pendingQuestions,
      state.draftSessionDirectory,
      state.draftSessionBackendId,
      state.namingSessionIds,
      state.unreadSessionIds,
      state.sessionDrafts,
      state.sessionMeta,
      state.childSessions,
    ],
  );

  const messagesCtx = useMemo<MessagesContextValue>(
    () => ({
      messages: state.messages,
      turnRuns: state.activeSessionId
        ? Object.fromEntries(
            Object.entries(state.turnRuns).filter(
              ([, run]) => run.sessionID === state.activeSessionId,
            ),
          )
        : {},
      childSessions: state.childSessions,
      messageHistoryHasMore: state.messageHistoryHasMore,
      isLoadingOlderMessages: state.isLoadingOlderMessages,
    }),
    [
      state.messages,
      state.activeSessionId,
      state.turnRuns,
      state.childSessions,
      state.messageHistoryHasMore,
      state.isLoadingOlderMessages,
    ],
  );

  const modelCtx = useMemo<ModelContextValue>(
    () => ({
      providers: state.providers,
      providerDefaults: state.providerDefaults,
      selectedModel: state.selectedModel,
      agents: state.agents,
      selectedAgent: state.selectedAgent,
      variantSelections: state.variantSelections,
      commands: state.commands,
      currentVariant,
    }),
    [
      state.providers,
      state.providerDefaults,
      state.selectedModel,
      state.agents,
      state.selectedAgent,
      state.variantSelections,
      state.commands,
      currentVariant,
    ],
  );

  const connectionCtx = useMemo<ConnectionContextValue>(
    () => ({
      workspaces: state.workspaces,
      activeWorkspace,
      activeWorkspaceId: state.activeWorkspaceId,
      supportsMultipleWorkspaces: shellWorkspacePolicy.supportsMultipleWorkspaces,
      workspaceStatuses: Object.fromEntries(
        state.workspaces.map((workspace) => {
          const workspaceSessions = state.sessions.filter((session) => {
            const sessionWorkspaceId = getSessionWorkspaceId(session);
            if (sessionWorkspaceId) {
              return sessionWorkspaceId === workspace.id;
            }
            const directory = session._projectDir ?? session.directory;
            return workspace.projects.includes(directory);
          });
          const sessionIds = new Set(workspaceSessions.map((session) => session.id));
          const workspaceConnections = Object.entries(state.connections).filter(
            ([projectKey]) => state.projectWorkspaceMap[projectKey]?.has(workspace.id) || false,
          );
          return [
            workspace.id,
            {
              busy: [...state.busySessionIds].some((id) => sessionIds.has(id)),
              needsAttention:
                Object.keys(state.pendingPermissions).some((id) => sessionIds.has(id)) ||
                Object.keys(state.pendingQuestions).some((id) => sessionIds.has(id)),
              error: workspaceConnections.some(([, status]) => status.state === "error"),
              connected: workspaceConnections.some(([, status]) => status.state === "connected"),
            },
          ] as const;
        }),
      ),
      connections: Object.fromEntries(
        Object.entries(visibleWorkspaceConnections).map(([projectKey, status]) => [
          parseProjectKey(projectKey).directory,
          status,
        ]),
      ),
      workspaceDirectory,
      defaultChatDirectory: state.defaultChatDirectory,
      workspaceServerUrl: workspaceProfile?.fields.serverUrl
        ? (activeWorkspace?.serverUrl ?? workspaceConnection?.serverUrl ?? null)
        : null,
      isLocalWorkspace:
        workspaceProfile?.kind === "local-cli"
          ? true
          : (activeWorkspace?.isLocal ?? isLocalServer()),
      activeDirectory: activeResourceDirectory,
      bootState: state.bootState,
      bootError: state.bootError,
      bootLogs: state.bootLogs,
      lastError: state.lastError,
      worktreeParents: state.worktreeParents,
      projectMeta: Object.fromEntries(
        Object.entries(state.projectMeta)
          .filter(([projectKey]) => {
            const { workspaceId } = parseProjectKey(projectKey);
            return workspaceId === state.activeWorkspaceId;
          })
          .map(([projectKey, meta]) => [parseProjectKey(projectKey).directory, meta]),
      ),
      pendingWorktreeCleanup: state.pendingWorktreeCleanup,
    }),
    [
      state.workspaces,
      activeWorkspace,
      state.activeWorkspaceId,
      shellWorkspacePolicy.supportsMultipleWorkspaces,
      state.sessions,
      state.connections,
      state.projectWorkspaceMap,
      state.busySessionIds,
      state.pendingPermissions,
      state.pendingQuestions,
      visibleWorkspaceConnections,
      workspaceDirectory,
      state.defaultChatDirectory,
      workspaceConnection,
      workspaceProfile,
      activeResourceDirectory,
      state.bootState,
      state.bootError,
      state.bootLogs,
      state.lastError,
      state.worktreeParents,
      state.projectMeta,
      state.pendingWorktreeCleanup,
    ],
  );

  const actionsCtx = useMemo<ActionsContextValue>(
    () => ({
      removeProject,
      selectSession,
      loadOlderMessages,
      deleteSession,
      renameSession,
      sendPrompt,
      findFiles,
      sendCommand,
      summarizeSession,
      abortSession,
      respondPermission,
      replyQuestion,
      rejectQuestion,
      setModel,
      setAgent,
      cycleVariant: doCycleVariant,
      revertVariant: doRevertVariant,
      clearError,
      refreshProviders,
      restartAgentBackends,
      getQueuedPrompts,
      removeFromQueue,
      reorderQueue,
      updateQueuedPrompt,
      sendQueuedNow,
      setSessionDraft,
      clearSessionDraft,
      openDirectory,
      connectToProject,
      startNewChat,
      startDraftSession,
      setDefaultChatDirectory,
      setDraftDirectory,
      setDraftBackend,
      revertToMessage,
      unrevert,
      forkFromMessage,
      setSessionColor,
      setSessionTags,
      setSessionPinned,
      moveSessionToProject,
      setProjectPinned,
      registerWorktree,
      unregisterWorktree,
      clearWorktreeCleanup,
      createWorkspace,
      updateWorkspace,
      removeWorkspace,
      switchWorkspace,
      reorderWorkspaces,
      reorderVisibleProjects,
    }),
    [
      removeProject,
      selectSession,
      loadOlderMessages,
      deleteSession,
      renameSession,
      sendPrompt,
      findFiles,
      sendCommand,
      abortSession,
      respondPermission,
      replyQuestion,
      rejectQuestion,
      setModel,
      setAgent,
      doCycleVariant,
      doRevertVariant,
      clearError,
      refreshProviders,
      restartAgentBackends,
      getQueuedPrompts,
      removeFromQueue,
      reorderQueue,
      updateQueuedPrompt,
      sendQueuedNow,
      setSessionDraft,
      clearSessionDraft,
      openDirectory,
      connectToProject,
      startNewChat,
      startDraftSession,
      setDefaultChatDirectory,
      setDraftDirectory,
      setDraftBackend,
      revertToMessage,
      unrevert,
      forkFromMessage,
      setSessionColor,
      setSessionTags,
      setSessionPinned,
      moveSessionToProject,
      setProjectPinned,
      registerWorktree,
      unregisterWorktree,
      clearWorktreeCleanup,
      createWorkspace,
      updateWorkspace,
      removeWorkspace,
      switchWorkspace,
      reorderWorkspaces,
      reorderVisibleProjects,
    ],
  );

  return (
    <ActionsContext.Provider value={actionsCtx}>
      <ConnectionContext.Provider value={connectionCtx}>
        <ModelContext.Provider value={modelCtx}>
          <SessionContext.Provider value={sessionCtx}>
            <MessagesContext.Provider value={messagesCtx}>{children}</MessagesContext.Provider>
          </SessionContext.Provider>
        </ModelContext.Provider>
      </ConnectionContext.Provider>
    </ActionsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Split hooks  (subscribe only to the slice you need)
// ---------------------------------------------------------------------------

/**
 * Session-related state: sessions list, active session, busy state, queue,
 * permissions, questions, draft, unread, meta.
 *
 * Does NOT include messages or childSessions - use useMessages() for those.
 * This split prevents streaming deltas from re-rendering the sidebar,
 * prompt box, and other components that only care about session metadata.
 */
export function useSessionState(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSessionState must be used within provider");
  }
  return ctx;
}

/**
 * Messages and child sessions for the active session.
 *
 * Only components that render message content should use this hook.
 * Changes on every streaming delta - that's the whole point of isolating it.
 */
export function useMessages(): MessagesContextValue {
  const ctx = useContext(MessagesContext);
  if (!ctx) {
    throw new Error("useMessages must be used within provider");
  }
  return ctx;
}

/**
 * Model / agent / variant / command state.
 *
 * Components like ModelSelector, AgentSelector, VariantSelector should use
 * this hook to avoid re-rendering on session changes.
 */
export function useModelState(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) {
    throw new Error("useModelState must be used within provider");
  }
  return ctx;
}

/**
 * Connection lifecycle state: per-project connections, boot state, errors,
 * worktree parents.
 */
export function useConnectionState(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error("useConnectionState must be used within provider");
  }
  return ctx;
}

/**
 * Stable action functions.  Because every function is wrapped in useCallback,
 * this context value changes infrequently.  Components that only need to
 * *dispatch* actions (not read state) should use this hook.
 */
export function useActions(): ActionsContextValue {
  const ctx = useContext(ActionsContext);
  if (!ctx) {
    throw new Error("useActions must be used within provider");
  }
  return ctx;
}

// Compatibility aliases. App-facing code should prefer generic names.
export const AgentBackendProvider = InternalAgentProvider;
export type AgentBackendState = InternalAgentState;
