import { describe, expect, test } from "vite-plus/test";
import type { HarnessId } from "@/agents";
import { createProjectConnectionStatus } from "@/hooks/agent-project-connection";
import { initialAgentState } from "@/hooks/agent-initial-state";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import {
  applyReducerActions,
  planAddProjectFlow,
  workspaceIncludesProject,
} from "./agent-project-flow";

const DISCOVERY: HarnessId[] = ["opencode", "pi"];

function localWorkspaceState(): InternalAgentState {
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
    connections: {
      "local\u0000/tmp/chat-root": createProjectConnectionStatus(
        "connected",
        "http://localhost:4096",
        "chat-infra",
      ),
    },
    bootState: "ready",
    defaultChatDirectory: "/tmp/chat-root",
    projectMeta: { "local\u0000/tmp/chat-root": { hidden: true } },
  };
}

describe("planAddProjectFlow", () => {
  test("promotes pre-hydrated default-chat path to workspace project without re-hydrating", () => {
    const state = localWorkspaceState();
    const projectKey = "local\u0000/tmp/chat-root";
    const plan = planAddProjectFlow({
      state,
      config: {
        workspaceId: "local",
        baseUrl: "http://localhost:4096",
        directory: "/tmp/chat-root",
      },
      options: { hidden: false, transient: false },
      workspace: state.workspaces[0]!,
      worktreeParents: {},
      discoveryHarnessIds: DISCOVERY,
      hydrationByProjectKey: {
        [projectKey]: {
          desiredHarnessIds: DISCOVERY,
          loadingHarnessIds: [],
          completedHarnessIds: DISCOVERY,
          failedHarnessIds: [],
          errors: {},
          lastStartedAt: 1,
          lastSettledAt: 2,
        },
      },
      hasHarnesses: true,
    });

    expect(plan).not.toBeNull();
    expect(plan?.skipHydration).toBe(true);
    expect(plan?.targetHarnessIds).toEqual([]);

    const next = applyReducerActions(state, [
      ...plan!.actionsBeforeHydration,
      ...plan!.actionsOnSkipHydration,
    ]);

    expect(workspaceIncludesProject(next, "local", "/tmp/chat-root")).toBe(true);
    expect(next.projectMeta[projectKey]?.hidden).toBe(false);
    expect(next.connections[projectKey]?.kind).toBe("project");
    expect(next.connections[projectKey]?.state).toBe("connected");
  });

  test("does not add workspace project for hidden transient chat-infra", () => {
    const state = localWorkspaceState();
    const projectKey = "local\u0000/tmp/chat-root";
    const plan = planAddProjectFlow({
      state,
      config: {
        workspaceId: "local",
        baseUrl: "http://localhost:4096",
        directory: "/tmp/chat-root",
      },
      options: { hidden: true, transient: true },
      workspace: state.workspaces[0]!,
      worktreeParents: {},
      discoveryHarnessIds: DISCOVERY,
      hydrationByProjectKey: {
        [projectKey]: {
          desiredHarnessIds: DISCOVERY,
          loadingHarnessIds: [],
          completedHarnessIds: DISCOVERY,
          failedHarnessIds: [],
          errors: {},
          lastStartedAt: 1,
          lastSettledAt: 2,
        },
      },
      hasHarnesses: true,
    });

    expect(plan?.actionsOnSkipHydration).toEqual([]);
    const next = applyReducerActions(state, plan!.actionsBeforeHydration);
    expect(workspaceIncludesProject(next, "local", "/tmp/chat-root")).toBe(false);
  });
});
