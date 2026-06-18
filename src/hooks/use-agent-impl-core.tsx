/**
 * Central React context + hook for Harness state.
 *
 * Provides connection lifecycle, session management, messages,
 * variant selection, and real-time Harness event handling to entire
 * component tree.
 *
 * Uses v2 SDK types which include variant support on models.
 */

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
import { DEFAULT_HARNESS_ID, HARNESS_IDS, type ActiveHarnessId, type HarnessId } from "@/agents";
import { resolveActiveHarnessScope } from "@/hooks/active-harness-scope";
import { useBackendEventSubscription } from "@/hooks/agent-backend-event-subscription";
import {
  resolvePendingPromptCreationHarnessRoute,
  resolveSessionHarnessRoute,
} from "@/hooks/agent-harness-routing";
import { useLocalIntentOrchestration } from "@/features/local-intent";
import { resolvePromptBoxHarnessId } from "@/hooks/prompt-box-selection";
import { useSessionInteractionOrchestration } from "@/hooks/agent-session-interactions";
import { nextNamingRequestId } from "@/hooks/agent-send-state";
import { useAgentSessionActivation } from "@/hooks/agent-session-activation";
import {
  createLifecycleSession,
  createSessionRenamePlan,
  deleteLifecycleSession,
  forkLifecycleSession,
  refreshLifecycleSession,
} from "@/hooks/agent-session-lifecycle";
import {
  createWorkspaceLifecyclePlan,
  createWorkspaceSwitchPlan,
  createWorkspaceUpdatePlan,
} from "@/hooks/agent-workspace-lifecycle";
import { updateVariantSelections, useVariant, variantKey } from "@/hooks/use-agent-variant-core";
import {
  getActiveWorkspaceId,
  getLegacyStoredDefaultChatDirectory,
  getVariantSelectionsForWorkspace,
  getWorkspaceDefaultChatDirectory,
  getWorkspaceRootDirectory,
  getWorktreeParents,
  initializeBackendWorkspaceState,
  isLocalServer,
  LOCAL_WORKSPACE_ID,
  persistUnreadSessionIds,
  persistVariantSelectionsForWorkspace,
  persistWorkspaces,
  persistWorktreeParents,
  type SessionColor,
} from "@/hooks/agent-state-persistence";
import { resolveWorkspacePresentation } from "@/hooks/workspace-presentation";
import { canManageProjects as resolveCanManageProjects } from "@/hooks/workspace-guards";
import { initialAgentState } from "@/hooks/agent-initial-state";
import {
  isModelAvailable,
  resolveAvailableAgent,
  resolveServerDefaultModel,
  selectedModelsEqual,
  selectedVariantsEqual,
} from "@/hooks/agent-model-selection";
import {
  buildBootstrapProjectConfigs,
  buildWorkspaceProjectPersistPlan,
  createProjectConnectionDescriptor,
  createProjectConnectionStatus,
  createProjectRemovalPlan,
  createWorkspaceConnectionConfig,
  createWorkspaceProjectConnectionPlan,
  resolveConnectionWorkspace,
  shouldPersistLocalConnectionSettings,
  shouldPersistWorkspaceProject,
  shouldSnapshotProjectConnectionForRestart,
  type SessionListTargetSource,
} from "@/hooks/agent-project-connection";
import {
  createEmptyProjectHydrationState,
  getPendingProjectHydrationHarnessIds,
  hasProjectHydrationInFlight,
  isProjectHydrationComplete,
  settleProjectHydration,
  startProjectHydration,
  type ProjectHydrationState,
} from "@/hooks/agent-project-hydration";
import { mapSessionQueryErrorsForProject } from "@/hooks/session-query-errors";
import {
  fetchSessionMessagePage,
  hydrateChildSessionMessages,
  loadOlderSessionMessages,
} from "@/hooks/agent-message-loading";
import {
  buildActiveWorkspaceProjectSet,
  filterActiveWorkspaceSessions,
} from "@/hooks/agent-workspace-session-scope";
import {
  createSessionProjectDetachMeta,
  createSessionProjectMoveMeta,
  getSessionProjectTarget,
  getSessionSelectedAgent,
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
export { resolveServerDefaultModel } from "@/hooks/agent-model-selection";
import { DEFAULT_SERVER_URL, STORAGE_KEYS } from "@/lib/constants";
import { getNewChatModelBehavior } from "@/lib/new-chat-model-behavior";
import {
  onSettingsChange,
  storageGet,
  storageRemove,
  storageSet,
  storageSetOrRemove,
} from "@/lib/safe-storage";
import { useOpenGuiClient } from "@/protocol/provider";
import { persistSessionDrafts } from "@/lib/session-drafts";
import { generateSessionTitle } from "@/lib/session-namer";
import { i18n } from "@/i18n";
import { notifyInfo } from "@/lib/notify";
import { getErrorMessage, normalizeProjectPath } from "@/lib/utils";
import type {
  ConnectionConfig,
  ConnectionStatus,
  SelectedModel,
  Workspace,
} from "@/types/electron";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

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
  const [state, dispatch] = useReducer(reducer, initialAgentState);
  const [workspaceStateReady, setWorkspaceStateReady] = useState(false);
  const shellWorkspacePolicy = useMemo(() => getShellWorkspacePolicy(), []);
  const [preferredHarnessId, setPreferredHarnessId] = useState<HarnessId>(() => {
    const stored = storageGet(STORAGE_KEYS.HARNESS);
    return HARNESS_IDS.includes(stored as ActiveHarnessId)
      ? (stored as ActiveHarnessId)
      : DEFAULT_HARNESS_ID;
  });

  const openGuiClient = useOpenGuiClient();
  const allHarnesses = useMemo(() => openGuiClient.harnesses.list(), [openGuiClient]);
  const backendsById = useMemo(
    () =>
      Object.fromEntries(
        allHarnesses.map((backend) => [backend.id as HarnessId, backend]),
      ) as Record<HarnessId, (typeof allHarnesses)[number]>,
    [allHarnesses],
  );
  const activeSession = state.activeSessionId
    ? (state.sessions.find((session) => session.id === state.activeSessionId) ?? null)
    : null;
  const activeSessionHarnessRoute = resolveSessionHarnessRoute(activeSession);
  const activeSessionHarnessId = activeSessionHarnessRoute.harnessId;
  const discoveryHarnessIds = useMemo(
    () => allHarnesses.map((backend) => backend.id as HarnessId),
    [allHarnesses],
  );
  const expectedDirectoriesRef = useRef<Set<string>>(new Set());
  const forcedSessionTitlesRef = useRef<Map<string, string>>(new Map());
  const pendingTitlePersistenceRef = useRef<Map<string, string>>(new Map());
  const sessionIdAliasesRef = useRef<Map<string, string>>(new Map());
  const namingRequestIdsRef = useRef<Map<string, number>>(new Map());

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
  const loadedResourceHarnessIdRef = useRef<HarnessId | null>(null);
  const resourceLoadRequestRef = useRef(0);
  const resourceLoadInFlightKeyRef = useRef<string | null>(null);
  const updateProjectHydration = useCallback(
    (
      projectKey: string,
      updater: (current: ProjectHydrationState | undefined) => ProjectHydrationState,
    ) => {
      const hydration = updater(stateRef.current.projectHydration[projectKey]);
      dispatch({ type: "SET_PROJECT_HYDRATION", payload: { projectKey, hydration } });
      return hydration;
    },
    [],
  );
  const clearProjectHydration = useCallback((projectKey: string) => {
    dispatch({
      type: "SET_PROJECT_HYDRATION",
      payload: { projectKey, hydration: createEmptyProjectHydrationState() },
    });
  }, []);

  useEffect(() => {
    return onSettingsChange((change) => {
      if (change.key !== STORAGE_KEYS.HARNESS) return;
      setPreferredHarnessId(
        HARNESS_IDS.includes(change.value as ActiveHarnessId)
          ? (change.value as ActiveHarnessId)
          : DEFAULT_HARNESS_ID,
      );
    });
  }, []);

  const workspaceBootstrapRef = useRef(false);
  const pendingStartupSessionRestoreRef = useRef<string | null>(null);
  const attemptedStartupSessionRestoreRef = useRef<string | null>(null);
  const attemptedEmptySessionLoadRef = useRef<string | null>(null);
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
        pendingStartupSessionRestoreRef.current = activeWorkspace?.lastActiveSessionId ?? null;
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

  useBackendEventSubscription({
    allHarnessesCount: allHarnesses.length,
    cleanupSessionRefs,
    dispatch,
    openGuiClient,
    tracking: {
      expectedProjectKeys: expectedDirectoriesRef,
      forcedTitles: forcedSessionTitlesRef,
      pendingTitlePersistence: pendingTitlePersistenceRef,
      sessionIdAliases: sessionIdAliasesRef,
      namingRequestIds: namingRequestIdsRef,
    },
    workspaces: state.workspaces,
  });

  useEffect(() => {
    if (!workspaceStateReady) return;
    persistWorkspaces(state.workspaces);
  }, [state.workspaces, workspaceStateReady]);

  useEffect(() => {
    storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, state.activeWorkspaceId);
  }, [state.activeWorkspaceId]);

  // Persist unreadSessionIds through the frontend persistence abstraction whenever it changes
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
    workspaceId: state.activeWorkspaceId,
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
    async (harnessId: HarnessId, directory?: string | null, workspaceId?: string | null) => {
      const targetDirectory = directory?.trim() || undefined;
      const targetWorkspaceId = workspaceId?.trim() || undefined;
      const targetWorkspace = targetWorkspaceId
        ? stateRef.current.workspaces.find((workspace) => workspace.id === targetWorkspaceId)
        : null;
      const projectKey = targetDirectory ? makeProjectKey(targetWorkspaceId, targetDirectory) : "";
      const loadKey = `${harnessId}\u0000${projectKey}`;
      if (
        resourceLoadInFlightKeyRef.current === loadKey ||
        (loadedResourceHarnessIdRef.current === harnessId &&
          loadedResourceProjectKeyRef.current === (targetDirectory ? projectKey : null))
      ) {
        return;
      }
      resourceLoadInFlightKeyRef.current = loadKey;
      const requestId = ++resourceLoadRequestRef.current;
      try {
        const { providersData, agentsData, commandsData } =
          await openGuiClient.harnesses.loadResources({
            harnessId,
            target: {
              directory: targetDirectory,
              workspaceId: targetWorkspaceId,
              baseUrl: targetWorkspace?.isLocal ? undefined : targetWorkspace?.serverUrl,
              authToken: targetWorkspace?.isLocal ? undefined : targetWorkspace?.authToken,
            },
          });

        if (requestId !== resourceLoadRequestRef.current) return;

        loadedResourceProjectKeyRef.current = targetDirectory ? projectKey : null;
        loadedResourceHarnessIdRef.current = harnessId;

        const currentSelection = stateRef.current.selectedModel;
        const nextSelection = isModelAvailable(providersData.providers, currentSelection)
          ? currentSelection
          : null;
        dispatch({
          type: "SET_SELECTED_MODEL",
          payload: nextSelection ?? null,
        });

        dispatch({ type: "SET_AGENTS", payload: agentsData });
        const activeSessionId = stateRef.current.activeSessionId;
        const activeSession = activeSessionId
          ? stateRef.current.sessions.find((session) => session.id === activeSessionId)
          : null;
        const activeSessionAgent = getSessionSelectedAgent(activeSession);
        const activeSessionMeta = activeSessionId
          ? stateRef.current.sessionMeta[activeSessionId]
          : undefined;
        const nextAgent = resolveAvailableAgent({
          agents: agentsData,
          sessionAgent: activeSessionAgent ?? activeSessionMeta?.selectedAgent,
          hasSessionAgent: Boolean(
            activeSessionAgent ||
            (activeSessionMeta && Object.hasOwn(activeSessionMeta, "selectedAgent")),
          ),
          workspaceAgent: storageGet(STORAGE_KEYS.SELECTED_AGENT),
        });
        dispatch({ type: "SET_SELECTED_AGENT", payload: nextAgent });

        let nextVariantSelections = getVariantSelectionsForWorkspace(
          targetWorkspaceId ?? stateRef.current.activeWorkspaceId,
        );
        if (
          activeSessionMeta &&
          Object.hasOwn(activeSessionMeta, "selectedVariant") &&
          nextSelection
        ) {
          const key = variantKey(nextSelection.providerID, nextSelection.modelID);
          const desiredVariant = activeSessionMeta.selectedVariant ?? undefined;
          if (nextVariantSelections[key] !== desiredVariant) {
            nextVariantSelections = updateVariantSelections(
              nextVariantSelections,
              key,
              desiredVariant,
            );
          }
        }
        if (nextVariantSelections !== stateRef.current.variantSelections) {
          persistVariantSelectionsForWorkspace(
            targetWorkspaceId ?? stateRef.current.activeWorkspaceId,
            nextVariantSelections,
          );
        }

        dispatch({
          type: "SET_WORKSPACE_RESOURCES",
          payload: {
            workspaceId: targetWorkspaceId ?? stateRef.current.activeWorkspaceId,
            harnessId,
            projectKey: targetDirectory ? projectKey : null,
            providersData,
            agentsData,
            commandsData,
            variantSelections: nextVariantSelections,
          },
        });
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
      harnessId,
      suppressError,
      connectionKind,
    }: {
      config: ConnectionConfig;
      workspaceId: string;
      projectKey: string;
      harnessId: HarnessId;
      suppressError?: boolean;
      connectionKind?: ConnectionStatus["kind"];
    }) => {
      const connection = createProjectConnectionDescriptor({ config, workspaceId });
      updateProjectHydration(projectKey, (current) => startProjectHydration(current, [harnessId]));
      try {
        const connectResult = await openGuiClient.harnesses.registerDirectory({
          config: connection.config,
          harnessIds: [harnessId],
        });
        const connectionError =
          connectResult.connectedHarnessIds.length === 0
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
        // when a specific Harness is currently unhealthy/unavailable for new
        // work. Keep loading the session index after a failed connect and only
        // mark Harness hydration as failed after history has merged.
        const sessionQuery = await openGuiClient.sessions.query({
          projects: [
            {
              directory: connection.directory,
              workspaceId: connection.target.workspaceId,
              baseUrl: connection.config.baseUrl,
              authToken: connection.config.authToken,
            },
          ],
          harnessIds: [harnessId],
        });
        const sessions =
          sessionQuery.items.find((item) => item.harnessId === harnessId)?.sessions ?? [];
        dispatch({
          type: "MERGE_PROJECT_SESSIONS",
          payload: {
            projectKey,
            directory: connection.directory,
            sessions,
            harnessIds: [harnessId],
            source: connectionKind === "chat-infra" ? "default-chat" : "workspace-project",
          },
        });

        const queryScopeErrors = mapSessionQueryErrorsForProject({
          projectKey,
          directory: connection.directory,
          harnessIds: [harnessId],
          queryResult: sessionQuery,
        });

        if (connectionError) {
          updateProjectHydration(projectKey, (current) =>
            settleProjectHydration(current, {
              failedBackends: { [harnessId]: connectionError, ...queryScopeErrors },
            }),
          );
          return { harnessId, success: false as const, error: connectionError };
        }

        try {
          if (!connection.target.directory) {
            throw new Error("Queue listing requires a Project directory");
          }
          const queuedPromptsBySession = await openGuiClient.sessions.queue.listProject({
            harnessId,
            target: { ...connection.target, directory: connection.target.directory },
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
          const statuses = await openGuiClient.harnesses.listDirectorySessionStatuses({
            harnessIds: [harnessId],
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
            completedHarnessIds: [harnessId],
            failedBackends: queryScopeErrors,
          }),
        );
        return { harnessId, success: true as const };
      } catch (error) {
        const errorMessage = getErrorMessage(error) || "Connection failed";
        updateProjectHydration(projectKey, (current) =>
          settleProjectHydration(current, {
            failedBackends: { [harnessId]: errorMessage },
          }),
        );
        if (!suppressError) {
          dispatch({ type: "SET_ERROR", payload: errorMessage });
        }
        return { harnessId, success: false as const, error: errorMessage };
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
        harnessIds?: HarnessId[];
      },
    ) => {
      if (allHarnesses.length === 0 || !config.directory) return;
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
      const currentHydration = stateRef.current.projectHydration[projectKey];
      const requestedHarnessIds = options?.harnessIds?.length
        ? options.harnessIds
        : discoveryHarnessIds;
      const targetHarnessIds = options?.harnessIds?.length
        ? requestedHarnessIds.filter((harnessId) => {
            const completed = currentHydration?.completedHarnessIds.includes(harnessId) ?? false;
            const loading = currentHydration?.loadingHarnessIds.includes(harnessId) ?? false;
            return !completed && !loading;
          })
        : getPendingProjectHydrationHarnessIds(currentHydration, requestedHarnessIds);

      const applyVisibleWorkspaceProjectPersistence = () => {
        const worktreeParentMap = getWorktreeParents();
        const plan = buildWorkspaceProjectPersistPlan({
          directory: connection.directory,
          workspaceId: connection.workspaceId,
          worktreeParents: worktreeParentMap,
          workspace,
          config: connection.config,
          options,
        });
        if (!plan) return;
        if (plan.addWorkspaceProject) {
          dispatch({
            type: "ADD_WORKSPACE_PROJECT",
            payload: plan.addWorkspaceProject,
          });
        }
        if (plan.persistLocalConnectionSettings) {
          storageSet(STORAGE_KEYS.SERVER_URL, plan.serverUrl);
          storageSetOrRemove(STORAGE_KEYS.USERNAME, plan.username);
        }
      };

      if (targetHarnessIds.length === 0) {
        if (shouldPersistWorkspaceProject(options)) {
          dispatch({
            type: "SET_PROJECT_META",
            payload: { projectKey, meta: { hidden: false } },
          });
          if (
            isProjectHydrationComplete(currentHydration, requestedHarnessIds) &&
            (currentHydration?.completedHarnessIds.length ?? 0) > 0
          ) {
            dispatch({
              type: "SET_PROJECT_CONNECTION",
              payload: {
                projectKey,
                status: createProjectConnectionStatus(
                  "connected",
                  connection.config.baseUrl,
                  "project",
                ),
              },
            });
          }
          applyVisibleWorkspaceProjectPersistence();
        }
        return;
      }

      const hydrationResults = await Promise.allSettled(
        targetHarnessIds.map(
          async (harnessId) =>
            await hydrateProjectBackend({
              config: connection.config,
              workspaceId: connection.workspaceId,
              projectKey,
              harnessId,
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
        targetHarnessIds.length === discoveryHarnessIds.length
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
            if (stateRef.current.activeTargetDirectory === normalizedDirectory) {
              dispatch({ type: "CLEAR_ACTIVE_TARGET" });
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

      applyVisibleWorkspaceProjectPersistence();
    },
    [allHarnesses, discoveryHarnessIds, hydrateProjectBackend],
  );

  const ensureDirectoryConnection = useCallback(
    async (
      directory: string,
      options?: { hidden?: boolean; transient?: boolean; harnessIds?: HarnessId[] },
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
      const requestedHarnessIds = options?.harnessIds?.length
        ? options.harnessIds
        : discoveryHarnessIds;
      const currentHydration = stateRef.current.projectHydration[projectKey];
      const missingHarnessIds = getPendingProjectHydrationHarnessIds(
        currentHydration,
        requestedHarnessIds,
      );
      const completedRequestedBackends = requestedHarnessIds.every(
        (harnessId) => currentHydration?.completedHarnessIds.includes(harnessId) ?? false,
      );
      if (missingHarnessIds.length === 0) {
        const hasInFlightHydration = hasProjectHydrationInFlight(
          currentHydration,
          requestedHarnessIds,
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
          harnessIds: missingHarnessIds.length > 0 ? missingHarnessIds : requestedHarnessIds,
        },
      );

      if (options?.harnessIds?.length) {
        const nextHydration = stateRef.current.projectHydration[projectKey];
        const completedExplicitBackends = requestedHarnessIds.every(
          (harnessId) => nextHydration?.completedHarnessIds.includes(harnessId) ?? false,
        );
        const stillLoadingExplicitBackends = hasProjectHydrationInFlight(
          nextHydration,
          requestedHarnessIds,
        );
        if (!completedExplicitBackends && !stillLoadingExplicitBackends) {
          const firstError = requestedHarnessIds
            .map((harnessId) => nextHydration?.errors?.[harnessId])
            .find((value) => typeof value === "string" && value.length > 0);
          throw new Error(firstError || "Connection failed");
        }
      }
    },
    [addProject, discoveryHarnessIds],
  );

  const restartHarnesses = useCallback(async () => {
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
    const restartResults = await openGuiClient.harnesses.restart();
    const failedRestarts = Object.entries(restartResults).filter(([, result]) => !result.success);
    if (failedRestarts.length > 0) {
      const message = failedRestarts
        .map(([harnessId, result]) => `${harnessId}: ${result.error || "restart failed"}`)
        .join("; ");
      dispatch({ type: "SET_ERROR", payload: message });
      throw new Error(message);
    }
    dispatch({ type: "RESET_PROJECT_HYDRATION" });

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
          harnessIds: discoveryHarnessIds,
        });
      }),
    );
  }, [addProject, discoveryHarnessIds, openGuiClient]);

  const removeProject = useCallback(
    async (directory: string) => {
      if (allHarnesses.length === 0) return;
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
        await openGuiClient.harnesses.releaseDirectory({
          target: { directory: dir, workspaceId },
        });
        dispatch({
          type: "REMOVE_PROJECT",
          payload: { projectKey, directory: dir },
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
      allHarnesses,
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
        source?: SessionListTargetSource;
      }>,
      harnessIds: HarnessId[] = discoveryHarnessIds,
    ) => {
      const uniqueProjects = Array.from(
        new Map(
          projects
            .map((project) => ({
              workspaceId: project.workspaceId,
              directory: normalizeProjectPath(project.directory),
              baseUrl: project.baseUrl,
              authToken: project.authToken,
              source: project.source,
            }))
            .filter((project) => project.directory)
            .map((project) => [makeProjectKey(project.workspaceId, project.directory), project]),
        ).values(),
      );
      if (uniqueProjects.length === 0 || harnessIds.length === 0) return;

      const queryResult = await openGuiClient.sessions.query({
        projects: uniqueProjects.map((project) => ({
          directory: project.directory,
          workspaceId: project.workspaceId,
          baseUrl: project.baseUrl,
          authToken: project.authToken,
        })),
        harnessIds,
      });

      for (const item of queryResult.items) {
        const workspaceId =
          item.workspaceId ??
          uniqueProjects.find(
            (project) =>
              normalizeProjectPath(project.directory) === normalizeProjectPath(item.directory),
          )?.workspaceId;
        if (!workspaceId) continue;
        dispatch({
          type: "MERGE_PROJECT_SESSIONS",
          payload: {
            projectKey: makeProjectKey(workspaceId, item.directory),
            directory: item.directory,
            sessions: item.sessions,
            harnessIds: [item.harnessId],
            source: uniqueProjects.find(
              (project) =>
                project.workspaceId === workspaceId &&
                normalizeProjectPath(project.directory) === normalizeProjectPath(item.directory),
            )?.source,
          },
        });
      }

      for (const project of uniqueProjects) {
        const projectKey = makeProjectKey(project.workspaceId, project.directory);
        const queryScopeErrors = mapSessionQueryErrorsForProject({
          projectKey,
          directory: project.directory,
          harnessIds,
          queryResult,
        });
        if (Object.keys(queryScopeErrors).length === 0) continue;
        updateProjectHydration(projectKey, (current) =>
          settleProjectHydration(current, { failedBackends: queryScopeErrors }),
        );
      }
    },
    [discoveryHarnessIds, openGuiClient, updateProjectHydration],
  );

  // --- Startup bootstrap: ensure local server, then auto-connect open projects ---
  const startupAttempted = useRef(false);
  useEffect(() => {
    if (!workspaceStateReady || startupAttempted.current) return;
    startupAttempted.current = true;
    let cancelled = false;

    const bootstrap = async () => {
      const localServerBackend =
        allHarnesses.find((backend) => backend.capabilities.localServer) ?? null;
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
            payload: { projectKey, meta: { hidden: item.source === "default-chat" } },
          });
          dispatch({
            type: "ASSIGN_PROJECT_WORKSPACE",
            payload: { projectKey, workspaceId: item.workspaceId },
          });
          dispatch({
            type: "SET_PROJECT_CONNECTION",
            payload: {
              projectKey,
              status: createProjectConnectionStatus(
                "connected",
                item.baseUrl,
                item.source === "default-chat" ? "chat-infra" : "project",
              ),
            },
          });
          updateProjectHydration(projectKey, (current) =>
            settleProjectHydration(current, { completedHarnessIds: discoveryHarnessIds }),
          );
        }

        const activeWorkspaceId = stateRef.current.activeWorkspaceId;
        const activeWorkspaceProject = allProjectConfigs.find(
          (config) => config.workspaceId === activeWorkspaceId,
        );
        if (activeWorkspaceProject) {
          void loadServerResources(
            preferredHarnessId,
            activeWorkspaceProject.directory,
            activeWorkspaceProject.workspaceId,
          );
        }

        void loadSessionIndex(allProjectConfigs, discoveryHarnessIds).catch(() => {
          /* startup session index is best effort */
        });
      } catch {
        /* ignore frontend persistence errors */
        if (!cancelled) dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [
    allHarnesses,
    detachedProject,
    discoveryHarnessIds,
    loadServerResources,
    loadSessionIndex,
    preferredHarnessId,
    updateProjectHydration,
    workspaceStateReady,
    shellWorkspacePolicy.localWorkspaceMode,
  ]);

  useEffect(() => {
    if (detachedProject) return;
    if (state.activeSessionId || state.activeTargetDirectory) return;
    if (!state.defaultChatDirectory) return;
    dispatch({
      type: "SET_ACTIVE_TARGET",
      payload: {
        directory: state.defaultChatDirectory,
        harnessId: preferredHarnessId,
      },
    });
  }, [
    detachedProject,
    preferredHarnessId,
    state.activeSessionId,
    state.activeTargetDirectory,
    state.defaultChatDirectory,
  ]);

  const activeWorkspace = useMemo(
    () =>
      state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
      state.workspaces[0] ??
      null,
    [state.workspaces, state.activeWorkspaceId],
  );

  const workspacePresentation = useMemo(
    () => resolveWorkspacePresentation(activeWorkspace),
    [activeWorkspace],
  );

  const activeWorkspaceProjectSet = useMemo(() => {
    return buildActiveWorkspaceProjectSet({
      activeWorkspace,
      projectWorkspaceMap: state.projectWorkspaceMap,
    });
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
      filterActiveWorkspaceSessions({
        sessions: state.sessions,
        sessionMeta: state.sessionMeta,
        activeWorkspace,
        activeWorkspaceProjectSet,
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
    return state.activeTargetDirectory &&
      visibleActiveWorkspaceProjectSet.has(state.activeTargetDirectory)
      ? getWorkspaceRootDirectory(state.activeTargetDirectory, state.worktreeParents)
      : null;
  }, [
    visibleWorkspaceConnections,
    visibleActiveWorkspaceProjectSet,
    state.worktreeParents,
    state.activeTargetDirectory,
  ]);

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

  const activeHarnessScope = resolveActiveHarnessScope({
    activeSession,
    activeTargetDirectory: state.activeTargetDirectory,
    activeTargetHarnessId: state.activeTargetHarnessId,
    workspaceDirectory,
    preferredHarnessId,
    backendsById,
    openGuiClient,
  });
  const activeResourceHarnessId = activeHarnessScope.harnessId;
  const activeResourceDirectory = activeHarnessScope.directory;
  const resourceHarness = activeHarnessScope.harness;
  const runtime = activeHarnessScope.runtime;
  useEffect(() => {
    if (!state.activeTargetHarnessId) return;
    if (backendsById[state.activeTargetHarnessId]) return;
    if (!activeResourceDirectory || !backendsById[preferredHarnessId]) return;
    dispatch({
      type: "SET_ACTIVE_TARGET",
      payload: { directory: activeResourceDirectory, harnessId: preferredHarnessId },
    });
  }, [
    activeResourceDirectory,
    backendsById,
    dispatch,
    preferredHarnessId,
    state.activeTargetHarnessId,
  ]);
  useEffect(() => {
    if (!resourceHarness || !activeResourceDirectory) return;
    const activeProjectKey = makeProjectKey(activeWorkspace?.id, activeResourceDirectory);
    const activeConnection = state.connections[activeProjectKey];
    if (activeConnection?.state !== "connected") return;
    const activeWorkspaceId = activeWorkspace?.id;
    const cached = activeWorkspaceId ? state.workspaceResources[activeWorkspaceId] : undefined;
    if (
      activeWorkspaceId &&
      cached?.loadedHarnessId === activeResourceHarnessId &&
      cached.loadedProjectKey === activeProjectKey
    ) {
      dispatch({
        type: "ACTIVATE_WORKSPACE_RESOURCES",
        payload: { workspaceId: activeWorkspaceId },
      });
      return;
    }
    if (
      loadedResourceHarnessIdRef.current === activeResourceHarnessId &&
      loadedResourceProjectKeyRef.current === activeProjectKey
    )
      return;
    void loadServerResources(activeResourceHarnessId, activeResourceDirectory, activeWorkspace?.id);
  }, [
    resourceHarness,
    activeResourceHarnessId,
    activeResourceDirectory,
    activeWorkspace?.id,
    loadServerResources,
    state.connections,
    state.workspaceResources,
  ]);

  const openDirectory = useCallback(async (): Promise<string | null> => {
    if (!workspacePresentation.supportsNativeDirectoryPicker) {
      return null;
    }
    return await openGuiClient.desktop.openDirectory();
  }, [workspacePresentation.supportsNativeDirectoryPicker, openGuiClient]);

  const connectToProject = useCallback(
    async (
      directory: string,
      serverUrl?: string,
      usernameOverride?: string,
      passwordOverride?: string,
    ) => {
      const trimmedDirectory = normalizeProjectPath(directory);
      if (!trimmedDirectory) return;
      const currentState = stateRef.current;
      const activeWorkspaceRecord =
        currentState.workspaces.find((item) => item.id === currentState.activeWorkspaceId) ?? null;
      if (
        !resolveCanManageProjects(
          currentState.workspaces,
          currentState.activeWorkspaceId,
          activeWorkspaceRecord,
        )
      ) {
        notifyInfo(i18n.t("workspace.requiredBeforeProject"));
        return;
      }
      const workspace = resolveConnectionWorkspace(
        currentState.workspaces,
        currentState.activeWorkspaceId,
      );
      const url = serverUrl ?? workspace.serverUrl ?? DEFAULT_SERVER_URL;
      const normalizedUrl = url.replace(/\/+$/, "");
      const username = usernameOverride ?? workspace.username ?? undefined;
      const password = passwordOverride ?? workspace.password ?? undefined;
      const authToken = workspace.authToken ?? undefined;
      const workspaceId = workspace.id;
      const localServerApi = backendsById[preferredHarnessId]?.platform?.server;
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
    [addProject, backendsById, preferredHarnessId, connectedDirectorySet, loadSessionIndex],
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
          harnessId: resolveSessionHarnessRoute(current).harnessId ?? undefined,
          target: (() => {
            const target = getSessionProjectTarget(
              current,
              current ? stateRef.current.sessionMeta[current.id] : undefined,
            );
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
      const resolvedProjectTarget =
        projectTarget ??
        getSessionProjectTarget(
          session,
          session ? stateRef.current.sessionMeta[session.id] : undefined,
        ) ??
        undefined;
      const workspaceId =
        resolvedProjectTarget?.workspaceId ??
        session?._workspaceId ??
        stateRef.current.activeWorkspaceId;
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
            ? { ...resolvedProjectTarget, baseUrl: workspace.serverUrl, workspaceId }
            : resolvedProjectTarget,
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
      refreshSessionStatus: async (sessionId, projectTarget) => {
        const session = stateRef.current.sessions.find((item) => item.id === sessionId);
        const harnessId = resolveSessionHarnessRoute(session).harnessId;
        if (!harnessId || !projectTarget?.directory) return;
        const statuses = await openGuiClient.harnesses.listDirectorySessionStatuses({
          harnessIds: [harnessId],
          target: projectTarget,
        });
        const status = statuses[sessionId];
        const activeTurnId = stateRef.current.activeTurnRunBySession[sessionId];
        const activeTurn = activeTurnId ? stateRef.current.turnRuns[activeTurnId] : null;
        const lastAssistant = stateRef.current.messages.findLast(
          (message) => message.info.role === "assistant",
        );
        const completedAt = lastAssistant
          ? (lastAssistant.info.time as { completed?: number }).completed
          : undefined;
        const hasRunningTool = lastAssistant?.parts.some(
          (part) =>
            part.type === "tool" &&
            (part.state.status === "running" || part.state.status === "pending"),
        );
        const transcriptLooksSettled = Boolean(
          activeTurn?.status === "running" &&
          typeof completedAt === "number" &&
          Date.now() - completedAt > 2000 &&
          !hasRunningTool,
        );
        if (!status && !transcriptLooksSettled) return;
        dispatch({
          type: "SESSION_STATUS",
          payload: {
            sessionID: sessionId,
            status: transcriptLooksSettled ? { type: "idle" } : status!,
          },
        });
      },
      hydrateChildSessionsForMessages,
      dispatch,
      stateRef,
      selectSessionRequestRef,
      sessionReconcileRequestRef,
    });

  useEffect(() => {
    if (!workspaceStateReady) return;
    const restoreSessionId = pendingStartupSessionRestoreRef.current;
    if (!restoreSessionId) return;
    const activeWorkspaceId = state.activeWorkspaceId;
    const session = state.sessions.find(
      (item) => item.id === restoreSessionId && getSessionWorkspaceId(item) === activeWorkspaceId,
    );
    if (!session) return;
    const attemptKey = `${activeWorkspaceId}\u0000${restoreSessionId}`;
    if (attemptedStartupSessionRestoreRef.current === attemptKey) return;
    attemptedStartupSessionRestoreRef.current = attemptKey;
    pendingStartupSessionRestoreRef.current = null;
    void selectSession(restoreSessionId, {
      session,
      force: true,
      preserveSelectionOnFailure: true,
    });
  }, [selectSession, state.activeWorkspaceId, state.sessions, workspaceStateReady]);

  useEffect(() => {
    const sessionId = state.activeSessionId;
    if (!sessionId || state.isLoadingMessages || state.messages.length > 0) return;
    if (attemptedEmptySessionLoadRef.current === sessionId) return;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    attemptedEmptySessionLoadRef.current = sessionId;
    void selectSession(sessionId, {
      session,
      force: true,
      preserveSelectionOnFailure: true,
    });
  }, [
    selectSession,
    state.activeSessionId,
    state.isLoadingMessages,
    state.messages.length,
    state.sessions,
  ]);

  const isChatDirectory = useCallback((directory?: string | null) => {
    const normalizedDirectory = directory ? normalizeProjectPath(directory) : null;
    const defaultChatDirectory = stateRef.current.defaultChatDirectory;
    if (!normalizedDirectory || !defaultChatDirectory) return false;
    return normalizedDirectory === normalizeProjectPath(defaultChatDirectory);
  }, []);

  const loadOlderMessages = useCallback(async (): Promise<boolean> => {
    const sessionId = stateRef.current.activeSessionId;
    const session = sessionId
      ? stateRef.current.sessions.find((candidate) => candidate.id === sessionId)
      : undefined;
    const projectTarget = session
      ? (getSessionProjectTarget(session, stateRef.current.sessionMeta[session.id]) ?? undefined)
      : undefined;
    return await loadOlderSessionMessages({
      state: stateRef.current,
      fetchMessagePage: (id, options) => fetchMessagePage(id, options, projectTarget),
      dispatch,
    });
  }, [fetchMessagePage]);

  const createSession = useCallback(
    async (title?: string, directory?: string): Promise<Session | null> => {
      return await createLifecycleSession({
        title,
        directory,
        state: {
          activeTargetHarnessId: stateRef.current.activeTargetHarnessId,
          sessions: stateRef.current.sessions,
          activeSessionId: stateRef.current.activeSessionId,
          activeWorkspaceId: stateRef.current.activeWorkspaceId,
          activeWorkspaceServerUrl: stateRef.current.workspaces.find(
            (workspace) => workspace.id === stateRef.current.activeWorkspaceId,
          )?.serverUrl,
        },
        preferredHarnessId,
        ensureDirectoryConnection,
        sessionsClient: openGuiClient.sessions,
        isChatDirectory,
        selectSession,
        dispatch,
      });
    },
    [openGuiClient, preferredHarnessId, selectSession, ensureDirectoryConnection, isChatDirectory],
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
          harnessId: resolveSessionHarnessRoute(plan.currentSession).harnessId ?? undefined,
          target:
            getSessionProjectTarget(
              plan.currentSession,
              plan.currentSession
                ? stateRef.current.sessionMeta[plan.currentSession.id]
                : undefined,
            ) ?? undefined,
        })
        .catch(() => {
          /* best-effort rename – backend events will reconcile */
        });
    },
    [openGuiClient],
  );

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

  const { sendPrompt, sendCommand, sendQueuedNow, ensureSession, justIdledMap } =
    useLocalIntentOrchestration({
      state,
      getState: () => stateRef.current,
      getResourceRuntime: () => runtime,
      getCurrentVariant: () => currentVariant,
      getWorkspaceBaseUrl: (workspaceId) => {
        const workspace = stateRef.current.workspaces.find((item) => item.id === workspaceId);
        return workspace && !workspace.isLocal ? workspace.serverUrl : undefined;
      },
      sessionsClient: openGuiClient.sessions,
      createSession,
      scheduleSessionMessageReconcile,
      requestSessionAutoName,
      dispatch: (action) => dispatch(action as never),
      refreshSessionMessages: refreshActiveSessionMessages,
      getFallbackHarnessId: () => preferredHarnessId,
    });

  const {
    summarizeSession,
    abortSession,
    respondPermission,
    replyQuestion,
    rejectQuestion,
    getQueuedPrompts,
    removeFromQueue,
    reorderQueue,
    updateQueuedPrompt,
  } = useSessionInteractionOrchestration({
    state,
    stateRef,
    runtime,
    openGuiClient,
    ensureSession,
    resolveCurrentSessionId,
    dispatch,
  });

  const findFiles = useCallback(
    async (
      target: { directory?: string; workspaceId?: string; baseUrl?: string } | null,
      query: string,
    ): Promise<string[]> => {
      if (!runtime) return [];
      try {
        return await openGuiClient.files.find({
          target: target ?? {},
          query,
        });
      } catch (error) {
        console.error("[findFiles] request failed", {
          target,
          query,
          error,
        });
        return [];
      }
    },
    [openGuiClient, runtime],
  );

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

  const setDefaultChatDirectory = useCallback(
    (directory: string | null) => {
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

      const workspace = nextWorkspaces.find((item) => item.id === workspaceId);
      if (!workspace || !normalizedDirectory) return;
      const alreadyProject = workspace.projects.some(
        (project) => normalizeProjectPath(project) === normalizedDirectory,
      );
      if (alreadyProject) return;

      void ensureDirectoryConnection(normalizedDirectory, {
        hidden: true,
        transient: true,
      }).catch(() => {
        /* default chat verification/indexing is best effort */
      });
    },
    [ensureDirectoryConnection],
  );

  const setActiveTarget = useCallback(
    (
      directory: string,
      harnessId?: HarnessId | null,
      options?: { resetSelection?: boolean; newChat?: boolean },
    ) => {
      const payload: {
        directory: string;
        harnessId: HarnessId | null;
        resetSelection?: boolean;
        selectedModel?: SelectedModel | null;
        selectedAgent?: string | null;
      } = {
        directory,
        harnessId:
          harnessId ??
          activeSessionHarnessId ??
          resolvePendingPromptCreationHarnessRoute({
            activeTargetHarnessId: stateRef.current.activeTargetHarnessId,
            preferredHarnessId,
          }).harnessId,
      };

      if (options?.newChat) {
        const behavior = getNewChatModelBehavior();
        if (behavior === "ask") {
          payload.resetSelection = true;
        } else if (behavior === "workspace-default") {
          payload.resetSelection = true;
          payload.selectedModel = resolveServerDefaultModel(
            stateRef.current.providers,
            stateRef.current.providerDefaults,
          );
          payload.selectedAgent = null;
        }
      } else if (options?.resetSelection) {
        payload.resetSelection = true;
      }

      dispatch({ type: "SET_ACTIVE_TARGET", payload });
    },
    [activeSessionHarnessId, preferredHarnessId],
  );

  const startNewChat = useCallback(async () => {
    const defaultChatDirectory = normalizeProjectPath(stateRef.current.defaultChatDirectory ?? "");
    if (!defaultChatDirectory) return;
    // Opening a blank chat should not touch the filesystem. The project connection is
    // created lazily when the user sends a prompt or explicitly connects a project,
    // which avoids unnecessary macOS Documents/Desktop permission prompts.
    setActiveTarget(defaultChatDirectory, preferredHarnessId, { newChat: true });
  }, [preferredHarnessId, setActiveTarget]);

  const setActiveTargetDirectory = useCallback(
    (directory: string) => {
      const harnessId =
        activeSessionHarnessId ??
        resolvePendingPromptCreationHarnessRoute({
          activeTargetHarnessId: stateRef.current.activeTargetHarnessId,
          preferredHarnessId,
        }).harnessId;
      dispatch({ type: "SET_ACTIVE_TARGET", payload: { directory, harnessId } });
    },
    [activeSessionHarnessId, preferredHarnessId],
  );

  const persistPromptBoxHarnessId = useCallback((harnessId: HarnessId) => {
    storageSet(STORAGE_KEYS.HARNESS, harnessId);
    setPreferredHarnessId(harnessId);
  }, []);

  const setPromptBoxSelection = useCallback(
    (input: { harnessId: HarnessId; model: SelectedModel }) => {
      dispatch({ type: "SET_PROMPT_BOX_SELECTION", payload: input });
      persistPromptBoxHarnessId(input.harnessId);
    },
    [persistPromptBoxHarnessId],
  );

  const setModelWithHarnessPersistence = useCallback(
    (model: SelectedModel | null) => {
      setModel(model);
      if (model && stateRef.current.activeTargetDirectory && !stateRef.current.activeSessionId) {
        const harnessId = resolvePromptBoxHarnessId({
          activeSession: null,
          activeTargetHarnessId: stateRef.current.activeTargetHarnessId,
          fallbackHarnessId: preferredHarnessId,
        });
        persistPromptBoxHarnessId(harnessId);
      }
    },
    [persistPromptBoxHarnessId, preferredHarnessId, setModel],
  );

  /** Re-fetch providers from the server and update global state. */
  const refreshProviders = useCallback(async () => {
    await loadServerResources(
      activeResourceHarnessId,
      activeResourceDirectory ??
        (loadedResourceProjectKeyRef.current
          ? parseProjectKey(loadedResourceProjectKeyRef.current).directory
          : null),
      activeWorkspace?.id,
    );
  }, [activeResourceHarnessId, activeResourceDirectory, activeWorkspace?.id, loadServerResources]);

  const clearError = useCallback(() => {
    dispatch({ type: "SET_ERROR", payload: null });
    if (state.bootState === "error") {
      dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
    }
  }, [state.bootState]);

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
          harnessId: resolveSessionHarnessRoute(activeSession).harnessId ?? undefined,
          target:
            getSessionProjectTarget(
              activeSession,
              activeSession ? state.sessionMeta[activeSession.id] : undefined,
            ) ?? undefined,
        });
      }
      const activeSession = stateRef.current.sessions.find(
        (session) => session.id === state.activeSessionId,
      );
      const projectTarget =
        getSessionProjectTarget(
          activeSession,
          activeSession ? stateRef.current.sessionMeta[activeSession.id] : undefined,
        ) ?? undefined;
      await refreshLifecycleSession({
        sessionId: state.activeSessionId,
        mutateSession: () =>
          runtime.revertSession(state.activeSessionId!, messageID, undefined, projectTarget),
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
    const activeSession = stateRef.current.sessions.find(
      (session) => session.id === state.activeSessionId,
    );
    const projectTarget =
      getSessionProjectTarget(
        activeSession,
        activeSession ? stateRef.current.sessionMeta[activeSession.id] : undefined,
      ) ?? undefined;
    await refreshLifecycleSession({
      sessionId: state.activeSessionId,
      mutateSession: () => runtime.unrevertSession(state.activeSessionId!, projectTarget),
      fetchMessagePage,
      dispatch,
      errorMessage: "Failed to unrevert session",
    });
  }, [runtime, fetchMessagePage, state.activeSessionId]);

  const forkFromMessage = useCallback(
    async (messageID: string) => {
      if (!runtime || !state.activeSessionId) return;
      const activeSession = stateRef.current.sessions.find(
        (session) => session.id === state.activeSessionId,
      );
      const projectTarget =
        getSessionProjectTarget(
          activeSession,
          activeSession ? stateRef.current.sessionMeta[activeSession.id] : undefined,
        ) ?? undefined;
      await forkLifecycleSession({
        messageId: messageID,
        activeSessionId: state.activeSessionId,
        sessions: stateRef.current.sessions,
        runtime,
        selectSession,
        forceSessionTitle,
        dispatch,
        target: projectTarget,
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
        const meta = createSessionProjectMoveMeta(
          sourceSession,
          stateRef.current.sessionMeta[sessionId],
          targetDirectory,
        );
        if (!meta) return;

        dispatch({
          type: "SET_SESSION_META",
          payload: {
            sessionId,
            meta,
          },
        });
        await ensureDirectoryConnection(targetDirectory);
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

  const removeSessionFromProject = useCallback(
    async (sessionId: string) => {
      try {
        if (stateRef.current.busySessionIds.has(sessionId)) {
          throw new Error("Wait for the session to finish before removing it from the project.");
        }
        const sourceSession = stateRef.current.sessions.find((session) => session.id === sessionId);
        if (!sourceSession) return;
        const sourceDirectory = normalizeProjectPath(
          (sourceSession._projectDir ?? sourceSession.directory) || "",
        );
        if (!sourceDirectory) return;
        const meta = createSessionProjectDetachMeta(
          sourceSession,
          stateRef.current.sessionMeta[sessionId],
          Date.now(),
          stateRef.current.defaultChatDirectory,
        );
        if (!meta) return;

        dispatch({
          type: "SET_SESSION_META",
          payload: {
            sessionId,
            meta,
          },
        });
        await selectSession(sessionId);
      } catch (error) {
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error) || "Failed to remove session from project",
        });
      }
    },
    [selectSession],
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
      activeTargetDirectory: state.activeTargetDirectory,
      activeTargetHarnessId: state.activeTargetHarnessId,
      namingSessionIds: state.namingSessionIds,
      unreadSessionIds: state.unreadSessionIds,
      sessionDrafts: state.sessionDrafts,
      sessionMeta: state.sessionMeta,
      sessionErrors: state.sessionErrors,
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
      state.activeTargetDirectory,
      state.activeTargetHarnessId,
      state.namingSessionIds,
      state.unreadSessionIds,
      state.sessionDrafts,
      state.sessionMeta,
      state.sessionErrors,
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
      canManageProjects: resolveCanManageProjects(
        state.workspaces,
        state.activeWorkspaceId,
        activeWorkspace,
      ),
      workspaceStatuses: Object.fromEntries(
        state.workspaces.map((workspace) => {
          const workspaceSessions = state.sessions.filter((session) => {
            const sessionWorkspaceId = getSessionWorkspaceId(session);
            if (sessionWorkspaceId) {
              return sessionWorkspaceId === workspace.id;
            }
            const directory = normalizeProjectPath(
              (session._projectDir ?? session.directory) || "",
            );
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
      workspaceServerUrl: workspacePresentation.activeBackendUrl,
      isLocalWorkspace: workspacePresentation.isLocalWorkspace,
      supportsNativeDirectoryPicker: workspacePresentation.supportsNativeDirectoryPicker,
      attachmentBaseUrl: workspacePresentation.attachmentBaseUrl,
      activeDirectory: activeResourceDirectory,
      bootState: state.bootState,
      bootError: state.bootError,
      bootLogs: state.bootLogs,
      lastError: state.lastError,
      worktreeParents: state.worktreeParents,
      projectMeta: state.projectMeta,
      pendingWorktreeCleanup: state.pendingWorktreeCleanup,
      workspaceResources: state.workspaceResources,
      projectHydration: state.projectHydration,
    }),
    [
      state.workspaces,
      activeWorkspace,
      state.activeWorkspaceId,
      shellWorkspacePolicy.supportsMultipleWorkspaces,
      state.sessions,
      state.connections,
      state.projectHydration,
      state.projectWorkspaceMap,
      state.busySessionIds,
      state.pendingPermissions,
      state.pendingQuestions,
      visibleWorkspaceConnections,
      workspaceDirectory,
      state.defaultChatDirectory,
      workspacePresentation,
      activeResourceDirectory,
      state.bootState,
      state.bootError,
      state.bootLogs,
      state.lastError,
      state.worktreeParents,
      state.projectMeta,
      state.pendingWorktreeCleanup,
      state.workspaceResources,
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
      setModel: setModelWithHarnessPersistence,
      setPromptBoxSelection,
      setAgent,
      cycleVariant: doCycleVariant,
      revertVariant: doRevertVariant,
      clearError,
      refreshProviders,
      restartHarnesses,
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
      setActiveTarget,
      setDefaultChatDirectory,
      setActiveTargetDirectory,
      revertToMessage,
      unrevert,
      forkFromMessage,
      setSessionColor,
      setSessionTags,
      setSessionPinned,
      moveSessionToProject,
      removeSessionFromProject,
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
      summarizeSession,
      abortSession,
      respondPermission,
      replyQuestion,
      rejectQuestion,
      setModelWithHarnessPersistence,
      setPromptBoxSelection,
      setAgent,
      doCycleVariant,
      doRevertVariant,
      clearError,
      refreshProviders,
      restartHarnesses,
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
      setActiveTarget,
      setDefaultChatDirectory,
      setActiveTargetDirectory,
      revertToMessage,
      unrevert,
      forkFromMessage,
      setSessionColor,
      setSessionTags,
      setSessionPinned,
      moveSessionToProject,
      removeSessionFromProject,
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
export const HarnessProvider = InternalAgentProvider;
export type HarnessState = InternalAgentState;
