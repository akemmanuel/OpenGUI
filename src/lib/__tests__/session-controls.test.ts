import { describe, expect, test } from "vite-plus/test";
import { shouldShowSendButton, shouldShowStopButton } from "../session-controls";

describe("shouldShowStopButton", () => {
  test("shows stop while a session is loading even if the composer has draft input", () => {
    expect(
      shouldShowStopButton({
        isSessionRunning: true,
      }),
    ).toBe(true);
  });

  test("hides stop while the session is idle", () => {
    expect(
      shouldShowStopButton({
        isSessionRunning: false,
      }),
    ).toBe(false);
  });
});

describe("shouldShowSendButton", () => {
  test("shows send when prompt text exists and the session is idle", () => {
    expect(shouldShowSendButton({ hasPromptText: true, isSessionRunning: false })).toBe(true);
  });

  test("shows send when prompt text exists and the session is running", () => {
    expect(shouldShowSendButton({ hasPromptText: true, isSessionRunning: true })).toBe(true);
  });

  test("shows disabled send affordance when the session is idle and prompt text is empty", () => {
    expect(shouldShowSendButton({ hasPromptText: false, isSessionRunning: false })).toBe(true);
  });

  test("hides send when the session is running and prompt text is empty", () => {
    expect(shouldShowSendButton({ hasPromptText: false, isSessionRunning: true })).toBe(false);
  });
});
