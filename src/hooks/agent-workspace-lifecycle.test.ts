import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { LOCAL_WORKSPACE_ID } from "@/hooks/agent-state-persistence";
import { DEFAULT_SERVER_URL } from "@/lib/constants";
import type { Workspace } from "@/types/electron";
import {
  createWorkspaceLifecyclePlan,
  createWorkspaceRemovalPlan,
  createWorkspaceSelectionSyncPlan,
  createWorkspaceSwitchPlan,
  createWorkspaceUpdatePlan,
  removeLifecycleWorkspace,
} from "./agent-workspace-lifecycle";

function makeWorkspace(input: Partial<Workspace> & Pick<Workspace, "id" | "name">): Workspace {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    isLocal: false,
    projects: [],
    selectedModel: null,
    selectedAgent: null,
    lastActiveSessionId: null,
    ...input,
  };
}

describe("createWorkspaceLifecyclePlan", () => {
  test("creates a normalized workspace and activates it", () => {
    const plan = createWorkspaceLifecyclePlan({
      workspaces: [makeWorkspace({ id: "local", name: "Local", isLocal: true })],
      input: {
        name: "  Team Workspace  ",
        serverUrl: "  http://example.com/  ",
        authToken: "secret-token",
      },
      now: 35,
    });

    expect(plan.workspace).toMatchObject({
      id: "ws_z",
      name: "Team Workspace",
      serverUrl: "http://example.com/",
      authToken: "secret-token",
      projects: [],
    });
    expect(plan.nextActiveWorkspaceId).toBe("ws_z");
    expect(plan.nextActiveSessionId).toBeNull();
    expect(plan.nextWorkspaces.at(-1)).toEqual(plan.workspace);
  });

  test("adds https to bare workspace backend hostnames", () => {
    const plan = createWorkspaceLifecyclePlan({
      workspaces: [],
      input: {
        name: "Remote",
        serverUrl: "gui.idunara.com",
      },
      now: 36,
    });

    expect(plan.workspace.serverUrl).toBe("https://gui.idunara.com");
    expect(plan.workspace.settings?.serverUrl).toBe("https://gui.idunara.com");
  });
});

describe("createWorkspaceUpdatePlan", () => {
  test("keeps remote workspace backend URLs immutable", () => {
    const next = createWorkspaceUpdatePlan({
      workspaces: [
        makeWorkspace({
          id: "workspace-1",
          name: "Remote",
          serverUrl: "http://backend-a.example.com",
        }),
      ],
      workspaceId: "workspace-1",
      input: {
        serverUrl: "http://backend-b.example.com",
        name: "Renamed",
        authToken: "secret-token",
      },
    });

    expect(next).toEqual([
      expect.objectContaining({
        id: "workspace-1",
        name: "Renamed",
        serverUrl: "http://backend-a.example.com",
        authToken: "secret-token",
      }),
    ]);
  });

  test("keeps local workspaces pinned to the local server url", () => {
    const next = createWorkspaceUpdatePlan({
      workspaces: [
        makeWorkspace({
          id: "local",
          name: "Local",
          isLocal: true,
          serverUrl: DEFAULT_SERVER_URL,
        }),
      ],
      workspaceId: "local",
      input: { serverUrl: "http://remote.example.com", name: "Updated" },
    });

    expect(next).toEqual([
      expect.objectContaining({
        id: "local",
        name: "Updated",
        serverUrl: DEFAULT_SERVER_URL,
      }),
    ]);
  });
});

describe("createWorkspaceSelectionSyncPlan", () => {
  test("returns null when the active workspace already matches the current selection", () => {
    const result = createWorkspaceSelectionSyncPlan({
      workspaces: [
        makeWorkspace({
          id: "workspace-1",
          name: "Workspace",
          selectedModel: { providerID: "openai", modelID: "gpt-5" },
          selectedAgent: "reviewer",
        }),
      ],
      activeWorkspaceId: "workspace-1",
      selection: {
        selectedModel: { providerID: "openai", modelID: "gpt-5" },
        selectedAgent: "reviewer",
      },
    });

    expect(result).toBeNull();
  });

  test("updates the active workspace when the current selection changes", () => {
    const result = createWorkspaceSelectionSyncPlan({
      workspaces: [makeWorkspace({ id: "workspace-1", name: "Workspace" })],
      activeWorkspaceId: "workspace-1",
      selection: {
        selectedModel: { providerID: "openai", modelID: "gpt-5" },
        selectedAgent: "reviewer",
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: "workspace-1",
        selectedModel: { providerID: "openai", modelID: "gpt-5" },
        selectedAgent: "reviewer",
      }),
    ]);
  });
});

