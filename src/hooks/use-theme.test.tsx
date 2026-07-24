// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { STORAGE_KEYS } from "@/lib/constants";
import { applyStoredAppearance, useTheme } from "./use-theme";

function mediaQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
    dispatch: () => listeners.forEach((listener) => listener()),
    listenerCount: () => listeners.size,
  };
}

describe("appearance persistence", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    });
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  test("applies validated stored appearance and readable accent tokens", () => {
    const query = mediaQuery(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(query as never);
    localStorage.setItem(STORAGE_KEYS.THEME, "light");
    localStorage.setItem(STORAGE_KEYS.CONTRAST, "25");
    localStorage.setItem(STORAGE_KEYS.ACCENT_COLOR, "#ffffff");
    localStorage.setItem(STORAGE_KEYS.CODE_FONT_SIZE, "18");

    applyStoredAppearance();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--dynamic-bg-l")).toBe("0.955");
    expect(document.documentElement.style.getPropertyValue("--dynamic-primary-foreground")).toBe(
      "oklch(0.145 0 0)",
    );
    expect(document.documentElement.style.getPropertyValue("--code-font-size")).toBe("18px");
  });

  test("follows system changes, persists controls, clamps font size, and cleans up", () => {
    const query = mediaQuery(true);
    vi.spyOn(window, "matchMedia").mockReturnValue(query as never);
    const { result, unmount } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("dark");
    expect(query.listenerCount()).toBe(1);
    act(() => {
      result.current.setContrast(80);
      result.current.setAccentColor("not-a-color");
      result.current.setCodeFontSize(99);
      result.current.toggleTheme();
    });

    expect(result.current.mode).toBe("light");
    expect(result.current.codeFontSize).toBe(20);
    expect(result.current.accentColor).toBe("default");
    expect(localStorage.getItem(STORAGE_KEYS.CONTRAST)).toBe("80");
    expect(localStorage.getItem(STORAGE_KEYS.CODE_FONT_SIZE)).toBe("20");
    expect(query.listenerCount()).toBe(0);

    unmount();
    expect(query.listenerCount()).toBe(0);
  });
});
