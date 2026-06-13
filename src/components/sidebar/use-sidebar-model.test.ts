import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessId } from "@/agents";
import type { Session } from "@/hooks/agent-state-types";
import { shouldShowSessionInChatList, sortSessionsForSidebar } from "./use-sidebar-model";

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

describe("shouldShowSessionInChatList", () => {
  test("hides default-chat sessions after moving them into a project", () => {
    const item = session("chat", "opencode", 20);
    item.directory = "/home/tobias/Dokumente";
    item._projectDir = "/home/tobias/Dokumente";

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: { assignedProjectDir: "/home/tobias/Dokumente/Jutta Kürzl" },
        isDefaultChatDirectory: (directory) => directory === "/home/tobias/Dokumente",
      }),
    ).toBe(false);
  });

  test("hides project-origin sessions even when assignment is same-directory", () => {
    const item = session("same-dir", "opencode", 20);
    item.directory = "/home/tobias/Dokumente/Jutta Kürzl";
    item._projectDir = "/home/tobias/Dokumente/Jutta Kürzl";

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: { originMode: "project", assignedProjectDir: null },
        isDefaultChatDirectory: (directory) => directory === "/home/tobias/Dokumente/Jutta Kürzl",
      }),
    ).toBe(false);
  });

  test("still shows explicitly detached project sessions in Chats", () => {
    const item = session("detached", "opencode", 20);

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: { assignedProjectDir: "/other", detachedFromProject: true },
        isDefaultChatDirectory: () => false,
      }),
    ).toBe(true);
  });
});
