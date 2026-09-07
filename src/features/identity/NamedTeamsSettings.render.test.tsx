// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
const f = vi.hoisted(() => ({ save: vi.fn(), teams: [] as any[] }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./workspace-identity", () => ({
  getIdentityWorkspace: () => ({ serverUrl: "http://localhost", authToken: "test" }),
}));
vi.mock("./identity-client", () => ({
  createIdentityClient: () => ({
    teams: async () => f.teams,
    members: async () => [{ id: "alice", username: "Alice", email: "alice@test" }],
    modelOfferings: async () => [{ id: "company", displayName: "Company model" }],
    modelPolicy: async () => ({
      host: { allowByok: true, allowByos: true },
      team: { allowByok: true, allowByos: true },
    }),
    saveTeam: f.save,
  }),
}));
import { NamedTeamsSettings } from "./NamedTeamsSettings";
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  f.teams = [
    {
      id: "host_default",
      name: "Everyone",
      memberIds: ["alice"],
      modelOfferingIds: [],
      allowByok: true,
      allowByos: true,
    },
  ];
  f.save.mockImplementation(async (input) => {
    const team = { ...input, id: "design" };
    f.teams.push(team);
    return team;
  });
});
test("creates a team with members, model access and credential policy in one save, then reloads", async () => {
  const first = render(<NamedTeamsSettings />);
  await userEvent.click(await screen.findByRole("button", { name: "teams.create" }));
  await userEvent.type(screen.getByLabelText("teams.name"), "Design");
  await userEvent.click(screen.getByRole("checkbox", { name: /Alice/ }));
  await userEvent.click(screen.getByRole("button", { name: "teams.tabs.models" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Company model" }));
  await userEvent.click(screen.getByRole("button", { name: "teams.tabs.personal" }));
  await userEvent.click(screen.getByRole("switch", { name: /teams.allowByok/ }));
  await userEvent.click(screen.getByRole("button", { name: "access.save" }));
  await waitFor(() =>
    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Design",
        memberIds: ["alice"],
        modelOfferingIds: ["company"],
        allowByok: false,
        allowByos: true,
      }),
      undefined,
    ),
  );
  await screen.findByRole("button", { name: /Design/ });
  first.unmount();
  render(<NamedTeamsSettings />);
  await userEvent.click(await screen.findByRole("button", { name: /Design/ }));
  expect(screen.getByRole("checkbox", { name: /Alice/ }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "teams.tabs.personal" }));
  expect(screen.getByRole("switch", { name: /teams.allowByok/ }).getAttribute("aria-checked")).toBe(
    "false",
  );
});
test("keeps a failed team draft for retry", async () => {
  f.save.mockRejectedValueOnce(new Error("offline"));
  render(<NamedTeamsSettings />);
  await userEvent.click(await screen.findByRole("button", { name: "teams.create" }));
  await userEvent.type(screen.getByLabelText("teams.name"), "Design");
  await userEvent.click(screen.getByRole("button", { name: "access.save" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("teams.name") as HTMLInputElement).value).toBe("Design");
  await userEvent.click(screen.getByRole("button", { name: "access.save" }));
  expect(await screen.findByRole("button", { name: /Design/ })).toBeTruthy();
});
