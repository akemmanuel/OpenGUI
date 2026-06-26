import { describe, expect, test } from "vite-plus/test";
import type { HarnessId } from "@/agents";
import type { Session } from "@/hooks/agent-state-types";
import {
  shouldKeepSessionOutOfProjectGroups,
  shouldShowSessionInChatList,
  sortSessionsForSidebar,
} from "./use-sidebar-model";

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
  test("sorts by newest update regardless of Harness", () => {
    const sorted = sortSessionsForSidebar(
      [session("claude-new", "claude-code", 20), session("open-old", "opencode", 10)],
      {},
      "opencode",
    );

    expect(sorted.map((item) => item.id)).toEqual(["claude-new", "open-old"]);
  });

  test("sorts by newest update inside the same Harness", () => {
    const sorted = sortSessionsForSidebar(
      [session("open-old", "opencode", 10), session("open-new", "opencode", 20)],
      {},
      "opencode",
    );

    expect(sorted.map((item) => item.id)).toEqual(["open-new", "open-old"]);
  });

  test("handles sessions without time metadata", () => {
    const withoutTime = session("no-time", "opencode", 0);
    delete (withoutTime as { time?: Session["time"] }).time;

    const sorted = sortSessionsForSidebar(
      [withoutTime, session("with-time", "opencode", 20)],
      {},
      "opencode",
    );

    expect(sorted.map((item) => item.id)).toEqual(["with-time", "no-time"]);
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

  test("keeps unclassified default-chat sessions in Chats even when path is also a project", () => {
    const item = session("chat-row", "opencode", 20);
    item.directory = "/project-c";
    item._projectDir = "/project-c";

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: undefined,
        isDefaultChatDirectory: (directory) => directory === "/project-c",
      }),
    ).toBe(true);
  });

  test("shows chat-origin sessions when default chat is also a project", () => {
    const item = session("chat-row", "opencode", 20);
    item.directory = "/project-c";
    item._projectDir = "/project-c";

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: { originMode: "chat", nativeProjectDir: "/project-c", assignedProjectDir: null },
        isDefaultChatDirectory: (directory) => directory === "/project-c",
      }),
    ).toBe(true);
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

describe("shouldKeepSessionOutOfProjectGroups", () => {
  test("keeps unclassified default-chat sessions out of Projects", () => {
    const item = session("chat", "opencode", 20);
    item.directory = "/project-c";
    item._projectDir = "/project-c";

    expect(
      shouldKeepSessionOutOfProjectGroups({
        session: item,
        meta: undefined,
        assignedProjectDir: "",
        isDefaultChatDirectory: (directory) => directory === "/project-c",
      }),
    ).toBe(true);
  });

  test("allows explicit project-origin sessions at the default-chat path into Projects", () => {
    const item = session("project", "opencode", 20);
    item.directory = "/project-c";
    item._projectDir = "/project-c";

    expect(
      shouldKeepSessionOutOfProjectGroups({
        session: item,
        meta: { originMode: "project", assignedProjectDir: null },
        assignedProjectDir: "",
        isDefaultChatDirectory: (directory) => directory === "/project-c",
      }),
    ).toBe(false);
  });
});
