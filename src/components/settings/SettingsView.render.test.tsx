// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/SettingsProviders", () => ({
  SettingsProviders: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => (
    <button onClick={() => onDirtyChange(true)}>models-panel</button>
  ),
}));
vi.mock("@/components/settings/DesktopSettings", () => ({
  DesktopSettings: () => <p>desktop-panel</p>,
}));
vi.mock("@/runtime/clients", () => ({
  getDesktopShellClient: () => ({ runtime: { isElectron: true } }),
}));
vi.mock("@/features/identity/TeamSettings", () => ({
  TeamSettings: ({ view }: { view: string }) => <p>team-{view}</p>,
}));
vi.mock("@/features/skills/SkillsSettings", () => ({
  SkillsSettings: () => <p>skills-library</p>,
}));
vi.mock("@/features/instructions/InstructionsSettings", () => ({
  InstructionsSettings: () => <p>instructions-panel</p>,
}));
vi.mock("@/features/mcp/McpSettings", () => ({
  McpSettings: () => <p>mcp-connections</p>,
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => ({ type: "user", id: "owner", role: "owner" }),
}));
vi.mock("@/features/identity/workspace-identity", () => ({
  getIdentityWorkspace: () => ({ authToken: "token", isLocal: false }),
  identityWorkspaceIsLocalBypass: () => false,
}));

import { SettingsView } from "./SettingsView";

describe("SettingsView responsive navigation", () => {
  afterEach(cleanup);

  test("groups sections and exposes the same ones to desktop and compact navigation", async () => {
    render(<SettingsView onBack={vi.fn()} />);
    const navigation = screen.getByRole("navigation", { name: "settings.navigationLabel" });
    expect(navigation).toBeTruthy();
    for (const tab of ["models", "integrations", "paths", "host", "desktop"]) {
      expect(screen.getByRole("button", { name: `settings.tabs.${tab}` })).toBeTruthy();
    }
    expect(screen.getAllByText("settings.groups.host").length).toBe(1);
    expect(screen.queryByText("settings.tabs.general")).toBeNull();

    await userEvent.click(screen.getByRole("combobox", { name: "settings.navigationLabel" }));
    for (const tab of ["models", "integrations", "paths", "host", "desktop"]) {
      expect(await screen.findByRole("option", { name: `settings.tabs.${tab}` })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole("option", { name: "settings.tabs.paths" }));
    expect(await screen.findByText("team-paths")).toBeTruthy();
    expect(screen.getByText("settings.paths.boundaryTitle")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.desktop" }));
    expect(screen.getByText("desktop-panel")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.host" }));
    expect(screen.getByText("team-host")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.integrations" }));
    expect(screen.getByText("mcp-connections")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.skills" }));
    expect(screen.getByText("skills-library")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.instructions" }));
    expect(screen.getByText("instructions-panel")).toBeTruthy();
  });

  test("opens on the first available section", () => {
    render(<SettingsView onBack={vi.fn()} />);
    expect(screen.getByText("models-panel")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "settings.tabs.models" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  test("asks before discarding access changes when switching settings or leaving", async () => {
    const onBack = vi.fn();
    render(<SettingsView onBack={onBack} />);
    await userEvent.click(screen.getByRole("button", { name: "models-panel" }));
    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.host" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "access.keepEditing" }));
    expect(screen.getByText("models-panel")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "settings.backToChat" }));
    expect(onBack).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "access.discard" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  test("keeps the side navigation from the medium breakpoint upward", () => {
    render(<SettingsView onBack={vi.fn()} />);
    expect(
      screen.getByRole("combobox", { name: "settings.navigationLabel" }).parentElement?.className,
    ).toContain("md:hidden");
    expect(
      screen.getByRole("button", { name: "settings.tabs.models" }).closest("ul")?.parentElement
        ?.parentElement?.className,
    ).toContain("md:block");
  });
});
