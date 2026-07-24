// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { useAppKeyboardShortcuts } from "./useAppKeyboardShortcuts";

const actions = {
  abort: vi.fn().mockResolvedValue(undefined),
  cycle: vi.fn(),
  previous: vi.fn(),
  unrevert: vi.fn().mockResolvedValue(undefined),
  revert: vi.fn(),
};

function Harness({ busy = true }: { busy?: boolean }) {
  const { queueMode } = useAppKeyboardShortcuts({
    capabilities: { models: true, revert: true } as never,
    isBusy: busy,
    abortSession: actions.abort as never,
    cycleVariant: actions.cycle as never,
    revertVariant: actions.previous as never,
    unrevert: actions.unrevert as never,
    revertToLastMessage: actions.revert,
  });
  return (
    <div>
      <output>{queueMode}</output>
      <textarea aria-label="editor" />
      <div role="dialog">
        <button type="button">inside dialog</button>
      </div>
    </div>
  );
}

describe("application keyboard shortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("toggles queue steering only for a running Session outside dialogs", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect(screen.getByText("after-part")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "inside dialog" }), {
      key: "d",
      ctrlKey: true,
    });
    expect(screen.getByText("after-part")).toBeTruthy();
  });

  test("protects editable text from undo and sidebar search shortcuts", () => {
    const sidebarSearch = vi.fn();
    window.addEventListener("focus-sidebar-search", sidebarSearch);
    render(<Harness />);
    const editor = screen.getByRole("textbox", { name: "editor" });
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "k", ctrlKey: true });
    expect(actions.revert).not.toHaveBeenCalled();
    expect(sidebarSearch).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(actions.revert).toHaveBeenCalledOnce();
    expect(sidebarSearch).toHaveBeenCalledOnce();
    window.removeEventListener("focus-sidebar-search", sidebarSearch);
  });

  test("requires a quick unmodified double Escape to abort", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(actions.abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(actions.abort).toHaveBeenCalledOnce();
  });

  test("opens model selection for Ctrl-X then M, unless text is selected", () => {
    const open = vi.fn();
    window.addEventListener("open-model-selector", open);
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "" } as Selection);
    render(<Harness />);
    fireEvent.keyDown(window, { key: "x", ctrlKey: true });
    fireEvent.keyDown(window, { key: "m" });
    expect(open).toHaveBeenCalledOnce();
    window.removeEventListener("open-model-selector", open);
  });
});
