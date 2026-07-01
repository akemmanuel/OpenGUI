import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from "react";
import { useAgentWorkspacePersistence } from "@/features/agent-bootstrap";
import type { Action } from "@/hooks/agent-reducer";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import {
  getWorkspaceDefaultChatDirectory,
  getWorkspaceRootDirectory,
  persistWorkspaces,
} from "@/hooks/agent-state-persistence";
import {
  buildActiveWorkspaceProjectSet,
  filterActiveWorkspaceSessions,
} from "@/hooks/agent-workspace-session-scope";
import {
  createWorkspaceLifecyclePlan,
  createWorkspaceSwitchPlan,
  createWorkspaceUpdatePlan,
} from "@/hooks/agent-workspace-lifecycle";
import {
  getSessionWorkspaceId,
  isHiddenProject,
  makeProjectKey,
  parseProjectKey,
} from "@/hooks/agent-session-utils";
import { canManageProjects as resolveCanManageProjects } from "@/hooks/workspace-guards";
import { resolveWorkspacePresentation } from "@/hooks/workspace-presentation";
import type { ConnectionContextValue } from "@/hooks/agent-contexts";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageSet } from "@/lib/safe-storage";
import type { OpenGuiClient } from "@/protocol/client";
import { normalizeProjectPath } from "@/lib/utils";
import type { HarnessId } from "@/agents";
import type { ShellWorkspacePolicy } from "@/runtime/shell-policy";
import type { Workspace } from "@/types/electron";

export type AgentWorkspaceScopeInput = {
  state: InternalAgentState;
  dispatch: Dispatch<Action>;
  openGuiClient: OpenGuiClient;
  shellWorkspacePolicy: ShellWorkspacePolicy;
};

/** Persistence + derived workspace scope (call before active harness / project bootstrap). */
export function useAgentWorkspaceScope(input: AgentWorkspaceScopeInput) {
  const { state, dispatch, openGuiClient, shellWorkspacePolicy } = input;

  const [workspaceStateReady, setWorkspaceStateReady] = useState(false);
  const pendingStartupSessionRestoreRef = useRef<string | null>(null);

  useAgentWorkspacePersistence({
    openGuiClient,
    dispatch,
    setWorkspaceStateReady,
    pendingStartupSessionRestoreRef,
  });

  useEffect(() => {
    if (!workspaceStateReady) return;
    persistWorkspaces(state.workspaces);
  }, [state.workspaces, workspaceStateReady]);

  useEffect(() => {
    storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, state.activeWorkspaceId);
  }, [state.activeWorkspaceId]);

  const activeWorkspace = useMemo(
    () =>
      state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
      state.workspaces[0] ??
      null,
    [state.workspaces, state.activeWorkspaceId],
  );

  const workspacePresentation = useMemo(
    () => resolveWorkspacePresentation(activeWorkspace, shellWorkspacePolicy),
    [activeWorkspace, shellWorkspacePolicy],
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

  return {
    workspaceStateReady,
    pendingStartupSessionRestoreRef,
    activeWorkspace,
    workspacePresentation,
    workspaceDirectory,
    activeWorkspaceSessions,
    visibleWorkspaceConnections,
  };
}

export type AgentWorkspaceAdminInput = {
  state: InternalAgentState;
  dispatch: Dispatch<Action>;
  getState: () => InternalAgentState;
  openGuiClient: OpenGuiClient;
  shellWorkspacePolicy: ShellWorkspacePolicy;
  workspaceStateReady: boolean;
  pendingStartupSessionRestoreRef: MutableRefObject<string | null>;
  activeWorkspace: Workspace | null;
  workspacePresentation: ReturnType<typeof resolveWorkspacePresentation>;
  workspaceDirectory: string | null;
  activeWorkspaceSessions: Session[];
  visibleWorkspaceConnections: Record<string, import("@/types/electron").ConnectionStatus>;
  activeResourceDirectory: string | null;
  activeResourceHarnessId: HarnessId;
  resourceHarness: unknown;
  loadServerResources: (
    harnessId: HarnessId,
    directory: string,
    workspaceId: string | undefined,
  ) => Promise<void>;
  loadedResourceProjectKeyRef: MutableRefObject<string | null>;
  loadedResourceHarnessIdRef: MutableRefObject<string | null>;
  selectSession: (
    sessionId: string | null,
    options?: {
      session?: Session;
      force?: boolean;
      preserveSelectionOnFailure?: boolean;
    },
  ) => Promise<void>;
};

