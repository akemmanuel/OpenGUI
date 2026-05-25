import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { shouldShowStopButton } from "../session-controls";

describe("shouldShowStopButton", () => {
  test("shows stop while a session is loading even if the composer has draft input", () => {
    expect(
      shouldShowStopButton({
        isLoading: true,
        isCompactingInProgress: false,
      }),
    ).toBe(true);
  });

  test("shows stop while compaction is in progress", () => {
    expect(
      shouldShowStopButton({
        isLoading: false,
        isCompactingInProgress: true,
      }),
    ).toBe(true);
  });

  test("hides stop when the session is idle", () => {
    expect(
      shouldShowStopButton({
        isLoading: false,
        isCompactingInProgress: false,
      }),
    ).toBe(false);
  });
});
