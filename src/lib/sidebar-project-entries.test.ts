import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  buildSidebarOrderedRootProjectDirectories,
  isProjectListedInSidebar,
} from "./sidebar-project-entries";

describe("buildSidebarOrderedRootProjectDirectories", () => {
  test("lists workspace projects before connection completes", () => {
    const ordered = buildSidebarOrderedRootProjectDirectories({
      availableProjectDirectories: ["/repo-a", "/repo-b"],
      connectedRootDirectories: ["/repo-a"],
    });
    expect(ordered).toEqual(["/repo-a", "/repo-b"]);
    expect(isProjectListedInSidebar("/repo-b", ordered)).toBe(true);
  });

  test("does not drop projects that only exist in workspace.projects", () => {
    const ordered = buildSidebarOrderedRootProjectDirectories({
      availableProjectDirectories: ["/new-project"],
      connectedRootDirectories: [],
    });
    expect(ordered).toEqual(["/new-project"]);
  });
});