/** Workspace CRUD, restore, resource activation, connection context slice (after selectSession). */
export function useAgentWorkspaceAdmin(input: AgentWorkspaceAdminInput) {
  const {
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
    activeWorkspaceSessions,
    visibleWorkspaceConnections,
    activeResourceDirectory,
    activeResourceHarnessId,
    resourceHarness,
    loadServerResources,
    loadedResourceProjectKeyRef,
    loadedResourceHarnessIdRef,
    selectSession,
  } = input;

  const attemptedStartupSessionRestoreRef = useRef<string | null>(null);

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
  }, [
    selectSession,
    state.activeWorkspaceId,
    state.sessions,
    workspaceStateReady,
    pendingStartupSessionRestoreRef,
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
    ) {
      return;
    }
    void loadServerResources(activeResourceHarnessId, activeResourceDirectory, activeWorkspace?.id);
  }, [
    resourceHarness,
    activeResourceDirectory,
    activeResourceHarnessId,
    activeWorkspace?.id,
    dispatch,
    loadServerResources,
    loadedResourceHarnessIdRef,
    loadedResourceProjectKeyRef,
    state.connections,
    state.workspaceResources,
  ]);

  const openDirectory = useCallback(async (): Promise<string | null> => {
    if (!workspacePresentation.supportsNativeDirectoryPicker) {
      return null;
    }
    return await openGuiClient.desktop.openDirectory();
  }, [workspacePresentation.supportsNativeDirectoryPicker, openGuiClient]);

  const createWorkspace = useCallback(
    (input: { name: string; serverUrl: string; authToken?: string }) => {
      const plan = createWorkspaceLifecyclePlan({
        workspaces: getState().workspaces,
        input,
      });
      dispatch({ type: "SET_WORKSPACES", payload: plan.nextWorkspaces });
      dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: plan.nextActiveWorkspaceId });
      dispatch({ type: "SET_ACTIVE_SESSION", payload: plan.nextActiveSessionId });
      dispatch({ type: "SET_DEFAULT_CHAT_DIRECTORY", payload: null });
    },
    [dispatch, getState],
  );

  const updateWorkspace = useCallback(
    (workspaceId: string, input: Partial<Pick<Workspace, "name" | "serverUrl" | "authToken">>) => {
      const current = getState().workspaces.find((workspace) => workspace.id === workspaceId);
      if (!current) return;
      const nextWorkspaces = createWorkspaceUpdatePlan({
        workspaces: getState().workspaces,
        workspaceId,
        input,
      });
      dispatch({ type: "SET_WORKSPACES", payload: nextWorkspaces });
    },
    [dispatch, getState],
  );

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      const plan = createWorkspaceSwitchPlan({
        workspaces: getState().workspaces,
        workspaceId,
      });
      const nextWorkspace = getState().workspaces.find(
        (workspace) => workspace.id === plan.nextActiveWorkspaceId,
      );
      dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: plan.nextActiveWorkspaceId });
      dispatch({
        type: "SET_DEFAULT_CHAT_DIRECTORY",
        payload: getWorkspaceDefaultChatDirectory(nextWorkspace),
      });
      void selectSession(plan.nextActiveSessionId);
    },
    [dispatch, getState, selectSession],
  );

  const removeWorkspace = useCallback(
    async (workspaceId: string) => {
      const current = getState().workspaces.find((workspace) => workspace.id === workspaceId);
      if (!current) return;
      const remaining = getState().workspaces.filter((workspace) => workspace.id !== workspaceId);
      dispatch({ type: "SET_WORKSPACES", payload: remaining });
      const nextActiveWorkspaceId =
        getState().activeWorkspaceId === workspaceId
          ? (remaining[0]?.id ?? "")
          : getState().activeWorkspaceId;
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
    [dispatch, getState, selectSession],
  );

  const reorderWorkspaces = useCallback(
    (fromIndex: number, toIndex: number) => {
      const next = [...getState().workspaces];
      if (fromIndex < 0 || fromIndex >= next.length) return;
      const clampedTo = Math.max(0, Math.min(toIndex, next.length - 1));
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return;
      next.splice(clampedTo, 0, moved);
      dispatch({
        type: "REORDER_WORKSPACES",
        payload: { fromIndex, toIndex: clampedTo },
      });
    },
    [dispatch, getState],
  );

  const reorderVisibleProjects = useCallback(
    (orderedDirectories: string[]) => {
      const workspaceId = getState().activeWorkspaceId;
      if (!workspaceId) return;
      dispatch({
        type: "REORDER_VISIBLE_WORKSPACE_PROJECTS",
        payload: { workspaceId, orderedDirectories },
      });
    },
    [dispatch, getState],
  );

  const connectionContextSlice = useMemo((): ConnectionContextValue => {
    return {
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
    };
  }, [
    activeResourceDirectory,
    activeWorkspace,
    shellWorkspacePolicy.supportsMultipleWorkspaces,
    state.activeWorkspaceId,
    state.bootError,
    state.bootLogs,
    state.bootState,
    state.busySessionIds,
    state.connections,
    state.defaultChatDirectory,
    state.lastError,
    state.pendingPermissions,
    state.pendingQuestions,
    state.projectHydration,
    state.projectMeta,
    state.projectWorkspaceMap,
    state.pendingWorktreeCleanup,
    state.sessions,
    state.workspaces,
    state.worktreeParents,
    state.workspaceResources,
    visibleWorkspaceConnections,
    workspaceDirectory,
    workspacePresentation,
  ]);

  return {
    activeWorkspaceSessions,
    connectionContextSlice,
    openDirectory,
    createWorkspace,
    updateWorkspace,
    removeWorkspace,
    switchWorkspace,
    reorderWorkspaces,
    reorderVisibleProjects,
  };
}
