// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ProviderLoginStatus } from "@/protocol/host-types";

const browser = vi.hoisted(() => ({
  copy: vi.fn().mockResolvedValue(undefined),
  open: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/browser", () => ({
  copyTextToClipboard: browser.copy,
  openExternalLink: browser.open,
}));

import { ProviderLoginDialog } from "./ProviderLoginDialog";

function dialog(status: ProviderLoginStatus, overrides: Record<string, unknown> = {}) {
  const props = {
    open: true,
    providerName: "Provider",
    status,
    onPoll: vi.fn(async () => status),
    onRespond: vi.fn(async () => ({ ...status, state: "succeeded" as const, prompt: undefined })),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    ...overrides,
  };
  render(<ProviderLoginDialog {...props} />);
  return props;
}

describe("ProviderLoginDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("answers a select prompt with the chosen option id", async () => {
    const props = dialog({
      providerId: "openai-codex",
      method: "oauth",
      state: "awaiting_input",
      events: [],
      prompt: {
        id: "choice",
        type: "select",
        message: "Select login method",
        options: [
          { id: "browser", label: "Browser login" },
          { id: "device_code", label: "Device code login", description: "Headless" },
        ],
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /Device code login/ }));
    expect(props.onRespond).toHaveBeenCalledWith("choice", "device_code");
    expect(await screen.findByText("providers.login.successTitle")).toBeTruthy();
    expect(props.onSuccess).toHaveBeenCalledOnce();
  });

  test("opens sign-in links only for web URLs", async () => {
    dialog({
      providerId: "anthropic",
      method: "oauth",
      state: "awaiting_input",
      events: [{ type: "auth_url", url: "https://claude.ai/oauth/authorize?x=1" }],
      prompt: { id: "code", type: "manual_code", message: "Paste the code" },
    });
    await userEvent.click(screen.getByRole("button", { name: "providers.login.openSignIn" }));
    expect(browser.open).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?x=1");
    cleanup();

    dialog({
      providerId: "anthropic",
      method: "oauth",
      state: "running",
      events: [{ type: "auth_url", url: "javascript:alert(1)" }],
    });
    expect(screen.queryByRole("button", { name: "providers.login.openSignIn" })).toBeNull();
  });

  test("shows a failed sign-in and retries it", async () => {
    const props = dialog({
      providerId: "groq",
      method: "api_key",
      state: "failed",
      events: [],
      error: "Invalid API key",
    });
    expect(screen.getByRole("alert").textContent).toContain("Invalid API key");
    await userEvent.click(screen.getByRole("button", { name: "providers.login.retry" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });
});
