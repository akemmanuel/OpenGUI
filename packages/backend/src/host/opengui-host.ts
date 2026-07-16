import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createOpenGuiHarness,
  CodexResponsesTransport,
  OpenAiChatTransport,
  type CreateSessionInput,
  type ModelSelection,
  type ModelTransport,
  type OpenAiCompatibleConnection,
  type OpenGuiHarness,
  type PromptInput,
  type ReasoningLevel,
  type SessionEvent,
  type SessionSnapshot,
  type SessionSummary,
} from "@opengui/harness";
import {
  CHATGPT_CODEX_PRESET,
  OPENCODE_GO_PRESET,
  SUPERGROK_PRESET,
  supportedOpenCodeGoModelIds,
  type ProviderConnectionPreset,
} from "@opengui/protocol";
import {
  beginCodexDeviceAuth,
  pollCodexDeviceAuth,
  refreshCodexTokens,
  revokeCodexToken,
  type CodexTokens,
  type DeviceAuthorization,
} from "./codex-oauth.ts";
import {
  beginDeviceOAuth,
  pollDeviceOAuth,
  refreshDeviceOAuth,
  type DeviceOAuthPending,
  type OAuthTokens,
} from "./device-oauth.ts";

export interface HostHealth {
  ok: true;
  version: string;
  shell: string;
}

export interface HostModelConnection extends OpenAiCompatibleConnection {}

export interface HostProject {
  directory: string;
  name: string;
}

export interface HostSessionSummary extends SessionSummary {}

export interface HostSessionSnapshot extends SessionSnapshot {}

export interface HostEvent {
  sessionId: string;
  event: SessionEvent;
}

interface HostSettingsFile {
  modelConnections: HostModelConnection[];
  defaultConnectionId: string | null;
  projects: string[];
}

const SETTINGS_FILENAME = "opengui-host-settings.json";
const SECRETS_FILENAME = "opengui-host-secrets.json";
function connectionFromPreset(preset: ProviderConnectionPreset): HostModelConnection {
  return {
    ...preset,
    modelIds: [...preset.modelIds],
    modelRoutes: preset.modelRoutes ? { ...preset.modelRoutes } : undefined,
    modelCapabilities: preset.modelCapabilities
      ? Object.fromEntries(
          Object.entries(preset.modelCapabilities).map(([modelId, capabilities]) => [
            modelId,
            {
              ...capabilities,
              reasoningEfforts: capabilities.reasoningEfforts
                ? [...capabilities.reasoningEfforts]
                : undefined,
            },
          ]),
        )
      : undefined,
  };
}

const CODEX_CONNECTION = connectionFromPreset(CHATGPT_CODEX_PRESET);
const XAI_CONNECTION = connectionFromPreset(SUPERGROK_PRESET);
const XAI_OAUTH = {
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  deviceEndpoint: "https://auth.x.ai/oauth2/device/code",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
  scope:
    "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
};
function projectName(directory: string) {
  const parts = directory.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || directory;
}

function validOAuthTokens(value: unknown): OAuthTokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const token = value as Record<string, unknown>;
  return typeof token.accessToken === "string" &&
    token.accessToken.length > 0 &&
    typeof token.refreshToken === "string" &&
    token.refreshToken.length > 0 &&
    typeof token.expiresAt === "number" &&
    Number.isFinite(token.expiresAt)
    ? {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
      }
    : null;
}

function validCodexTokens(value: unknown): CodexTokens | null {
  const token = validOAuthTokens(value);
  if (!token || !value || typeof value !== "object") return null;
  const accountId = (value as Record<string, unknown>).accountId;
  return typeof accountId === "string" && accountId.length > 0 ? { ...token, accountId } : null;
}

