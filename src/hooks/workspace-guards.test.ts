import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { canManageProjects } from "./workspace-guards";
import type { Workspace } from "@/types/electron";

function makeWorkspace(id: string): Workspace {
  return {
    id,
    name: id,
    createdAt: "",
    updatedAt: "",
    serverUrl: "http://localhost:4096",
    isLocal: false,
    projects: [],
    selectedModel: null,
    selectedAgent: null,
    lastActiveSessionId: null,
  };
}

describe("canManageProjects", () => {
  test("returns false when there are no workspaces", () => {
    expect(canManageProjects([], "ws-1", null)).toBe(false);
  });

  test("returns false when active workspace id is missing", () => {
    const workspaces = [makeWorkspace("ws-1")];
    expect(canManageProjects(workspaces, "", workspaces[0])).toBe(false);
  });

  test("returns false when active workspace record is missing", () => {
    const workspaces = [makeWorkspace("ws-1")];
    expect(canManageProjects(workspaces, "ws-1", null)).toBe(false);
  });

  test("returns false when active id does not match any workspace", () => {
    const workspaces = [makeWorkspace("ws-1")];
    expect(canManageProjects(workspaces, "other", workspaces[0])).toBe(false);
  });

  test("returns true when workspace list and active selection are valid", () => {
    const workspaces = [makeWorkspace("ws-1")];
    expect(canManageProjects(workspaces, "ws-1", workspaces[0])).toBe(true);
  });
});
