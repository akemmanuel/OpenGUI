import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { buildPromptWorktreeOptions } from "@/hooks/use-prompt-worktree-selector";
import type { WorktreeParentMap } from "@/hooks/agent-state-persistence";
import type { GitWorktree } from "@/types/electron";

const parents: WorktreeParentMap = {
  "/repo-feature": {
    parentDir: "/repo",
    branch: "feature",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("buildPromptWorktreeOptions", () => {
  test("returns no options until discovery is ready", () => {
    expect(
      buildPromptWorktreeOptions({
        discoveryState: "hidden",
        projectDir: "/repo",
        selectedDirectory: "/repo",
        discoveredWorktrees: [],
        worktreeParents: {},
      }),
    ).toEqual([]);
  });

  test("adds the root worktree when discovery omits it", () => {
    const options = buildPromptWorktreeOptions({
      discoveryState: "ready",
      projectDir: "/repo",
      selectedDirectory: "/repo-feature",
      discoveredWorktrees: [{ path: "/repo-feature", branch: "feature" } as GitWorktree],
      worktreeParents: parents,
    });

    expect(options.map((option) => option.path)).toContain("/repo");
    expect(options.find((option) => option.path === "/repo")?.isRoot).toBe(true);
  });

  test("adds the selected worktree when discovery omits it", () => {
    const options = buildPromptWorktreeOptions({
      discoveryState: "ready",
      projectDir: "/repo",
      selectedDirectory: "/repo-feature",
      discoveredWorktrees: [{ path: "/repo", branch: "main" } as GitWorktree],
      worktreeParents: parents,
    });

    expect(options.find((option) => option.path === "/repo-feature")?.branch).toBe("feature");
  });

  test("normalizes discovered paths", () => {
    const options = buildPromptWorktreeOptions({
      discoveryState: "ready",
      projectDir: "/repo",
      selectedDirectory: "/repo-feature",
      discoveredWorktrees: [{ path: "/repo-feature/", branch: "feature" } as GitWorktree],
      worktreeParents: parents,
    });

    expect(options.map((option) => option.path)).toContain("/repo-feature");
  });
});
