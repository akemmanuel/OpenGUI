import { describe, expect, test } from "vite-plus/test";
import type { Session } from "@/hooks/agent-state-types";
import {
  shouldKeepSessionOutOfProjectGroups,
  shouldShowSessionInChatList,
  sortSessionsForSidebar,
} from "./use-sidebar-model";

function session(id: string, updated: number): Session {
  return {
    id,
    title: id,
    directory: "/repo",
    _projectDir: "/repo",
    _workspaceId: "workspace-1",
    time: { created: updated, updated },
  } as Session;
}

describe("sortSessionsForSidebar", () => {
  test("sorts by newest update regardless of Harness", () => {
    const sorted = sortSessionsForSidebar([session("new", 20), session("old", 10)], {});

    expect(sorted.map((item) => item.id)).toEqual(["new", "old"]);
  });

  test("sorts by newest update inside the same Harness", () => {
    const sorted = sortSessionsForSidebar([session("old", 10), session("new", 20)], {});

    expect(sorted.map((item) => item.id)).toEqual(["new", "old"]);
  });

  test("handles sessions without time metadata", () => {
    const withoutTime = session("no-time", 0);
    delete (withoutTime as { time?: Session["time"] }).time;

    const sorted = sortSessionsForSidebar([withoutTime, session("with-time", 20)], {});

    expect(sorted.map((item) => item.id)).toEqual(["with-time", "no-time"]);
  });
});

describe("shouldShowSessionInChatList", () => {
  test("hides default-chat sessions after moving them into a project", () => {
    const item = session("chat", 20);
    item.directory = "/home/tobias/Dokumente";
    item._projectDir = "/home/tobias/Dokumente";

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: {
          sidebarSection: "projects",
          displayProjectDir: "/home/tobias/Dokumente/Jutta Kürzl",
        },
        isDefaultChatDirectory: (directory) => directory === "/home/tobias/Dokumente",
      }),
    ).toBe(false);
  });

  test("hides project-sidebar sessions from Chats", () => {
    const item = session("same-dir", 20);
    item.directory = "/home/tobias/Dokumente/Jutta Kürzl";
    item._projectDir = "/home/tobias/Dokumente/Jutta Kürzl";

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: {
          sidebarSection: "projects",
          displayProjectDir: "/home/tobias/Dokumente/Jutta Kürzl",
        },
        isDefaultChatDirectory: (directory) => directory === "/home/tobias/Dokumente/Jutta Kürzl",
      }),
    ).toBe(false);
  });

  test("keeps unclassified default-chat sessions in Chats even when path is also a project", () => {
    const item = session("chat-row", 20);
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

  test("shows chat-sidebar sessions when default chat is also a project", () => {
    const item = session("chat-row", 20);
    item.directory = "/project-c";
    item._projectDir = "/project-c";

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: { sidebarSection: "chats", displayProjectDir: null },
        isDefaultChatDirectory: (directory) => directory === "/project-c",
      }),
    ).toBe(true);
  });

  test("shows detached sessions in Chats", () => {
    const item = session("detached", 20);

    expect(
      shouldShowSessionInChatList({
        session: item,
        meta: { sidebarSection: "chats", displayProjectDir: null },
        isDefaultChatDirectory: () => false,
      }),
    ).toBe(true);
  });
});

describe("shouldKeepSessionOutOfProjectGroups", () => {
  test("keeps unclassified default-chat sessions out of Projects", () => {
    const item = session("chat", 20);
    item.directory = "/project-c";
    item._projectDir = "/project-c";

    expect(
      shouldKeepSessionOutOfProjectGroups({
        session: item,
        meta: undefined,
        displayProjectDir: "",
        isDefaultChatDirectory: (directory) => directory === "/project-c",
      }),
    ).toBe(true);
  });

  test("allows project-sidebar sessions at the default-chat path into Projects", () => {
    const item = session("project", 20);
    item.directory = "/project-c";
    item._projectDir = "/project-c";

    expect(
      shouldKeepSessionOutOfProjectGroups({
        session: item,
        meta: { sidebarSection: "projects", displayProjectDir: "/project-c" },
        displayProjectDir: "",
        isDefaultChatDirectory: (directory) => directory === "/project-c",
      }),
    ).toBe(false);
  });
});
