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
import { type AgentBackendId, getAgentBackendIdFromSessionId } from "@/agents";
import type { AgentBackendEvent } from "@/agents/backend";
import {
  resolveVariant,
  updateVariantSelections,
  useVariant,
  type VariantSelections,
  variantKey,
} from "@/hooks/use-agent-variant-core";
import {
  getActiveWorkspaceId,
  getProjectMetaMap,
  getSessionMetaMap,
  getStoredDefaultChatDirectory,
  getUnreadSessionIds,
  getWorkspaceRootDirectory,
  getWorktreeParents,
  isLocalServer,
  LOCAL_WORKSPACE_ID,
  getStoredWorkspaces,
  normalizeWorkspace,
  createLocalWorkspace,
  persistUnreadSessionIds,
  persistWorkspaces,
  type SessionColor,
} from "@/hooks/agent-state-persistence";
import {
  getChildSessionId,
  MESSAGE_PAGE_SIZE,
  tagPartWithDeltaPositions,
} from "@/hooks/agent-message-state";
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
import type {
  InternalAgentState,
  MessageEntry,
  QueueMode,
  QueuedPrompt,
  Session,
} from "@/hooks/agent-state-types";
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
import { useOpenGuiClient } from "@/protocol/provider";
import {
  getQueuedPrompts,
  getSessionDrafts,
  persistQueuedPrompts,
  persistSessionDrafts,
} from "@/lib/session-drafts";
import { generateSessionTitle } from "@/lib/session-namer";
import { getErrorMessage, normalizeProjectPath } from "@/lib/utils";
import type {
  ConnectionConfig,
  ConnectionStatus,
  SelectedModel,
  Workspace,
} from "@/types/electron";

const FORK_TITLE_RE = /^#(\d+)\s+(.+)$/;

function getForkBaseTitle(title: string | null | undefined): string {
  const trimmed = title?.trim() || "Untitled";
  return trimmed.match(FORK_TITLE_RE)?.[2]?.trim() || trimmed;
}

function getNextForkTitle(baseTitle: string, sessions: readonly Session[]): string {
  let maxFork = 0;
  for (const session of sessions) {
    const match = session.title?.trim().match(FORK_TITLE_RE);
    if (!match || match[2]?.trim() !== baseTitle) continue;
    maxFork = Math.max(maxFork, Number.parseInt(match[1] ?? "0", 10) || 0);
  }
  return `#${maxFork + 1} ${baseTitle}`;
}

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

