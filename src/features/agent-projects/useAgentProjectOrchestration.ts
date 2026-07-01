import { useCallback, useRef } from "react";
import type { HarnessId } from "@/agents";
import {
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
import type { Action } from "@/hooks/agent-reducer";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import { getWorktreeParents, LOCAL_WORKSPACE_ID } from "@/hooks/agent-state-persistence";
import { STORAGE_KEYS } from "@/lib/constants";
import { refreshProjectSessionIndex } from "@/hooks/agent-session-index-refresh";
import { mapSessionQueryErrorsForProject } from "@/hooks/session-query-errors";
import {
  getSessionWorkspaceId,
  makeProjectKey,
  parseProjectKey,
} from "@/hooks/agent-session-utils";
import { canManageProjects as resolveCanManageProjects } from "@/hooks/workspace-guards";
import { DEFAULT_SERVER_URL } from "@/lib/constants";
import { i18n } from "@/i18n";
import { notifyInfo } from "@/lib/notify";
import { storageSet, storageSetOrRemove } from "@/lib/safe-storage";
import type { OpenGuiClient } from "@/protocol/client";
import { getErrorMessage, normalizeProjectPath } from "@/lib/utils";
import type { ConnectionConfig, ConnectionStatus } from "@/types/electron";

type HarnessBackend = ReturnType<OpenGuiClient["harnesses"]["list"]>[number];

export type AgentProjectOrchestrationInput = {
  openGuiClient: OpenGuiClient;
  dispatch: (action: Action) => void;
  getState: () => InternalAgentState;
  allHarnesses: HarnessBackend[];
  discoveryHarnessIds: HarnessId[];
  backendsById: Record<HarnessId, HarnessBackend>;
  preferredHarnessId: HarnessId;
  cleanupSessionRefs: (sessionIds?: Iterable<string>) => void;
  clearDefaultChatDirectory: () => void;
};

export function useAgentProjectOrchestration(input: AgentProjectOrchestrationInput) {
  const {
    openGuiClient,
    dispatch,
    getState,
    allHarnesses,
    discoveryHarnessIds,
    backendsById,
    preferredHarnessId,
    cleanupSessionRefs,
    clearDefaultChatDirectory,
  } = input;

  const expectedDirectoriesRef = useRef<Set<string>>(new Set());

  const updateProjectHydration = useCallback(
    (
      projectKey: string,
      updater: (current: ProjectHydrationState | undefined) => ProjectHydrationState,
    ) => {
      const hydration = updater(getState().projectHydration[projectKey]);
      dispatch({ type: "SET_PROJECT_HYDRATION", payload: { projectKey, hydration } });
      return hydration;
    },
    [dispatch, getState],
  );

  const clearProjectHydration = useCallback(
    (projectKey: string) => {
      dispatch({
        type: "SET_PROJECT_HYDRATION",
        payload: { projectKey, hydration: createEmptyProjectHydrationState() },
      });
    },
    [dispatch],
  );

  const hydrateProjectBackend = useCallback(
    async ({
      config,
      workspaceId,
      projectKey,
      harnessId,
      suppressError,
      connectionKind,
      source,
    }: {
      config: ConnectionConfig;
      workspaceId: string;
      projectKey: string;
      harnessId: HarnessId;
      suppressError?: boolean;
      connectionKind?: ConnectionStatus["kind"];
      source?: "workspace-project" | "default-chat";
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

        const { queryResult: sessionQuery } = await refreshProjectSessionIndex({
          sessionsClient: openGuiClient.sessions,
          dispatchMerge: (payload) => dispatch({ type: "MERGE_PROJECT_SESSIONS", payload }),
          workspaceId: connection.target.workspaceId,
          directory: connection.directory,
          harnessId,
          source: source ?? "workspace-project",
          baseUrl: connection.config.baseUrl,
          authToken: connection.config.authToken,
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
    [dispatch, openGuiClient, updateProjectHydration],
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
      const state = getState();
      const workspaceId = config.workspaceId ?? state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
      const connection = createProjectConnectionDescriptor({ config, workspaceId });
      const projectKey = connection.projectKey;
      const workspace =
        state.workspaces.find((candidate) => candidate.id === connection.workspaceId) ??
        resolveConnectionWorkspace(state.workspaces, connection.workspaceId);
      const connectionKind: ConnectionStatus["kind"] = "project";
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
      const currentHydration = state.projectHydration[projectKey];
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
              source: options?.transient ? "default-chat" : "workspace-project",
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
            getState().defaultChatDirectory ?? "",
          );

          if (
            normalizedDirectory &&
            normalizedDefaultChatDirectory &&
            normalizedDirectory === normalizedDefaultChatDirectory
          ) {
            clearDefaultChatDirectory();
            if (getState().activeTargetDirectory === normalizedDirectory) {
              dispatch({ type: "CLEAR_ACTIVE_TARGET" });
            }
          }

          if (workspace.projects.includes(connection.directory) && options?.transient !== true) {
            dispatch({
              type: "REMOVE_PROJECT",
              payload: { projectKey, directory: connection.directory },
            });
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
    [
      allHarnesses.length,
      clearDefaultChatDirectory,
      discoveryHarnessIds,
      dispatch,
      getState,
      hydrateProjectBackend,
    ],
  );

  const ensureDirectoryConnection = useCallback(
    async (
      directory: string,
      options?: { hidden?: boolean; transient?: boolean; harnessIds?: HarnessId[] },
    ) => {
      const normalizedDirectory = normalizeProjectPath(directory);
      if (!normalizedDirectory) return;
      const state = getState();
      const workspace = resolveConnectionWorkspace(state.workspaces, state.activeWorkspaceId);
      const workspaceId = workspace.id;
      const projectKey = makeProjectKey(workspaceId, normalizedDirectory);
      const status = state.connections[projectKey];
      const requestedHarnessIds = options?.harnessIds?.length
        ? options.harnessIds
        : discoveryHarnessIds;
      const currentHydration = state.projectHydration[projectKey];
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
        const nextHydration = getState().projectHydration[projectKey];
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
    [addProject, discoveryHarnessIds, getState],
  );

  const restartHarnesses = useCallback(async () => {
    const state = getState();
    const snapshot = Object.entries(state.connections)
      .map(([projectKey, status]) => {
        const { workspaceId, directory } = parseProjectKey(projectKey);
        const workspace =
          state.workspaces.find((candidate) => candidate.id === workspaceId) ??
          resolveConnectionWorkspace(state.workspaces, workspaceId);
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
        const connectionKind = getState().connections[projectKey]?.kind ?? "project";
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
          hidden: getState().projectMeta[projectKey]?.hidden === true,
          harnessIds: discoveryHarnessIds,
        });
      }),
    );
  }, [addProject, discoveryHarnessIds, dispatch, getState, openGuiClient]);

  const removeProject = useCallback(
    async (directory: string) => {
      if (allHarnesses.length === 0) return;
      const state = getState();
      const workspaceId = state.activeWorkspaceId;
      const worktreeParentMap = getWorktreeParents();
      const { directoriesToRemove } = createProjectRemovalPlan({
        directory,
        worktreeParents: worktreeParentMap,
      });

      for (const dir of directoriesToRemove) {
        const projectKey = makeProjectKey(workspaceId, dir);
        const isExplicitWorkspaceProject = state.workspaces.some(
          (workspace) => workspace.id === workspaceId && workspace.projects.includes(dir),
        );
        const removedSessionIds = isExplicitWorkspaceProject
          ? state.sessions
              .filter((session) => {
                if (getSessionWorkspaceId(session) !== workspaceId) return false;
                const sessionDir = session._projectDir ?? session.directory;
                if (sessionDir !== dir) return false;
                const meta = state.sessionMeta[session.id];
                if (meta?.displayProjectDir && meta.displayProjectDir !== dir) return false;
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

      const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
      const removedExplicitProject = state.workspaces.some(
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
      allHarnesses.length,
      cleanupSessionRefs,
      clearProjectHydration,
      dispatch,
      getState,
      openGuiClient,
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
    [discoveryHarnessIds, dispatch, openGuiClient, updateProjectHydration],
  );

  const connectToProject = useCallback(
    async (
      directory: string,
      serverUrl?: string,
      usernameOverride?: string,
      passwordOverride?: string,
    ) => {
      const trimmedDirectory = normalizeProjectPath(directory);
      if (!trimmedDirectory) return;
      const currentState = getState();
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
      const connectedDirectorySet = new Set(
        Object.keys(currentState.connections)
          .filter((projectKey) => parseProjectKey(projectKey).workspaceId === workspaceId)
          .map((projectKey) => parseProjectKey(projectKey).directory),
      );
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
    [addProject, backendsById, getState, loadSessionIndex, preferredHarnessId],
  );

  return {
    expectedDirectoriesRef,
    updateProjectHydration,
    addProject,
    ensureDirectoryConnection,
    restartHarnesses,
    removeProject,
    loadSessionIndex,
    connectToProject,
  };
}

export type AgentProjectOrchestration = ReturnType<typeof useAgentProjectOrchestration>;
