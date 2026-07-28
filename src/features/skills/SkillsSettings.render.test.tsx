// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  actor: { type: "local", id: "local", role: "owner" } as {
    type: "local" | "user";
    id: string;
    role: "owner" | "admin" | "member" | "viewer";
  },
  host: {
    listSkillInstallations: vi.fn(),
    supportedSkillSources: vi.fn(),
    listSkills: vi.fn(),
    installManagedSkill: vi.fn(),
    updateManagedSkill: vi.fn(),
    removeManagedSkill: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => fixture.actor,
}));
vi.mock("@/features/identity/workspace-identity", () => ({
  getIdentityWorkspace: () => ({ id: "local", isLocal: true }),
  identityWorkspaceIsLocalBypass: () => true,
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useWorkspaceState: () => ({ activeDirectory: "/project" }),
}));
vi.mock("@/protocol/host-client", () => ({ createHostClient: () => fixture.host }));

import { SkillsSettings } from "./SkillsSettings";

const installed = {
  name: "review",
  description: "Review changes",
  manual: false,
  scope: "project" as const,
  location: "/project/.agents/skills/review",
  managed: true,
  modified: false,
  generation: 2,
  source: "github:acme/skills/review@main",
  revision: "a".repeat(40),
};

describe("SkillsSettings", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    fixture.actor = { type: "local", id: "local", role: "owner" };
  });

  test("renders installed provenance and honest preview state", async () => {
    fixture.host.listSkillInstallations.mockImplementation((scope: string) =>
      Promise.resolve(scope === "project" ? [installed] : []),
    );
    fixture.host.supportedSkillSources.mockResolvedValue([]);
    render(<SkillsSettings />);

    expect(await screen.findByText("review")).toBeTruthy();
    expect(screen.getByRole("tablist").getAttribute("data-variant")).toBe("default");
    expect(screen.getByText("github:acme/skills/review@main")).toBeTruthy();
    await userEvent.click(screen.getByText("skillsSettings.preview.title"));
    expect(screen.getByText("skillsSettings.preview.unavailable")).toBeTruthy();
  });

  test("confirms install and retries idempotently with the same request id", async () => {
    fixture.host.listSkillInstallations.mockResolvedValue([]);
    fixture.host.supportedSkillSources.mockResolvedValue([
      { example: "github:acme/skills/review@main" },
    ]);
    fixture.host.installManagedSkill
      .mockRejectedValueOnce(new Error("temporary offline"))
      .mockResolvedValueOnce(installed);
    render(<SkillsSettings />);

    await userEvent.click(await screen.findByText("skillsSettings.discover"));
    await userEvent.type(
      screen.getByLabelText("skillsSettings.repositorySource"),
      "github:acme/skills/review@main",
    );
    await userEvent.click(screen.getByText("skillsSettings.reviewInstall"));
    await userEvent.click(screen.getByText("skillsSettings.confirm.installAction"));
    expect(await screen.findByText("temporary offline")).toBeTruthy();
    await userEvent.click(screen.getByText("skillsSettings.retrySameRequest"));
    await userEvent.click(screen.getByText("skillsSettings.confirm.installAction"));

    await waitFor(() => expect(fixture.host.installManagedSkill).toHaveBeenCalledTimes(2));
    expect(fixture.host.installManagedSkill.mock.calls[0]![0].requestId).toBe(
      fixture.host.installManagedSkill.mock.calls[1]![0].requestId,
    );
  });

  test("confirms generation-checked update and removal", async () => {
    fixture.host.listSkillInstallations.mockImplementation((scope: string) =>
      Promise.resolve(scope === "project" ? [installed] : []),
    );
    fixture.host.supportedSkillSources.mockResolvedValue([]);
    fixture.host.updateManagedSkill.mockResolvedValue({ ...installed, generation: 3 });
    fixture.host.removeManagedSkill.mockResolvedValue(undefined);
    render(<SkillsSettings />);

    await userEvent.click(await screen.findByText("skillsSettings.update"));
    await userEvent.click(screen.getByText("skillsSettings.confirm.updateAction"));
    await waitFor(() =>
      expect(fixture.host.updateManagedSkill).toHaveBeenCalledWith(
        "review",
        expect.objectContaining({ expectedGeneration: 2, scope: "project" }),
      ),
    );

    await userEvent.click(screen.getByText("skillsSettings.remove"));
    await userEvent.click(screen.getByText("skillsSettings.confirm.removeAction"));
    await waitFor(() =>
      expect(fixture.host.removeManagedSkill).toHaveBeenCalledWith(
        "review",
        expect.objectContaining({ expectedGeneration: 2, scope: "project" }),
      ),
    );
  });

  test("shows installed Skills without management controls to read-only actors", async () => {
    fixture.actor = { type: "user", id: "viewer", role: "viewer" };
    fixture.host.listSkills.mockResolvedValue([
      { name: "review", description: "Review changes", source: "host", manual: false },
    ]);
    render(<SkillsSettings />);

    expect(await screen.findByText("review")).toBeTruthy();
    expect(screen.queryByText("skillsSettings.discover")).toBeNull();
    expect(screen.queryByText("skillsSettings.update")).toBeNull();
    expect(screen.getByText("skillsSettings.readOnlyHelp")).toBeTruthy();
  });
});
