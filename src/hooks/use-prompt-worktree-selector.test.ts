import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { buildPromptWorktreeOptions } from "@/hooks/use-prompt-worktree-selector";
import type { GitWorktree } from "@/types/electron";

describe("buildPromptWorktreeOptions", () => {
  test("returns no options until discovery is ready", () => {
    expect(
      buildPromptWorktreeOptions({
        discoveryState: "hidden",
        projectDir: "/repo",
        discoveredWorktrees: [],
      }),
    ).toEqual([]);
  });

  test("does not add the root worktree when discovery omits it", () => {
    const options = buildPromptWorktreeOptions({
      discoveryState: "ready",
      projectDir: "/repo",
      discoveredWorktrees: [{ path: "/repo-feature", branch: "feature" } as GitWorktree],
    });

    expect(options.map((option) => option.path)).not.toContain("/repo");
  });

  test("does not add the selected worktree when discovery omits it", () => {
    const options = buildPromptWorktreeOptions({
      discoveryState: "ready",
      projectDir: "/repo",
      discoveredWorktrees: [{ path: "/repo", branch: "main" } as GitWorktree],
    });

    expect(options.map((option) => option.path)).not.toContain("/repo-feature");
  });

  test("normalizes discovered paths", () => {
    const options = buildPromptWorktreeOptions({
      discoveryState: "ready",
      projectDir: "/repo",
      discoveredWorktrees: [{ path: "/repo-feature/", branch: "feature" } as GitWorktree],
    });

    expect(options.map((option) => option.path)).toContain("/repo-feature");
  });
});