describe("createWorkspaceSwitchPlan", () => {
  test("restores the workspace's last active session", () => {
    const plan = createWorkspaceSwitchPlan({
      workspaces: [
        makeWorkspace({
          id: "workspace-1",
          name: "Workspace",
          lastActiveSessionId: "session-42",
        }),
      ],
      workspaceId: "workspace-1",
    });

    expect(plan).toEqual({
      nextActiveWorkspaceId: "workspace-1",
      nextActiveSessionId: "session-42",
    });
  });
});

describe("createWorkspaceRemovalPlan", () => {
  test("skips removing the local workspace", () => {
    const plan = createWorkspaceRemovalPlan({
      workspaces: [makeWorkspace({ id: LOCAL_WORKSPACE_ID, name: "Local", isLocal: true })],
      activeWorkspaceId: LOCAL_WORKSPACE_ID,
      workspaceId: LOCAL_WORKSPACE_ID,
      hasBackends: true,
    });

    expect(plan).toEqual({ type: "skip" });
  });

  test("plans project disconnects and active workspace fallback", () => {
    const plan = createWorkspaceRemovalPlan({
      workspaces: [
        makeWorkspace({
          id: "workspace-1",
          name: "Workspace 1",
          projects: ["/repo", "/repo/feature-a"],
        }),
        makeWorkspace({
          id: "workspace-2",
          name: "Workspace 2",
          lastActiveSessionId: "session-9",
        }),
      ],
      activeWorkspaceId: "workspace-1",
      workspaceId: "workspace-1",
      hasBackends: true,
    });

    expect(plan).toEqual({
      type: "remove",
      workspace: expect.objectContaining({ id: "workspace-1" }),
      projectRemovals: [
        { directory: "/repo", projectKey: "workspace-1\u0000/repo" },
        { directory: "/repo/feature-a", projectKey: "workspace-1\u0000/repo/feature-a" },
      ],
      nextWorkspaces: [expect.objectContaining({ id: "workspace-2" })],
      nextActiveWorkspaceId: "workspace-2",
      nextActiveSessionId: "session-9",
    });
  });
});

describe("removeLifecycleWorkspace", () => {
  test("disconnects projects, updates workspaces, and switches the active workspace", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const disconnects: Array<Record<string, unknown>> = [];
    const selected: Array<string | null> = [];

    await removeLifecycleWorkspace({
      workspaceId: "workspace-1",
      state: {
        workspaces: [
          makeWorkspace({ id: "workspace-1", name: "Workspace 1", projects: ["/repo"] }),
          makeWorkspace({
            id: "workspace-2",
            name: "Workspace 2",
            lastActiveSessionId: "session-9",
          }),
        ],
        activeWorkspaceId: "workspace-1",
        hasBackends: true,
      },
      releaseDirectory: async (input) => {
        disconnects.push(input);
      },
      selectSession: async (sessionId) => {
        selected.push(sessionId);
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(disconnects).toEqual([{ target: { directory: "/repo", workspaceId: "workspace-1" } }]);
    expect(actions).toEqual([
      {
        type: "REMOVE_PROJECT",
        payload: { projectKey: "workspace-1\u0000/repo", directory: "/repo" },
      },
      {
        type: "SET_WORKSPACES",
        payload: [expect.objectContaining({ id: "workspace-2" })],
      },
      {
        type: "SET_ACTIVE_WORKSPACE",
        payload: "workspace-2",
      },
    ]);
    expect(selected).toEqual(["session-9"]);
  });
});
