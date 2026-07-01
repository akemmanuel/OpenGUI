import { describe, expect, test } from "vite-plus/test";

if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    value: { location: { origin: "http://localhost:4096" } },
    configurable: true,
  });
}
import {
  buildBootstrapProjectConfigs,
  getSessionIndexRootDirectories,
  getSessionIndexRootTargets,
  createProjectConnectionDescriptor,
  createProjectConnectionStatus,
  createProjectRemovalPlan,
  createWorkspaceConnectionConfig,
  createWorkspaceProjectConnectionPlan,
  resolveConnectionWorkspace,
  buildWorkspaceProjectPersistPlan,
  shouldPersistLocalConnectionSettings,
  shouldPersistWorkspaceProject,
  shouldSnapshotProjectConnectionForRestart,
} from "./agent-project-connection";

describe("createProjectConnectionStatus", () => {
  test("creates a connection status with the given state", () => {
    const status = createProjectConnectionStatus("connecting", "http://localhost:4096");

    expect(status).toMatchObject({
      state: "connecting",
      kind: "project",
      serverUrl: "http://localhost:4096",
      serverVersion: null,
      error: null,
    });
    expect(typeof status.lastEventAt).toBe("number");
  });
});

describe("resolveConnectionWorkspace", () => {
  test("falls back to the local workspace when the active workspace is missing", () => {
    const workspace = resolveConnectionWorkspace([], "missing");

    expect(workspace).toMatchObject({ id: "local" });
  });
});

describe("createWorkspaceProjectConnectionPlan", () => {
  test("expands a root project to include related worktrees", () => {
    const plan = createWorkspaceProjectConnectionPlan({
      directory: "/repo",
      workspaceId: "workspace-1",
      worktreeParents: {
        "/repo/feature-a": {
          parentDir: "/repo",
          branch: "feature-a",
          createdAt: "2026-01-01",
          lastOpenedAt: "2026-01-01",
        },
      },
      connectedDirectories: ["/repo"],
    });

    expect(plan.rootDirectory).toBe("/repo");
    expect(plan.relatedWorktrees).toEqual(["/repo/feature-a"]);
    expect(plan.desiredDirectories).toEqual(["/repo", "/repo/feature-a"]);
    expect(plan.missingDirectories).toEqual(["/repo/feature-a"]);
    expect(plan.expectedProjectKeys).toEqual([
      "workspace-1\u0000/repo",
      "workspace-1\u0000/repo/feature-a",
    ]);
  });

  test("collapses a worktree to its root project", () => {
    const plan = createWorkspaceProjectConnectionPlan({
      directory: "/repo/feature-a",
      workspaceId: "workspace-1",
      worktreeParents: {
        "/repo/feature-a": {
          parentDir: "/repo",
          branch: "feature-a",
          createdAt: "2026-01-01",
          lastOpenedAt: "2026-01-01",
        },
      },
    });

    expect(plan.rootDirectory).toBe("/repo");
    expect(plan.isWorktree).toBe(true);
    expect(plan.workspaceProjectDirectory).toBe("/repo");
  });
});

describe("createProjectRemovalPlan", () => {
  test("removes root project and related worktrees together", () => {
    const plan = createProjectRemovalPlan({
      directory: "/repo",
      worktreeParents: {
        "/repo/feature-a": {
          parentDir: "/repo",
          branch: "feature-a",
          createdAt: "2026-01-01",
          lastOpenedAt: "2026-01-01",
        },
      },
    });

    expect(plan.directoriesToRemove).toEqual(["/repo", "/repo/feature-a"]);
  });

  test("removes only the selected worktree when not removing the root", () => {
    const plan = createProjectRemovalPlan({
      directory: "/repo/feature-a",
      worktreeParents: {
        "/repo/feature-a": {
          parentDir: "/repo",
          branch: "feature-a",
          createdAt: "2026-01-01",
          lastOpenedAt: "2026-01-01",
        },
      },
    });

    expect(plan.directoriesToRemove).toEqual(["/repo/feature-a"]);
  });
});

