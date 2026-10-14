// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn() } }),
}));
vi.mock("@/hooks/use-agent-state", () => ({
  NOTIFICATIONS_ENABLED_KEY: "notifications-enabled",
}));

import { STORAGE_KEYS } from "@/lib/constants";
import { ModelAgeFilterSetting, NotificationsSetting } from "./PreferenceControls";

describe("profile preference controls", () => {
  beforeEach(() => {
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
    vi.unstubAllGlobals();
  });

  test("persists the model age preference and broadcasts the provider refresh signal", () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    window.addEventListener("model-max-age-months-changed", changed);
    render(<ModelAgeFilterSetting />);
    const input = document.querySelector("#model-age-filter-months") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "24" } });
    vi.advanceTimersByTime(401);
    expect(localStorage.getItem(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS)).toBe("24");
    expect(changed).toHaveBeenCalled();
    window.removeEventListener("model-max-age-months-changed", changed);
  });

  test("hides the month input while old models are shown", () => {
    localStorage.setItem(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS, "0");
    render(<ModelAgeFilterSetting />);
    expect(document.querySelector("#model-age-filter-months")).toBeNull();
  });

  test("explains how to unblock notifications instead of offering a dead switch", () => {
    vi.stubGlobal("Notification", { permission: "denied" });
    render(<NotificationsSetting />);
    const status = screen.getByText("settings.general.blockedByBrowser");
    expect(status.parentElement?.textContent).toContain("settings.general.blockedByBrowserHelp");
    expect(document.querySelector("#notifications-toggle")).toBeNull();
  });
});
