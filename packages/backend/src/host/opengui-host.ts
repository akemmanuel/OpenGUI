import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createOpenGuiHarness,
  CodexResponsesTransport,
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

export type SessionAccessGate = {
  onCreated(sessionId: string, actor: DurableActor): Promise<void>;
  onDeleted(sessionId: string): Promise<void>;
  authorize(
    sessionId: string,
    actor: DurableActor | undefined,
    action: SessionAccessAction,
  ): Promise<void>;
  filterList(sessionIds: string[], actor: DurableActor | undefined): Promise<string[]>;
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
  readonly #listeners = new Set<(event: HostEvent) => void | Promise<void>>();
  readonly #activeRuns = new Map<string, Promise<void>>();
  readonly #fetch: typeof fetch;
  readonly #pathAuthorizer: HostPathAuthorizer;
  readonly #resolveExecutionPolicy: ExecutionPolicyResolver | undefined;
  readonly #sessionAccess: SessionAccessGate | undefined;

  constructor(
    dataDirectory: string,
    options: {
      fetchImpl?: typeof fetch;
      resolveExecutionPolicy?: ExecutionPolicyResolver;
      sessionAccess?: SessionAccessGate;
    } = {},
  ) {
    this.#dataDirectory = dataDirectory;
    this.#settingsPath = join(dataDirectory, SETTINGS_FILENAME);
    this.#secretsPath = join(dataDirectory, SECRETS_FILENAME);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#resolveExecutionPolicy = options.resolveExecutionPolicy;
    this.#pathAuthorizer = new HostPathAuthorizer(options.resolveExecutionPolicy);
    this.#sessionAccess = options.sessionAccess;
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
      resolveExecutionPolicy: this.#resolveExecutionPolicy,
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

  async #authorizedSession(
    sessionId: string,
    actor?: DurableActor,
    action: SessionAccessAction = "view",
  ) {
    try {
      if (this.#sessionAccess) {
        await this.#sessionAccess.authorize(sessionId, actor, action);
      }
      const session = await this.#requireHarness().openSession(sessionId);
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
      this.#settings.projects = [directory, ...this.#settings.projects];
      await this.#saveSettings();
    }
    return { directory, name: projectName(directory) };
  }

  async unregisterProject(directory: string, actor?: DurableActor) {
    directory = await this.#pathAuthorizer.authorizePath(actor, directory, "read");
    this.#settings.projects = this.#settings.projects.filter((item) => item !== directory);
    await this.#saveSettings();
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
      await this.#sessionAccess.onCreated(snapshot.id, actor);
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
    const restricted = await this.requiresScopedEvents(actor);
    if (restricted && !sessionId) throw new HostSessionNotFoundError();
    if (sessionId) await this.authorizeSession(sessionId, actor);
    const authorizedListener = async (event: HostEvent) => {
      if (sessionId && event.sessionId !== sessionId) return;
      if (restricted) {
        try {
          await this.authorizeSession(event.sessionId, actor);
        } catch {
          return;
        }
      }
      await listener(event);
    };
    this.#listeners.add(authorizedListener);
    return () => this.#listeners.delete(authorizedListener);
  }

  #emit(sessionId: string, event: SessionEvent) {
    for (const listener of this.#listeners) void listener({ sessionId, event });
  }

  async prompt(
    sessionId: string,
    prompt: PromptInput,
    actor: DurableActor | undefined = prompt.actor,
  ) {
    const { session, snapshot } = await this.#authorizedSession(sessionId, actor, "run");
    if (snapshot.status === "running" || this.#activeRuns.has(sessionId)) {
      const followUp = await session.followUp(prompt);
      return { mode: "follow_up" as const, followUp };
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
    await this.#activeRuns.get(sessionId);
  }
}

export async function createOpenGuiHost(
  dataDirectory: string,
  options: {
    resolveExecutionPolicy?: ExecutionPolicyResolver;
    sessionAccess?: SessionAccessGate;
  } = {},
) {
  const host = new OpenGuiHost(dataDirectory, options);
  await host.start();
  return host;
}
