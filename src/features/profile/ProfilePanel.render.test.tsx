// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  actor: { type: "local", id: "local", displayName: "Local" } as {
    type: "local" | "user";
    id: string;
    displayName: string;
  },
  onDirty: null as ((dirty: boolean) => void) | null,
  logout: vi.fn(async () => undefined),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-theme", () => ({ useTheme: () => ({ mode: "dark" }) }));
vi.mock("@/features/identity/workspace-identity", () => ({
  logoutActiveWorkspaceIdentity: fixture.logout,
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => fixture.actor,
}));
vi.mock("@/features/identity/AccountSection", () => ({
  AccountSection: () => <p>account-section</p>,
  initialsFor: (name: string) => name.slice(0, 1),
}));
vi.mock("@/features/instructions/InstructionsSettings", () => ({
  usePersonalInstructionsAvailable: () => true,
  PersonalInstructions: ({ onDirty }: { onDirty: (dirty: boolean) => void }) => {
    fixture.onDirty = onDirty;
    return <p>personal-instructions</p>;
  },
}));
vi.mock("./PreferenceControls", () => ({
  AccentSetting: () => <p>accent</p>,
  ChatWidthSetting: () => <p>chat-width</p>,
  ContrastSetting: () => <p>contrast</p>,
  LanguageOptions: () => <p>language-options</p>,
  useLanguagePreference: () => ["auto", vi.fn()],
  ModelAgeFilterSetting: () => <p>model-age</p>,
  NewChatModelSetting: () => <p>new-chat-model</p>,
  NotificationsSetting: () => <p>notifications</p>,
  RespondingSidebarSetting: () => <p>responding-sidebar</p>,
  ThemeSetting: () => <p>theme</p>,
}));

import { act } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ProfilePanel as Panel } from "./ProfilePanel";

function ProfilePanel(props: { onClose: () => void }) {
  return (
    <SidebarProvider>
      <Panel {...props} />
    </SidebarProvider>
  );
}

describe("ProfilePanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    fixture.actor = { type: "local", id: "local", displayName: "Local" };
  });

  test("keeps account actions separate from centralized preferences", () => {
    render(<ProfilePanel onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "profile.preferencesTitle" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /profile.sections.appearance/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /settings.general.language/u })).toBeNull();
    expect(screen.getByRole("button", { name: /profile.personalInstructions/u })).toBeTruthy();
    // Nothing is expanded until asked for.
    expect(screen.queryByText("theme")).toBeNull();
    expect(screen.queryByText("personal-instructions")).toBeNull();
    // Desktop Local has no account to manage or sign out of.
    expect(screen.queryByText("identity.signOut")).toBeNull();
  });

  test("opens one group at a time and returns to the menu", async () => {
    const onClose = vi.fn();
    render(<ProfilePanel onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /profile.personalInstructions/u }));
    expect(screen.getByRole("heading", { name: "profile.personalInstructions" })).toBeTruthy();
    expect(screen.getByText("personal-instructions")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(screen.getByRole("heading", { name: "profile.preferencesTitle" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "profile.close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("leads with the account and offers sign out for signed-in people", async () => {
    fixture.actor = { type: "user", id: "alex", displayName: "Alex" };
    render(<ProfilePanel onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "profile.title" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "identity.signOut" }));
    expect(fixture.logout).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: /Alex/u }));
    expect(screen.getByText("account-section")).toBeTruthy();
  });

  test("guards unsaved personal instructions when leaving with Escape", async () => {
    const onClose = vi.fn();
    render(<ProfilePanel onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /profile.personalInstructions/u }));
    act(() => fixture.onDirty?.(true));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
    expect(confirm).toHaveBeenCalledWith("profile.discardInstructions");
    expect(screen.getByText("personal-instructions")).toBeTruthy();
  });
});
