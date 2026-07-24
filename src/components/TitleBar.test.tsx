// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  chrome: {
    platform: "linux" as string | null,
    isMac: false,
    isWebRuntime: false,
    isMaximized: false,
    shell: { window: { maximize: vi.fn(), minimize: vi.fn(), close: vi.fn() } },
  },
  supports: true,
  active: "one",
  workspaces: [
    { id: "one", name: "One", serverUrl: "https://one", authToken: "token", isLocal: false },
  ],
  actions: {
    createWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    switchWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => fixture.actions,
  useWorkspaceState: () => ({
    activeWorkspaceId: fixture.active,
    supportsMultipleWorkspaces: fixture.supports,
    workspaceStatuses: {},
    workspaces: fixture.workspaces,
  }),
}));
vi.mock("@/components/title-bar/use-window-chrome", () => ({
  useWindowChrome: () => fixture.chrome,
}));
vi.mock("@/components/title-bar/WorkspaceTabs", () => ({
  WorkspaceTabs: (props: any) => (
    <nav>
      <button onClick={props.onAdd}>add tab</button>
      <button onClick={props.onEdit}>edit tab</button>
      <button onClick={() => props.onSwitch("one")}>switch tab</button>
    </nav>
  ),
}));
vi.mock("@/components/title-bar/WorkspaceDialog", () => ({
  WorkspaceDialog: ({ open, mode, onSubmit, onRemove }: any) =>
    open ? (
      <section aria-label={`dialog-${mode}`}>
        <button onClick={() => onSubmit({ name: "Submitted", serverUrl: "https://new" })}>
          submit dialog
        </button>
        {onRemove && <button onClick={onRemove}>remove dialog</button>}
      </section>
    ) : null,
}));
vi.mock("@/components/title-bar/WindowControls", () => ({
  WindowControls: () => <div>window controls</div>,
}));

import { TitleBar } from "./TitleBar";

describe("TitleBar orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.chrome.platform = "linux";
    fixture.chrome.isWebRuntime = false;
    fixture.supports = true;
  });
  afterEach(cleanup);

  test("adds, edits, switches, removes, toggles the sidebar, and handles desktop maximize", async () => {
    const toggle = vi.fn();
    const view = render(<TitleBar onToggleLeftSidebar={toggle} />);
    await userEvent.click(screen.getByRole("button", { name: "workspace.toggleSidebar" }));
    await userEvent.click(screen.getByText("switch tab"));
    await userEvent.click(screen.getByText("add tab"));
    await userEvent.click(screen.getByText("submit dialog"));
    expect(fixture.actions.createWorkspace).toHaveBeenCalledWith({
      name: "Submitted",
      serverUrl: "https://new",
    });
    await userEvent.click(screen.getByText("edit tab"));
    await userEvent.click(screen.getByText("submit dialog"));
    await userEvent.click(screen.getByText("remove dialog"));
    expect(fixture.actions.updateWorkspace).toHaveBeenCalledWith("one", {
      name: "Submitted",
      serverUrl: "https://new",
    });
    expect(fixture.actions.removeWorkspace).toHaveBeenCalledWith("one");
    expect(toggle).toHaveBeenCalledOnce();
    expect(fixture.actions.switchWorkspace).toHaveBeenCalledWith("one");
    fireEvent.doubleClick(view.container.firstElementChild!.firstElementChild!);
    expect(fixture.chrome.shell.window.maximize).toHaveBeenCalledOnce();
  });

  test("obeys web and single-Workspace shell policies and unregisters the global dialog event", () => {
    fixture.chrome.isWebRuntime = true;
    fixture.supports = false;
    const view = render(<TitleBar />);
    expect(screen.queryByText("window controls")).toBeNull();
    fireEvent(
      window,
      new CustomEvent("opengui:open-workspace-dialog", { detail: { mode: "edit" } }),
    );
    expect(screen.queryByLabelText("dialog-edit")).toBeNull();
    fireEvent.doubleClick(view.container.firstElementChild!.firstElementChild!);
    expect(fixture.chrome.shell.window.maximize).not.toHaveBeenCalled();
    view.unmount();
    fixture.supports = true;
    fireEvent(window, new CustomEvent("opengui:open-workspace-dialog"));
    expect(screen.queryByLabelText("dialog-add")).toBeNull();
  });

  test("renders nothing until the Shell platform is known", () => {
    fixture.chrome.platform = null;
    const { container } = render(<TitleBar />);
    expect(container.firstChild).toBeNull();
  });
});
