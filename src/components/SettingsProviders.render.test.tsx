// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  actor: { type: "user", id: "member-1", role: "member" } as any,
  connections: [] as any[],
  identityEnabled: true,
  allowByos: false,
  modelPolicy: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  list: vi.fn(),
  upsert: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  beginCodex: vi.fn(),
  pollCodex: vi.fn().mockResolvedValue({ connected: false, pending: null }),
  cancelCodex: vi.fn().mockResolvedValue({ connected: false, pending: null }),
  codexStatus: vi.fn().mockResolvedValue({ connected: false, pending: null }),
  subscriptionStatus: vi.fn().mockResolvedValue({ connected: false, pending: null }),
  beginSubscription: vi.fn(),
  pollSubscription: vi.fn().mockResolvedValue({ connected: false, pending: null }),
  cancelSubscription: vi.fn().mockResolvedValue({ connected: false, pending: null }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => (values?.name ? `${key}:${values.name}` : key),
  }),
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ refreshProviders: fixture.refresh }),
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => fixture.actor,
}));
vi.mock("@/features/identity/workspace-identity", () => ({
  getIdentityWorkspace: () =>
    fixture.identityEnabled ? { serverUrl: "https://host.example", authToken: "token" } : null,
}));
vi.mock("@/features/identity/identity-client", () => ({
  createIdentityClient: () => ({ modelPolicy: fixture.modelPolicy }),
}));
vi.mock("@/protocol/host-client", () => ({
  createHostClient: () => ({
    listModelConnections: fixture.list,
    upsertModelConnection: fixture.upsert,
    removeModelConnection: fixture.remove,
    codexAuthStatus: fixture.codexStatus,
    beginCodexAuth: fixture.beginCodex,
    pollCodexAuth: fixture.pollCodex,
    cancelCodexAuth: fixture.cancelCodex,
    disconnectCodex: vi.fn(),
    subscriptionAuthStatus: fixture.subscriptionStatus,
    beginSubscriptionAuth: fixture.beginSubscription,
    pollSubscriptionAuth: fixture.pollSubscription,
    cancelSubscriptionAuth: fixture.cancelSubscription,
    disconnectSubscription: vi.fn(),
  }),
}));

import { SettingsProviders } from "./SettingsProviders";

describe("SettingsProviders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.actor = { type: "user", id: "member-1", role: "member" };
    fixture.connections = [];
    fixture.identityEnabled = true;
    fixture.allowByos = false;
    fixture.modelPolicy.mockImplementation(async () => ({
      host: { allowByok: true, allowByos: true },
      team: { allowByok: true, allowByos: fixture.allowByos },
      effective: { allowByok: true, allowByos: fixture.allowByos },
    }));
    fixture.list.mockImplementation(async () => fixture.connections);
    fixture.beginCodex.mockResolvedValue({
      connected: false,
      pending: { userCode: "ABCD", verificationUri: "https://auth.example/device" },
    });
  });
  afterEach(cleanup);

  test("validates custom connections and saves normalized member-owned configuration", async () => {
    render(<SettingsProviders />);
    await waitFor(() => expect(fixture.list).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "providers.addBackend" }));
    const endpoint = screen.getByLabelText("providers.baseUrl");
    const model = screen.getByLabelText("providers.upstreamModelId");
    const name = screen.getByLabelText("providers.backendName");
    const add = screen.getByRole("button", { name: "providers.saveBackend" });
    await userEvent.clear(endpoint);
    expect(add.hasAttribute("disabled")).toBe(true);

    await userEvent.type(endpoint, " https://models.example/v1 ");
    await userEvent.type(name, "My models");
    await userEvent.type(model, " model-x ");
    await userEvent.click(add);
    await waitFor(() => expect(fixture.upsert).toHaveBeenCalled());
    expect(fixture.upsert.mock.calls.at(-1)?.[0]).toMatchObject({
      baseUrl: "https://models.example/v1",
      modelIds: ["model-x"],
      plane: "user",
    });
    expect(fixture.refresh).toHaveBeenCalled();
  });

  test("shows personal subscription sign-in to a member allowed by BYOS policy", async () => {
    fixture.allowByos = true;
    render(<SettingsProviders />);

    expect(await screen.findByRole("button", { name: "providers.codex.signIn" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "providers.xai.signIn" })).toBeTruthy();
    await waitFor(() => expect(fixture.codexStatus).toHaveBeenCalledTimes(1));
    expect(fixture.subscriptionStatus).toHaveBeenCalledWith("xai");
  });

  test("does not expose raw shared connections or subscriptions to a member denied by BYOS policy", async () => {
    fixture.connections = [
      {
        id: "host-model",
        label: "Shared model",
        baseUrl: "https://models.example",
        modelIds: ["shared"],
        plane: "host",
      },
    ];
    render(<SettingsProviders />);
    await waitFor(() => expect(fixture.list).toHaveBeenCalled());
    expect(screen.queryByText("Shared model")).toBeNull();
    expect(screen.queryByRole("button", { name: "providers.codex.signIn" })).toBeNull();
    expect(fixture.codexStatus).not.toHaveBeenCalled();
    expect(fixture.subscriptionStatus).not.toHaveBeenCalled();
  });

  test("opens the device authorization dialog returned by the Host", async () => {
    fixture.actor = { type: "user", id: "owner-1", role: "owner" };
    fixture.identityEnabled = false;
    fixture.beginCodex.mockResolvedValue({
      connected: false,
      pending: {
        userCode: "ABCD",
        verificationUri: "https://auth.example/device",
        expiresAt: Date.now() + 60_000,
      },
    });
    fixture.pollCodex.mockResolvedValue({
      connected: false,
      pending: {
        userCode: "ABCD",
        verificationUri: "https://auth.example/device",
        expiresAt: Date.now() + 60_000,
      },
    });
    render(<SettingsProviders />);
    await userEvent.click(await screen.findByRole("button", { name: "providers.codex.signIn" }));
    expect(await screen.findByText("providers.codex.authorizeTitle")).toBeTruthy();
    expect(screen.getByText("ABCD")).toBeTruthy();
    expect(screen.getByRole("button", { name: "providers.deviceAuth.stop" })).toBeTruthy();
  });
});
