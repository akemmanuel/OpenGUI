// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { WindowControls } from "./WindowControls";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe("WindowControls", () => {
  test.each([false, true])(
    "exposes named keyboard controls on Windows/Linux (maximized=%s)",
    async (isMaximized) => {
      const shellWindow = { minimize: vi.fn(), maximize: vi.fn(), close: vi.fn() };
      render(<WindowControls isMac={false} isMaximized={isMaximized} window={shellWindow} />);
      const expected = isMaximized ? "windowControls.restore" : "windowControls.maximize";
      await userEvent.click(screen.getByRole("button", { name: "windowControls.minimize" }));
      await userEvent.click(screen.getByRole("button", { name: expected }));
      await userEvent.click(screen.getByRole("button", { name: "windowControls.close" }));
      expect(shellWindow.minimize).toHaveBeenCalledOnce();
      expect(shellWindow.maximize).toHaveBeenCalledOnce();
      expect(shellWindow.close).toHaveBeenCalledOnce();
    },
  );

  test("uses the native macOS control order", () => {
    render(
      <WindowControls
        isMac
        isMaximized={false}
        window={{ minimize: vi.fn(), maximize: vi.fn(), close: vi.fn() }}
      />,
    );
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["windowControls.maximize", "windowControls.minimize", "windowControls.close"]);
  });
});
