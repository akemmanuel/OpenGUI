// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ share: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => ({ type: "user", id: "owner" }),
}));
vi.mock("@/features/identity/SessionShareDialog", () => ({
  openSessionShareDialog: fixture.share,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarMenuItem: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/spinner", () => ({ Spinner: () => <span>busy</span> }));
vi.mock("@/components/SidebarItemMenus", () => ({
  SessionContextMenu: ({ children }: any) => <>{children}</>,
  SessionItemMenu: (props: any) => (
    <div>
      <button onClick={props.onTogglePin}>pin</button>
      <button onClick={() => props.onSetColor("blue")}>color</button>
      <button onClick={() => props.onSetTags(["next"])}>tags</button>
      <button onClick={() => props.onMoveToProject("/other")}>move</button>
      {props.onRemoveFromProject && (
        <button onClick={props.onRemoveFromProject}>remove project</button>
      )}
      {props.onRename && <button onClick={props.onRename}>rename</button>}
      {props.onShare && <button onClick={props.onShare}>share</button>}
      {props.onDelete && <button onClick={props.onDelete}>delete</button>}
    </div>
  ),
}));
vi.mock("./SidebarRow", () => ({
  SidebarRow: ({ children, actions, onActivate, active, editing }: any) => (
    <div data-active={String(active)} data-editing={String(editing)}>
      <button onClick={onActivate}>activate</button>
      {children}
      {actions}
    </div>
  ),
}));

import { SessionRow } from "./SessionRow";

function props(role: "owner" | "view" = "owner") {
  return {
    session: { id: "s1", title: "Plan", _accessRole: role, _shared: true },
    activeSessionId: "s1",
    busySessionIds: new Set(["s1"]),
    unreadSessionIds: new Set(["s1"]),
    queuedPrompts: { s1: [{ id: "q1" }, { id: "q2" }] },
    pendingQuestions: { s1: {} },
    pendingPermissions: { s1: {} },
    sessionMeta: {
      s1: {
        pinnedAt: "2026-01-01",
        color: "red",
        tags: ["one", "two", "three"],
        displayProjectDir: "/project",
      },
    },
    namingSessionIds: new Set<string>(),
    availableProjectDirectories: ["/project", "/other"],
    editingSessionId: null,
    editValue: "",
    editInputRef: { current: null },
    untitledLabel: "Untitled",
    hasUnsentDraft: vi.fn(() => true),
    selectSession: vi.fn(),
    closeMobileSidebar: vi.fn(),
    setEditValue: vi.fn(),
    commitRename: vi.fn(),
    cancelEditing: vi.fn(),
    startEditing: vi.fn(),
    setSessionPinned: vi.fn(),
    setSessionColor: vi.fn(),
    setSessionTags: vi.fn(),
    revealSessionInProject: vi.fn(),
    moveSessionToProject: vi.fn(),
    removeSessionFromProject: vi.fn(),
    currentProjectDir: "/project",
    deleteSession: vi.fn(),
  };
}

describe("SessionRow behavior", () => {
  beforeEach(() => {
    fixture.share.mockReset();
    window.confirm = vi.fn(() => true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders live state and routes owner menu, pin, color, tags, Project, sharing, and deletion actions", async () => {
    const input = props();
    render(<SessionRow {...(input as unknown as ComponentProps<typeof SessionRow>)} />);
    expect(screen.getByText("busy")).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    await userEvent.click(screen.getByText("activate"));
    await userEvent.click(screen.getByText("pin"));
    await userEvent.click(screen.getByText("color"));
    await userEvent.click(screen.getByText("tags"));
    await userEvent.click(screen.getByText("move"));
    await userEvent.click(screen.getByText("remove project"));
    await userEvent.click(screen.getByText("rename"));
    await userEvent.click(screen.getByText("share"));
    await userEvent.click(screen.getByText("delete"));
    expect(input.selectSession).toHaveBeenCalledWith("s1");
    expect(input.closeMobileSidebar).toHaveBeenCalledOnce();
    expect(input.setSessionPinned).toHaveBeenCalledWith("s1", false);
    expect(input.setSessionColor).toHaveBeenCalledWith("s1", "blue");
    expect(input.setSessionTags).toHaveBeenCalledWith("s1", ["next"]);
    expect(input.revealSessionInProject).toHaveBeenCalledWith("/other");
    expect(input.moveSessionToProject).toHaveBeenCalledWith("s1", "/other");
    expect(input.removeSessionFromProject).toHaveBeenCalledWith("s1");
    expect(input.startEditing).toHaveBeenCalledWith("s1", "Plan");
    expect(fixture.share).toHaveBeenCalledWith("s1", "Plan");
    expect(input.deleteSession).toHaveBeenCalledWith("s1");
  });

  test("keeps view shares read-only while still selectable", () => {
    render(<SessionRow {...(props("view") as unknown as ComponentProps<typeof SessionRow>)} />);
    expect(screen.queryByText("rename")).toBeNull();
    expect(screen.queryByText("share")).toBeNull();
    expect(screen.queryByText("delete")).toBeNull();
    expect(screen.getByText("activate")).toBeTruthy();
  });
});
