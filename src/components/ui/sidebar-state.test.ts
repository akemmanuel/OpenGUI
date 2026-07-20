import { describe, expect, test } from "vite-plus/test";
import { SIDEBAR_COOKIE_MAX_AGE, createSidebarCookie } from "./sidebar-persistence";
import { isSidebarKeyboardShortcut } from "./use-sidebar-controller";

describe("sidebar persistence", () => {
  test.each([true, false])("serializes the %s state using the existing cookie contract", (open) => {
    expect(createSidebarCookie(open)).toBe(
      `sidebar_state=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`,
    );
  });
});

describe("sidebar keyboard shortcut", () => {
  test.each([
    [{ key: "b", metaKey: true, ctrlKey: false }, true],
    [{ key: "b", metaKey: false, ctrlKey: true }, true],
    [{ key: "B", metaKey: true, ctrlKey: false }, false],
    [{ key: "b", metaKey: false, ctrlKey: false }, false],
    [{ key: "x", metaKey: true, ctrlKey: false }, false],
  ])("recognizes only Cmd/Ctrl+B", (event, expected) => {
    expect(isSidebarKeyboardShortcut(event)).toBe(expected);
  });
});
