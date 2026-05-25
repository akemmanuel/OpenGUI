import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  buildBootstrapProjectConfigs,
  createProjectConnectionStatus,
  createProjectRemovalPlan,
  createWorkspaceConnectionConfig,
  createWorkspaceProjectConnectionPlan,
  resolveConnectionWorkspace,
  shouldPersistLocalConnectionSettings,
  shouldPersistWorkspaceProject,
} from "./agent-project-connection";

describe("createProjectConnectionStatus", () => {
  test("creates a connection status with the given state", () => {
    const status = createProjectConnectionStatus("connecting", "http://localhost:4096");

    expect(status).toMatchObject({
      state: "connecting",
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

    expect(workspace).toMatchObject({ id: "local", name: "Local" });
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
      },
      {
        workspaceId: "workspace-1",
        baseUrl: "http://localhost:4096",
        directory: "/repo/feature-a",
        username: undefined,
        password: undefined,
      },
    ]);
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

describe("workspace project persistence", () => {
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
