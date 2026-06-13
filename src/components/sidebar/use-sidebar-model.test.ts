import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessId } from "@/agents";
import type { Session } from "@/hooks/agent-state-types";
import { sortSessionsForSidebar } from "./use-sidebar-model";

function session(id: string, harnessId: HarnessId, updated: number): Session {
  return {
    id,
    title: id,
    directory: "/repo",
    _projectDir: "/repo",
    _workspaceId: "workspace-1",
    _harnessId: harnessId,
    time: { created: updated, updated },
  } as Session;
}

describe("sortSessionsForSidebar", () => {
  test("keeps preferred Harness sessions above newer sessions from other Harnesses", () => {
    const sorted = sortSessionsForSidebar(
      [session("claude-new", "claude-code", 20), session("open-old", "opencode", 10)],
      {},
      "opencode",
    );

    expect(sorted.map((item) => item.id)).toEqual(["open-old", "claude-new"]);
  });

  test("sorts by newest update inside the same Harness", () => {
    const sorted = sortSessionsForSidebar(
      [session("open-old", "opencode", 10), session("open-new", "opencode", 20)],
      {},
      "opencode",
    );

    expect(sorted.map((item) => item.id)).toEqual(["open-new", "open-old"]);
  });
});