describe("buildBootstrapProjectConfigs", () => {
  test("expands stored projects to root projects and worktrees without duplicates", () => {
    const result = buildBootstrapProjectConfigs({
      workspaces: [
        {
          id: "workspace-1",
          name: "Workspace",
          serverUrl: "http://localhost:4096",
          isLocal: false,
          projects: ["/repo", "/repo/feature-a"],
        },
      ] as never,
      worktreeParents: {
        "/repo/feature-a": {
          parentDir: "/repo",
          branch: "feature-a",
          createdAt: "2026-01-01",
          lastOpenedAt: "2026-01-01",
        },
      },
    });

    expect(result.expectedProjectKeys).toEqual([
      "workspace-1\u0000/repo",
      "workspace-1\u0000/repo/feature-a",
    ]);
    expect(result.projectConfigs).toEqual([
      {
        workspaceId: "workspace-1",
        baseUrl: "http://localhost:4096",
        directory: "/repo",
        username: undefined,
        password: undefined,
        source: "workspace-project",
      },
      {
        workspaceId: "workspace-1",
        baseUrl: "http://localhost:4096",
        directory: "/repo/feature-a",
        username: undefined,
        password: undefined,
        source: "workspace-project",
      },
    ]);
  });

  test("includes default chat directory in bootstrap index when it is not a workspace project", () => {
    const result = buildBootstrapProjectConfigs({
      workspaces: [
        {
          id: "workspace-1",
          name: "Workspace",
          serverUrl: "http://localhost:4096",
          isLocal: true,
          projects: ["/project-a"],
          settings: { defaultChatDirectory: "/home/chats" },
        },
      ] as never,
      worktreeParents: {},
    });

    const directories = result.projectConfigs.map((config) => config.directory).sort();
    expect(directories).toEqual(["/home/chats", "/project-a"]);
    expect(
      result.projectConfigs
        .map((config) => ({ directory: config.directory, source: config.source }))
        .sort((a, b) => a.directory.localeCompare(b.directory)),
    ).toEqual([
      { directory: "/home/chats", source: "default-chat" },
      { directory: "/project-a", source: "workspace-project" },
    ]);
  });

  test("indexes resolved active default chat even when workspace settings lack it", () => {
    const result = buildBootstrapProjectConfigs({
      workspaces: [
        {
          id: "local",
          name: "Local",
          serverUrl: "http://localhost:4096",
          isLocal: true,
          projects: ["/project-a"],
          settings: {},
        },
      ] as never,
      activeWorkspaceId: "local",
      defaultChatDirectory: "/home/emmanuel",
      worktreeParents: {},
    });

    expect(
      result.projectConfigs
        .map((config) => ({ directory: config.directory, source: config.source }))
        .sort((a, b) => a.directory.localeCompare(b.directory)),
    ).toEqual([
      { directory: "/home/emmanuel", source: "default-chat" },
      { directory: "/project-a", source: "workspace-project" },
    ]);
  });
});

describe("getSessionIndexRootDirectories", () => {
  test("does not duplicate default chat when it is already a project", () => {
    expect(
      getSessionIndexRootDirectories({
        id: "ws",
        name: "W",
        serverUrl: "http://localhost:4096",
        isLocal: true,
        projects: ["/same"],
        settings: { defaultChatDirectory: "/same" },
      } as never),
    ).toEqual(["/same"]);
  });
});

describe("getSessionIndexRootTargets", () => {
  test("keeps project source when default chat is already a project", () => {
    expect(
      getSessionIndexRootTargets({
        id: "ws",
        name: "W",
        serverUrl: "http://localhost:4096",
        isLocal: true,
        projects: ["/same"],
        settings: { defaultChatDirectory: "/same" },
      } as never),
    ).toEqual([{ directory: "/same", source: "workspace-project" }]);
  });
});

