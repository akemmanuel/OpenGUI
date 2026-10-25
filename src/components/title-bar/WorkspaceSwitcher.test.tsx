// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  supports: true,
  active: "one" as string | null,
  workspaces: [
    { id: "one", name: "Local" },
    { id: "two", name: "gui.idunara.com" },
  ],
  switchWorkspace: vi.fn(),
  dialogs: [] as unknown[],
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ switchWorkspace: fixture.switchWorkspace }),
  useWorkspaceState: () => ({
    activeWorkspaceId: fixture.active,
    supportsMultipleWorkspaces: fixture.supports,
    workspaceStatuses: { two: { connected: true } },
    workspaces: fixture.workspaces,
  }),
}));

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const onDialog = (event: Event) => fixture.dialogs.push((event as CustomEvent).detail);

describe("WorkspaceSwitcher", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.removeEventListener("opengui:open-workspace-dialog", onDialog);
    fixture.dialogs = [];
    fixture.supports = true;
    fixture.active = "one";
  });

  test("switches Hosts and opens the Workspace dialog", async () => {
    window.addEventListener("opengui:open-workspace-dialog", onDialog);
    render(<WorkspaceSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: "workspace.switchWorkspace" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "gui.idunara.com" }));
    expect(fixture.switchWorkspace).toHaveBeenCalledWith("two");

    await userEvent.click(screen.getByRole("button", { name: "workspace.switchWorkspace" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /workspace.editTitle/u }));
    expect(fixture.dialogs).toEqual([{ mode: "edit" }]);
  });

  test("offers to add a Workspace when none is active", async () => {
    window.addEventListener("opengui:open-workspace-dialog", onDialog);
    fixture.active = null;
    render(<WorkspaceSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: /workspace.addWorkspace/u }));
    expect(fixture.dialogs).toEqual([{ mode: "add" }]);
  });

  test("stays out of single-Host shells such as the web app", () => {
    fixture.supports = false;
    const { container } = render(<WorkspaceSwitcher />);
    expect(container.firstChild).toBeNull();
  });
});
