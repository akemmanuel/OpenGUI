// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/SettingsProviders", () => ({
  SettingsProviders: () => <p>models-panel</p>,
}));
vi.mock("@/components/settings/GeneralSettings", () => ({
  GeneralSettings: () => <p>general-panel</p>,
  PathsAndShellSettings: () => <p>paths-panel</p>,
}));
vi.mock("@/features/identity/TeamSettings", () => ({
  TeamSettings: ({ view }: { view: string }) => <p>team-{view}</p>,
}));
vi.mock("@/features/skills/SkillsSettings", () => ({
  SkillsSettings: () => <p>skills-library</p>,
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

  test("exposes the same coherent sections to desktop and compact navigation", async () => {
    render(<SettingsView onBack={vi.fn()} />);
    const navigation = screen.getByRole("navigation", { name: "settings.navigationLabel" });
    expect(navigation).toBeTruthy();
    expect(screen.getAllByText("settings.tabs.models").length).toBe(2);
    expect(screen.getAllByText("settings.tabs.paths").length).toBe(2);
    expect(screen.getAllByText("settings.tabs.host").length).toBe(2);
    expect(screen.getAllByText("settings.tabs.integrations").length).toBe(2);

    await userEvent.selectOptions(screen.getByRole("combobox"), "paths");
    expect(screen.getByText("paths-panel")).toBeTruthy();
    expect(screen.getByText("team-paths")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.host" }));
    expect(screen.getByText("team-host")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.integrations" }));
    expect(screen.getByText("mcp-connections")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "settings.tabs.skills" }));
    expect(screen.getByText("skills-library")).toBeTruthy();
  });

  test("keeps the side navigation from the medium breakpoint upward", () => {
    render(<SettingsView onBack={vi.fn()} />);

    expect(screen.getByRole("combobox").className).toContain("md:hidden");
    expect(
      screen.getByRole("button", { name: "settings.tabs.general" }).parentElement?.className,
    ).toContain("md:block");
  });
});
