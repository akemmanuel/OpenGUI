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
const CODEX_CONNECTION = {
  id: "chatgpt-codex",
  label: "ChatGPT (Codex)",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  modelIds: ["gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini"],
};
const XAI_CONNECTION = {
  id: "supergrok",
  label: "SuperGrok",
  baseUrl: "https://api.x.ai/v1",
  modelIds: ["grok-build-0.1", "grok-4.3"],
};
const OPENCODE_CONNECTION = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  modelIds: [
    "glm-5.2",
    "glm-5.1",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "mimo-v2.5",
    "mimo-v2.5-pro",
  ],
};
const XAI_OAUTH = {
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  deviceEndpoint: "https://auth.x.ai/oauth2/device/code",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
  scope: "openid profile email offline_access grok-cli:access api:access",
};
const OPENCODE_OAUTH = {
  clientId: "opencode-cli",
  deviceEndpoint: "https://console.opencode.ai/auth/device/code",
  tokenEndpoint: "https://console.opencode.ai/auth/device/token",
  json: true,
};

function projectName(directory: string) {
  const parts = directory.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || directory;
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
    endpoint: "https://api.x.ai/v1/responses",
    headers: { originator: "opengui", "user-agent": "OpenGUI/1.0" },
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
  #subscriptionTokens: Partial<Record<"xai" | "opencode", OAuthTokens>> = {};
  #subscriptionPending: Partial<Record<"xai" | "opencode", DeviceOAuthPending>> = {};
  readonly #listeners = new Set<(event: HostEvent) => void>();
  readonly #activeRuns = new Map<string, Promise<void>>();

  constructor(dataDirectory: string) {
    this.#dataDirectory = dataDirectory;
    this.#settingsPath = join(dataDirectory, SETTINGS_FILENAME);
    this.#secretsPath = join(dataDirectory, SECRETS_FILENAME);
  }

  async start() {
    await mkdir(this.#dataDirectory, { recursive: true });
    await this.#loadSettings();
    await this.#loadSecrets();
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
              : selected?.type === "user_message" &&
                  selected.model.connectionId === OPENCODE_CONNECTION.id
                ? this.#streamOpenCode(request, signal)
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
      if (parsed.codex && typeof parsed.codex === "object")
        this.#codexTokens = parsed.codex as CodexTokens;
      if (parsed.subscriptions && typeof parsed.subscriptions === "object")
        this.#subscriptionTokens = parsed.subscriptions as Partial<
          Record<"xai" | "opencode", OAuthTokens>
        >;
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
      [
        ...this.#settings.modelConnections.map((connection) => ({
          ...connection,
          apiKey: this.#apiKeys[connection.id],
        })),
        ...(this.#subscriptionTokens.opencode
          ? [{ ...OPENCODE_CONNECTION, apiKey: this.#subscriptionTokens.opencode.accessToken }]
          : []),
      ],
      this.#settings.defaultConnectionId,
    );
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
      ...(this.#subscriptionTokens.opencode ? [OPENCODE_CONNECTION] : []),
      ...this.#settings.modelConnections,
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
    if (!this.#deviceAuth) throw new Error("No ChatGPT sign-in is pending");
    if (Date.now() >= this.#deviceAuth.expiresAt) {
      this.#deviceAuth = null;
      throw new Error("The device code expired. Start sign-in again.");
    }
    const result = await pollCodexDeviceAuth(this.#deviceAuth);
    if (result) {
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
      try {
        this.#codexTokens = await refreshCodexTokens(this.#codexTokens);
        await this.#saveSecrets();
      } catch {
        this.#codexTokens = null;
        await this.#saveSecrets();
        throw new Error("ChatGPT sign-in expired or was revoked. Sign in again in Providers.");
      }
    }
    return { accessToken: this.#codexTokens.accessToken, accountId: this.#codexTokens.accountId };
  }

  subscriptionAuthStatus(provider: "xai" | "opencode") {
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
  async beginSubscriptionAuth(provider: "xai" | "opencode") {
    this.#subscriptionPending[provider] = await beginDeviceOAuth(
      provider === "xai" ? XAI_OAUTH : OPENCODE_OAUTH,
    );
    return this.subscriptionAuthStatus(provider);
  }
  async pollSubscriptionAuth(provider: "xai" | "opencode") {
    const pending = this.#subscriptionPending[provider];
    if (!pending) throw new Error("No sign-in is pending");
    if (pending.expiresAt <= Date.now()) {
      delete this.#subscriptionPending[provider];
      throw new Error("The device code expired. Start sign-in again.");
    }
    const result = await pollDeviceOAuth(provider === "xai" ? XAI_OAUTH : OPENCODE_OAUTH, pending);
    if (result) {
      this.#subscriptionTokens[provider] = result;
      delete this.#subscriptionPending[provider];
      this.#refreshTransport();
      await this.#saveSecrets();
    }
    return this.subscriptionAuthStatus(provider);
  }
  async disconnectSubscription(provider: "xai" | "opencode") {
    delete this.#subscriptionTokens[provider];
    delete this.#subscriptionPending[provider];
    this.#refreshTransport();
    await this.#saveSecrets();
  }
  async #subscriptionCredential(provider: "xai" | "opencode") {
    let current = this.#subscriptionTokens[provider];
    if (!current) throw new Error("Sign in to this provider in Settings before using it");
    if (current.expiresAt <= Date.now() + 60_000) {
      try {
        current = await refreshDeviceOAuth(
          provider === "xai" ? XAI_OAUTH : OPENCODE_OAUTH,
          current,
        );
        this.#subscriptionTokens[provider] = current;
        this.#refreshTransport();
        await this.#saveSecrets();
      } catch {
        delete this.#subscriptionTokens[provider];
        this.#refreshTransport();
        await this.#saveSecrets();
        throw new Error("Provider sign-in expired or was revoked. Sign in again in Settings.");
      }
    }
    return { accessToken: current.accessToken, accountId: "" };
  }
  async *#streamOpenCode(request: Parameters<ModelTransport["stream"]>[0], signal: AbortSignal) {
    await this.#subscriptionCredential("opencode");
    yield* this.#transport.stream(request, signal);
  }

  async upsertModelConnection(connection: HostModelConnection) {
    if (connection.apiKey) this.#apiKeys[connection.id] = connection.apiKey;
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
      const connection = this.#settings.modelConnections[0];
      if (!connection?.modelIds[0])
        throw new Error("Configure a model connection before creating a Session");
      input = {
        ...input,
        model: {
          connectionId: connection.id,
          modelId: connection.modelIds[0],
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
