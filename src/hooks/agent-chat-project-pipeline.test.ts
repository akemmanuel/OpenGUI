import { describe, expect, test } from "vite-plus/test";
import type { HarnessId } from "@/agents";
import { initialAgentState } from "@/hooks/agent-initial-state";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import { buildSidebarOrderedRootProjectDirectories } from "@/lib/sidebar-project-entries";
import { shouldShowSessionInChatList } from "@/components/sidebar/use-sidebar-model";
import { createProjectConnectionStatus } from "./agent-project-connection";
import {
  applyReducerActions,
  planAddProjectFlow,
  workspaceIncludesProject,
} from "./agent-project-flow";
import {
  buildActiveWorkspaceProjectSet,
  filterActiveWorkspaceSessions,
} from "./agent-workspace-session-scope";

const HARNESS_IDS: HarnessId[] = ["opencode", "pi"];

function session(id: string, directory: string, workspaceId?: string): Session {
  return {
    id,
    title: id,
    directory,
    _projectDir: directory,
    _workspaceId: workspaceId,
    _harnessId: "opencode",
    time: { created: 1, updated: 1 },
  } as Session;
}

function baseState(): InternalAgentState {
  return {
    ...initialAgentState,
    workspaces: [
      {
        id: "local",
        name: "Local",
        serverUrl: "http://localhost:4096",
        isLocal: true,
        projects: [],
      },
    ],
    activeWorkspaceId: "local",
    bootState: "ready",
    defaultChatDirectory: "/chat-root",
  };
}

function activeSessions(state: InternalAgentState) {
  const activeWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.activeWorkspaceId,
  );
  const activeWorkspaceProjectSet = buildActiveWorkspaceProjectSet({
    activeWorkspace,
    projectWorkspaceMap: state.projectWorkspaceMap,
  });
  return filterActiveWorkspaceSessions({
    sessions: state.sessions,
    sessionMeta: state.sessionMeta,
    activeWorkspace,
    activeWorkspaceProjectSet,
  });
}

describe("default-chat to project pipeline", () => {
  test("loads default-chat sessions into Chats and then promotes same path into Projects", () => {
    const projectKey = "local\u0000/chat-root";
    let state = baseState();

    state = applyReducerActions(state, [
      {
        type: "SET_PROJECT_META",
        payload: { projectKey, meta: { hidden: true } },
      },
      {
        type: "ASSIGN_PROJECT_WORKSPACE",
        payload: { projectKey, workspaceId: "local" },
      },
      {
        type: "SET_PROJECT_CONNECTION",
        payload: {
          projectKey,
          status: createProjectConnectionStatus("connected", "http://localhost:4096", "chat-infra"),
        },
      },
      {
        type: "MERGE_PROJECT_SESSIONS",
        payload: {
          projectKey,
          directory: "/chat-root",
          sessions: [session("opencode:chat-1", "/chat-root", "local")],
          harnessIds: ["opencode"],
          source: "default-chat",
        },
      },
    ]);

    const [chatSession] = activeSessions(state);
    expect(chatSession?.id).toBe("opencode:chat-1");
    expect(
      shouldShowSessionInChatList({
        session: chatSession!,
        meta: state.sessionMeta[chatSession!.id],
        isDefaultChatDirectory: (directory) => directory === "/chat-root",
      }),
    ).toBe(true);

    const plan = planAddProjectFlow({
      state,
      config: {
        workspaceId: "local",
        baseUrl: "http://localhost:4096",
        directory: "/chat-root",
      },
      options: { hidden: false, transient: false },
      workspace: state.workspaces[0]!,
      worktreeParents: {},
      discoveryHarnessIds: HARNESS_IDS,
      hydrationByProjectKey: {
        [projectKey]: {
          desiredHarnessIds: HARNESS_IDS,
          loadingHarnessIds: [],
          completedHarnessIds: HARNESS_IDS,
          failedHarnessIds: [],
          errors: {},
          lastStartedAt: 1,
          lastSettledAt: 2,
        },
      },
      hasHarnesses: true,
    });

    expect(plan?.skipHydration).toBe(true);
    state = applyReducerActions(state, [
      ...plan!.actionsBeforeHydration,
      ...plan!.actionsOnSkipHydration,
    ]);

    expect(workspaceIncludesProject(state, "local", "/chat-root")).toBe(true);
    expect(state.projectMeta[projectKey]?.hidden).toBe(false);
    expect(state.connections[projectKey]?.kind).toBe("project");
    expect(state.connections[projectKey]?.state).toBe("connected");

    const projectRows = buildSidebarOrderedRootProjectDirectories({
      availableProjectDirectories: state.workspaces[0]!.projects,
      connectedRootDirectories: ["/chat-root"],
    });
    expect(projectRows).toEqual(["/chat-root"]);
  });
});
