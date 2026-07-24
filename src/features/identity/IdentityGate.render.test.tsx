// @vitest-environment happy-dom

import { useIdentityActor } from "./identity-actor-context";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import "@/i18n";

const fixtures = vi.hoisted(() => ({
  workspace: {
    id: "remote-1",
    name: "Remote Host",
    serverUrl: "https://host.test",
    authToken: "saved-token",
    isLocal: false,
  } as Record<string, unknown> | null,
  client: {
    health: vi.fn(),
    policy: vi.fn(),
    me: vi.fn(),
    login: vi.fn(),
    setup: vi.fn(),
    register: vi.fn(),
  },
  persisted: vi.fn(),
}));

vi.mock("@/runtime/shell-policy", () => ({
  getShellWorkspacePolicy: () => ({ shellKind: "web", supportsMultipleWorkspaces: true }),
}));
vi.mock("./workspace-identity", () => ({
  WORKSPACE_IDENTITY_CHANGE_EVENT: "opengui:test-workspace-change",
  getIdentityWorkspace: () => fixtures.workspace,
  persistWorkspaceIdentityToken: fixtures.persisted,
}));
vi.mock("./identity-client", () => {
  class IdentityRequestError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return {
    createIdentityClient: () => fixtures.client,
    IdentityRequestError,
  };
});

import { IdentityGate } from "./IdentityGate";

function ActorProbe() {
  const actor = useIdentityActor();
  return <div>actor:{actor?.displayName ?? "none"}</div>;
}

describe("IdentityGate render integration", () => {
  beforeEach(() => {
    for (const method of Object.values(fixtures.client)) method.mockReset();
    fixtures.persisted.mockReset();
    fixtures.workspace = {
      id: "remote-1",
      name: "Remote Host",
      serverUrl: "https://host.test",
      authToken: "saved-token",
      isLocal: false,
    };
    fixtures.client.health.mockResolvedValue({
      authRequired: true,
      identity: "ready",
      hostName: "Remote Host",
    });
    fixtures.client.policy.mockResolvedValue({ registrationMode: "invite_only" });
    fixtures.client.me.mockResolvedValue({
      actor: { type: "user", id: "u1", displayName: "Ada", role: "owner" },
    });
  });
  afterEach(cleanup);

  test("checks a saved session and publishes the authenticated actor before rendering children", async () => {
    const view = render(
      <IdentityGate>
        <ActorProbe />
      </IdentityGate>,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByText("actor:Ada")).toBeTruthy();
    expect(fixtures.client.me).toHaveBeenCalledOnce();

    fixtures.client.me.mockResolvedValueOnce({
      actor: { type: "user", id: "u2", displayName: "Grace", role: "member" },
    });
    fixtures.workspace = { ...fixtures.workspace! };
    await act(async () => window.dispatchEvent(new Event("opengui:test-workspace-change")));
    expect(await screen.findByText("actor:Grace")).toBeTruthy();
    view.unmount();
  });

  test("clears an invalid saved session, then logs in through the public form", async () => {
    const { IdentityRequestError } = await import("./identity-client");
    fixtures.client.me.mockRejectedValueOnce(new IdentityRequestError("expired", 401));
    fixtures.client.login.mockResolvedValue({
      token: "fresh-token",
      actor: { type: "user", id: "u1", displayName: "Ada", role: "owner" },
    });
    render(
      <IdentityGate>
        <ActorProbe />
      </IdentityGate>,
    );

    const user = userEvent.setup();
    await waitFor(() => expect(document.querySelector('input[name="username"]')).toBeTruthy());
    await user.type(document.querySelector('input[name="username"]')!, "ada");
    await user.type(document.querySelector('input[name="password"]')!, "password-123");
    await user.click(document.querySelector('button[type="submit"]')!);

    expect(await screen.findByText("actor:Ada")).toBeTruthy();
    expect(fixtures.persisted).toHaveBeenNthCalledWith(1, "remote-1", undefined);
    expect(fixtures.persisted).toHaveBeenLastCalledWith("remote-1", "fresh-token");
  });

  test("shows an offline recovery action and retries the Host check", async () => {
    fixtures.client.health.mockRejectedValueOnce(new Error("offline"));
    render(
      <IdentityGate>
        <ActorProbe />
      </IdentityGate>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(fixtures.client.health).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("actor:Ada")).toBeTruthy();
  });
});
