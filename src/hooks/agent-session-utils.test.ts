import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Session } from "@/hooks/agent-state-types";
import {
  createSessionProjectDetachMeta,
  createSessionProjectMoveMeta,
} from "./agent-session-utils";

function session(directory: string): Session {
  return {
    id: "session-1",
    title: "Session",
    directory,
    _projectDir: directory,
    time: { created: 1, updated: 1 },
  } as Session;
}

describe("createSessionProjectMoveMeta", () => {
  test("marks a normal project move as requiring a directory-change notice", () => {
    expect(
      createSessionProjectMoveMeta(session("/project-a"), undefined, "/project-b", 10),
    ).toEqual({
      originMode: "project",
      nativeProjectDir: "/project-a",
      assignedProjectDir: "/project-b",
      assignedProjectMovedAt: 10,
      assignedProjectSourceDir: "/project-a",
      pendingDirectoryChangeNotice: true,
      hideSystemAppendBlocks: true,
      detachedFromProject: false,
      detachedFromProjectAt: null,
    });
  });

  test("still marks a move back to the native project as requiring a notice", () => {
    expect(
      createSessionProjectMoveMeta(
        session("/project-b"),
        { nativeProjectDir: "/project-a", assignedProjectDir: "/project-b" },
        "/project-a",
        20,
      ),
    ).toEqual({
      originMode: "project",
      nativeProjectDir: "/project-a",
      assignedProjectDir: null,
      assignedProjectMovedAt: 20,
      assignedProjectSourceDir: "/project-b",
      pendingDirectoryChangeNotice: true,
      hideSystemAppendBlocks: true,
      detachedFromProject: false,
      detachedFromProjectAt: null,
    });
  });

  test("moving a chat-origin session to its native project makes it project-origin", () => {
    expect(
      createSessionProjectMoveMeta(
        session("/chat-root"),
        { originMode: "chat", nativeProjectDir: "/chat-root", assignedProjectDir: null },
        "/chat-root",
        30,
      ),
    ).toEqual({
      originMode: "project",
      nativeProjectDir: "/chat-root",
      assignedProjectDir: null,
      assignedProjectMovedAt: null,
      assignedProjectSourceDir: null,
      pendingDirectoryChangeNotice: false,
      hideSystemAppendBlocks: false,
      detachedFromProject: false,
      detachedFromProjectAt: null,
    });
  });
});

describe("createSessionProjectDetachMeta", () => {
  test("marks removing a moved session back to Chats as requiring a notice", () => {
    expect(
      createSessionProjectDetachMeta(
        session("/chat-root"),
        { assignedProjectDir: "/project-b" },
        30,
      ),
    ).toEqual({
      originMode: "chat",
      nativeProjectDir: "/chat-root",
      assignedProjectDir: null,
      assignedProjectMovedAt: null,
      assignedProjectSourceDir: "/project-b",
      pendingDirectoryChangeNotice: true,
      hideSystemAppendBlocks: true,
      detachedFromProject: true,
      detachedFromProjectAt: 30,
    });
  });

  test("uses the stored native directory when backend echoes changed the session project", () => {
    expect(
      createSessionProjectDetachMeta(
        session("/project-b"),
        { nativeProjectDir: "/chat-root", assignedProjectDir: "/project-b" },
        40,
      ),
    ).toEqual({
      originMode: "chat",
      nativeProjectDir: "/chat-root",
      assignedProjectDir: null,
      assignedProjectMovedAt: null,
      assignedProjectSourceDir: "/project-b",
      pendingDirectoryChangeNotice: true,
      hideSystemAppendBlocks: true,
      detachedFromProject: true,
      detachedFromProjectAt: 40,
    });
  });
});
