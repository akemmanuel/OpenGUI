// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  onDirty: null as ((dirty: boolean) => void) | null,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/identity/AccountSection", () => ({
  AccountSection: () => <p>account-section</p>,
}));
vi.mock("@/features/instructions/InstructionsSettings", () => ({
  PersonalInstructions: ({ onDirty }: { onDirty: (dirty: boolean) => void }) => {
    fixture.onDirty = onDirty;
    return <p>personal-instructions</p>;
  },
}));

import { act } from "react";
import { ProfilePanel } from "./ProfilePanel";

describe("ProfilePanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("opens straight into the group chosen from the account menu", () => {
    render(<ProfilePanel view="account" onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "profile.account" })).toBeTruthy();
    expect(screen.getByText("account-section")).toBeTruthy();
    expect(screen.queryByText("personal-instructions")).toBeNull();
  });

  test("returns to the chats from the back button", async () => {
    const onClose = vi.fn();
    render(<ProfilePanel view="instructions" onClose={onClose} />);
    expect(screen.getByText("personal-instructions")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "profile.close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("guards unsaved personal instructions when leaving with Escape", () => {
    const onClose = vi.fn();
    render(<ProfilePanel view="instructions" onClose={onClose} />);
    act(() => fixture.onDirty?.(true));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
    expect(confirm).toHaveBeenCalledWith("profile.discardInstructions");
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
