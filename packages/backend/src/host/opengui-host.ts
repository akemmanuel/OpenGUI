import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createOpenGuiHarness,
  CodexResponsesTransport,
  discoverSkills,
  loadSkillsFromDir,
  OpenAiChatTransport,
  type CreateSessionInput,
  type DurableActor,
  type ExecutionPolicyResolver,
  type ModelSelection,
  type ModelTransport,
  type OpenAiCompatibleConnection,
  type OpenGuiHarness,
  type PromptInput,
  type ReasoningLevel,
  type SessionEvent,
  type SessionEntry,
  type SessionSnapshot,
  type SessionSummary,
  type Skill,
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
import { HostPathAuthorizer } from "../path-policy/enforcement.ts";
import type { SessionAccessAction } from "../identity/identity.ts";
import {
  openDurableJsonTransaction,
  type DurableJsonTransaction,
} from "./durable-json-transaction.ts";

export type SessionAccessGate = {
  onCreated(sessionId: string, actor: DurableActor): Promise<void>;
  onDeleted(sessionId: string): Promise<void>;
  authorize(
    sessionId: string,
    actor: DurableActor | undefined,
    action: SessionAccessAction,
  ): Promise<void>;
  filterList(sessionIds: string[], actor: DurableActor | undefined): Promise<string[]>;
  reconcile?(sessionIds: string[]): Promise<string[]>;
};

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

/** UI-safe skill metadata advertised for an empty-session agent overview. */
export interface HostSkill {
  name: string;
  description: string;
  source: "host" | "project";
  /** True when the skill is user-invoked only (not auto-advertised to the model). */
  manual: boolean;
}

export interface HostSessionSummary extends SessionSummary {}

export interface HostSessionSnapshot extends SessionSnapshot {}

export interface HostEvent {
  sessionId: string;
  event: SessionEvent;
}

export class HostSessionNotFoundError extends Error {
  constructor() {
    super("Session not found");
  }
}

interface HostSettingsFile {
  modelConnections: HostModelConnection[];
  defaultConnectionId: string | null;
  projects: string[];
}

type HostSecretsFile = {
  apiKeys: Record<string, string>;
  codexTokens: CodexTokens | null;
  subscriptionTokens: Partial<Record<"xai", OAuthTokens>>;
};

type HostDurableState = {
  version: 1;
  settings: HostSettingsFile;
  secrets: HostSecretsFile;
};

