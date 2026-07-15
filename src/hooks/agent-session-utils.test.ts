import { describe, expect, test } from "vite-plus/test";
import type { Session } from "@/hooks/agent-state-types";
import {
  createSessionProjectDetachMeta,
  createSessionProjectMoveMeta,
  getSessionProjectTarget,
  shouldAutoNameSession,
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
  test("moves session presentation into a Project without retargeting execution", () => {
    expect(
      createSessionProjectMoveMeta(session("/project-a"), undefined, "/project-b", 10),
    ).toEqual({
      sidebarSection: "projects",
      displayProjectDir: "/project-b",
      sidebarMovedAt: 10,
    });
  });

  test("updates the display Project when moving again", () => {
    expect(
      createSessionProjectMoveMeta(
        session("/project-b"),
        { displayProjectDir: "/project-b" },
        "/project-a",
        20,
      ),
    ).toEqual({
      sidebarSection: "projects",
      displayProjectDir: "/project-a",
      sidebarMovedAt: 20,
    });
  });

  test("moving a Chat session to a Project switches only the sidebar bucket", () => {
    expect(
      createSessionProjectMoveMeta(
        session("/chat-root"),
        { sidebarSection: "chats", displayProjectDir: null },
        "/chat-root",
        30,
      ),
    ).toEqual({
      sidebarSection: "projects",
      displayProjectDir: "/chat-root",
      sidebarMovedAt: 30,
    });
  });
});

describe("createSessionProjectDetachMeta", () => {
  test("moves a Project session back to Chats", () => {
    expect(
      createSessionProjectDetachMeta(
        session("/chat-root"),
        { displayProjectDir: "/project-b" },
        30,
      ),
    ).toEqual({
      sidebarSection: "chats",
      displayProjectDir: null,
      sidebarMovedAt: 30,
    });
  });

  test("does not need native directory metadata when moving back to Chats", () => {
    expect(
      createSessionProjectDetachMeta(
        session("/project-b"),
        { displayProjectDir: "/project-b" },
        40,
      ),
    ).toEqual({
      sidebarSection: "chats",
      displayProjectDir: null,
      sidebarMovedAt: 40,
    });
  });
});

describe("getSessionProjectTarget", () => {
  test("uses the session execution directory", () => {
    expect(
      getSessionProjectTarget(session("/project-a"), {
        displayProjectDir: "/project-b",
      }),
    ).toEqual({ directory: "/project-a", workspaceId: undefined });
  });
});

describe("shouldAutoNameSession", () => {
  test.each(["", "Untitled", "New Session", "New session"])(
    "treats the placeholder title %j as unnamed",
    (title) => expect(shouldAutoNameSession({ ...session("/project-a"), title })).toBe(true),
  );

  test("preserves a meaningful title", () => {
    expect(shouldAutoNameSession(session("/project-a"))).toBe(false);
  });
});
