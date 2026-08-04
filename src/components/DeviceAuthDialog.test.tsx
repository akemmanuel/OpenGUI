// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const browser = vi.hoisted(() => ({
  copy: vi.fn().mockResolvedValue(undefined),
  open: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { code?: string; time?: string }) => {
      if (values?.code) return `${key}:${values.code}`;
      if (values?.time) return `${key}:${values.time}`;
      return key;
    },
  }),
}));

vi.mock("@/lib/browser", () => ({
  copyTextToClipboard: browser.copy,
  openExternalLink: browser.open,
}));

import { DeviceAuthDialog } from "./DeviceAuthDialog";

describe("DeviceAuthDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("copies the user code and opens the verification page", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const pending = {
      userCode: "WDJB-MJHT",
      verificationUri: "https://auth.example/device",
      expiresAt: Date.now() + 60_000,
    };
    render(
      <DeviceAuthDialog
        open
        title="Authorize ChatGPT"
        pending={pending}
        onPoll={vi.fn().mockResolvedValue({ connected: false, pending })}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        onRetry={vi.fn()}
        pollIntervalMs={60_000}
      />,
    );

    expect(screen.getByText("WDJB-MJHT")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "providers.deviceAuth.copyCode" }));
    expect(browser.copy).toHaveBeenCalledWith("WDJB-MJHT");
    await user.click(screen.getByRole("button", { name: /auth\.example/i }));
    expect(browser.open).toHaveBeenCalledWith("https://auth.example/device");
  });

  test("auto-polls until connected, then reports success", async () => {
    const onPoll = vi
      .fn()
      .mockResolvedValueOnce({
        connected: false,
        pending: {
          userCode: "WDJB-MJHT",
          verificationUri: "https://auth.example/device",
          expiresAt: Date.now() + 60_000,
        },
      })
      .mockResolvedValueOnce({ connected: true, pending: null });
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <DeviceAuthDialog
        open
        title="Authorize ChatGPT"
        pending={{
          userCode: "WDJB-MJHT",
          verificationUri: "https://auth.example/device",
          expiresAt: Date.now() + 60_000,
        }}
        onPoll={onPoll}
        onCancel={vi.fn()}
        onClose={onClose}
        onSuccess={onSuccess}
        onRetry={vi.fn()}
        pollIntervalMs={1_000}
      />,
    );

    await waitFor(() => expect(onPoll).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ connected: true, pending: null }));
    expect(screen.getByText("providers.deviceAuth.successTitle")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1_300);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("stop authorization cancels local pending state", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <DeviceAuthDialog
        open
        title="Authorize ChatGPT"
        pending={{
          userCode: "WDJB-MJHT",
          verificationUri: "https://auth.example/device",
          expiresAt: Date.now() + 60_000,
        }}
        onPoll={vi.fn().mockResolvedValue({
          connected: false,
          pending: {
            userCode: "WDJB-MJHT",
            verificationUri: "https://auth.example/device",
            expiresAt: Date.now() + 60_000,
          },
        })}
        onCancel={onCancel}
        onClose={onClose}
        onSuccess={vi.fn()}
        onRetry={vi.fn()}
        pollIntervalMs={60_000}
      />,
    );

    await user.click(screen.getByRole("button", { name: "providers.deviceAuth.stop" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