export class OpenGuiHost {
  readonly #dataDirectory: string;
  readonly #settingsPath: string;
  readonly #secretsPath: string;
  readonly #transport = new OpenAiChatTransport();
  readonly #codexTransport = new CodexResponsesTransport({
    getCredential: () => this.#codexCredential(),
  });
  readonly #xaiTransport = new CodexResponsesTransport({
    endpoint: "https://cli-chat-proxy.grok.com/v1/responses",
    headers: {
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-identifier": "opengui",
    },
    requestLabel: "SuperGrok",
    unauthorizedMessage:
      "SuperGrok sign-in expired or is not entitled to Grok Build. Sign in again in Providers.",
    getCredential: () => this.#subscriptionCredential("xai"),
  });
  #harness: OpenGuiHarness | null = null;
  #settings: HostSettingsFile = {
    modelConnections: [],
    defaultConnectionId: null,
    projects: [],
  };
  #apiKeys: Record<string, string> = {};
  #codexTokens: CodexTokens | null = null;
  #deviceAuth: DeviceAuthorization | null = null;
  #subscriptionTokens: Partial<Record<"xai", OAuthTokens>> = {};
  #subscriptionPending: Partial<Record<"xai", DeviceOAuthPending>> = {};
  #codexRefresh: Promise<CodexTokens> | null = null;
  #xaiRefresh: Promise<OAuthTokens> | null = null;
  readonly #listeners = new Set<(event: HostEvent) => void>();
  readonly #activeRuns = new Map<string, Promise<void>>();
  readonly #fetch: typeof fetch;

  constructor(dataDirectory: string, options: { fetchImpl?: typeof fetch } = {}) {
    this.#dataDirectory = dataDirectory;
    this.#settingsPath = join(dataDirectory, SETTINGS_FILENAME);
    this.#secretsPath = join(dataDirectory, SECRETS_FILENAME);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async start() {
    await mkdir(this.#dataDirectory, { recursive: true });
    await this.#loadSettings();
    await this.#loadSecrets();
    await this.#refreshOpenCodeGoCatalog();
    this.#refreshTransport();
    this.#harness = createOpenGuiHarness({
      dataDirectory: this.#dataDirectory,
      model: {
        stream: (request, signal) => {
          const selected = [...request.context]
            .reverse()
            .find((item) => item.type === "user_message");
          return selected?.type === "user_message" &&
            selected.model.connectionId === CODEX_CONNECTION.id
            ? this.#codexTransport.stream(request, signal)
            : selected?.type === "user_message" && selected.model.connectionId === XAI_CONNECTION.id
              ? this.#xaiTransport.stream(request, signal)
              : this.#transport.stream(request, signal);
        },
      } satisfies ModelTransport,
    });
  }

  async close() {
    await this.#harness?.close();
    this.#harness = null;
  }

  #requireHarness() {
    if (!this.#harness) throw new Error("OpenGUI Host is not started");
    return this.#harness;
  }

  async #loadSettings() {
    try {
      const raw = await readFile(this.#settingsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HostSettingsFile>;
      this.#settings = {
        modelConnections: Array.isArray(parsed.modelConnections) ? parsed.modelConnections : [],
        defaultConnectionId:
          typeof parsed.defaultConnectionId === "string" ? parsed.defaultConnectionId : null,
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.filter((item): item is string => typeof item === "string")
          : [],
      };
    } catch {
      this.#settings = { modelConnections: [], defaultConnectionId: null, projects: [] };
    }
  }

  async #saveSettings() {
    await writeFile(this.#settingsPath, `${JSON.stringify(this.#settings, null, 2)}\n`, "utf8");
  }

  async #loadSecrets() {
    try {
      const raw = await readFile(this.#secretsPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.#apiKeys = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            entry[0] !== "codex" && entry[0] !== "subscriptions" && typeof entry[1] === "string",
        ),
      );
      this.#codexTokens = validCodexTokens(parsed.codex);
      const subscriptions =
        parsed.subscriptions && typeof parsed.subscriptions === "object"
          ? (parsed.subscriptions as Record<string, unknown>)
          : {};
      const xai = validOAuthTokens(subscriptions.xai);
      this.#subscriptionTokens = xai ? { xai } : {};
    } catch {
      this.#apiKeys = {};
    }
  }

  async #saveSecrets() {
    await writeFile(
      this.#secretsPath,
      `${JSON.stringify({ ...this.#apiKeys, ...(this.#codexTokens ? { codex: this.#codexTokens } : {}), subscriptions: this.#subscriptionTokens }, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }

  #refreshTransport() {
    this.#transport.setConnections(
      this.#settings.modelConnections.map((connection) => ({
        ...connection,
        apiKey: this.#apiKeys[connection.id],
      })),
      this.#settings.defaultConnectionId,
    );
  }

  async #openCodeGoConnection(apiKey?: string): Promise<HostModelConnection> {
    let modelIds: readonly string[] = [...OPENCODE_GO_PRESET.modelIds];
    try {
      const response = await this.#fetch(`${OPENCODE_GO_PRESET.baseUrl}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      });
      if (!response.ok) throw new Error(`OpenCode Go model catalog returned ${response.status}`);
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const discovered = supportedOpenCodeGoModelIds(
        (body.data ?? []).flatMap((model) => (typeof model.id === "string" ? [model.id] : [])),
      );
      if (discovered.length > 0) modelIds = discovered;
    } catch {
      // The documented catalog is the safe fallback: every entry has a verified route.
    }
    const preset = connectionFromPreset(OPENCODE_GO_PRESET);
    preset.modelIds = [...modelIds];
    preset.modelRoutes = Object.fromEntries(
      Object.entries(preset.modelRoutes ?? {}).filter(([modelId]) => modelIds.includes(modelId)),
    );
    return preset;
  }

  async #refreshOpenCodeGoCatalog() {
    const index = this.#settings.modelConnections.findIndex(
      (connection) => connection.id === OPENCODE_GO_PRESET.id,
    );
    if (index < 0) return;
    const connection = await this.#openCodeGoConnection(this.#apiKeys[OPENCODE_GO_PRESET.id]);
    this.#settings.modelConnections[index] = connection;
    await this.#saveSettings();
  }

  health(): HostHealth {
    return {
      ok: true,
      version: process.env.npm_package_version || "0.0.0",
      shell: process.env.SHELL || (process.platform === "win32" ? "powershell" : "/bin/sh"),
    };
  }

  listModelConnections() {
    return [
      ...(this.#codexTokens ? [CODEX_CONNECTION] : []),
      ...(this.#subscriptionTokens.xai ? [XAI_CONNECTION] : []),
      ...this.#settings.modelConnections.map(({ apiKey: _apiKey, ...connection }) => connection),
    ];
  }

  codexAuthStatus() {
    return {
      connected: Boolean(this.#codexTokens),
      pending: this.#deviceAuth
        ? {
            userCode: this.#deviceAuth.userCode,
            verificationUri: this.#deviceAuth.verificationUri,
            expiresAt: this.#deviceAuth.expiresAt,
          }
        : null,
    };
  }
  async beginCodexAuth() {
    this.#deviceAuth = await beginCodexDeviceAuth();
    return this.codexAuthStatus();
  }
  async pollCodexAuth() {
    const pending = this.#deviceAuth;
    if (!pending) throw new Error("No ChatGPT sign-in is pending");
    if (Date.now() >= pending.expiresAt) {
      this.#deviceAuth = null;
      throw new Error("The device code expired. Start sign-in again.");
    }
    const result = await pollCodexDeviceAuth(pending);
    if (result && this.#deviceAuth === pending) {
      this.#codexTokens = result;
      this.#deviceAuth = null;
      await this.#saveSecrets();
    }
    return this.codexAuthStatus();
  }
  async disconnectCodex() {
    const tokens = this.#codexTokens;
    this.#codexTokens = null;
    this.#deviceAuth = null;
    await this.#saveSecrets();
    if (tokens) await revokeCodexToken(tokens.refreshToken);
  }
  async #codexCredential() {
    if (!this.#codexTokens) throw new Error("Sign in to ChatGPT in Providers before using Codex");
    if (this.#codexTokens.expiresAt <= Date.now() + 60_000) {
      const current = this.#codexTokens;
      try {
        this.#codexRefresh ??= refreshCodexTokens(current).finally(() => {
          this.#codexRefresh = null;
        });
        const refreshed = await this.#codexRefresh;
        if (this.#codexTokens !== current) throw new Error("ChatGPT sign-in changed");
        this.#codexTokens = refreshed;
        await this.#saveSecrets();
      } catch {
        if (this.#codexTokens === current) {
          this.#codexTokens = null;
          await this.#saveSecrets();
        }
        throw new Error("ChatGPT sign-in expired or was revoked. Sign in again in Providers.");
      }
    }
    return { accessToken: this.#codexTokens.accessToken, accountId: this.#codexTokens.accountId };
  }

  subscriptionAuthStatus(provider: "xai") {
    const pending = this.#subscriptionPending[provider];
    return {
      connected: Boolean(this.#subscriptionTokens[provider]),
      pending: pending
        ? {
            userCode: pending.userCode,
            verificationUri: pending.verificationUri,
            expiresAt: pending.expiresAt,
          }
        : null,
    };
  }
  async beginSubscriptionAuth(provider: "xai") {
    this.#subscriptionPending[provider] = await beginDeviceOAuth(XAI_OAUTH);
    return this.subscriptionAuthStatus(provider);
  }
  async pollSubscriptionAuth(provider: "xai") {
    const pending = this.#subscriptionPending[provider];
    if (!pending) throw new Error("No sign-in is pending");
    if (pending.expiresAt <= Date.now()) {
      delete this.#subscriptionPending[provider];
      throw new Error("The device code expired. Start sign-in again.");
    }
    const result = await pollDeviceOAuth(XAI_OAUTH, pending);
    if (result && this.#subscriptionPending[provider] === pending) {
      this.#subscriptionTokens[provider] = result;
      delete this.#subscriptionPending[provider];
      this.#refreshTransport();
      await this.#saveSecrets();
    }
    return this.subscriptionAuthStatus(provider);
  }
  async disconnectSubscription(provider: "xai") {
    delete this.#subscriptionTokens[provider];
    delete this.#subscriptionPending[provider];
    this.#refreshTransport();
    await this.#saveSecrets();
  }
  async #subscriptionCredential(provider: "xai") {
    let current = this.#subscriptionTokens[provider];
    if (!current) throw new Error("Sign in to this provider in Settings before using it");
    if (current.expiresAt <= Date.now() + 60_000) {
      try {
        const expected = current;
        this.#xaiRefresh ??= refreshDeviceOAuth(XAI_OAUTH, current).finally(() => {
          this.#xaiRefresh = null;
        });
        current = await this.#xaiRefresh;
        if (this.#subscriptionTokens[provider] !== expected)
          throw new Error("Provider sign-in changed");
        this.#subscriptionTokens[provider] = current;
        this.#refreshTransport();
        await this.#saveSecrets();
      } catch {
        if (this.#subscriptionTokens[provider] === current) {
          delete this.#subscriptionTokens[provider];
          this.#refreshTransport();
          await this.#saveSecrets();
        }
        throw new Error("Provider sign-in expired or was revoked. Sign in again in Settings.");
      }
    }
    return { accessToken: current.accessToken, accountId: "" };
  }

  async upsertModelConnection(connection: HostModelConnection) {
    if (connection.apiKey) this.#apiKeys[connection.id] = connection.apiKey;
    if (connection.id === OPENCODE_GO_PRESET.id) {
      connection = await this.#openCodeGoConnection(
        connection.apiKey ?? this.#apiKeys[OPENCODE_GO_PRESET.id],
      );
    }
    const publicConnection = { ...connection, apiKey: undefined };
    const next = this.#settings.modelConnections.filter((item) => item.id !== connection.id);
    next.push(publicConnection);
    this.#settings.modelConnections = next;
    if (!this.#settings.defaultConnectionId) this.#settings.defaultConnectionId = connection.id;
    this.#refreshTransport();
    await this.#saveSettings();
    await this.#saveSecrets();
    return publicConnection;
  }

  async removeModelConnection(connectionId: string) {
    this.#settings.modelConnections = this.#settings.modelConnections.filter(
      (item) => item.id !== connectionId,
    );
    if (this.#settings.defaultConnectionId === connectionId) {
      this.#settings.defaultConnectionId = this.#settings.modelConnections[0]?.id ?? null;
    }
    delete this.#apiKeys[connectionId];
    this.#refreshTransport();
    await this.#saveSettings();
    await this.#saveSecrets();
  }

  listProjects(): HostProject[] {
    return this.#settings.projects.map((directory) => ({
      directory,
      name: projectName(directory),
    }));
  }

  async registerProject(directory: string) {
    if (!this.#settings.projects.includes(directory)) {
      this.#settings.projects = [directory, ...this.#settings.projects];
      await this.#saveSettings();
    }
    return { directory, name: projectName(directory) };
  }

  async unregisterProject(directory: string) {
    this.#settings.projects = this.#settings.projects.filter((item) => item !== directory);
    await this.#saveSettings();
  }

  async listSessions(projectDirectory: string): Promise<HostSessionSummary[]> {
    return this.#requireHarness().listSessions(projectDirectory);
  }

  async createSession(input: CreateSessionInput): Promise<HostSessionSnapshot> {
    if (!input.model.connectionId || !input.model.modelId) {
      const connection = this.listModelConnections()[0];
      const defaultModelId = connection?.defaultModelId ?? connection?.modelIds[0];
      if (!connection || !defaultModelId)
        throw new Error("Configure a model connection before creating a Session");
      input = {
        ...input,
        model: {
          connectionId: connection.id,
          modelId: defaultModelId,
        },
      };
    }
    await this.registerProject(input.projectDirectory);
    const session = await this.#requireHarness().createSession(input);
    return session.read();
  }

  async readSession(sessionId: string): Promise<HostSessionSnapshot> {
    return (await this.#requireHarness().openSession(sessionId)).read();
  }

  async renameSession(sessionId: string, title: string) {
    const session = await this.#requireHarness().openSession(sessionId);
    await session.rename(title);
    return session.read();
  }

  async deleteSession(sessionId: string) {
    const session = await this.#requireHarness().openSession(sessionId);
    await session.delete();
  }

  async setModel(sessionId: string, selection: ModelSelection) {
    const session = await this.#requireHarness().openSession(sessionId);
    await session.setModel(selection);
    return session.read();
  }

  async setReasoning(sessionId: string, reasoning: ReasoningLevel) {
    const session = await this.#requireHarness().openSession(sessionId);
    await session.setReasoning(reasoning);
    return session.read();
  }

  subscribe(listener: (event: HostEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(sessionId: string, event: SessionEvent) {
    for (const listener of this.#listeners) listener({ sessionId, event });
  }

  async prompt(sessionId: string, prompt: PromptInput) {
    const session = await this.#requireHarness().openSession(sessionId);
    const snapshot = await session.read();
    if (snapshot.status === "running" || this.#activeRuns.has(sessionId)) {
      await session.followUp(prompt);
      return { mode: "follow_up" as const };
    }
    const run = (async () => {
      try {
        for await (const event of session.run(prompt)) {
          this.#emit(sessionId, event);
        }
      } catch (error) {
        console.error("OpenGUI Run failed", error);
      }
    })();
    this.#activeRuns.set(sessionId, run);
    void run.finally(() => {
      if (this.#activeRuns.get(sessionId) === run) this.#activeRuns.delete(sessionId);
    });
    return { mode: "run" as const };
  }

  async abort(sessionId: string) {
    const session = await this.#requireHarness().openSession(sessionId);
    await session.abort();
  }

  async waitForIdle(sessionId: string) {
    await this.#activeRuns.get(sessionId);
  }
}

export async function createOpenGuiHost(dataDirectory: string) {
  const host = new OpenGuiHost(dataDirectory);
  await host.start();
  return host;
}
