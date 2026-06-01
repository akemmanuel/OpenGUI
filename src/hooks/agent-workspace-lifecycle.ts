import { normalizeWorkspace } from "@/hooks/agent-state-persistence";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import { DEFAULT_SERVER_URL } from "@/lib/constants";
import type { SelectedModel, Workspace } from "@/types/electron";

type WorkspaceLifecycleAction =
  | { type: "SET_WORKSPACES"; payload: Workspace[] }
  | { type: "SET_ACTIVE_WORKSPACE"; payload: string }
  | { type: "SET_ACTIVE_SESSION"; payload: string | null }
  | {
      type: "REMOVE_PROJECT";
      payload: { projectKey: string; directory: string };
    };

interface WorkspaceSelection {
  selectedModel: SelectedModel | null;
  selectedAgent: string | null;
}

function selectedModelsEqual(
  a: SelectedModel | null | undefined,
  b: SelectedModel | null | undefined,
) {
  return a?.providerID === b?.providerID && a?.modelID === b?.modelID;
}

export function createWorkspaceLifecyclePlan({
  workspaces,
  input,
  now = Date.now(),
}: {
  workspaces: Workspace[];
  input: { name: string; serverUrl: string; authToken?: string };
  now?: number;
}) {
  const workspace = normalizeWorkspace({
    id: `ws_${now.toString(36)}`,
    name: input.name,
    serverUrl: input.serverUrl,
    authToken: input.authToken,
    isLocal: false,
    projects: [],
    selectedModel: null,
    selectedAgent: null,
    lastActiveSessionId: null,
  });

  return {
    workspace,
    nextWorkspaces: [...workspaces, workspace],
    nextActiveWorkspaceId: workspace.id,
    nextActiveSessionId: null,
  };
}

export function createWorkspaceUpdatePlan({
  workspaces,
  workspaceId,
  input,
}: {
  workspaces: Workspace[];
  workspaceId: string;
  input: Partial<Pick<Workspace, "name" | "serverUrl" | "authToken">>;
}) {
  return workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    return normalizeWorkspace({
      ...workspace,
      name: input.name ?? workspace.name,
      // A Workspace is the OpenGUI Backend connection. Its backend URL is immutable;
      // wrong URL means creating a different Workspace, while auth may still change.
      serverUrl: workspace.isLocal ? DEFAULT_SERVER_URL : workspace.serverUrl,
      authToken: input.authToken ?? workspace.authToken,
    });
  });
}

export function createWorkspaceSelectionSyncPlan({
  workspaces,
  activeWorkspaceId,
  selection,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  selection: WorkspaceSelection;
}) {
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  if (!activeWorkspace) return null;
  if (
    selectedModelsEqual(activeWorkspace.selectedModel, selection.selectedModel) &&
    activeWorkspace.selectedAgent === selection.selectedAgent
  ) {
    return null;
  }

  return workspaces.map((workspace) =>
    workspace.id === activeWorkspaceId
      ? {
          ...workspace,
          selectedModel: selection.selectedModel,
          selectedAgent: selection.selectedAgent,
          settings: {
            ...workspace.settings,
            selectedModel: selection.selectedModel,
            selectedAgent: selection.selectedAgent,
          },
        }
      : workspace,
  );
}

export function createWorkspaceSwitchPlan({
  workspaces,
  workspaceId,
}: {
  workspaces: Workspace[];
  workspaceId: string;
}) {
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
  return {
    nextActiveWorkspaceId: workspaceId,
    nextActiveSessionId: workspace?.lastActiveSessionId ?? null,
  };
}

export function createWorkspaceRemovalPlan({
  workspaces,
  activeWorkspaceId,
  workspaceId,
  hasBackends,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  workspaceId: string;
  hasBackends: boolean;
}) {
  if (!hasBackends) {
    return { type: "skip" } as const;
  }

  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    return { type: "skip" } as const;
  }
  if (workspace.isLocal) {
    return { type: "skip" } as const;
  }

  const nextWorkspaces = workspaces.filter((item) => item.id !== workspaceId);
  const nextWorkspace = nextWorkspaces[0] ?? null;
  const removingActiveWorkspace = activeWorkspaceId === workspaceId;

  return {
    type: "remove",
    workspace,
    projectRemovals: workspace.projects.map((directory) => ({
      directory,
      projectKey: makeProjectKey(workspaceId, directory),
    })),
    nextWorkspaces,
    nextActiveWorkspaceId: removingActiveWorkspace ? (nextWorkspace?.id ?? "") : activeWorkspaceId,
    nextActiveSessionId: removingActiveWorkspace
      ? (nextWorkspace?.lastActiveSessionId ?? null)
      : null,
  } as const;
}

export async function removeLifecycleWorkspace({
  workspaceId,
  state,
  disconnectProject,
  selectSession,
  dispatch,
}: {
  workspaceId: string;
  state: {
    workspaces: Workspace[];
    activeWorkspaceId: string;
    hasBackends: boolean;
  };
  disconnectProject: (input: {
    target: { directory: string; workspaceId: string };
  }) => Promise<unknown>;
  selectSession: (sessionId: string | null) => Promise<void>;
  dispatch: (action: WorkspaceLifecycleAction) => void;
}) {
  const plan = createWorkspaceRemovalPlan({
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceId,
    hasBackends: state.hasBackends,
  });

  if (plan.type === "skip") return;

  for (const removal of plan.projectRemovals) {
    await disconnectProject({
      target: { directory: removal.directory, workspaceId },
    });
    dispatch({
      type: "REMOVE_PROJECT",
      payload: { projectKey: removal.projectKey, directory: removal.directory },
    });
  }

  dispatch({ type: "SET_WORKSPACES", payload: plan.nextWorkspaces });

  if (state.activeWorkspaceId === workspaceId) {
    dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: plan.nextActiveWorkspaceId });
    await selectSession(plan.nextActiveSessionId);
  }
}
