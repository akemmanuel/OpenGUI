// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { WorkspaceTabs } from "./WorkspaceTabs";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const props = () => ({
  workspaces: [
    { id: "one", name: "One" },
    { id: "two", name: "Two" },
  ],
  workspaceStatuses: { one: { connected: true }, two: { error: new Error("offline") } },
  activeWorkspaceId: "one",
  canManage: true,
  visible: true,
  isMac: false,
  isWebRuntime: false,
  onSwitch: vi.fn(),
  onReorder: vi.fn(),
  onAdd: vi.fn(),
  onEdit: vi.fn(),
});

describe("WorkspaceTabs", () => {
  test("switches, edits on double click, adds, and horizontally scrolls with Shift+wheel", async () => {
    const input = props();
    const { container } = render(<WorkspaceTabs {...input} />);
    await userEvent.click(screen.getByRole("button", { name: "Two" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "One" }));
    await userEvent.click(screen.getByRole("button", { name: "workspace.addWorkspace" }));
    expect(input.onSwitch.mock.calls).toEqual([["two"], ["one"]]);
    expect(input.onEdit).toHaveBeenCalledOnce();
    expect(input.onAdd).toHaveBeenCalledOnce();
    const scroller = container.querySelector(".overflow-x-auto") as HTMLElement;
    scroller.scrollLeft = 5;
    const wheel = new Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperties(wheel, { shiftKey: { value: true }, deltaY: { value: 30 } });
    fireEvent(scroller, wheel);
    expect(scroller.scrollLeft).toBe(35);
  });

  test("hides tabs while preserving the add policy and desktop chrome spacing", () => {
    const input = props();
    const view = render(<WorkspaceTabs {...input} visible={false} canManage={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <WorkspaceTabs {...input} visible={false} canManage isMac isWebRuntime={false} />,
    );
    expect(screen.getByRole("button", { name: "workspace.addWorkspace" })).toBeTruthy();
    expect(view.container.firstElementChild?.className).toContain("right-20");
    view.rerender(
      <WorkspaceTabs {...input} visible={false} canManage isMac={false} isWebRuntime />,
    );
    expect(view.container.firstElementChild?.className).toContain("right-2");
  });
});
