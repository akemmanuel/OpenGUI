import { useEffect, useRef, type Dispatch, type MutableRefObject } from "react";
import type { HarnessId } from "@/agents";
import {
  buildBootstrapProjectConfigs,
  createProjectConnectionStatus,
} from "@/hooks/agent-project-connection";
import {
  settleProjectHydration,
  startProjectHydration,
  type ProjectHydrationState,
} from "@/hooks/agent-project-hydration";
import type { OpenGuiClient } from "@/protocol/client";
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
  openGuiClient: OpenGuiClient;
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
        const state = getState();
        const { projectConfigs: allProjectConfigs, expectedProjectKeys } =
          buildBootstrapProjectConfigs({
            workspaces: state.workspaces,
            detachedProject,
            worktreeParents: worktreeParentMap,
            activeWorkspaceId: state.activeWorkspaceId,
            defaultChatDirectory: state.defaultChatDirectory,
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
          updateProjectHydration(projectKey, (current) =>
            startProjectHydration(current, discoveryHarnessIds),
          );
          try {
            const connectResult = await openGuiClient.harnesses.registerDirectory({
              config: {
                directory: item.directory,
                workspaceId: item.workspaceId,
                baseUrl: item.baseUrl,
                authToken: item.authToken,
              },
              harnessIds: discoveryHarnessIds,
            });
            const failedBackends = Object.fromEntries(
              connectResult.errors.map((entry) => [entry.harnessId, entry.error]),
            ) as Partial<Record<HarnessId, string>>;
            const connectedHarnessIds = connectResult.connectedHarnessIds;
            const connectionError =
              connectedHarnessIds.length === 0
                ? connectResult.errors[0]?.error || "Connection failed"
                : null;
            dispatch({
              type: "SET_PROJECT_CONNECTION",
              payload: {
                projectKey,
                status: createProjectConnectionStatus(
                  connectionError ? "error" : "connected",
                  item.baseUrl,
                  "project",
                  connectionError ?? undefined,
                ),
              },
            });
            updateProjectHydration(projectKey, (current) =>
              settleProjectHydration(current, {
                completedHarnessIds: connectedHarnessIds,
                failedBackends,
              }),
            );
          } catch (error) {
            const message = getErrorMessage(error);
            dispatch({
              type: "SET_PROJECT_CONNECTION",
              payload: {
                projectKey,
                status: createProjectConnectionStatus("error", item.baseUrl, "project", message),
              },
            });
            updateProjectHydration(projectKey, (current) =>
              settleProjectHydration(current, {
                failedBackends: Object.fromEntries(
                  discoveryHarnessIds.map((harnessId) => [harnessId, message]),
                ) as Partial<Record<HarnessId, string>>,
              }),
            );
          }
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

        void loadSessionIndex(allProjectConfigs, discoveryHarnessIds).catch((error) => {
          console.error("startup session index failed", error);
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
    openGuiClient,
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