function deriveSelectionFromMessages(messages: MessageEntry[]) {
  let selectedAgent: string | null | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const info = messages[i]?.info;
    if (!info || typeof info !== "object") continue;
    if (selectedAgent === undefined && "agent" in info && typeof info.agent === "string") {
      selectedAgent = info.agent;
    }
    const variant =
      "variant" in info && typeof info.variant === "string" ? info.variant : undefined;
    if (
      "providerID" in info &&
      typeof info.providerID === "string" &&
      "modelID" in info &&
      typeof info.modelID === "string"
    ) {
      return {
        selectedModel: {
          providerID: info.providerID,
          modelID: info.modelID,
        },
        selectedAgent,
        variant,
      };
    }
    if (
      "model" in info &&
      info.model &&
      typeof info.model === "object" &&
      "providerID" in info.model &&
      typeof info.model.providerID === "string" &&
      "modelID" in info.model &&
      typeof info.model.modelID === "string"
    ) {
      return {
        selectedModel: {
          providerID: info.model.providerID,
          modelID: info.model.modelID,
        },
        selectedAgent,
        variant,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const initialWorkspaces = getStoredWorkspaces();

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
  queuedPrompts: getQueuedPrompts(),
  defaultChatDirectory: getStoredDefaultChatDirectory(),
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
  const agentsRef = useRef(state.agents);
  agentsRef.current = state.agents;
  const variantSelectionsRef = useRef(state.variantSelections);
  variantSelectionsRef.current = state.variantSelections;
  const selectedModelRef = useRef(state.selectedModel);
  selectedModelRef.current = state.selectedModel;
  const selectedAgentRef = useRef(state.selectedAgent);
  selectedAgentRef.current = state.selectedAgent;
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

  // --- Backend event handler ---
  const handleBackendEvent = useCallback(
    (event: AgentBackendEvent) => {
      const enforceForcedTitle = (session: Session): Session => {
        const forcedTitle = forcedSessionTitlesRef.current.get(session.id);
        if (!forcedTitle || session.title === forcedTitle) return session;
        return { ...session, title: forcedTitle };
      };
      if ("directory" in event) {
        const projectKey = makeProjectKey(event.workspaceId, event.directory);
        if (!expectedDirectoriesRef.current.has(projectKey)) {
          return;
        }
        if (event.type === "connection.status") {
          dispatch({
            type: "SET_PROJECT_CONNECTION",
            payload: { projectKey, status: event.status },
          });
          return;
        }
      }

      switch (event.type) {
        case "session.created":
          dispatch({ type: "SESSION_CREATED", payload: enforceForcedTitle(event.session) });
          break;
        case "session.replaced": {
          const oldForcedTitle = forcedSessionTitlesRef.current.get(event.oldId);
          if (oldForcedTitle) {
            forcedSessionTitlesRef.current.delete(event.oldId);
            forcedSessionTitlesRef.current.set(event.newId, oldForcedTitle);
          }
          sessionIdAliasesRef.current.set(event.oldId, event.newId);
          const oldRequestId = namingRequestIdsRef.current.get(event.oldId);
          if (oldRequestId !== undefined) {
            namingRequestIdsRef.current.set(event.newId, oldRequestId);
          }
          const oldPendingTitle = pendingTitlePersistenceRef.current.get(event.oldId);
          if (oldPendingTitle) {
            pendingTitlePersistenceRef.current.delete(event.oldId);
            pendingTitlePersistenceRef.current.set(event.newId, oldPendingTitle);
          }
          const titleToPersist = oldPendingTitle ?? oldForcedTitle;
          if (titleToPersist) {
            const backendId = getAgentBackendIdFromSessionId(event.newId) ?? undefined;
            openGuiClient.sessions
              .rename({ sessionId: event.newId, title: titleToPersist, backendId })
              .then(() => {
                pendingTitlePersistenceRef.current.delete(event.newId);
              })
              .catch((error) => {
                pendingTitlePersistenceRef.current.set(event.newId, titleToPersist);
                console.warn("[session-title] failed to persist after session replacement", {
                  sessionId: event.newId,
                  error,
                });
              });
          }
          dispatch({
            type: "SESSION_REPLACED",
            payload: {
              oldId: event.oldId,
              newId: event.newId,
              session: enforceForcedTitle(event.session),
            },
          });
          break;
        }
        case "session.updated":
          dispatch({ type: "SESSION_UPDATED", payload: enforceForcedTitle(event.session) });
          break;
        case "session.deleted":
          cleanupSessionRefs([event.sessionId]);
          dispatch({ type: "SESSION_DELETED", payload: event.sessionId });
          break;
        case "message.updated":
          dispatch({ type: "MESSAGE_UPDATED", payload: event.message });
          break;
        case "message.replaced":
          dispatch({
            type: "MESSAGE_REPLACED",
            payload: {
              sessionID: event.sessionID,
              oldId: event.oldId,
              message: event.message,
              parts: event.parts,
            },
          });
          break;
        case "message.part.updated":
          dispatch({ type: "PART_UPDATED", payload: { part: event.part } });
          break;
        case "message.part.delta":
          dispatch({
            type: "PART_DELTA",
            payload: {
              sessionID: event.sessionID,
              messageID: event.messageID,
              partID: event.partID,
              field: event.field,
              delta: event.delta,
            },
          });
          break;
        case "message.part.removed":
          dispatch({
            type: "PART_REMOVED",
            payload: {
              sessionID: event.sessionID,
              messageID: event.messageID,
              partID: event.partID,
            },
          });
          break;
        case "message.removed":
          dispatch({
            type: "MESSAGE_REMOVED",
            payload: {
              sessionID: event.sessionID,
              messageID: event.messageID,
            },
          });
          break;
        case "session.status":
          dispatch({
            type: "SESSION_STATUS",
            payload: {
              sessionID: event.sessionID,
              status: event.status,
            },
          });
          break;
        case "permission.requested":
          dispatch({ type: "SET_PERMISSION", payload: event.request });
          break;
        case "permission.cleared":
          dispatch({
            type: "SET_PERMISSION",
            payload: { sessionID: event.sessionID, clear: true },
          });
          break;
        case "question.requested":
          dispatch({ type: "SET_QUESTION", payload: event.request });
          break;
        case "question.cleared":
          dispatch({
            type: "SET_QUESTION",
            payload: { sessionID: event.sessionID, clear: true },
          });
          break;
        case "session.error":
          if (!event.sessionID) {
            dispatch({ type: "SET_ERROR", payload: event.error });
          }
          break;
      }
    },
    [cleanupSessionRefs, openGuiClient],
  );

  // Subscribe to backend events.
  // Use ref guard to prevent duplicate subscriptions that can occur
  // when React StrictMode double-mounts effects, which would cause every
  // streaming delta to be dispatched twice and produce garbled/doubled text.
  const subscribedRef = useRef(false);
  useEffect(() => {
    if (allBackends.length === 0 || subscribedRef.current) return;
    subscribedRef.current = true;
    const unsubscribe = openGuiClient.agentBackends.subscribe(handleBackendEvent);
    return () => {
      unsubscribe();
      subscribedRef.current = false;
    };
  }, [allBackends, handleBackendEvent, openGuiClient]);

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
    persistWorkspaces(state.workspaces);
  }, [state.workspaces]);

  useEffect(() => {
    const activeId = state.activeWorkspaceId;
    if (!activeId) return;
    const active = state.workspaces.find((w) => w.id === activeId);
    if (!active) return;
    // Only dispatch when the values actually differ to avoid an infinite
    // loop: .map() + spread always creates new object references, so a
    // naive reference-equality check would always be true, causing
    // dispatch -> new state.workspaces ref -> effect re-fires -> repeat.
    const modelSame =
      active.selectedModel?.providerID === state.selectedModel?.providerID &&
      active.selectedModel?.modelID === state.selectedModel?.modelID;
    const agentSame = active.selectedAgent === state.selectedAgent;
    if (modelSame && agentSame) return;
    const next = state.workspaces.map((workspace) =>
      workspace.id === activeId
        ? {
            ...workspace,
            selectedModel: state.selectedModel,
            selectedAgent: state.selectedAgent,
          }
        : workspace,
    );
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

  useEffect(() => {
    persistQueuedPrompts(state.queuedPrompts);
  }, [state.queuedPrompts]);

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
      const requestId = ++resourceLoadRequestRef.current;
      const targetDirectory = directory?.trim() || undefined;
      const targetWorkspaceId = workspaceId?.trim() || undefined;
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

        loadedResourceProjectKeyRef.current = targetDirectory
          ? makeProjectKey(targetWorkspaceId, targetDirectory)
          : null;
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
      }
    },
    [openGuiClient],
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
      const projectKey = makeProjectKey(workspaceId, config.directory);
      dispatch({
        type: "SET_PROJECT_META",
        payload: { projectKey, meta: { hidden: options?.hidden === true } },
      });
      dispatch({
        type: "ASSIGN_PROJECT_WORKSPACE",
        payload: { projectKey, workspaceId },
      });
      expectedDirectoriesRef.current.add(projectKey);
      if (!options?.suppressError) {
        dispatch({ type: "SET_ERROR", payload: null });
      }
      dispatch({
        type: "SET_PROJECT_CONNECTION",
        payload: {
          projectKey,
          status: {
            state: "connecting",
            serverUrl: config.baseUrl,
            serverVersion: null,
            error: null,
            lastEventAt: Date.now(),
          },
        },
      });
      const targetBackendIds = options?.backendIds?.length
        ? options.backendIds
        : discoveryBackendIds;
      if (targetBackendIds.length === 0) return;

      const connectResult = await openGuiClient.agentBackends.connectProject({
        config: { ...config, workspaceId },
        backendIds: targetBackendIds,
      });
      if (connectResult.connectedBackendIds.length === 0) {
        expectedDirectoriesRef.current.delete(projectKey);
        const firstError = connectResult.errors[0]?.error;
        if (!options?.suppressError) {
          dispatch({
            type: "SET_ERROR",
            payload: firstError || "Connection failed",
          });
        }
        return;
      }
      dispatch({
        type: "SET_PROJECT_CONNECTION",
        payload: {
          projectKey,
          status: {
            state: "connected",
            serverUrl: config.baseUrl,
            serverVersion: null,
            error: null,
            lastEventAt: Date.now(),
          },
        },
      });
      const successfulSessionResults = await openGuiClient.agentBackends.listProjectSessions({
        backendIds: connectResult.connectedBackendIds,
        target: {
          directory: config.directory,
          workspaceId,
        },
      });
      if (successfulSessionResults.length > 0) {
        dispatch({
          type: "MERGE_PROJECT_SESSIONS",
          payload: {
            projectKey,
            directory: config.directory,
            sessions: successfulSessionResults.flatMap((result) => result.sessions),
            backendIds: successfulSessionResults.map((result) => result.backendId),
          },
        });
      }
      try {
        const statuses = await openGuiClient.agentBackends.listProjectSessionStatuses({
          backendIds: connectResult.connectedBackendIds,
          target: {
            directory: config.directory,
            workspaceId,
          },
        });
        dispatch({
          type: "INIT_BUSY_SESSIONS",
          payload: statuses,
        });
      } catch {
        /* ignore – spinner will appear on next backend event */
      }
      const worktreeParentMap = getWorktreeParents();
      const isWorktree = Boolean(worktreeParentMap[config.directory]);
      const workspaceDirectory = isWorktree
        ? worktreeParentMap[config.directory]?.parentDir
        : config.directory;
      if (workspaceDirectory && !options?.hidden && !options?.transient) {
        dispatch({
          type: "ADD_WORKSPACE_PROJECT",
          payload: {
            workspaceId,
            directory: workspaceDirectory,
            serverUrl: config.baseUrl,
            username: config.username,
            password: config.password,
          },
        });
      }
      if (
        workspaceDirectory &&
        !options?.hidden &&
        !options?.transient &&
        workspaceId === LOCAL_WORKSPACE_ID
      ) {
        storageSet(STORAGE_KEYS.SERVER_URL, config.baseUrl);
        storageSetOrRemove(STORAGE_KEYS.USERNAME, config.username);
      }
    },
    [allBackends, discoveryBackendIds, openGuiClient],
  );

  const ensureDirectoryConnection = useCallback(
    async (
      directory: string,
      options?: { hidden?: boolean; transient?: boolean; backendIds?: AgentBackendId[] },
    ) => {
      const normalizedDirectory = normalizeProjectPath(directory);
      if (!normalizedDirectory) return;
      const workspace =
        stateRef.current.workspaces.find(
          (item) => item.id === stateRef.current.activeWorkspaceId,
        ) ?? createLocalWorkspace();
      const workspaceId = workspace.id;
      const projectKey = makeProjectKey(workspaceId, normalizedDirectory);
      const status = stateRef.current.connections[projectKey];
      if (
        !options?.backendIds?.length &&
        (status?.state === "connected" || status?.state === "connecting")
      ) {
        return;
      }
      await addProject(
        {
          workspaceId,
          baseUrl: workspace.serverUrl ?? DEFAULT_SERVER_URL,
          directory: normalizedDirectory,
          username: workspace.username,
          password: workspace.password,
        },
        {
          suppressError: true,
          hidden: options?.hidden,
          transient: options?.transient,
          backendIds: options?.backendIds,
        },
      );
    },
    [addProject],
  );

  const ensureDefaultChatConnection = useCallback(async () => {
    const defaultChatDirectory = stateRef.current.defaultChatDirectory;
    if (!defaultChatDirectory || detachedProject) return;
    await ensureDirectoryConnection(defaultChatDirectory, {
      transient: true,
      backendIds: allBackends.map((backend) => backend.id as AgentBackendId),
    });
  }, [allBackends, detachedProject, ensureDirectoryConnection]);

  const removeProject = useCallback(
    async (directory: string) => {
      if (allBackends.length === 0) return;
      const workspaceId = stateRef.current.activeWorkspaceId;
      const worktreeParentMap = getWorktreeParents();
      const workspaceDirectory = getWorkspaceRootDirectory(directory, worktreeParentMap);
      const directoriesToRemove =
        workspaceDirectory === directory
          ? [
              workspaceDirectory,
              ...Object.entries(worktreeParentMap)
                .filter(([, meta]) => meta.parentDir === workspaceDirectory)
                .map(([worktreeDir]) => worktreeDir),
            ]
          : [directory];

      for (const dir of directoriesToRemove) {
        const projectKey = makeProjectKey(workspaceId, dir);
        const removedSessionIds = stateRef.current.sessions
          .filter(
            (session) =>
              getSessionWorkspaceId(session) === workspaceId &&
              (session._projectDir ?? session.directory) === dir,
          )
          .map((session) => session.id);
        cleanupSessionRefs(removedSessionIds);
        expectedDirectoriesRef.current.delete(projectKey);
        await openGuiClient.agentBackends.disconnectProject({
          target: { directory: dir, workspaceId },
        });
        dispatch({
          type: "REMOVE_PROJECT",
          payload: { projectKey, directory: dir },
        });
      }

      // If the active session belongs to this project, clear it
      const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
      if (
        (activeSession?._projectDir ?? activeSession?.directory) === directory &&
        getSessionWorkspaceId(activeSession) === workspaceId
      ) {
        dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
      }
    },
    [allBackends, cleanupSessionRefs, openGuiClient, state.sessions, state.activeSessionId],
  );

  // --- Startup bootstrap: ensure local server, then auto-connect open projects ---
  const startupAttempted = useRef(false);
  useEffect(() => {
    if (startupAttempted.current) return;
    startupAttempted.current = true;
    let cancelled = false;

    const bootstrap = async () => {
      const localServerBackend =
        allBackends.find((backend) => backend.capabilities.localServer) ?? null;
      const localServerPlatform = localServerBackend?.platform;
      const shouldEnsureLocalServer = Boolean(localServerBackend) && isLocalServer();
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
        const bootWorkspaces = stateRef.current.workspaces.map((workspace) =>
          workspace.id === LOCAL_WORKSPACE_ID && detachedProject
            ? { ...workspace, projects: [detachedProject] }
            : workspace,
        );

        // Collect all project configs upfront so we can connect in parallel
        const allProjectConfigs: Array<{
          workspaceId: string;
          baseUrl: string;
          directory: string;
          username?: string;
          password?: string;
        }> = [];

        for (const workspace of bootWorkspaces) {
          for (const project of workspace.projects) {
            const rootDirectory = getWorkspaceRootDirectory(project, worktreeParentMap);
            const relatedWorktrees = Object.entries(worktreeParentMap)
              .filter(([, meta]) => meta.parentDir === rootDirectory)
              .map(([worktreeDir]) => worktreeDir);
            expectedDirectoriesRef.current = new Set([
              ...expectedDirectoriesRef.current,
              makeProjectKey(workspace.id, rootDirectory),
              ...relatedWorktrees.map((worktreeDir) => makeProjectKey(workspace.id, worktreeDir)),
            ]);
            const baseConfig = {
              workspaceId: workspace.id,
              baseUrl: workspace.serverUrl,
              username: workspace.username,
              password: workspace.password,
            };
            allProjectConfigs.push({
              ...baseConfig,
              directory: rootDirectory,
            });
            for (const worktreeDir of relatedWorktrees) {
              allProjectConfigs.push({
                ...baseConfig,
                directory: worktreeDir,
              });
            }
          }
        }

        if (cancelled) return;
        dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });

        const startupBackendId = backendsById[preferredBackendId]
          ? preferredBackendId
          : ((allBackends[0]?.id ?? "opencode") as AgentBackendId);

        // Warm saved projects in background. Do not keep startup banner blocked by
        // session scans or heavyweight CLI runtimes. Load the selected backend first,
        // then hydrate the other backends slowly so their sessions still appear.
        void (async () => {
          await Promise.allSettled(
            allProjectConfigs.map(async (config) => {
              if (cancelled) return;
              await addProject(config, {
                suppressError: true,
                backendIds: [startupBackendId],
              });
            }),
          );

          if (cancelled) return;
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (cancelled) return;

          const deferredBackendIds = allBackends
            .map((backend) => backend.id as AgentBackendId)
            .filter((backendId) => backendId !== startupBackendId);

          for (const backendId of deferredBackendIds) {
            for (const config of allProjectConfigs) {
              if (cancelled) return;
              await addProject(config, {
                suppressError: true,
                backendIds: [backendId],
              });
            }
          }
        })();
      } catch {
        /* ignore localStorage errors */
        if (!cancelled) dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [allBackends, addProject, backendsById, detachedProject, preferredBackendId]);

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
      const workspace =
        stateRef.current.workspaces.find(
          (item) => item.id === stateRef.current.activeWorkspaceId,
        ) ?? createLocalWorkspace();
      const url = serverUrl ?? workspace.serverUrl ?? DEFAULT_SERVER_URL;
      const normalizedUrl = url.replace(/\/+$/, "");
      const username = usernameOverride ?? workspace.username ?? undefined;
      const password = passwordOverride ?? workspace.password ?? undefined;
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
      const targetWorkspace = getWorkspaceRootDirectory(trimmedDirectory, worktreeParentMap);
      const relatedWorktrees = Object.entries(worktreeParentMap)
        .filter(([, meta]) => meta.parentDir === targetWorkspace)
        .map(([worktreeDir]) => worktreeDir);
      const desiredDirectories = [targetWorkspace, ...relatedWorktrees];
      const activeWorkspaceProjects = new Set(workspace.projects);

      if (activeWorkspaceProjects.has(targetWorkspace)) {
        expectedDirectoriesRef.current = new Set([
          ...expectedDirectoriesRef.current,
          ...desiredDirectories.map((dir) => makeProjectKey(workspaceId, dir)),
        ]);
        const missingDirectories = desiredDirectories.filter(
          (dir) => !connectedDirectorySet.has(dir),
        );
        await Promise.allSettled(
          missingDirectories.map((dir) =>
            addProject({
              workspaceId,
              baseUrl: url,
              directory: dir,
              username: username || undefined,
              password: password || undefined,
            }),
          ),
        );
        return;
      }

      expectedDirectoriesRef.current = new Set([
        ...expectedDirectoriesRef.current,
        ...desiredDirectories.map((dir) => makeProjectKey(workspaceId, dir)),
      ]);
      await addProject({
        workspaceId,
        baseUrl: url,
        directory: targetWorkspace,
        username: username || undefined,
        password: password || undefined,
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
            }),
          ),
      );
      if (workspaceId === LOCAL_WORKSPACE_ID) {
        if (username) {
          storageSet(STORAGE_KEYS.USERNAME, username);
        } else {
          storageRemove(STORAGE_KEYS.USERNAME);
        }
        storageSet(STORAGE_KEYS.SERVER_URL, url);
      }
    },
    [addProject, backendsById, preferredBackendId, connectedDirectorySet],
  );

  // Single ref to avoid stale closures and prevent unnecessary callback recreation
  const stateRef = useRef(state);
  stateRef.current = state;

  const forceSessionTitle = useCallback(
    (sessionId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      forcedSessionTitlesRef.current.set(sessionId, trimmed);
      const current = stateRef.current.sessions.find((session) => session.id === sessionId);
      if (current && current.title !== trimmed) {
        dispatch({
          type: "SESSION_UPDATED",
          payload: { ...current, title: trimmed },
        });
      }
      openGuiClient.sessions
        .rename({ sessionId, title: trimmed })
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
      const pageSize = options?.limit ?? MESSAGE_PAGE_SIZE;
      const resolvedTarget =
        projectTarget ??
        getSessionProjectTarget(
          stateRef.current.sessions.find((session) => session.id === sessionId),
        );
      const session = stateRef.current.sessions.find((session) => session.id === sessionId);
      const data = await openGuiClient.sessions.getMessages({
        sessionId,
        backendId: getSessionBackendId(session) ?? undefined,
        options: {
          limit: pageSize,
          before: options?.before,
          directory: resolvedTarget?.directory,
          workspaceId: resolvedTarget?.workspaceId,
        },
      });
      const messages = data?.messages ?? [];
      const nextCursor = data?.nextCursor ?? null;
      return {
        messages,
        // Only an explicit backend cursor means older history can be loaded.
        // Pi/Codex currently return full transcripts without cursors; inferring
        // hasMore from page size makes the UI show unreachable history.
        hasMore: nextCursor !== null,
        nextCursor,
      };
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
      if (messages.length === 0) return;

      const childSessionIds = new Set<string>();
      for (const msg of messages) {
        for (const part of msg.parts) {
          const childSid = getChildSessionId(part);
          if (childSid) childSessionIds.add(childSid);
        }
      }

      for (const childSid of childSessionIds) {
        const nextVersion = (childHydrationVersionRef.current[childSid] ?? 0) + 1;
        childHydrationVersionRef.current[childSid] = nextVersion;
        const backendId = options?.sessionId
          ? (getAgentBackendIdFromSessionId(options.sessionId) ?? undefined)
          : undefined;
        openGuiClient.sessions
          .getMessages({
            sessionId: childSid,
            backendId,
            options: {
              limit: 10000,
              directory: options?.directory,
              workspaceId: options?.workspaceId,
            },
          })
          .then((childRes) => {
            if (childHydrationVersionRef.current[childSid] !== nextVersion) {
              return;
            }
            if (
              options?.requestId !== undefined &&
              options.requestId !== selectSessionRequestRef.current
            ) {
              return;
            }
            if (options?.sessionId && options.sessionId !== stateRef.current.activeSessionId) {
              return;
            }
            const childMessages = childRes.messages;
            if (childMessages) {
              dispatch({
                type: "LOAD_CHILD_SESSION",
                payload: {
                  childSessionId: childSid,
                  messages: childMessages,
                },
              });
            }
          })
          .catch(() => {
            /* best-effort child session fetch */
          });
      }
    },
    [openGuiClient],
  );

  const selectSession = useCallback(
    async (id: string | null, options?: { session?: Session | null }) => {
      if (id === stateRef.current.activeSessionId) return;

      const applySelectionFromMessages = (messages: MessageEntry[]) => {
        const derived = deriveSelectionFromMessages(messages);
        if (!derived?.selectedModel) return;
        dispatch({ type: "SET_SELECTED_MODEL", payload: derived.selectedModel });
        if (derived.selectedAgent !== undefined) {
          dispatch({ type: "SET_SELECTED_AGENT", payload: derived.selectedAgent ?? null });
        }
        if (derived.variant !== undefined) {
          const key = variantKey(derived.selectedModel.providerID, derived.selectedModel.modelID);
          const nextSelections = updateVariantSelections(
            stateRef.current.variantSelections,
            key,
            derived.variant,
          );
          if (nextSelections !== stateRef.current.variantSelections) {
            dispatch({
              type: "SET_VARIANT_SELECTIONS",
              payload: nextSelections,
            });
          }
        }
      };

      // Check if we have a cached buffer BEFORE dispatching (dispatch consumes it).
      // Extract messages from the buffer now because stateRef won't reflect the
      // new reducer state until the next render, and we need the correct
      // messages for child-session hydration.
      const bufferSnapshot = id ? stateRef.current._sessionBuffers[id] : undefined;
      const hadCompleteBuffer = !!bufferSnapshot?.complete;
      let bufferMessages: MessageEntry[] | undefined;
      if (bufferSnapshot) {
        bufferMessages = Object.values(bufferSnapshot.messages).map((entry) => ({
          info: entry.info,
          parts: Object.values(entry.parts).map((p) => tagPartWithDeltaPositions(p)),
        }));
      }

      const requestId = ++selectSessionRequestRef.current;
      dispatch({ type: "SET_ACTIVE_SESSION", payload: id });
      if (!id) return;
      const resolvedSession =
        options?.session && options.session.id === id
          ? options.session
          : stateRef.current.sessions.find((session) => session.id === id);
      const projectTarget = getSessionProjectTarget(resolvedSession);

      if (hadCompleteBuffer && bufferMessages) {
        applySelectionFromMessages(bufferMessages);
        // Buffer was consumed and displayed instantly by SET_ACTIVE_SESSION
        // (which also set isLoadingMessages to false). Just hydrate child
        // sessions from the pre-extracted buffer messages.
        hydrateChildSessionsForMessages(bufferMessages, {
          requestId,
          sessionId: id,
          directory: projectTarget?.directory,
          workspaceId: projectTarget?.workspaceId,
        });
        return;
      }

      const { messages, hasMore, nextCursor } = await fetchMessagePage(
        id,
        undefined,
        projectTarget ?? undefined,
      );
      if (requestId !== selectSessionRequestRef.current) return;
      dispatch({
        type: "SET_MESSAGES",
        payload: { messages, hasMore, nextCursor },
      });
      applySelectionFromMessages(messages);
      hydrateChildSessionsForMessages(messages, {
        requestId,
        sessionId: id,
        directory: projectTarget?.directory,
        workspaceId: projectTarget?.workspaceId,
      });
    },
    [fetchMessagePage, hydrateChildSessionsForMessages],
  );

  const refreshActiveSessionMessages = useCallback(
    async (sessionId: string, projectTarget?: { directory?: string; workspaceId?: string }) => {
      if (stateRef.current.activeSessionId !== sessionId) return false;
      const refreshed = await fetchMessagePage(
        sessionId,
        {
          limit: Math.max(MESSAGE_PAGE_SIZE, stateRef.current.messages.length + 8),
        },
        projectTarget,
      );
      if (stateRef.current.activeSessionId !== sessionId) return false;
      dispatch({
        type: "SET_MESSAGES",
        payload: {
          messages: refreshed.messages,
          hasMore: refreshed.hasMore,
          nextCursor: refreshed.nextCursor,
        },
      });
      hydrateChildSessionsForMessages(refreshed.messages, {
        sessionId,
        directory: projectTarget?.directory,
        workspaceId: projectTarget?.workspaceId,
      });
      return true;
    },
    [fetchMessagePage, hydrateChildSessionsForMessages],
  );

  const scheduleSessionMessageReconcile = useCallback(
    (sessionId: string, projectTarget?: { directory?: string; workspaceId?: string }) => {
      const requestId = (sessionReconcileRequestRef.current[sessionId] ?? 0) + 1;
      sessionReconcileRequestRef.current[sessionId] = requestId;
      const delays = [150, 450, 900, 1500, 3000, 5000, 8000, 13000, 21000, 34000, 55000];

      void (async () => {
        for (const delayMs of delays) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          if (sessionReconcileRequestRef.current[sessionId] !== requestId) return;
          if (stateRef.current.activeSessionId !== sessionId) return;
          try {
            await refreshActiveSessionMessages(sessionId, projectTarget);
          } catch {
            /* best-effort transcript reconcile */
          }
        }
      })();
    },
    [refreshActiveSessionMessages],
  );

  const isChatDirectory = useCallback((directory?: string | null) => {
    const normalizedDirectory = directory ? normalizeProjectPath(directory) : null;
    const defaultChatDirectory = stateRef.current.defaultChatDirectory;
    if (!normalizedDirectory || !defaultChatDirectory) return false;
    return normalizedDirectory === normalizeProjectPath(defaultChatDirectory);
  }, []);

  const loadOlderMessages = useCallback(async (): Promise<boolean> => {
    const {
      activeSessionId,
      messages,
      isLoadingOlderMessages,
      messageHistoryHasMore,
      messageHistoryCursor,
    } = stateRef.current;
    if (
      !activeSessionId ||
      isLoadingOlderMessages ||
      !messageHistoryHasMore ||
      !messageHistoryCursor ||
      messages.length === 0
    ) {
      return false;
    }

    dispatch({ type: "SET_LOADING_OLDER_MESSAGES", payload: true });

    try {
      const {
        messages: olderMessages,
        hasMore,
        nextCursor,
      } = await fetchMessagePage(activeSessionId, {
        before: messageHistoryCursor,
      });
      // Ensure we are still on the same session
      if (stateRef.current.activeSessionId !== activeSessionId) return false;
      dispatch({
        type: "SET_MESSAGES",
        payload: {
          messages: olderMessages,
          hasMore,
          nextCursor,
          mode: "prepend",
        },
      });
      return hasMore;
    } catch {
      dispatch({ type: "SET_LOADING_OLDER_MESSAGES", payload: false });
      return false;
    }
  }, [fetchMessagePage]);

  const createSession = useCallback(
    async (title?: string, directory?: string): Promise<Session | null> => {
      const targetBackendId =
        stateRef.current.draftSessionBackendId ??
        getSessionBackendId(
          stateRef.current.sessions.find(
            (session) => session.id === stateRef.current.activeSessionId,
          ),
        ) ??
        preferredBackendId;
      try {
        if (directory) {
          await ensureDirectoryConnection(directory);
        }
        const session = await openGuiClient.sessions.create({
          backendId: targetBackendId,
          title,
          target: { directory, workspaceId: stateRef.current.activeWorkspaceId },
        });
        dispatch({ type: "SESSION_CREATED", payload: session });
        if (isChatDirectory(directory)) {
          dispatch({
            type: "SET_SESSION_META",
            payload: {
              sessionId: session.id,
              meta: { originMode: "chat", assignedProjectDir: null },
            },
          });
        }
        await selectSession(session.id, { session });
        return session;
      } catch (error) {
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error) || "Failed to create session",
        });
        return null;
      }
    },
    [openGuiClient, preferredBackendId, selectSession, ensureDirectoryConnection, isChatDirectory],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      const currentSessions = stateRef.current.sessions;
      const deletedSession = currentSessions.find((s) => s.id === id);
      const sessionBackendId = getSessionBackendId(deletedSession);
      if (!sessionBackendId) return;
      if (
        (sessionBackendId === "pi" || sessionBackendId === "codex") &&
        stateRef.current.busySessionIds.has(id)
      ) {
        dispatch({
          type: "SET_ERROR",
          payload:
            sessionBackendId === "pi"
              ? "Stop Pi session before deleting it."
              : "Stop Codex session before deleting it.",
        });
        return;
      }
      const currentActiveId = stateRef.current.activeSessionId;
      const deletedDir = deletedSession?._projectDir ?? deletedSession?.directory;
      const wtMeta = deletedDir ? stateRef.current.worktreeParents[deletedDir] : undefined;
      const needsSwitch = currentActiveId === id;
      const nextId = needsSwitch
        ? (() => {
            const idx = currentSessions.findIndex((s) => s.id === id);
            const next = currentSessions[idx + 1] ?? currentSessions[idx - 1] ?? null;
            return next?.id ?? null;
          })()
        : null;

      cleanupSessionRefs([id]);
      dispatch({ type: "SESSION_DELETED", payload: id });
      if (needsSwitch && nextId) {
        void selectSession(nextId);
      }

      openGuiClient.sessions.delete({ sessionId: id, backendId: sessionBackendId }).catch(() => {
        /* best-effort deletion */
      });

      if (deletedDir && wtMeta) {
        const remaining = currentSessions.filter(
          (s) => s.id !== id && (s._projectDir ?? s.directory) === deletedDir,
        );
        if (remaining.length === 0) {
          dispatch({
            type: "SET_PENDING_WORKTREE_CLEANUP",
            payload: {
              worktreeDir: deletedDir,
              parentDir: wtMeta.parentDir,
            },
          });
        }
      }
    },
    [openGuiClient, cleanupSessionRefs, selectSession],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      namingRequestIdsRef.current.set(id, (namingRequestIdsRef.current.get(id) ?? 0) + 1);
      dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId: id, naming: false } });
      const trimmed = title.trim();
      if (!trimmed) return;
      forcedSessionTitlesRef.current.set(id, trimmed);
      const current = stateRef.current.sessions.find((session) => session.id === id);
      if (current && current.title !== trimmed) {
        dispatch({ type: "SESSION_UPDATED", payload: { ...current, title: trimmed } });
      }
      openGuiClient.sessions
        .rename({
          sessionId: id,
          title: trimmed,
          backendId: getSessionBackendId(current) ?? undefined,
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

  /**
   * Ensure a session exists, creating one from a draft if needed.
   * Returns the session ID or null if no session is available.
   */
  const ensureSessionFromDraft = useCallback(async (): Promise<string | null> => {
    let sessionId = stateRef.current.activeSessionId;
    const draftDirectory = stateRef.current.draftSessionDirectory;
    if (!sessionId && draftDirectory) {
      if (draftCreatingRef.current) return null;
      draftCreatingRef.current = true;
      try {
        const newSession = await createSession(undefined, draftDirectory);
        if (!newSession) {
          draftCreatingRef.current = false;
          return null;
        }
        dispatch({ type: "CLEAR_DRAFT_SESSION" });
        sessionId = newSession.id;
      } catch {
        draftCreatingRef.current = false;
        return null;
      }
      draftCreatingRef.current = false;
    }
    if (!sessionId) {
      dispatch({
        type: "SET_ERROR",
        payload: "Select or create a session first.",
      });
      return null;
    }
    return sessionId;
  }, [createSession]);

  const prepareDirectoryChangePrompt = useCallback((sessionId: string, text: string) => {
    const meta = stateRef.current.sessionMeta[sessionId];
    const targetDirectory = meta?.assignedProjectDir
      ? normalizeProjectPath(meta.assignedProjectDir)
      : null;
    if (!meta?.pendingDirectoryChangeNotice || !targetDirectory) return text;
    const session = stateRef.current.sessions.find((item) => item.id === sessionId);
    const sourceDirectory = normalizeProjectPath(
      meta.assignedProjectSourceDir ?? session?._projectDir ?? session?.directory ?? "",
    );
    const notice = [
      "<SYSTEM-APPEND>",
      `OpenGUI has reassigned this conversation from project \`${sourceDirectory || "unknown"}\` to project \`${targetDirectory}\`.`,
      "Important: the native backend session may still have its original working directory.",
      `From now on, treat \`${targetDirectory}\` as the intended project root.`,
      `When using tools, file paths, search commands, shell commands, or edits, explicitly target \`${targetDirectory}\` unless the user asks otherwise.`,
      "Do not assume relative paths resolve against the intended project root; use absolute paths when needed.",
      "Do not mention this implementation detail to the user unless it becomes relevant to explain tool behavior.",
      "</SYSTEM-APPEND>",
    ].join("\n");
    dispatch({
      type: "SET_SESSION_META",
      payload: {
        sessionId,
        meta: {
          pendingDirectoryChangeNotice: false,
          hideSystemAppendBlocks: true,
        },
      },
    });
    return `${notice}\n\n${text}`;
  }, []);

  /** Internal: send a prompt directly to the server (no queue check).
   *  Optional overrides allow queued prompts to use the model/agent/variant
   *  that was active at enqueue time rather than the current selection. */
  const dispatchPromptDirect = useCallback(
    async (
      sessionId: string,
      text: string,
      images?: string[],
      overrideModel?: SelectedModel,
      overrideAgent?: string,
      overrideVariant?: string,
    ) => {
      dispatch({ type: "SET_BUSY", payload: true });

      const model = overrideModel ?? state.selectedModel ?? undefined;
      const agent = overrideAgent ?? state.selectedAgent ?? undefined;
      const variant =
        overrideVariant ??
        resolveVariant(
          state.selectedModel,
          state.variantSelections,
          state.agents,
          state.selectedAgent,
        );
      const turnId = crypto.randomUUID();
      const startedAt = Date.now();
      dispatch({
        type: "TURN_RUN_STARTED",
        payload: {
          id: turnId,
          sessionID: sessionId,
          startedAt,
          providerID: model?.providerID,
          modelID: model?.modelID,
          thinkingLevel: variant,
        },
      });
      dispatch({
        type: "PROMPT_SUBMITTED",
        payload: {
          id: turnId,
          sessionID: sessionId,
          text,
          createdAt: startedAt,
        },
      });

      const currentSession = stateRef.current.sessions.find((session) => session.id === sessionId);
      const projectTarget = getSessionProjectTarget(currentSession);
      const backendId = getSessionBackendId(currentSession) ?? undefined;

      try {
        await openGuiClient.sessions.prompt({
          sessionId,
          text,
          images,
          model,
          agent,
          variant,
          target: projectTarget ?? undefined,
          backendId,
        });
        scheduleSessionMessageReconcile(sessionId, projectTarget ?? undefined);
      } catch {
        // Prompt failures for existing sessions should render in the
        // session transcript, not in the global app banner.
        dispatch({ type: "SET_BUSY", payload: false });
      }
    },
    [
      openGuiClient,
      state.selectedModel,
      state.selectedAgent,
      state.variantSelections,
      state.agents,
      scheduleSessionMessageReconcile,
    ],
  );

  /** Dispatch the next queued prompt for a session (if any). */
  const dispatchNextQueued = useCallback(
    async (sessionId: string) => {
      if (dispatchingRef.current.has(sessionId)) return;
      const queue = stateRef.current.queuedPrompts[sessionId];
      if (!queue || queue.length === 0) return;

      dispatchingRef.current.add(sessionId);
      try {
        const next = queue[0];
        if (!next) return;
        dispatch({ type: "QUEUE_SHIFT", payload: { sessionID: sessionId } });
        await dispatchPromptDirect(
          sessionId,
          prepareDirectoryChangePrompt(sessionId, next.text),
          next.images,
          next.model,
          next.agent,
          next.variant,
        );
      } finally {
        dispatchingRef.current.delete(sessionId);
      }
    },
    [dispatchPromptDirect, prepareDirectoryChangePrompt],
  );

  const sendPrompt = useCallback(
    async (text: string, images?: string[], mode?: QueueMode) => {
      const effectiveMode = mode ?? "queue";
      const draftDirectory = stateRef.current.draftSessionDirectory;
      const creationRuntime = creationBridge?.runtime;
      if (!stateRef.current.activeSessionId && draftDirectory && creationRuntime?.startSession) {
        if (draftCreatingRef.current) return;
        draftCreatingRef.current = true;
        try {
          await ensureDirectoryConnection(draftDirectory);
          const pendingTitle = "Untitled";
          dispatch({ type: "SET_BUSY", payload: true });
          const model = selectedModelRef.current ?? undefined;
          const agent = selectedAgentRef.current ?? undefined;
          const variant = resolveVariant(
            selectedModelRef.current,
            variantSelectionsRef.current,
            agentsRef.current,
            selectedAgentRef.current,
          );
          const startedAt = Date.now();
          const session = await creationRuntime.startSession({
            text,
            images,
            model,
            agent,
            variant,
            title: creationBackendId === "claude-code" ? undefined : pendingTitle,
            directory: draftDirectory,
            workspaceId: stateRef.current.activeWorkspaceId,
          });
          const titledSession = { ...session, title: pendingTitle };
          dispatch({ type: "SESSION_CREATED", payload: titledSession });
          dispatch({
            type: "TURN_RUN_STARTED",
            payload: {
              id: crypto.randomUUID(),
              sessionID: session.id,
              startedAt,
              providerID: model?.providerID,
              modelID: model?.modelID,
              thinkingLevel: variant,
            },
          });
          dispatch({
            type: "SET_SESSION_NAMING",
            payload: { sessionId: session.id, naming: true },
          });
          if (isChatDirectory(draftDirectory)) {
            dispatch({
              type: "SET_SESSION_META",
              payload: {
                sessionId: session.id,
                meta: { originMode: "chat", assignedProjectDir: null },
              },
            });
          }
          dispatch({ type: "CLEAR_DRAFT_SESSION" });
          await selectSession(session.id, { session: titledSession });
          scheduleSessionMessageReconcile(session.id, {
            directory: session.directory,
            workspaceId: stateRef.current.activeWorkspaceId,
          });
          const requestId = (namingRequestIdsRef.current.get(session.id) ?? 0) + 1;
          namingRequestIdsRef.current.set(session.id, requestId);
          void generateSessionTitle(text).then((generatedTitle) => {
            applyGeneratedSessionTitle(session.id, requestId, generatedTitle);
          });
          return;
        } catch (error) {
          dispatch({
            type: "SET_ERROR",
            payload: getErrorMessage(error) || "Prompt failed",
          });
          dispatch({ type: "SET_BUSY", payload: false });
          return;
        } finally {
          draftCreatingRef.current = false;
        }
      }

      const sessionId = await ensureSessionFromDraft();
      if (!sessionId) return;

      const currentSession = stateRef.current.sessions.find((session) => session.id === sessionId);
      if (shouldAutoNameSession(currentSession)) {
        dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId, naming: true } });
        const requestId = (namingRequestIdsRef.current.get(sessionId) ?? 0) + 1;
        namingRequestIdsRef.current.set(sessionId, requestId);
        void generateSessionTitle(text).then((generatedTitle) => {
          applyGeneratedSessionTitle(sessionId, requestId, generatedTitle);
        });
      }

      // If session is busy, enqueue instead of sending directly.
      // Read from ref to avoid stale closures when the user switches
      // model/agent/variant right before pressing Enter.
      if (stateRef.current.busySessionIds.has(sessionId)) {
        const snapModel = selectedModelRef.current;
        const snapAgent = selectedAgentRef.current;
        const snapVariant = resolveVariant(
          snapModel,
          variantSelectionsRef.current,
          agentsRef.current,
          snapAgent,
        );
        const queued: QueuedPrompt = {
          id: crypto.randomUUID(),
          text,
          images,
          createdAt: Date.now(),
          model: snapModel ?? undefined,
          agent: snapAgent ?? undefined,
          variant: snapVariant,
          mode: effectiveMode,
        };

        if (effectiveMode === "interrupt" || effectiveMode === "after-part") {
          // Enqueue at front for both interrupt and after-part modes
          dispatch({
            type: "QUEUE_ADD",
            payload: { sessionID: sessionId, prompt: queued },
          });
          const existingQueue = stateRef.current.queuedPrompts[sessionId] ?? [];
          if (existingQueue.length > 0) {
            dispatch({
              type: "QUEUE_REORDER",
              payload: {
                sessionID: sessionId,
                fromIndex: existingQueue.length,
                toIndex: 0,
              },
            });
          }
          if (effectiveMode === "interrupt") {
            await openGuiClient.sessions.abort({ sessionId });
          } else {
            dispatch({
              type: "SET_AFTER_PART_PENDING",
              payload: { sessionID: sessionId, pending: true },
            });
          }
        } else {
          // Queue (default): enqueue at end, wait for session to become idle.
          dispatch({
            type: "QUEUE_ADD",
            payload: { sessionID: sessionId, prompt: queued },
          });
        }
        return;
      }

      await dispatchPromptDirect(sessionId, prepareDirectoryChangePrompt(sessionId, text), images);
    },
    [
      creationBridge,
      creationBackendId,
      openGuiClient,
      dispatchPromptDirect,
      prepareDirectoryChangePrompt,
      ensureSessionFromDraft,
      selectSession,
      ensureDirectoryConnection,
      isChatDirectory,
      applyGeneratedSessionTitle,
      scheduleSessionMessageReconcile,
    ],
  );

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

  const sendCommand = useCallback(
    async (command: string, args: string) => {
      const commandText = `/${command}${args ? ` ${args}` : ""}`;
      const creationRuntime = creationBridge?.runtime;
      if (
        !stateRef.current.activeSessionId &&
        stateRef.current.draftSessionDirectory &&
        creationRuntime?.startSession
      ) {
        if (draftCreatingRef.current) return;
        draftCreatingRef.current = true;
        try {
          await ensureDirectoryConnection(stateRef.current.draftSessionDirectory);
          const pendingTitle = "Untitled";
          dispatch({ type: "SET_BUSY", payload: true });
          const session = await creationRuntime.startSession({
            text: commandText,
            model: state.selectedModel ?? undefined,
            agent: state.selectedAgent ?? undefined,
            variant: currentVariant,
            title: creationBackendId === "claude-code" ? undefined : pendingTitle,
            directory: stateRef.current.draftSessionDirectory,
            workspaceId: stateRef.current.activeWorkspaceId,
          });
          const titledSession = { ...session, title: pendingTitle };
          dispatch({ type: "SESSION_CREATED", payload: titledSession });
          dispatch({
            type: "SET_SESSION_NAMING",
            payload: { sessionId: session.id, naming: true },
          });
          if (isChatDirectory(stateRef.current.draftSessionDirectory)) {
            dispatch({
              type: "SET_SESSION_META",
              payload: {
                sessionId: session.id,
                meta: { originMode: "chat", assignedProjectDir: null },
              },
            });
          }
          dispatch({ type: "CLEAR_DRAFT_SESSION" });
          await selectSession(session.id, { session: titledSession });
          scheduleSessionMessageReconcile(session.id, {
            directory: session.directory,
            workspaceId: stateRef.current.activeWorkspaceId,
          });
          const requestId = (namingRequestIdsRef.current.get(session.id) ?? 0) + 1;
          namingRequestIdsRef.current.set(session.id, requestId);
          void generateSessionTitle(commandText).then((generatedTitle) => {
            applyGeneratedSessionTitle(session.id, requestId, generatedTitle);
          });
          return;
        } catch (err) {
          dispatch({ type: "SET_BUSY", payload: false });
          dispatch({
            type: "SET_ERROR",
            payload: getErrorMessage(err),
          });
          return;
        } finally {
          draftCreatingRef.current = false;
        }
      }
      const sessionId = await ensureSessionFromDraft();
      if (!sessionId) return;

      const currentSession = stateRef.current.sessions.find((session) => session.id === sessionId);
      if (shouldAutoNameSession(currentSession)) {
        dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId, naming: true } });
        const requestId = (namingRequestIdsRef.current.get(sessionId) ?? 0) + 1;
        namingRequestIdsRef.current.set(sessionId, requestId);
        void generateSessionTitle(commandText).then((generatedTitle) => {
          applyGeneratedSessionTitle(sessionId, requestId, generatedTitle);
        });
      }

      const commandRuntime = runtime;
      if (!commandRuntime) return;
      dispatch({ type: "SET_BUSY", payload: true });
      try {
        const model = state.selectedModel ?? undefined;
        const agent = state.selectedAgent ?? undefined;
        const variant = currentVariant;
        const projectTarget = getSessionProjectTarget(
          stateRef.current.sessions.find((session) => session.id === sessionId),
        );
        await commandRuntime.sendCommand({
          sessionId,
          command,
          args,
          model,
          agent,
          variant,
          directory: projectTarget?.directory,
          workspaceId: projectTarget?.workspaceId,
        });
        scheduleSessionMessageReconcile(sessionId, projectTarget ?? undefined);
      } catch {
        // Command failures for existing sessions should render in the
        // session transcript, not in the global app banner.
        dispatch({ type: "SET_BUSY", payload: false });
      }
    },
    [
      creationBridge,
      creationBackendId,
      runtime,
      state.selectedModel,
      state.selectedAgent,
      currentVariant,
      ensureSessionFromDraft,
      selectSession,
      ensureDirectoryConnection,
      isChatDirectory,
      applyGeneratedSessionTitle,
      scheduleSessionMessageReconcile,
    ],
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
    const prevBusy = prevBusyRef.current;
    const nowBusy = state.busySessionIds;
    const newlyIdle: Record<string, true> = {};

    for (const sessionId of prevBusy) {
      if (!nowBusy.has(sessionId)) {
        void dispatchNextQueued(sessionId);
        newlyIdle[sessionId] = true;
        if (sessionId === stateRef.current.activeSessionId) {
          const projectTarget = getSessionProjectTarget(
            stateRef.current.sessions.find((session) => session.id === sessionId),
          );
          void refreshActiveSessionMessages(sessionId, projectTarget ?? undefined).catch(() => {
            /* best-effort final transcript reconcile */
          });
        }
      }
    }

    setJustIdledMap(newlyIdle);
    prevBusyRef.current = new Set(nowBusy);
  }, [state.busySessionIds, dispatchNextQueued, refreshActiveSessionMessages]);

  // After-part trigger: when the reducer detects a part just finished while
  // an "after-part" prompt is pending, it adds the sessionID to
  // _afterPartTriggered.  This effect picks it up, aborts the session, and
  // the abort causes busy->idle which dispatches the queued prompt above.
  useEffect(() => {
    if (state._afterPartTriggered.size === 0) return;
    for (const sessionId of state._afterPartTriggered) {
      dispatch({
        type: "CLEAR_AFTER_PART_TRIGGERED",
        payload: { sessionID: sessionId },
      });
      void openGuiClient.sessions.abort({ sessionId });
    }
  }, [openGuiClient, state._afterPartTriggered]);

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
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
    await openGuiClient.sessions.abort({
      sessionId: state.activeSessionId,
      backendId: getSessionBackendId(activeSession) ?? undefined,
    });
  }, [openGuiClient, state.activeSessionId, state.sessions]);

  const respondPermission = useCallback(
    async (response: "once" | "always" | "reject") => {
      if (!state.activeSessionId) return;
      const pending = state.pendingPermissions[state.activeSessionId];
      if (!pending) return;
      await openGuiClient.sessions.respondPermission({
        sessionId: state.activeSessionId,
        permissionId: pending.id,
        response,
      });
      dispatch({
        type: "SET_PERMISSION",
        payload: { sessionID: state.activeSessionId, clear: true },
      });
    },
    [openGuiClient, state.pendingPermissions, state.activeSessionId],
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
    if (normalizedDirectory) {
      storageSet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY, normalizedDirectory);
    } else {
      storageRemove(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY);
    }
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

  const removeFromQueue = useCallback((sessionId: string, promptId: string) => {
    dispatch({
      type: "QUEUE_REMOVE",
      payload: { sessionID: sessionId, promptID: promptId },
    });
  }, []);

  const reorderQueue = useCallback((sessionId: string, fromIndex: number, toIndex: number) => {
    dispatch({
      type: "QUEUE_REORDER",
      payload: { sessionID: sessionId, fromIndex, toIndex },
    });
  }, []);

  const updateQueuedPrompt = useCallback((sessionId: string, promptId: string, text: string) => {
    dispatch({
      type: "QUEUE_UPDATE",
      payload: { sessionID: sessionId, promptID: promptId, text },
    });
  }, []);

  const sendQueuedNow = useCallback(
    async (sessionId: string, promptId: string) => {
      const queue = state.queuedPrompts[sessionId] ?? [];
      if (queue.length === 0) return;

      const index = queue.findIndex((item) => item.id === promptId);
      if (index === -1) return;
      const target = queue[index];
      if (!target) return;

      if (stateRef.current.busySessionIds.has(sessionId)) {
        if (index > 0) {
          dispatch({
            type: "QUEUE_REORDER",
            payload: { sessionID: sessionId, fromIndex: index, toIndex: 0 },
          });
        }
        await openGuiClient.sessions.abort({ sessionId });
        return;
      }

      dispatch({
        type: "QUEUE_REMOVE",
        payload: { sessionID: sessionId, promptID: promptId },
      });

      await dispatchPromptDirect(
        sessionId,
        target.text,
        target.images,
        target.model,
        target.agent,
        target.variant,
      );
    },
    [state.queuedPrompts, openGuiClient, dispatchPromptDirect],
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
        await openGuiClient.sessions.abort({ sessionId: state.activeSessionId });
      }
      try {
        const session = await runtime.revertSession(state.activeSessionId, messageID);
        dispatch({ type: "SESSION_UPDATED", payload: session });
        // Re-fetch messages to reflect the reverted state
        const refreshed = await fetchMessagePage(state.activeSessionId);
        dispatch({
          type: "SET_MESSAGES",
          payload: {
            messages: refreshed.messages,
            hasMore: refreshed.hasMore,
            nextCursor: refreshed.nextCursor,
          },
        });
      } catch (err) {
        dispatch({
          type: "SET_ERROR",
          payload: err instanceof Error ? err.message : "Failed to revert session",
        });
      }
    },
    [runtime, fetchMessagePage, openGuiClient, state.activeSessionId, state.busySessionIds],
  );

  const unrevert = useCallback(async () => {
    if (!runtime || !state.activeSessionId) return;
    try {
      const session = await runtime.unrevertSession(state.activeSessionId);
      dispatch({ type: "SESSION_UPDATED", payload: session });
      // Re-fetch messages to include the restored messages
      const refreshed = await fetchMessagePage(state.activeSessionId);
      dispatch({
        type: "SET_MESSAGES",
        payload: {
          messages: refreshed.messages,
          hasMore: refreshed.hasMore,
          nextCursor: refreshed.nextCursor,
        },
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : "Failed to unrevert session",
      });
    }
  }, [runtime, fetchMessagePage, state.activeSessionId]);

  const forkFromMessage = useCallback(
    async (messageID: string) => {
      if (!runtime || !state.activeSessionId) return;
      try {
        const sourceSession = stateRef.current.sessions.find(
          (session) => session.id === stateRef.current.activeSessionId,
        );
        const forkTitle = getNextForkTitle(
          getForkBaseTitle(sourceSession?.title),
          stateRef.current.sessions,
        );
        const session = await runtime.forkSession(state.activeSessionId, messageID);
        const titledSession = { ...session, title: forkTitle };
        dispatch({ type: "SESSION_CREATED", payload: titledSession });
        forceSessionTitle(session.id, forkTitle);
        // Navigate to the newly forked session
        await selectSession(session.id, { session: titledSession });
      } catch (err) {
        dispatch({
          type: "SET_ERROR",
          payload: err instanceof Error ? err.message : "Failed to fork session",
        });
      }
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
    dispatch({ type: "UNREGISTER_WORKTREE", payload: normalizedWorktreeDir });
  }, []);

  const clearWorktreeCleanup = useCallback(() => {
    dispatch({ type: "SET_PENDING_WORKTREE_CLEANUP", payload: null });
  }, []);

  const createWorkspace = useCallback(
    (input: { name: string; serverUrl: string; username?: string; password?: string }) => {
      const id = `ws_${Date.now().toString(36)}`;
      const workspace = normalizeWorkspace({
        id,
        name: input.name,
        serverUrl: input.serverUrl,
        username: input.username,
        password: input.password,
        isLocal: false,
        projects: [],
        selectedModel: null,
        selectedAgent: null,
        lastActiveSessionId: null,
      });
      dispatch({
        type: "SET_WORKSPACES",
        payload: [...stateRef.current.workspaces, workspace],
      });
      dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: workspace.id });
      dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
    },
    [],
  );

  const updateWorkspace = useCallback(
    (
      workspaceId: string,
      input: Partial<Pick<Workspace, "name" | "serverUrl" | "username" | "password">>,
    ) => {
      const next = stateRef.current.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const nextServerUrl = workspace.isLocal
          ? DEFAULT_SERVER_URL
          : (input.serverUrl ?? workspace.serverUrl);
        return normalizeWorkspace({
          ...workspace,
          name: input.name ?? workspace.name,
          serverUrl: nextServerUrl,
          username: input.username ?? workspace.username,
          password: input.password ?? workspace.password,
        });
      });
      dispatch({ type: "SET_WORKSPACES", payload: next });
    },
    [],
  );

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      const workspace = stateRef.current.workspaces.find((item) => item.id === workspaceId);
      dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: workspaceId });
      void selectSession(workspace?.lastActiveSessionId ?? null);
    },
    [selectSession],
  );

  const removeWorkspace = useCallback(
    async (workspaceId: string) => {
      if (workspaceId === LOCAL_WORKSPACE_ID || allBackends.length === 0) return;
      const workspace = stateRef.current.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return;
      for (const directory of workspace.projects) {
        const projectKey = makeProjectKey(workspaceId, directory);
        await openGuiClient.agentBackends.disconnectProject({
          target: { directory, workspaceId },
        });
        dispatch({
          type: "REMOVE_PROJECT",
          payload: { projectKey, directory },
        });
      }
      const nextWorkspaces = stateRef.current.workspaces.filter((item) => item.id !== workspaceId);
      dispatch({ type: "SET_WORKSPACES", payload: nextWorkspaces });
      if (stateRef.current.activeWorkspaceId === workspaceId) {
        const nextWorkspace = nextWorkspaces[0] ?? null;
        dispatch({
          type: "SET_ACTIVE_WORKSPACE",
          payload: nextWorkspace?.id ?? LOCAL_WORKSPACE_ID,
        });
        void selectSession(nextWorkspace?.lastActiveSessionId ?? null);
      }
    },
    [allBackends, openGuiClient, selectSession],
  );

  const reorderWorkspaces = useCallback((fromIndex: number, toIndex: number) => {
    dispatch({
      type: "REORDER_WORKSPACES",
      payload: { fromIndex, toIndex },
    });
  }, []);

  const reorderVisibleProjects = useCallback((orderedDirectories: string[]) => {
    const workspaceId = stateRef.current.activeWorkspaceId;
    if (!workspaceId) return;
    dispatch({
      type: "REORDER_VISIBLE_WORKSPACE_PROJECTS",
      payload: { workspaceId, orderedDirectories },
    });
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