describe("createProjectConnectionDescriptor", () => {
  test("owns Project connection identity and backend target shape", () => {
    expect(
      createProjectConnectionDescriptor({
        config: {
          workspaceId: "workspace-1",
          baseUrl: "http://localhost:4096",
          directory: "/repo/",
          authToken: "token",
        },
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      directory: "/repo",
      projectKey: "workspace-1\u0000/repo",
      config: {
        workspaceId: "workspace-1",
        baseUrl: "http://localhost:4096",
        directory: "/repo",
        authToken: "token",
      },
      target: {
        directory: "/repo",
        workspaceId: "workspace-1",
        baseUrl: "http://localhost:4096",
        authToken: "token",
      },
    });
  });
});

describe("createWorkspaceConnectionConfig", () => {
  test("maps workspace settings to a connection config", () => {
    expect(
      createWorkspaceConnectionConfig({
        workspace: {
          id: "workspace-1",
          name: "Workspace",
          serverUrl: "http://localhost:4096",
          username: "user",
          password: "secret",
          isLocal: false,
          projects: [],
        },
        directory: "/repo",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      baseUrl: "http://localhost:4096",
      directory: "/repo",
      username: "user",
      password: "secret",
    });
  });
});

describe("restart snapshot filtering", () => {
  test("skips directories that are not workspace Projects", () => {
    expect(
      shouldSnapshotProjectConnectionForRestart({
        status: createProjectConnectionStatus("connected", "http://localhost:4096"),
        workspace: {
          id: "local",
          name: "Local",
          serverUrl: "http://localhost:4096",
          isLocal: true,
          projects: ["/home/emmanuel"],
        },
        directory: "/chat",
      }),
    ).toBe(false);
  });

  test("keeps explicit workspace project connections", () => {
    expect(
      shouldSnapshotProjectConnectionForRestart({
        status: createProjectConnectionStatus("connected", "http://localhost:4096"),
        workspace: {
          id: "local",
          name: "Local",
          serverUrl: "http://localhost:4096",
          isLocal: true,
          projects: ["/repo"],
        },
        directory: "/repo",
      }),
    ).toBe(true);
  });
});

describe("workspace project persistence", () => {
  test("buildWorkspaceProjectPersistPlan returns ADD payload for visible projects", () => {
    const plan = buildWorkspaceProjectPersistPlan({
      directory: "/repo",
      workspaceId: "local",
      worktreeParents: {},
      workspace: {
        id: "local",
        name: "Local",
        serverUrl: "http://localhost:4096",
        isLocal: true,
        projects: [],
      },
      config: {
        baseUrl: "http://localhost:4096",
        directory: "/repo",
        username: "u",
        password: "p",
      },
      options: { hidden: false, transient: false },
    });
    expect(plan).toMatchObject({
      addWorkspaceProject: {
        workspaceId: "local",
        directory: "/repo",
        serverUrl: "http://localhost:4096",
        username: "u",
        password: "p",
      },
      persistLocalConnectionSettings: true,
    });
  });

  test("buildWorkspaceProjectPersistPlan is null for hidden transient targets", () => {
    expect(
      buildWorkspaceProjectPersistPlan({
        directory: "/chat",
        workspaceId: "local",
        worktreeParents: {},
        workspace: {
          id: "local",
          name: "Local",
          serverUrl: "http://localhost:4096",
          isLocal: true,
          projects: [],
        },
        config: { baseUrl: "http://localhost:4096", directory: "/chat" },
        options: { hidden: true, transient: true },
      }),
    ).toBeNull();
  });

  test("persists visible workspace projects", () => {
    expect(shouldPersistWorkspaceProject({ hidden: false, transient: false })).toBe(true);
    expect(shouldPersistWorkspaceProject({ hidden: true })).toBe(false);
    expect(shouldPersistWorkspaceProject({ transient: true })).toBe(false);
  });

  test("persists local connection settings only for local visible projects", () => {
    expect(shouldPersistLocalConnectionSettings("local", { hidden: false, transient: false })).toBe(
      true,
    );
    expect(shouldPersistLocalConnectionSettings("workspace-1", { hidden: false })).toBe(false);
  });
});
