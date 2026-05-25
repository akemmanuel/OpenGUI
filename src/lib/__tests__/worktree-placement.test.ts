import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  getSessionPlacementInfo,
  getWorktreeDisplayLabel,
  getWorktreeLabel,
  shouldHideTopLevelProjectDirectory,
  shouldShowSessionInProjectList,
} from "../worktree-placement";

describe("worktree placement", () => {
  const worktreeParents = {
    "/repo/.worktrees/feature-a": {
      parentDir: "/repo",
      branch: "feature-a",
    },
  };

  test("places a worktree session under its workspace root project", () => {
    expect(
      getSessionPlacementInfo(
        { directory: "/repo/.worktrees/feature-a", _projectDir: "/repo/.worktrees/feature-a" },
        worktreeParents,
      ),
    ).toMatchObject({
      executionDirectory: "/repo/.worktrees/feature-a",
      rootDirectory: "/repo",
      displayDirectory: "/repo",
      isKnownWorktree: true,
    });
  });

  test("keeps worktree sessions visible when only the root project is visible", () => {
    expect(
      shouldShowSessionInProjectList(
        { directory: "/repo/.worktrees/feature-a", _projectDir: "/repo/.worktrees/feature-a" },
        {
          worktreeParents,
          visibleProjectDirectories: ["/repo"],
        },
      ),
    ).toBe(true);
  });

  test("hides known worktree directories from top-level project rows", () => {
    expect(shouldHideTopLevelProjectDirectory("/repo/.worktrees/feature-a", worktreeParents)).toBe(
      true,
    );
    expect(shouldHideTopLevelProjectDirectory("/repo", worktreeParents)).toBe(false);
  });

  test("uses a visible assigned project directory when provided", () => {
    expect(
      getSessionPlacementInfo(
        { directory: "/repo/.worktrees/feature-a", _projectDir: "/repo/.worktrees/feature-a" },
        worktreeParents,
        "/another-project",
      ),
    ).toMatchObject({ displayDirectory: "/another-project" });
  });

  test("uses worktree branch labels when available", () => {
    expect(getWorktreeDisplayLabel("/repo/.worktrees/feature-a", worktreeParents)).toBe(
      "feature-a",
    );
  });

  test("formats root worktree labels distinctly", () => {
    expect(
      getWorktreeLabel({
        path: "/repo",
        branch: "ci/fast-macos-builds",
        rootDirectory: "/repo",
      }),
    ).toBe("ci/fast-macos-builds (root)");
  });

  test("formats detached worktree labels distinctly", () => {
    expect(
      getWorktreeLabel({
        path: "/repo/.worktrees/feature-a",
        detached: true,
        rootDirectory: "/repo",
      }),
    ).toBe("feature-a (detached HEAD)");
  });
});
