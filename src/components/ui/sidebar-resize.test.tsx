// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

import { Sidebar, SidebarProvider } from "./sidebar";
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH_PX } from "@/hooks/use-sidebar-width";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageSet } from "@/lib/persistence/storage";

function renderSidebar() {
  return render(
    <SidebarProvider>
      <Sidebar collapsible="offcanvas">content</Sidebar>
    </SidebarProvider>,
  );
}

describe("sidebar resizing", () => {
  afterEach(() => {
    cleanup();
    storageSet(STORAGE_KEYS.SIDEBAR_WIDTH, String(SIDEBAR_DEFAULT_WIDTH_PX));
  });

  test("clamps widths to the supported range", () => {
    expect(clampSidebarWidth(50)).toBe(200);
    expect(clampSidebarWidth(9999)).toBe(480);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH_PX);
  });

  test("resizes with the keyboard and resets on double-click", () => {
    const view = renderSidebar();
    const wrapper = view.container.querySelector<HTMLElement>("[data-slot=sidebar-wrapper]")!;
    const handle = screen.getByRole("separator", { name: "workspace.resizeSidebar" });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("272px");

    fireEvent.doubleClick(handle);
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(`${SIDEBAR_DEFAULT_WIDTH_PX}px`);
  });
});
