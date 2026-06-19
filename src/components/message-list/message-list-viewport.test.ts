import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { resolveMessageListViewport } from "./message-list-viewport";

describe("resolveMessageListViewport", () => {
  test("prefers error over loading when session failed to load", () => {
    expect(
      resolveMessageListViewport({
        visibleCount: 0,
        isBusy: false,
        isLoadingMessages: true,
        activeSessionId: "s1",
        activeLoadError: "sessionError.foo",
        activeLoadErrorText: "Failed",
      }),
    ).toEqual({ kind: "error", message: "Failed" });
  });

  test("shows loading while fetching with no error", () => {
    expect(
      resolveMessageListViewport({
        visibleCount: 0,
        isBusy: false,
        isLoadingMessages: true,
        activeSessionId: "s1",
        activeLoadError: null,
        activeLoadErrorText: null,
      }),
    ).toEqual({ kind: "loading" });
  });

  test("uses transcript when busy with no visible rows yet", () => {
    expect(
      resolveMessageListViewport({
        visibleCount: 0,
        isBusy: true,
        isLoadingMessages: false,
        activeSessionId: "s1",
        activeLoadError: null,
        activeLoadErrorText: null,
      }),
    ).toEqual({ kind: "transcript" });
  });
});
