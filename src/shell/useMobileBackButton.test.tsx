// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  listener: undefined as (() => void) | undefined,
  remove: vi.fn(async () => undefined),
  exit: vi.fn(async () => undefined),
  toggle: vi.fn(async () => undefined),
  toast: vi.fn(),
  addListener: vi.fn(),
}));

vi.mock("@capacitor/app", () => ({
  App: {
    toggleBackButtonHandler: fixture.toggle,
    addListener: fixture.addListener.mockImplementation(
      async (_name: string, listener: () => void) => {
        fixture.listener = listener;
        return { remove: fixture.remove };
      },
    ),
    exitApp: fixture.exit,
  },
}));
vi.mock("sonner", () => ({ toast: fixture.toast }));
vi.mock("@/i18n", () => ({ i18n: { t: () => "Press back again to exit" } }));
vi.mock("@/runtime/shell-policy", () => ({ getShellKind: () => "mobile" }));

import { useMobileBackButton } from "./useMobileBackButton";

describe("mobile root back behavior", () => {
  beforeEach(() => {
    fixture.listener = undefined;
    fixture.remove.mockClear();
    fixture.exit.mockClear();
    fixture.toggle.mockClear();
    fixture.toast.mockClear();
    fixture.addListener.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  test("requires two root presses to exit and restores native handling on unmount", async () => {
    const hook = renderHook(() => useMobileBackButton());
    await vi.waitFor(() => expect(fixture.listener).toBeTypeOf("function"));
    await act(async () => fixture.listener?.());
    await waitFor(() => expect(fixture.toast).toHaveBeenCalledOnce());
    expect(fixture.exit).not.toHaveBeenCalled();
    await act(async () => fixture.listener?.());
    await waitFor(() => expect(fixture.exit).toHaveBeenCalledOnce());

    hook.unmount();
    await waitFor(() => expect(fixture.remove).toHaveBeenCalledOnce());
    expect(fixture.toggle).toHaveBeenLastCalledWith({ enabled: true });
  });

  test("shares one native listener across repeated mounts and removes it after the last unmount", async () => {
    const first = renderHook(() => useMobileBackButton());
    const second = renderHook(() => useMobileBackButton());
    await waitFor(() => expect(fixture.addListener).toHaveBeenCalledOnce());
    expect(fixture.toggle).toHaveBeenCalledTimes(1);

    first.unmount();
    await Promise.resolve();
    expect(fixture.remove).not.toHaveBeenCalled();
    second.unmount();
    await waitFor(() => expect(fixture.remove).toHaveBeenCalledOnce());
    expect(fixture.toggle).toHaveBeenLastCalledWith({ enabled: true });
  });
});
