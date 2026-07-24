// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { STORAGE_KEYS } from "@/lib/constants";
import { polyfillLocalStorage } from "@/lib/__tests__/setup";

polyfillLocalStorage();

const fixture = vi.hoisted(() => ({
  upsert: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined),
  browse: vi.fn().mockResolvedValue("/srv/chosen"),
  registerBack: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/protocol/host-client", () => ({
  createHostClient: () => ({ upsertModelConnection: fixture.upsert }),
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ refreshProviders: fixture.refresh }),
}));
vi.mock("@/shell/provider", () => ({
  useDesktopShell: () => ({
    runtime: { isElectron: false },
    dialog: { openDirectory: vi.fn() },
  }),
}));
vi.mock("@/components/ProjectPathDialog", () => ({
  requestProjectPath: fixture.browse,
}));
vi.mock("@/shell/useRegisterMobileBackHandler", () => ({
  useRegisterMobileBackHandler: fixture.registerBack,
}));

import { SetupWizard } from "./SetupWizard";

describe("SetupWizard journey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(cleanup);

  test("saves a valid connection, browses a Host folder, and completes setup", async () => {
    const onComplete = vi.fn();
    render(<SetupWizard onComplete={onComplete} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /setupWizard.continue/ }));
    await waitFor(() => expect(fixture.upsert).toHaveBeenCalledOnce());
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(screen.getByText("2 / 3")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /common.browse/ }));
    await waitFor(() => expect(fixture.browse).toHaveBeenCalled());
    expect(
      (screen.getByPlaceholderText("setupWizard.folderPlaceholder") as HTMLInputElement).value,
    ).toBe("/srv/chosen");
    await userEvent.click(screen.getByRole("button", { name: /setupWizard.continue/ }));
    await userEvent.click(screen.getByRole("button", { name: /setupWizard.openOpenGui/ }));

    expect(localStorage.getItem(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY)).toBe("/srv/chosen");
    expect(localStorage.getItem(STORAGE_KEYS.SETUP_COMPLETE)).toBe("true");
    expect(onComplete).toHaveBeenCalledOnce();
  });

  test("does not allow an invalid model endpoint to advance", async () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    await userEvent.clear(inputs[0]!);
    const continueButton = screen.getByRole("button", { name: /setupWizard.continue/ });

    expect(continueButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  test("mobile back navigates steps before dismissing the wizard", async () => {
    const onComplete = vi.fn();
    render(<SetupWizard onComplete={onComplete} />);
    await userEvent.click(screen.getByRole("button", { name: "setupWizard.skip" }));
    const handler = fixture.registerBack.mock.calls.at(-1)?.[2] as () => boolean;
    expect(handler()).toBe(true);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    expect(onComplete).not.toHaveBeenCalled();
  });
});
