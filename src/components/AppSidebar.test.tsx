// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  isMobile: false,
  sidebarState: "expanded",
  canManage: true,
  supportsNative: true,
  workspaces: [{ id: "local" }],
  openDirectory: vi.fn().mockResolvedValue("/native/project"),
  requestPath: vi.fn().mockResolvedValue("/remote/project"),
  connect: vi.fn().mockResolvedValue(undefined),
  notifyInfo: vi.fn(),
  addWorkspace: vi.fn(),
  setOpen: vi.fn(),
  setOpenMobile: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { query?: string }) =>
      values?.query ? `${key}:${values.query}` : key,
  }),
}));
vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: any) => <aside>{children}</aside>,
  SidebarContent: ({ children, onClickCapture }: any) => (
    <main onClickCapture={onClickCapture}>{children}</main>
  ),
  useSidebar: () => ({
    state: fixture.sidebarState,
    isMobile: fixture.isMobile,
    setOpen: fixture.setOpen,
    setOpenMobile: fixture.setOpenMobile,
  }),
}));
vi.mock("@/hooks/use-home-dir", () => ({ useHomeDir: () => "/home/test" }));
vi.mock("@/hooks/use-outside-click", () => ({ useOutsideClick: vi.fn() }));
vi.mock("@/hooks/workspace-guards", () => ({ openAddWorkspaceDialog: fixture.addWorkspace }));
vi.mock("@/lib/notify", () => ({
  notifyInfo: fixture.notifyInfo,
  notifyUnknownError: vi.fn(),
}));
vi.mock("./ProjectPathDialog", () => ({
  ProjectPathDialog: () => null,
  requestProjectPath: fixture.requestPath,
}));
vi.mock("./sidebar/use-sidebar-collapsed-projects", () => ({
  useSidebarCollapsedProjects: () => ({
    collapsed: {},
    toggleCollapsed: vi.fn(),
    revealCollapsedProject: vi.fn(),
  }),
}));
vi.mock("./sidebar/use-sidebar-rename", () => ({
  useSidebarRename: () => ({
    editingSessionId: null,
    editValue: "",
    setEditValue: vi.fn(),
    editInputRef: { current: null },
    startEditing: vi.fn(),
    commitRename: vi.fn(),
    cancelEditing: vi.fn(),
  }),
}));
vi.mock("./sidebar/use-sidebar-model", () => ({
  useSidebarModel: () => ({
    hasActiveSearch: false,
    availableProjectDirectories: [],
    filteredChatSessions: [],
    pinnedEntries: [],
    projectEntries: [],
    projectSessionsByDirectory: {},
    showChatsSection: true,
  }),
}));
vi.mock("./sidebar/use-sidebar-renderers", () => ({
  useSidebarRenderers: () => ({ renderSessionRow: vi.fn(), renderProjectEntry: vi.fn() }),
}));
vi.mock("./sidebar/SidebarHeaderContent", () => ({
  SidebarHeaderContent: ({ searchInputRef, searchQuery, setSearchQuery, startNewChat }: any) => (
    <header>
      <input
        aria-label="sidebar search"
        ref={searchInputRef}
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
      />
      <button onClick={startNewChat}>new chat</button>
    </header>
  ),
}));
vi.mock("./sidebar/SidebarContentSections", () => ({
  SidebarContentSections: ({ handleAddProject }: any) => (
    <button onClick={() => void handleAddProject()}>add project</button>
  ),
}));
vi.mock("./sidebar/SidebarFooterContent", () => ({
  SidebarFooterContent: ({ onOpenSettings }: any) => (
    <button onClick={onOpenSettings}>settings</button>
  ),
}));
vi.mock("./sidebar/CollapsedProjectPopover", () => ({ CollapsedProjectPopover: () => null }));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({
    selectSession: vi.fn(),
    startNewChat: vi.fn(),
    setActiveTarget: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    removeProject: vi.fn(),
    openDirectory: fixture.openDirectory,
    connectToProject: fixture.connect,
    setSessionColor: vi.fn(),
    setSessionTags: vi.fn(),
    setSessionPinned: vi.fn(),
    moveSessionToProject: vi.fn(),
    removeSessionFromProject: vi.fn(),
    setProjectPinned: vi.fn(),
    reorderVisibleProjects: vi.fn(),
  }),
  useSessionState: () => ({
    sessions: [],
    activeSessionId: null,
    busySessionIds: new Set(),
    queuedPrompts: {},
    pendingQuestions: {},
    pendingPermissions: {},
    unreadSessionIds: new Set(),
    sessionDrafts: {},
    sessionMeta: {},
    namingSessionIds: new Set(),
    activeTargetDirectory: null,
  }),
  useWorkspaceState: () => ({
    connections: {},
    projectMeta: {},
    isLocalWorkspace: fixture.supportsNative,
    supportsNativeDirectoryPicker: fixture.supportsNative,
    activeWorkspace: { id: "local", projects: [] },
    workspaces: fixture.workspaces,
    canManageProjects: fixture.canManage,
    workspaceDirectory: "/srv",
    defaultChatDirectory: null,
    bootState: "ready",
  }),
}));

import { AppSidebar } from "./AppSidebar";

describe("AppSidebar orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.isMobile = false;
    fixture.sidebarState = "expanded";
    fixture.canManage = true;
    fixture.supportsNative = true;
    fixture.workspaces = [{ id: "local" }];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
  });
  afterEach(cleanup);

  test("opens the native picker, connects the Project, and routes shell actions", async () => {
    const openSettings = vi.fn();
    const openChat = vi.fn();
    render(<AppSidebar onOpenSettings={openSettings} onOpenChat={openChat} />);
    await userEvent.click(screen.getByText("add project"));
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledWith("/native/project"));
    await userEvent.click(screen.getByText("settings"));
    expect(openSettings).toHaveBeenCalledOnce();
    expect(openChat).toHaveBeenCalled();
  });

  test("uses Host browsing remotely and explains denied Project management", async () => {
    fixture.supportsNative = false;
    const { rerender } = render(<AppSidebar onOpenSettings={vi.fn()} onOpenChat={vi.fn()} />);
    await userEvent.click(screen.getByText("add project"));
    await waitFor(() => expect(fixture.requestPath).toHaveBeenCalledWith("/srv"));
    expect(fixture.connect).toHaveBeenCalledWith("/remote/project");

    fixture.canManage = false;
    fixture.workspaces = [];
    rerender(<AppSidebar onOpenSettings={vi.fn()} onOpenChat={vi.fn()} />);
    await userEvent.click(screen.getByText("add project"));
    expect(fixture.notifyInfo).toHaveBeenCalledWith("workspace.requiredBeforeProject");
    expect(fixture.addWorkspace).toHaveBeenCalledOnce();
  });

  test("opens and focuses sidebar search responsively", async () => {
    fixture.isMobile = true;
    render(<AppSidebar onOpenSettings={vi.fn()} onOpenChat={vi.fn()} />);
    const search = screen.getByRole("textbox", { name: "sidebar search" });
    fireEvent(window, new CustomEvent("focus-sidebar-search"));
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(fixture.setOpenMobile).toHaveBeenCalledWith(true);
    expect(fixture.setOpen).not.toHaveBeenCalled();
  });

  test("hides global Workspace controls in a detached Project window", () => {
    render(
      <AppSidebar detachedProject="/detached" onOpenSettings={vi.fn()} onOpenChat={vi.fn()} />,
    );
    expect(screen.queryByText("settings")).toBeNull();
  });
});
