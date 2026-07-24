// @vitest-environment happy-dom

import { describe, expect, test, vi } from "vite-plus/test";
import {
  dismissTopOverlayViaEscape,
  registerMobileBackHandler,
  runMobileBackHandlers,
} from "./mobile-back-handler";

describe("mobile back orchestration", () => {
  test("runs newest highest-priority handler first and unregisters cleanly", () => {
    const calls: string[] = [];
    const removeLow = registerMobileBackHandler(10, () => (calls.push("low"), true));
    const removeHighOld = registerMobileBackHandler(20, () => (calls.push("old"), false));
    const removeHighNew = registerMobileBackHandler(20, () => (calls.push("new"), true));

    expect(runMobileBackHandlers()).toBe(true);
    expect(calls).toEqual(["new"]);
    removeHighNew();
    calls.length = 0;
    expect(runMobileBackHandlers()).toBe(true);
    expect(calls).toEqual(["old", "low"]);

    removeLow();
    removeHighOld();
    expect(runMobileBackHandlers()).toBe(false);
  });

  test("dismisses only the topmost open overlay with Escape", () => {
    const first = document.createElement("div");
    first.dataset.slot = "dialog-content";
    first.dataset.open = "";
    const top = document.createElement("div");
    top.dataset.slot = "sheet-content";
    top.dataset.open = "";
    const firstHandler = vi.fn();
    const topHandler = vi.fn();
    first.addEventListener("keydown", firstHandler);
    top.addEventListener("keydown", topHandler);
    document.body.append(first, top);

    expect(dismissTopOverlayViaEscape()).toBe(true);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(topHandler).toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    first.remove();
    top.remove();
    expect(dismissTopOverlayViaEscape()).toBe(false);
  });
});
