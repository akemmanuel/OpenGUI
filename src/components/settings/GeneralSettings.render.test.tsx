// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  logout: vi.fn(),
  setDefault: vi.fn(),
  openDirectory: vi.fn(),
}));

vi.mock("@/components/AppearanceSetting", () => ({
  AppearanceSetting: () => <div>appearance</div>,
}));
vi.mock("@/hooks/use-agent-state", () => ({
  NOTIFICATIONS_ENABLED_KEY: "notifications-enabled",
  useActions: () => ({
    setDefaultChatDirectory: fixture.setDefault,
    openDirectory: fixture.openDirectory,
  }),
  useWorkspaceState: () => ({ defaultChatDirectory: null, supportsNativeDirectoryPicker: false }),
}));
vi.mock("@/runtime/clients", () => ({
  getDesktopShellClient: () => ({ runtime: { isElectron: false }, backend: null }),
}));
vi.mock("@/features/identity/workspace-identity", () => ({
  getIdentityWorkspace: () => ({
    id: "remote",
    name: "Shared Host",
    authToken: "token",
    isLocal: false,
  }),
  identityWorkspaceIsLocalBypass: () => false,
  logoutActiveWorkspaceIdentity: fixture.logout,
}));

import { STORAGE_KEYS } from "@/lib/constants";
import { GeneralSettings } from "./GeneralSettings";

describe("GeneralSettings persistence", () => {
  beforeEach(() => {
    fixture.logout.mockReset().mockResolvedValue(undefined);
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("persists the model age preference and broadcasts the provider refresh signal", () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    window.addEventListener("model-max-age-months-changed", changed);
    render(<GeneralSettings />);
    const input = document.querySelector("#model-age-filter-months") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "24" } });
    vi.advanceTimersByTime(401);
    expect(localStorage.getItem(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS)).toBe("24");
    expect(changed).toHaveBeenCalled();
    window.removeEventListener("model-max-age-months-changed", changed);
  });

  test("shows the active remote account and delegates sign out", async () => {
    render(<GeneralSettings />);
    expect(screen.getByText("Shared Host")).toBeTruthy();
    const account = screen
      .getByText("identity.accountSession")
      .closest("div.flex.items-center.justify-between");
    await userEvent.click(account!.querySelector("button")!);
    expect(fixture.logout).toHaveBeenCalledOnce();
  });

  test("does not offer a notification switch when browser permission is denied", () => {
    vi.stubGlobal("Notification", { permission: "denied" });
    render(<GeneralSettings />);
    expect(screen.getByText("settings.general.blockedByBrowser")).toBeTruthy();
    expect(document.querySelector("#notifications-toggle")).toBeNull();
  });
});
