import {
  buildWorkspaceProjectPersistPlan,
  createProjectConnectionDescriptor,
  createProjectConnectionStatus,
  shouldPersistWorkspaceProject,
} from "@/hooks/agent-project-connection";
import type { ProjectHydrationState } from "@/hooks/agent-project-hydration";
import {
  getPendingProjectHydrationHarnessIds,
  isProjectHydrationComplete,
} from "@/hooks/agent-project-hydration";
import { reducer, type Action } from "@/hooks/agent-reducer";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import { LOCAL_WORKSPACE_ID } from "@/hooks/agent-state-persistence";
import type { WorktreeParentMap } from "@/hooks/agent-state-persistence";
import type { HarnessId } from "@/agents";
import type { ConnectionConfig, ConnectionStatus, Workspace } from "@/types/electron";

export type AddProjectOptions = {
  suppressError?: boolean;
  hidden?: boolean;
  transient?: boolean;
  harnessIds?: HarnessId[];
};

export type AddProjectFlowInput = {
  state: InternalAgentState;
  config: ConnectionConfig & { workspaceId?: string };
  options?: AddProjectOptions;
  workspace: Workspace;
  worktreeParents: WorktreeParentMap;
  discoveryHarnessIds: HarnessId[];
  hydrationByProjectKey: Record<string, ProjectHydrationState | undefined>;
  hasHarnesses: boolean;
};

export type AddProjectFlowPlan = {
  earlyExit: boolean;
  skipHydration: boolean;
  targetHarnessIds: HarnessId[];
  requestedHarnessIds: HarnessId[];
  projectKey: string;
  directory: string;
  workspaceId: string;
  connectionKind: ConnectionStatus["kind"];
  actionsBeforeHydration: Action[];
  actionsOnSkipHydration: Action[];
};

export function planAddProjectFlow(input: AddProjectFlowInput): AddProjectFlowPlan | null {
  if (!input.hasHarnesses || !input.config.directory) return null;

  const workspaceId =
    input.config.workspaceId ?? input.state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
  const connection = createProjectConnectionDescriptor({ config: input.config, workspaceId });
  const projectKey = connection.projectKey;
  const workspace =
    input.state.workspaces.find((candidate) => candidate.id === connection.workspaceId) ??
    input.workspace;

  const connectionKind: ConnectionStatus["kind"] = "project";

  const currentHydration = input.hydrationByProjectKey[projectKey];
  const requestedHarnessIds = input.options?.harnessIds?.length
    ? input.options.harnessIds
    : input.discoveryHarnessIds;
  const targetHarnessIds = input.options?.harnessIds?.length
    ? requestedHarnessIds.filter((harnessId) => {
        const completed = currentHydration?.completedHarnessIds.includes(harnessId) ?? false;
        const loading = currentHydration?.loadingHarnessIds.includes(harnessId) ?? false;
        return !completed && !loading;
      })
    : getPendingProjectHydrationHarnessIds(currentHydration, requestedHarnessIds);

  const actionsBeforeHydration: Action[] = [
    {
      type: "SET_PROJECT_META",
      payload: { projectKey, meta: { hidden: input.options?.hidden === true } },
    },
    {
      type: "ASSIGN_PROJECT_WORKSPACE",
      payload: { projectKey, workspaceId: connection.workspaceId },
    },
    {
      type: "SET_PROJECT_CONNECTION",
      payload: {
        projectKey,
        status: createProjectConnectionStatus(
          "connecting",
          connection.config.baseUrl,
          connectionKind,
        ),
      },
    },
  ];

  const actionsOnSkipHydration: Action[] = [];
  if (targetHarnessIds.length === 0 && shouldPersistWorkspaceProject(input.options)) {
    actionsOnSkipHydration.push({
      type: "SET_PROJECT_META",
      payload: { projectKey, meta: { hidden: false } },
    });
    if (
      isProjectHydrationComplete(currentHydration, requestedHarnessIds) &&
      (currentHydration?.completedHarnessIds.length ?? 0) > 0
    ) {
      actionsOnSkipHydration.push({
        type: "SET_PROJECT_CONNECTION",
        payload: {
          projectKey,
          status: createProjectConnectionStatus("connected", connection.config.baseUrl, "project"),
        },
      });
    }
    const persistPlan = buildWorkspaceProjectPersistPlan({
      directory: connection.directory,
      workspaceId: connection.workspaceId,
      worktreeParents: input.worktreeParents,
      workspace,
      config: connection.config,
      options: input.options,
    });
    if (persistPlan?.addWorkspaceProject) {
      actionsOnSkipHydration.push({
        type: "ADD_WORKSPACE_PROJECT",
        payload: persistPlan.addWorkspaceProject,
      });
    }
  }

  return {
    earlyExit: targetHarnessIds.length === 0,
    skipHydration: targetHarnessIds.length === 0,
    targetHarnessIds,
    requestedHarnessIds,
    projectKey,
    directory: connection.directory,
    workspaceId: connection.workspaceId,
    connectionKind,
    actionsBeforeHydration,
    actionsOnSkipHydration,
  };
}

export function applyReducerActions(
  state: InternalAgentState,
  actions: Action[],
): InternalAgentState {
  return actions.reduce((next, action) => reducer(next, action), state);
}

export function workspaceIncludesProject(
  state: InternalAgentState,
  workspaceId: string,
  directory: string,
): boolean {
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  return Boolean(workspace?.projects.includes(directory));
}
