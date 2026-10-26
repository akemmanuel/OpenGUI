// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  actor: { type: "local", id: "local", displayName: "Local" } as {
    type: "local" | "user";
    id: string;
    displayName: string;
  },
  setTheme: vi.fn(),
  chooseLanguage: vi.fn(),
  logout: vi.fn(async () => undefined),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ mode: "dark", setTheme: fixture.setTheme }),
}));
vi.mock("@/features/identity/workspace-identity", () => ({
  logoutActiveWorkspaceIdentity: fixture.logout,
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => fixture.actor,
}));
vi.mock("@/features/identity/AccountSection", () => ({
  initialsFor: (name: string) => name.slice(0, 1),
}));
vi.mock("@/features/instructions/InstructionsSettings", () => ({
  usePersonalInstructionsAvailable: () => true,
}));
vi.mock("./PreferenceControls", () => ({
  useLanguagePreference: () => ["auto", fixture.chooseLanguage],
}));

import { SidebarProvider } from "@/components/ui/sidebar";
import { AccountMenu } from "./AccountMenu";

function renderMenu() {
  const props = { onOpenSettings: vi.fn(), onOpenProfile: vi.fn() };
  render(
    <SidebarProvider>
      <AccountMenu active={false} {...props} />
    </SidebarProvider>,
  );
  return props;
}

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: "profile.open" }));
}

describe("AccountMenu", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    fixture.actor = { type: "local", id: "local", displayName: "Local" };
  });

  test("Desktop Local offers preferences and Settings without account actions", async () => {
    const props = renderMenu();
    expect(screen.getByText("common.settings")).toBeTruthy();
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /profile.account/u })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /identity.signOut/u })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: /profile.personalInstructions/u }));
    expect(props.onOpenProfile).toHaveBeenCalledWith("instructions");
  });

  test("switches the theme in place and routes to Settings", async () => {
    const props = renderMenu();
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: "settings.general.themeLight" }),
    );
    expect(fixture.setTheme).toHaveBeenCalledWith("light");
    // The theme toggle keeps the menu open for a second try.
    await userEvent.click(screen.getByRole("menuitem", { name: /profile.moreAppearance/u }));
    expect(props.onOpenSettings).toHaveBeenCalledWith("appearance");
  });

  test("signed-in people reach their account and can sign out", async () => {
    fixture.actor = { type: "user", id: "alex", displayName: "Alex" };
    const props = renderMenu();
    expect(screen.getByText("Alex")).toBeTruthy();
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /profile.account/u }));
    expect(props.onOpenProfile).toHaveBeenCalledWith("account");
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /identity.signOut/u }));
    expect(fixture.logout).toHaveBeenCalledOnce();
  });
});
