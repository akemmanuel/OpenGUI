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
  providers: [] as any[],
  listProviders: vi.fn(),
  beginLogin: vi.fn(),
  loginStatus: vi.fn(),
  respondLogin: vi.fn(),
  cancelLogin: vi.fn().mockResolvedValue(undefined),
  disconnectProvider: vi.fn().mockResolvedValue(undefined),
}));

const PROVIDERS = [
  { id: "openai-codex", name: "ChatGPT", oauth: { name: "ChatGPT", subscription: true } },
  {
    id: "anthropic",
    name: "Anthropic",
    apiKey: { name: "Anthropic API key", interactive: true },
    oauth: { name: "Claude", subscription: true },
  },
  { id: "opencode", name: "OpenCode Zen", apiKey: { name: "OpenCode API key", interactive: true } },
];

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
    listProviders: fixture.listProviders,
    beginProviderLogin: fixture.beginLogin,
    providerLoginStatus: fixture.loginStatus,
    respondProviderLogin: fixture.respondLogin,
    cancelProviderLogin: fixture.cancelLogin,
    disconnectProvider: fixture.disconnectProvider,
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
    fixture.providers = PROVIDERS;
    fixture.listProviders.mockImplementation(async () => fixture.providers);
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

  test("offers every provider's sign-in methods to a member allowed by BYOS policy", async () => {
    fixture.allowByos = true;
    render(<SettingsProviders />);

    expect(
      await screen.findByRole("button", { name: "providers.directory.signInNamed:ChatGPT" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "providers.directory.signInNamed:Anthropic" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "providers.directory.apiKeyNamed:Anthropic" }),
    ).toBeTruthy();
    // ChatGPT has no API-key sign-in.
    expect(
      screen.queryByRole("button", { name: "providers.directory.apiKeyNamed:ChatGPT" }),
    ).toBeNull();
  });

  test("withholds subscriptions and shared connections from a member denied by BYOS policy", async () => {
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
    expect(
      await screen.findByRole("button", { name: "providers.directory.apiKeyNamed:Anthropic" }),
    ).toBeTruthy();
    expect(screen.queryByText("Shared model")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "providers.directory.signInNamed:ChatGPT" }),
    ).toBeNull();
  });

  test("filters providers by search", async () => {
    fixture.allowByos = true;
    render(<SettingsProviders />);
    await screen.findByText("Anthropic");
    await userEvent.type(screen.getByLabelText("providers.searchPlaceholder"), "zen");
    expect(screen.getByText("OpenCode Zen")).toBeTruthy();
    expect(screen.queryByText("Anthropic")).toBeNull();
  });

  test("answers a pi API-key prompt and refreshes models once connected", async () => {
    fixture.actor = { type: "user", id: "owner-1", role: "owner" };
    fixture.identityEnabled = false;
    fixture.beginLogin.mockResolvedValue({
      providerId: "anthropic",
      method: "api_key",
      state: "awaiting_input",
      prompt: { id: "prompt-1", type: "secret", message: "Enter Anthropic API key" },
      events: [],
    });
    fixture.respondLogin.mockResolvedValue({
      providerId: "anthropic",
      method: "api_key",
      state: "succeeded",
      events: [],
      connectionId: "anthropic",
    });
    render(<SettingsProviders />);
    await userEvent.click(
      await screen.findByRole("button", { name: "providers.directory.apiKeyNamed:Anthropic" }),
    );
    expect(fixture.beginLogin).toHaveBeenCalledWith("anthropic", "api_key");
    const input = await screen.findByLabelText("Enter Anthropic API key");
    expect(input.getAttribute("type")).toBe("password");
    const submit = screen.getByRole("button", { name: "providers.login.submit" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await userEvent.type(input, " sk-ant-test ");
    await userEvent.click(submit);
    expect(fixture.respondLogin).toHaveBeenCalledWith("anthropic", "prompt-1", "sk-ant-test");
    expect(await screen.findByText("providers.login.successTitle")).toBeTruthy();
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalled());
  });

  test("lets OpenCode Zen continue without a key for its free models", async () => {
    fixture.actor = { type: "user", id: "owner-1", role: "owner" };
    fixture.identityEnabled = false;
    fixture.beginLogin.mockResolvedValue({
      providerId: "opencode",
      method: "api_key",
      state: "awaiting_input",
      prompt: { id: "prompt-zen", type: "secret", message: "Enter OpenCode API key" },
      events: [],
    });
    fixture.respondLogin.mockResolvedValue({
      providerId: "opencode",
      method: "api_key",
      state: "succeeded",
      events: [],
    });
    render(<SettingsProviders />);
    await userEvent.click(
      await screen.findByRole("button", { name: "providers.directory.apiKeyNamed:OpenCode Zen" }),
    );
    expect(await screen.findByText("providers.directory.freeTierHint")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "providers.login.submit" }));
    expect(fixture.respondLogin).toHaveBeenCalledWith("opencode", "prompt-zen", "");
  });

  test("shows the device code and sign-in link pi reports", async () => {
    fixture.actor = { type: "user", id: "owner-1", role: "owner" };
    fixture.identityEnabled = false;
    const status = {
      providerId: "openai-codex",
      method: "oauth",
      state: "running",
      events: [
        {
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://auth.example/device",
        },
      ],
    };
    fixture.beginLogin.mockResolvedValue(status);
    fixture.loginStatus.mockResolvedValue(status);
    render(<SettingsProviders />);
    await userEvent.click(
      await screen.findByRole("button", { name: "providers.directory.signInNamed:ChatGPT" }),
    );
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByRole("button", { name: "auth.example" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "providers.login.stop" }));
    expect(fixture.cancelLogin).toHaveBeenCalledWith("openai-codex");
  });

  test("lists connected providers and disconnects them", async () => {
    fixture.actor = { type: "user", id: "owner-1", role: "owner" };
    fixture.identityEnabled = false;
    fixture.providers = [
      { ...PROVIDERS[1], connection: { id: "anthropic", authType: "api_key", personal: false } },
    ];
    render(<SettingsProviders />);
    await userEvent.click(
      await screen.findByRole("button", { name: "providers.disconnectNamed:Anthropic" }),
    );
    expect(fixture.disconnectProvider).toHaveBeenCalledWith("anthropic");
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalled());
  });
});