const SETTINGS_FILENAME = "opengui-host-settings.json";
const SECRETS_FILENAME = "opengui-host-secrets.json";
export const HOST_STATE_FILENAME = "opengui-host-state.json";
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
  readonly #statePath: string;
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
  #stateStore: DurableJsonTransaction<HostDurableState> | null = null;
  readonly #listeners = new Set<(event: HostEvent) => void | Promise<void>>();
  readonly #activeRuns = new Map<string, Promise<void>>();
  readonly #promptAdmissions = new Map<string, Promise<void>>();
  readonly #fetch: typeof fetch;
  readonly #model: ModelTransport | undefined;
  readonly #pathAuthorizer: HostPathAuthorizer;
  readonly #resolveExecutionPolicy: ExecutionPolicyResolver | undefined;
  readonly #sessionAccess: SessionAccessGate | undefined;
  #starting: Promise<void> | null = null;
  #closing: Promise<void> | null = null;

  constructor(
    dataDirectory: string,
    options: {
      fetchImpl?: typeof fetch;
      model?: ModelTransport;
      resolveExecutionPolicy?: ExecutionPolicyResolver;
      sessionAccess?: SessionAccessGate;
    } = {},
  ) {
    this.#dataDirectory = dataDirectory;
    this.#settingsPath = join(dataDirectory, SETTINGS_FILENAME);
    this.#secretsPath = join(dataDirectory, SECRETS_FILENAME);
    this.#statePath = join(dataDirectory, HOST_STATE_FILENAME);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#model = options.model;
    this.#resolveExecutionPolicy = options.resolveExecutionPolicy;
    this.#pathAuthorizer = new HostPathAuthorizer(options.resolveExecutionPolicy);
    this.#sessionAccess = options.sessionAccess;
  }

  async start() {
    if (this.#closing) await this.#closing;
    if (this.#harness || this.#starting) throw new Error("OpenGUI Host is already started");
    const starting = this.#start();
    this.#starting = starting;
    try {
      await starting;
    } catch (error) {
      await this.#stateStore?.close().catch(() => undefined);
      this.#stateStore = null;
      throw error;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }

  async #start() {
    await mkdir(this.#dataDirectory, { recursive: true });
    const fallback = await this.#loadLegacyState();
    this.#stateStore = await openDurableJsonTransaction(this.#statePath, {
      fallback,
      validate: (value) => this.#validateState(value),
      mode: 0o600,
    });
    this.#applyState(this.#stateStore.current());
    await this.#refreshOpenCodeGoCatalog();
    this.#refreshTransport();
    const harness = createOpenGuiHarness({
      dataDirectory: this.#dataDirectory,
      model:
        this.#model ??
        ({
          stream: (request, signal) => {
            const selected = [...request.context]
              .reverse()
              .find((item) => item.type === "user_message");
            return selected?.type === "user_message" &&
              selected.model.connectionId === CODEX_CONNECTION.id
              ? this.#codexTransport.stream(request, signal)
              : selected?.type === "user_message" &&
                  selected.model.connectionId === XAI_CONNECTION.id
                ? this.#xaiTransport.stream(request, signal)
                : this.#transport.stream(request, signal);
          },
        } satisfies ModelTransport),
      resolveExecutionPolicy: this.#resolveExecutionPolicy,
    });
    // Do not report the Host as started while the Harness store is still
    // migrating/recovering; close() must be safe immediately after start().
    try {
      await harness.listSessions(this.#dataDirectory);
      if (this.#sessionAccess?.reconcile) {
        const sessions = await harness.listAllSessions();
        // Reconcile authorization metadata, but never turn a missing ACL row
        // into transcript deletion. The Session remains hidden until ownership
        // can be repaired or an explicit retention policy removes it.
        await this.#sessionAccess.reconcile(sessions.map((session) => session.id));
      }
    } catch (error) {
      await harness.close().catch(() => undefined);
      await this.#stateStore?.close().catch(() => undefined);
      this.#stateStore = null;
      throw error;
    }
    this.#harness = harness;
  }

  async close() {
    if (this.#closing) return await this.#closing;
    if (this.#starting) {
      try {
        await this.#starting;
      } catch {
        return;
      }
    }
    const harness = this.#harness;
    if (!harness) return;
    this.#harness = null;
    this.#closing = (async () => {
      const activeSessionIds = [...this.#activeRuns.keys()];
      const activeRuns = [...this.#activeRuns.values()];
      await Promise.all(
        activeSessionIds.map(async (sessionId) => {
          try {
            await (await harness.openSession(sessionId)).abort();
          } catch {
            // Continue draining any other active Sessions before shutdown.
          }
        }),
      );
      await Promise.allSettled(activeRuns);
      await harness.close();
      await this.#stateStore?.close();
      this.#stateStore = null;
      this.#activeRuns.clear();
      this.#promptAdmissions.clear();
      this.#listeners.clear();
    })();
    try {
      await this.#closing;
    } finally {
      this.#closing = null;
    }
  }

  #requireHarness() {
    if (!this.#harness) throw new Error("OpenGUI Host is not started");
    return this.#harness;
  }

  async #authorizedSession(
    sessionId: string,
    actor?: DurableActor,
    action: SessionAccessAction = "view",
  ) {
    try {
      // Bind the operation to the lifecycle instance that admitted it. An ACL
      // check may outlive close(); it must not resume on a subsequently
      // started Harness that happens to use the same data directory.
      const harness = this.#requireHarness();
      if (this.#sessionAccess) {
        await this.#sessionAccess.authorize(sessionId, actor, action);
      }
      const session = await harness.openSession(sessionId);
      const snapshot = await session.read();
      await this.#pathAuthorizer.authorizePath(actor, snapshot.projectDirectory, "read");
      return { session, snapshot };
    } catch {
      // Deliberately collapse existence and authorization into one observable result.
      throw new HostSessionNotFoundError();
    }
  }

  async authorizeSession(sessionId: string, actor?: DurableActor) {
    return (await this.#authorizedSession(sessionId, actor, "view")).snapshot;
  }

  async requiresScopedEvents(actor?: DurableActor) {
    return await this.#pathAuthorizer.isRestricted(actor);
  }

  async #loadLegacySettings(): Promise<HostSettingsFile> {
    try {
      const raw = await readFile(this.#settingsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HostSettingsFile>;
      return {
        modelConnections: Array.isArray(parsed.modelConnections) ? parsed.modelConnections : [],
        defaultConnectionId:
          typeof parsed.defaultConnectionId === "string" ? parsed.defaultConnectionId : null,
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.filter((item): item is string => typeof item === "string")
          : [],
      };
    } catch {
      return { modelConnections: [], defaultConnectionId: null, projects: [] };
    }
  }

  async #loadLegacySecrets(): Promise<HostSecretsFile> {
    try {
      const raw = await readFile(this.#secretsPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const apiKeys = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            entry[0] !== "codex" && entry[0] !== "subscriptions" && typeof entry[1] === "string",
        ),
      );
      const codexTokens = validCodexTokens(parsed.codex);
      const subscriptions =
        parsed.subscriptions && typeof parsed.subscriptions === "object"
          ? (parsed.subscriptions as Record<string, unknown>)
          : {};
      const xai = validOAuthTokens(subscriptions.xai);
      return { apiKeys, codexTokens, subscriptionTokens: xai ? { xai } : {} };
    } catch {
      return { apiKeys: {}, codexTokens: null, subscriptionTokens: {} };
    }
  }

  async #loadLegacyState(): Promise<HostDurableState> {
    return {
      version: 1,
      settings: await this.#loadLegacySettings(),
      secrets: await this.#loadLegacySecrets(),
    };
  }

  #validateState(value: unknown): HostDurableState {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid state");
    const state = value as Partial<HostDurableState>;
    if (state.version !== 1 || !state.settings || !state.secrets) throw new Error("Invalid state");
    const subscriptions = state.secrets.subscriptionTokens ?? {};
    return {
      version: 1,
      settings: {
        modelConnections: Array.isArray(state.settings.modelConnections)
          ? state.settings.modelConnections
          : [],
        defaultConnectionId:
          typeof state.settings.defaultConnectionId === "string"
            ? state.settings.defaultConnectionId
            : null,
        projects: Array.isArray(state.settings.projects)
          ? state.settings.projects.filter((item): item is string => typeof item === "string")
          : [],
      },
      secrets: {
        apiKeys:
          state.secrets.apiKeys && typeof state.secrets.apiKeys === "object"
            ? Object.fromEntries(
                Object.entries(state.secrets.apiKeys).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
            : {},
        codexTokens: validCodexTokens(state.secrets.codexTokens),
        subscriptionTokens: validOAuthTokens(subscriptions.xai)
          ? { xai: validOAuthTokens(subscriptions.xai)! }
          : {},
      },
    };
  }

  #applyState(state: HostDurableState) {
    this.#settings = structuredClone(state.settings);
    this.#apiKeys = { ...state.secrets.apiKeys };
    this.#codexTokens = state.secrets.codexTokens ? { ...state.secrets.codexTokens } : null;
    this.#subscriptionTokens = structuredClone(state.secrets.subscriptionTokens);
    this.#refreshTransport();
  }

  async #updateState(
    update: (state: HostDurableState) => HostDurableState | Promise<HostDurableState>,
  ) {
    const store = this.#stateStore;
    if (!store) throw new Error("OpenGUI Host is not started");
    try {
      return await store.update(update);
    } finally {
      this.#applyState(store.current());
    }
  }

  async #saveSettings() {
    const settings = structuredClone(this.#settings);
    await this.#updateState((state) => ({ ...state, settings }));
  }

  async #saveSecrets() {
    const secrets: HostSecretsFile = {
      apiKeys: { ...this.#apiKeys },
      codexTokens: this.#codexTokens ? { ...this.#codexTokens } : null,
      subscriptionTokens: structuredClone(this.#subscriptionTokens),
    };
    await this.#updateState((state) => ({ ...state, secrets }));
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
    let publicConnection: HostModelConnection | undefined;
    await this.#updateState(async (state) => {
      const apiKeys = { ...state.secrets.apiKeys };
      if (connection.apiKey) apiKeys[connection.id] = connection.apiKey;
      if (connection.id === OPENCODE_GO_PRESET.id) {
        connection = await this.#openCodeGoConnection(
          connection.apiKey ?? apiKeys[OPENCODE_GO_PRESET.id],
        );
      }
      publicConnection = { ...connection, apiKey: undefined };
      const next = state.settings.modelConnections.filter((item) => item.id !== connection.id);
      next.push(publicConnection);
      return {
        ...state,
        settings: {
          ...state.settings,
          modelConnections: next,
          defaultConnectionId: state.settings.defaultConnectionId ?? connection.id,
        },
        secrets: { ...state.secrets, apiKeys },
      };
    });
    return publicConnection!;
  }

  async removeModelConnection(connectionId: string) {
    await this.#updateState((state) => {
      const modelConnections = state.settings.modelConnections.filter(
        (item) => item.id !== connectionId,
      );
      const apiKeys = { ...state.secrets.apiKeys };
      delete apiKeys[connectionId];
      return {
        ...state,
        settings: {
          ...state.settings,
          modelConnections,
          defaultConnectionId:
            state.settings.defaultConnectionId === connectionId
              ? (modelConnections[0]?.id ?? null)
              : state.settings.defaultConnectionId,
        },
        secrets: { ...state.secrets, apiKeys },
      };
    });
  }

  async listProjects(actor?: DurableActor): Promise<HostProject[]> {
    const projects: HostProject[] = [];
    for (const directory of this.#settings.projects) {
      try {
        await this.#pathAuthorizer.authorizePath(actor, directory, "read");
        projects.push({ directory, name: projectName(directory) });
      } catch {
        // Project enumeration is filtered rather than exposing denied paths.
      }
    }
    return projects;
  }

  async registerProject(directory: string, actor?: DurableActor) {
    directory = await this.#pathAuthorizer.authorizePath(actor, directory, "read");
    if (!this.#settings.projects.includes(directory)) {
      await this.#updateState((state) =>
        state.settings.projects.includes(directory)
          ? state
          : {
              ...state,
              settings: {
                ...state.settings,
                projects: [directory, ...state.settings.projects],
              },
            },
      );
    }
    return { directory, name: projectName(directory) };
  }

  async unregisterProject(directory: string, actor?: DurableActor) {
    directory = await this.#pathAuthorizer.authorizePath(actor, directory, "read");
    await this.#updateState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        projects: state.settings.projects.filter((item) => item !== directory),
      },
    }));
  }

  async listSkills(projectDirectory: string, actor?: DurableActor): Promise<HostSkill[]> {
    const directory = await this.#pathAuthorizer.authorizePath(actor, projectDirectory, "read");
    const restricted = await this.#pathAuthorizer.isRestricted(actor);
    let skills: Skill[];
    if (restricted) {
      const requestedRoot = join(directory, ".agents", "skills");
      const policy = await this.#pathAuthorizer.policy(actor);
      const decision = policy ? await policy.authorizePath(requestedRoot, "read") : null;
      skills =
        decision?.allowed && decision.canonicalPath
          ? loadSkillsFromDir(decision.canonicalPath, "project").skills
          : [];
    } else {
      skills = discoverSkills({ projectDirectory: directory }).skills;
    }
    return skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        manual: skill.disableModelInvocation,
      }))
      .sort((left, right) => {
        if (left.manual !== right.manual) return left.manual ? -1 : 1;
        if (left.source !== right.source) return left.source === "project" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }

  async listSessions(
    projectDirectory: string,
    actor?: DurableActor,
  ): Promise<HostSessionSummary[]> {
    const canonical = await this.#pathAuthorizer.authorizePath(actor, projectDirectory, "read");
    const sessions = await this.#requireHarness().listSessions(canonical);
    if (!this.#sessionAccess || !actor) return sessions;
    const visibleIds = new Set(
      await this.#sessionAccess.filterList(
        sessions.map((session) => session.id),
        actor,
      ),
    );
    return sessions.filter((session) => visibleIds.has(session.id));
  }

  async searchSessionMessages(
    projectDirectories: readonly string[],
    query: string,
    actor?: DurableActor,
  ): Promise<string[]> {
    const canonicalDirectories = await Promise.all(
      Array.from(new Set(projectDirectories)).map((directory) =>
        this.#pathAuthorizer.authorizePath(actor, directory, "read"),
      ),
    );
    const sessionIds = await this.#requireHarness().searchSessionMessages(
      canonicalDirectories,
      query,
    );
    if (!this.#sessionAccess || !actor) return sessionIds;
    return this.#sessionAccess.filterList(sessionIds, actor);
  }

  async createSession(
    input: CreateSessionInput,
    actor?: DurableActor,
  ): Promise<HostSessionSnapshot> {
    input = {
      ...input,
      projectDirectory: await this.#pathAuthorizer.authorizePath(
        actor,
        input.projectDirectory,
        "read",
      ),
    };
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
    await this.registerProject(input.projectDirectory, actor);
    const session = await this.#requireHarness().createSession(input);
    const snapshot = await session.read();
    if (actor && this.#sessionAccess) {
      try {
        await this.#sessionAccess.onCreated(snapshot.id, actor);
      } catch (error) {
        await session.delete().catch(() => undefined);
        throw error;
      }
    }
    return snapshot;
  }

  async readSession(sessionId: string, actor?: DurableActor): Promise<HostSessionSnapshot> {
    return (await this.#authorizedSession(sessionId, actor, "view")).snapshot;
  }

  /** Internal read after a view-link token has already been validated. */
  async readSessionForViewLink(sessionId: string): Promise<HostSessionSnapshot> {
    try {
      return await (await this.#requireHarness().openSession(sessionId)).read();
    } catch {
      throw new HostSessionNotFoundError();
    }
  }

  async renameSession(sessionId: string, title: string, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "admin");
    await session.rename(title);
    return session.read();
  }

  async deleteSession(sessionId: string, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "delete");
    await session.delete();
    await this.#sessionAccess?.onDeleted(sessionId);
  }

  async setModel(sessionId: string, selection: ModelSelection, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    await session.setModel(selection);
    return session.read();
  }

  async setReasoning(sessionId: string, reasoning: ReasoningLevel, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    await session.setReasoning(reasoning);
    return session.read();
  }

  async subscribe(
    actor: DurableActor | undefined,
    sessionId: string | undefined,
    listener: (event: HostEvent) => void | Promise<void>,
  ) {
    const harness = this.#requireHarness();
    const restricted = await this.requiresScopedEvents(actor);
    if (restricted && !sessionId) throw new HostSessionNotFoundError();
    if (sessionId) await this.authorizeSession(sessionId, actor);
    if (this.#harness !== harness) throw new Error("OpenGUI Host is not started");
    let subscribed = true;
    let pending = Promise.resolve();
    const authorizedListener = (event: HostEvent) => {
      pending = pending
        .then(async () => {
          if (!subscribed || (sessionId && event.sessionId !== sessionId)) return;
          if (restricted || this.#sessionAccess) {
            try {
              await this.authorizeSession(event.sessionId, actor);
            } catch {
              return;
            }
          }
          if (subscribed) await listener(event);
        })
        .catch(() => {
          // A disconnected transport must not poison later Host emissions.
        });
      return pending;
    };
    this.#listeners.add(authorizedListener);
    return () => {
      subscribed = false;
      this.#listeners.delete(authorizedListener);
    };
  }

  #emit(sessionId: string, event: SessionEvent) {
    for (const listener of this.#listeners) void listener({ sessionId, event });
  }

  async compact(sessionId: string, actor?: DurableActor) {
    const previousAdmission = this.#promptAdmissions.get(sessionId) ?? Promise.resolve();
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const queuedAdmission = previousAdmission.then(() => admission);
    this.#promptAdmissions.set(sessionId, queuedAdmission);
    await previousAdmission;
    try {
      const { session, snapshot } = await this.#authorizedSession(sessionId, actor, "run");
      if (snapshot.status === "running") throw new Error("Cannot compact a running Session");
      const iterator = session.compact(actor)[Symbol.asyncIterator]();
      const startedEntries: SessionEntry[] = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error("Compaction ended before it started");
        this.#emit(sessionId, next.value);
        if (next.value.type === "entry_appended") startedEntries.push(next.value.entry);
        if (next.value.type === "entry_appended" && next.value.entry.kind === "run_started") break;
      }
      const run = (async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            this.#emit(sessionId, next.value);
          }
        } catch (error) {
          console.error("OpenGUI Compaction failed", error);
        }
      })();
      this.#activeRuns.set(sessionId, run);
      void run.finally(() => {
        if (this.#activeRuns.get(sessionId) === run) this.#activeRuns.delete(sessionId);
      });
      return { startedEntries };
    } finally {
      releaseAdmission();
      if (this.#promptAdmissions.get(sessionId) === queuedAdmission) {
        this.#promptAdmissions.delete(sessionId);
      }
    }
  }

  async prompt(
    sessionId: string,
    prompt: PromptInput,
    actor: DurableActor | undefined = prompt.actor,
  ) {
    const previousAdmission = this.#promptAdmissions.get(sessionId) ?? Promise.resolve();
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const queuedAdmission = previousAdmission.then(() => admission);
    this.#promptAdmissions.set(sessionId, queuedAdmission);
    await previousAdmission;
    try {
      const { session, snapshot } = await this.#authorizedSession(sessionId, actor, "run");
      if (snapshot.status === "running") {
        try {
          const followUp = await session.followUp(prompt);
          return { mode: "follow_up" as const, followUp };
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Follow-ups can only be queued while a Session is running"
          ) {
            throw error;
          }
          // A very short Run may finish between the status read and queue write.
          // Admission remains serialized, so it is safe to accept this as the next Run.
        }
      }
      const iterator = session.run(prompt)[Symbol.asyncIterator]();
      const startedEntries: SessionEntry[] = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error("Run ended before it started");
        this.#emit(sessionId, next.value);
        if (next.value.type === "entry_appended") startedEntries.push(next.value.entry);
        if (next.value.type === "entry_appended" && next.value.entry.kind === "run_started") break;
      }
      const run = (async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            this.#emit(sessionId, next.value);
          }
        } catch (error) {
          console.error("OpenGUI Run failed", error);
        }
      })();
      this.#activeRuns.set(sessionId, run);
      void run.finally(() => {
        if (this.#activeRuns.get(sessionId) === run) this.#activeRuns.delete(sessionId);
      });
      return { mode: "run" as const, startedEntries };
    } finally {
      releaseAdmission();
      if (this.#promptAdmissions.get(sessionId) === queuedAdmission) {
        this.#promptAdmissions.delete(sessionId);
      }
    }
  }

  async updateFollowUp(
    sessionId: string,
    followUpId: string,
    prompt: PromptInput,
    actor: DurableActor | undefined = prompt.actor,
  ) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    await session.updateFollowUp(followUpId, prompt);
    return (await session.read()).followUps;
  }

  async reorderFollowUp(
    sessionId: string,
    followUpId: string,
    index: number,
    actor?: DurableActor,
  ) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    await session.reorderFollowUp(followUpId, index);
    return (await session.read()).followUps;
  }

  async removeFollowUp(sessionId: string, followUpId: string, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    await session.removeFollowUp(followUpId);
    return (await session.read()).followUps;
  }

  async sendFollowUpNow(sessionId: string, followUpId: string, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    const followUps = (await session.read()).followUps;
    const selected = followUps.find((item) => item.id === followUpId);
    if (!selected) throw new Error(`Pending follow-up not found: ${followUpId}`);
    await session.reorderFollowUp(followUpId, 0);
    if (this.#activeRuns.has(sessionId)) {
      await session.abort();
      await this.#activeRuns.get(sessionId);
    }
    await session.removeFollowUp(followUpId);
    // The caller is authorized to operate the Session above, but execution
    // belongs to the actor stored with the accepted prompt. Reauthorize that
    // actor now rather than transferring the caller's grants.
    await this.prompt(sessionId, selected.prompt, selected.prompt.actor);
    return (await session.read()).followUps;
  }

  async abort(sessionId: string, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    await session.abort();
  }

  async waitForIdle(sessionId: string, actor?: DurableActor) {
    await this.#authorizedSession(sessionId, actor, "view");
    await this.#promptAdmissions.get(sessionId);
    await this.#activeRuns.get(sessionId);
  }
}

export async function createOpenGuiHost(
  dataDirectory: string,
  options: {
    resolveExecutionPolicy?: ExecutionPolicyResolver;
    sessionAccess?: SessionAccessGate;
    model?: ModelTransport;
  } = {},
) {
  const host = new OpenGuiHost(dataDirectory, options);
  await host.start();
  return host;
}
