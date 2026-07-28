// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import "@/i18n";

const fixture = vi.hoisted(() => ({
  client: {
    me: vi.fn(),
    members: vi.fn(),
    invites: vi.fn(),
    apiKeys: vi.fn(),
    hostPolicy: vi.fn(),
    modelPolicy: vi.fn(),
    accessibleRoots: vi.fn(),
    createInvite: vi.fn(),
    createApiKey: vi.fn(),
    setHostPolicy: vi.fn(),
    setModelPolicy: vi.fn(),
    setMemberCanInvite: vi.fn(),
    revokeInvite: vi.fn(),
    revokeApiKey: vi.fn(),
    removeMember: vi.fn(),
    resetMemberPassword: vi.fn(),
  },
}));

vi.mock("./workspace-identity", () => ({
  getIdentityWorkspace: () => ({
    id: "remote",
    name: "Remote",
    serverUrl: "https://host.test",
    authToken: "token",
    isLocal: false,
  }),
}));
vi.mock("./identity-client", () => ({ createIdentityClient: () => fixture.client }));
vi.mock("@/lib/browser", () => ({ copyTextToClipboard: vi.fn(async () => undefined) }));

import { TeamSettings } from "./TeamSettings";

describe("TeamSettings render integration", () => {
  beforeEach(() => {
    for (const method of Object.values(fixture.client)) method.mockReset();
    fixture.client.me.mockResolvedValue({
      actor: { type: "user", id: "owner", displayName: "Owner", role: "owner" },
      user: { id: "owner" },
      pathPolicy: { mode: "enforced", enforcementReady: true },
    });
    fixture.client.members.mockResolvedValue([
      { id: "owner", username: "owner", email: "owner@test", role: "owner" },
      { id: "member", username: "ada", email: "ada@test", role: "member", canInvite: false },
    ]);
    fixture.client.invites.mockResolvedValue([]);
    fixture.client.apiKeys.mockResolvedValue([]);
    fixture.client.hostPolicy.mockResolvedValue({ registrationMode: "invite_only" });
    fixture.client.modelPolicy.mockResolvedValue({
      host: { allowByok: true, allowByos: true },
      team: { allowByok: true, allowByos: false },
    });
    fixture.client.accessibleRoots.mockResolvedValue(["/project"]);
    fixture.client.createInvite.mockResolvedValue({
      id: "invite-1",
      email: "new@test",
      role: "member",
      token: "secret",
      expiresAt: Date.now() + 10000,
    });
    fixture.client.createApiKey.mockResolvedValue({
      id: "key-1",
      label: "automation",
      role: "member",
      secret: "shown-once",
      createdAt: Date.now(),
    });
    fixture.client.setMemberCanInvite.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  test("loads members and role controls without mixing in path grants", async () => {
    render(<TeamSettings />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByText("ada")).toBeTruthy();
    expect(screen.getByText("ada@test")).toBeTruthy();
    expect(screen.queryByText("identity.pathGrants.access")).toBeNull();
    expect(fixture.client.members).toHaveBeenCalledOnce();

    await userEvent.click(screen.getAllByRole("switch").at(-1)!);
    await waitFor(() =>
      expect(fixture.client.setMemberCanInvite).toHaveBeenCalledWith("member", true),
    );
  });

  test("creates an invite while keeping its one-time secret out of list metadata", async () => {
    render(<TeamSettings />);
    await screen.findByText("ada");
    const email = document.querySelector("#team-invite-email") as HTMLInputElement;
    fireEvent.change(email, { target: { value: "new@test" } });
    fireEvent.submit(email.closest("form")!);
    await waitFor(() =>
      expect(fixture.client.createInvite).toHaveBeenCalledWith({
        email: "new@test",
        role: "member",
        pathGrants: [],
      }),
    );
    expect(await screen.findByDisplayValue(/invite=secret/)).toBeTruthy();
  });

  test("separates path grants and Host API keys into their own views", async () => {
    const { unmount } = render(<TeamSettings view="paths" />);
    expect((await screen.findAllByText("identity.pathGrants.access")).length).toBeGreaterThan(0);
    expect(document.querySelector("#api-key-label")).toBeNull();
    unmount();

    render(<TeamSettings view="host" />);
    const label = (await screen.findByLabelText("identity.keyLabel")) as HTMLInputElement;
    fireEvent.change(label, { target: { value: "automation" } });
    fireEvent.submit(label.closest("form")!);
    await waitFor(() => expect(fixture.client.createApiKey).toHaveBeenCalled());
    expect(await screen.findByDisplayValue("shown-once")).toBeTruthy();
  });

  test("fails closed for non-owners", async () => {
    fixture.client.me.mockResolvedValueOnce({
      actor: { type: "user", id: "member", displayName: "Ada", role: "member" },
      pathPolicy: { mode: "enforced", enforcementReady: true },
    });
    render(<TeamSettings />);
    expect(await screen.findByText("identity.teamOwnerOnly")).toBeTruthy();
    expect(fixture.client.members).not.toHaveBeenCalled();
  });
});
