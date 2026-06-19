import { useEffect, useRef, type Dispatch, type MutableRefObject } from "react";
import type { HarnessId } from "@/agents";
import {
  buildBootstrapProjectConfigs,
  createProjectConnectionStatus,
} from "@/hooks/agent-project-connection";
import {
  settleProjectHydration,
  type ProjectHydrationState,
} from "@/hooks/agent-project-hydration";
import type { Action } from "@/hooks/agent-reducer";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import { getWorktreeParents, isLocalServer } from "@/hooks/agent-state-persistence";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import type { ShellWorkspacePolicy } from "@/runtime/shell-policy";
import { getErrorMessage } from "@/lib/utils";

type HarnessBackend = ReturnType<
  import("@/protocol/client").OpenGuiClient["harnesses"]["list"]
>[number];

export function useAgentProjectBootstrap(input: {
  workspaceStateReady: boolean;
  allHarnesses: HarnessBackend[];
  detachedProject?: string;
  discoveryHarnessIds: HarnessId[];
  preferredHarnessId: HarnessId;
  shellWorkspacePolicy: ShellWorkspacePolicy;
  dispatch: Dispatch<Action>;
  getState: () => InternalAgentState;
  expectedDirectoriesRef: MutableRefObject<Set<string>>;
  updateProjectHydration: (
    projectKey: string,
    updater: (current: ProjectHydrationState | undefined) => ProjectHydrationState,
  ) => ProjectHydrationState;
  loadServerResources: (
    harnessId: HarnessId,
    directory?: string | null,
    workspaceId?: string | null,
    options?: { force?: boolean },
  ) => Promise<void>;
  loadSessionIndex: (
    projects: Array<{
      workspaceId: string;
      directory: string;
      baseUrl?: string;
      authToken?: string;
      source?: import("@/hooks/agent-project-connection").SessionListTargetSource;
    }>,
    harnessIds?: HarnessId[],
  ) => Promise<void>;
}) {
  const {
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
  } = input;

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
            workspaces: getState().workspaces,
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

        const activeWorkspaceId = getState().activeWorkspaceId;
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
    dispatch,
    expectedDirectoriesRef,
    getState,
    loadServerResources,
    loadSessionIndex,
    preferredHarnessId,
    shellWorkspacePolicy.localWorkspaceMode,
    updateProjectHydration,
    workspaceStateReady,
  ]);
}
