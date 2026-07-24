// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  copy: vi.fn(),
  fileBrowser: vi.fn(),
  terminal: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/browser", () => ({ copyTextToClipboard: fixture.copy }));
vi.mock("@/shell/provider", () => ({
  useDesktopShell: () => ({
    system: { openInFileBrowser: fixture.fileBrowser, openInTerminal: fixture.terminal },
  }),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: any) => <span>{children}</span>,
  DropdownMenuTrigger: ({ children }: any) => children,
}));
vi.mock("@/components/ui/context-menu", () => ({
  Item: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  Separator: () => <hr />,
}));

import { ProjectMenuContent } from "./SidebarItemMenus";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Project menu", () => {
  test("routes all local Project actions and confirmations", async () => {
    const actions = {
      pin: vi.fn(),
      create: vi.fn(),
      collapse: vi.fn(),
      remove: vi.fn(),
      closeOthers: vi.fn(),
    };
    render(
      <ProjectMenuContent
        kind="dropdown"
        pinned={false}
        collapsed={false}
        canCreateSession
        onTogglePin={actions.pin}
        onNewSession={actions.create}
        onToggleCollapsed={actions.collapse}
        canRemove
        onRemove={actions.remove}
        canCloseOtherProjects
        onCloseOtherProjects={actions.closeOthers}
        directory="/work/Alpha"
        isLocalWorkspace
      />,
    );
    for (const name of [
      "projectMenu.newSession",
      "projectMenu.collapseProject",
      "projectMenu.pinProject",
      "projectMenu.copyAbsolutePath",
      "projectMenu.openInFileBrowser",
      "projectMenu.openInTerminal",
      "projectMenu.removeProject",
      "projectMenu.closeOtherProjects",
    ]) {
      await userEvent.click(screen.getByRole("button", { name }));
    }
    expect(actions.create).toHaveBeenCalled();
    expect(actions.collapse).toHaveBeenCalled();
    expect(actions.pin).toHaveBeenCalled();
    expect(fixture.copy).toHaveBeenCalledWith("/work/Alpha");
    expect(fixture.fileBrowser).toHaveBeenCalledWith("/work/Alpha", "");
    expect(fixture.terminal).toHaveBeenCalledWith("/work/Alpha", "");
    expect(actions.remove).toHaveBeenCalled();
    expect(actions.closeOthers).toHaveBeenCalled();
  });

  test("hides local and destructive actions for a read-only remote Project", () => {
    render(
      <ProjectMenuContent
        kind="dropdown"
        pinned
        collapsed
        canCreateSession={false}
        onTogglePin={vi.fn()}
        onNewSession={vi.fn()}
        onToggleCollapsed={vi.fn()}
        canRemove={false}
        onRemove={vi.fn()}
        canCloseOtherProjects={false}
        onCloseOtherProjects={vi.fn()}
        directory="/srv/Remote"
        isLocalWorkspace={false}
      />,
    );
    expect(screen.getByText("projectMenu.expandProject")).toBeTruthy();
    expect(screen.getByText("projectMenu.unpinProject")).toBeTruthy();
    expect(screen.queryByText("projectMenu.newSession")).toBeNull();
    expect(screen.queryByText("projectMenu.openInTerminal")).toBeNull();
    expect(screen.queryByText("projectMenu.removeProject")).toBeNull();
  });
});
