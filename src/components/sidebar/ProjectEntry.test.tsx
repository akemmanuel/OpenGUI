// @vitest-environment happy-dom

import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@/components/ui/context-menu", () => ({
  Root: ({ children }: any) => <div>{children}</div>,
  Trigger: ({ children }: any) => children,
  Portal: ({ children }: any) => <div>{children}</div>,
  Content: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: any) => <div>{children}</div>,
  SidebarMenuButton: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  SidebarMenuItem: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/SidebarItemMenus", () => ({
  ProjectItemMenu: () => <button>project menu</button>,
  ProjectMenuContent: () => null,
}));
vi.mock("@/components/ui/spinner", () => ({ Spinner: () => <span>connecting</span> }));

import { SESSION_PAGE_SIZE } from "@/lib/constants";
import { ProjectEntry } from "./ProjectEntry";

const translate = (key: string, options?: Record<string, unknown>) =>
  typeof options?.count === "number" ? `${key}:${options.count}` : key;

const connection = (state: "connected" | "connecting") => ({
  state,
  serverUrl: null,
  serverVersion: null,
  error: null,
  lastEventAt: null,
});

function props(
  overrides: Partial<ComponentProps<typeof ProjectEntry>> = {},
): ComponentProps<typeof ProjectEntry> {
  return {
    directory: "/work/Alpha",
    dirSessions: [],
    hasActiveSearch: false,
    collapsed: {},
    connections: { "/work/Alpha": connection("connected") },
    visibleByProject: {},
    sidebarState: "expanded" as const,
    isLocalWorkspace: true,
    availableProjectDirectories: ["/work/Alpha", "/work/Beta"],
    projectMeta: {},
    t: translate,
    renderSessionRow: (session) => <span key={session.id}>{session.title}</span>,
    setProjectPopover: vi.fn(),
    toggleCollapsed: vi.fn(),
    setActiveTarget: vi.fn(),
    closeMobileSidebar: vi.fn(),
    setProjectPinned: vi.fn(),
    removeProject: vi.fn(),
    closeOtherProjects: vi.fn(),
    setVisibleByProject: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("ProjectEntry", () => {
  test("creates a Session and collapses an expanded connected Project", async () => {
    const input = props();
    render(<ProjectEntry {...input} />);
    expect(screen.getByRole("button", { name: "sidebar.newSession" }).textContent).toContain(
      "projectMenu.newSession",
    );
    await userEvent.click(screen.getByRole("button", { name: "projectMenu.newSession" }));
    expect(input.setActiveTarget).toHaveBeenCalledWith("/work/Alpha", { newChat: true });
    expect(input.closeMobileSidebar).toHaveBeenCalled();
    await userEvent.click(screen.getByText("Alpha").closest("button")!);
    expect(input.toggleCollapsed).toHaveBeenCalledWith("/work/Alpha");
  });

  test("opens the compact Project popover instead of collapsing", async () => {
    const setProjectPopover = vi.fn();
    render(<ProjectEntry {...props({ sidebarState: "collapsed", setProjectPopover })} />);
    const row = screen.getByRole("button", { name: "Alpha" });
    Object.defineProperty(row, "getBoundingClientRect", {
      value: () => ({ top: 42 }),
    });
    fireEvent.click(row);
    const updater = setProjectPopover.mock.calls[0]?.[0];
    expect(updater(null)).toEqual({ directory: "/work/Alpha", top: 42 });
    expect(updater({ directory: "/work/Alpha", top: 1 })).toBeNull();
  });

  test("paginates large Session lists and exposes connection progress", async () => {
    const sessions = Array.from(
      { length: SESSION_PAGE_SIZE + 2 },
      (_, index) => ({ id: `s${index}`, title: `Session ${index}` }) as never,
    );
    const setVisibleByProject = vi.fn();
    const { rerender } = render(
      <ProjectEntry {...props({ dirSessions: sessions, setVisibleByProject })} />,
    );
    expect(screen.queryByText(`Session ${SESSION_PAGE_SIZE + 1}`)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "sidebar.loadMore:2" }));
    expect(setVisibleByProject).toHaveBeenCalled();

    rerender(
      <ProjectEntry
        {...props({
          dirSessions: sessions,
          connections: { "/work/Alpha": connection("connecting") },
        })}
      />,
    );
    expect(screen.getByText("connecting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "projectMenu.newSession" })).toBeNull();
  });
});
