import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createOpenGuiHarness,
  CodexResponsesTransport,
  discoverSkills,
  loadSkillsFromDir,
  OpenAiChatTransport,
  PiAiTransport,
  type CreateSessionInput,
  type DurableActor,
  type ExecutionPolicyResolver,
  type ModelSelection,
  type ModelRequest,
  ModelTransportError,
  type ModelTransport,
  deriveModelCacheKey,
  normalizeModelError,
  withoutModelContextImages,
  type ModelProtocol,
  type ProviderResponseMetadata,
  type OpenAiCompatibleConnection,
  type OpenGuiHarness,
  type PromptInput,
  type ReasoningLevel,
  type SessionEvent,
  type SessionEntry,
  type SessionSnapshot,
  type SessionSummary,
  type ShellToolExecutor,
  type Skill,
} from "@opengui/harness";
import {
  CHATGPT_CODEX_PRESET,
  type FlatModelCatalog,
  OPENCODE_GO_PRESET,
  selectCatalogModel,
  SUPERGROK_PRESET,
  XAI_API_PRESET,
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
import {
  SkillsManager,
  type SkillInstallation,
  type SkillScope,
  type SkillSourceDescriptor,
  type SkillSourceResolver,
} from "./skills-management.ts";
import { loadModelsDevCatalog, resolveConnectionReasoningEfforts } from "./model-capabilities.ts";
import {
  createMcpAgentToolSource,
  createMcpBroker,
  type McpBroker,
  type McpConnection,
} from "../mcp/mcp-broker.ts";

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

export interface HostMcpConnectionStatus {
  state: "disabled" | "refreshing" | "ready" | "degraded" | "offline";
  toolCount: number;
  lastCheckedAt?: string;
  problem?: {
    code: string;
    stage: string;
    message: string;
    retryable: boolean;
  };
}

export type HostMcpConnection = (
  | {
      id: string;
      label: string;
      enabled: boolean;
      transport: {
        kind: "stdio";
        command: string;
        args: string[];
        cwd?: string;
        envKeys: string[];
      };
    }
  | {
      id: string;
      label: string;
      enabled: boolean;
      transport: { kind: "http"; url: string; bearerTokenConfigured: boolean };
    }
) & { status?: HostMcpConnectionStatus };

export type HostMcpConnectionInput =
  | {
      id: string;
      label: string;
      enabled: boolean;
      transport: {
        kind: "stdio";
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      };
    }
  | {
      id: string;
      label: string;
      enabled: boolean;
      transport: { kind: "http"; url: string; bearerToken?: string };
    };

export const MODEL_OFFERING_CONNECTION_ID = "opengui-offering";

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

export type HostInstalledSkill = HostSkill & { location: string };

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
  hostId: string;
  modelConnections: HostModelConnection[];
  defaultConnectionId: string | null;
  projects: string[];
  mcpConnections: HostMcpConnection[];
}

type HostSecretsFile = {
  apiKeys: Record<string, string>;
  codexTokens: CodexTokens | null;
  subscriptionTokens: Partial<Record<"xai", OAuthTokens>>;
  mcp: Record<string, { env?: Record<string, string>; bearerToken?: string }>;
};

type HostDurableState = {
  version: 1;
  settings: HostSettingsFile;
  secrets: HostSecretsFile;
};

const SETTINGS_FILENAME = "opengui-host-settings.json";
const SECRETS_FILENAME = "opengui-host-secrets.json";
export const HOST_STATE_FILENAME = "opengui-host-state.json";
export const CODEX_DIAGNOSTICS_FILENAME = "opengui-codex-transport.jsonl";
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
const XAI_API_CONNECTION = connectionFromPreset(XAI_API_PRESET);
const OPENCODE_ZEN_CONNECTION_ID = "opencode-zen";
const BUILT_IN_CONNECTION_IDS = new Set<string>([
  CHATGPT_CODEX_PRESET.id,
  SUPERGROK_PRESET.id,
  XAI_API_PRESET.id,
  OPENCODE_GO_PRESET.id,
]);
const TEXT_ONLY_MODELS = new Set([`${OPENCODE_ZEN_CONNECTION_ID}/deepseek-v4-flash-free`]);
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

/** Provider continuation material is durable Host state, never a public Session payload. */
function publicSessionEntry(entry: SessionEntry): SessionEntry {
  if (entry.kind !== "provider_response") return entry;
  const payload = structuredClone(entry.payload) as Record<string, any>;
  const response = payload.response;
  if (response && typeof response === "object") {
    delete response.replay;
    if (response.cache && typeof response.cache === "object") delete response.cache.key;
    if (Array.isArray(response.diagnostics)) {
      response.diagnostics = response.diagnostics
        .filter((item: unknown) => item && typeof item === "object")
        .slice(0, 8)
        .map((item: { code?: unknown }) => ({
          code: typeof item.code === "string" ? item.code : "unknown",
        }));
    }
  }
  return { ...entry, payload } as SessionEntry;
}

function publicSessionSnapshot(snapshot: SessionSnapshot): HostSessionSnapshot {
  return { ...snapshot, entries: snapshot.entries.map(publicSessionEntry) };
}

function publicSessionEvent(event: SessionEvent): SessionEvent {
  return event.type === "entry_appended"
    ? { ...event, entry: publicSessionEntry(event.entry) }
    : event;
}

export class OpenGuiHost {
  readonly #dataDirectory: string;
  readonly #settingsPath: string;
  readonly #secretsPath: string;
  readonly #statePath: string;
  readonly #transport = new OpenAiChatTransport();
  readonly #piAiTransport: PiAiTransport;
  readonly #codexTransport: CodexResponsesTransport;
  readonly #xaiTransport: CodexResponsesTransport;
  readonly #xaiApiTransport: CodexResponsesTransport;
  #harness: OpenGuiHarness | null = null;
  #settings: HostSettingsFile = {
    hostId: "",
    modelConnections: [],
    defaultConnectionId: null,
    projects: [],
    mcpConnections: [],
  };
  #apiKeys: Record<string, string> = {};
  #codexTokens: CodexTokens | null = null;
  #deviceAuth: DeviceAuthorization | null = null;
  #subscriptionTokens: Partial<Record<"xai", OAuthTokens>> = {};
  #mcpSecrets: HostSecretsFile["mcp"] = {};
  #subscriptionPending: Partial<Record<"xai", DeviceOAuthPending>> = {};
  #codexRefresh: Promise<CodexTokens> | null = null;
  #xaiRefresh: Promise<OAuthTokens> | null = null;
  #stateStore: DurableJsonTransaction<HostDurableState> | null = null;
  readonly #listeners = new Set<(event: HostEvent) => void | Promise<void>>();
  readonly #activeRuns = new Map<string, Promise<void>>();
  readonly #promptAdmissions = new Map<string, Promise<void>>();
  readonly #fetch: typeof fetch;
  readonly #model: ModelTransport | undefined;
  readonly #mcpBroker: McpBroker = createMcpBroker({ connections: [] });
  readonly #usePiAiTransport: boolean;
  readonly #usePiAiCodexTransport: boolean;
  readonly #codexPiTransport: "auto" | "websocket" | "websocket-cached" | "sse";
  readonly #ownerModelDiagnostics: boolean;
  #diagnosticWrite = Promise.resolve();
  readonly #pathAuthorizer: HostPathAuthorizer;
  readonly #skillsManager: SkillsManager;
  readonly #resolveExecutionPolicy: ExecutionPolicyResolver | undefined;
  readonly #shellExecutor: ShellToolExecutor | undefined;
  readonly #authorizeMcpUse: ((actor: DurableActor | undefined) => Promise<boolean>) | undefined;
  readonly #sessionAccess: SessionAccessGate | undefined;
  readonly #resolveModelOffering:
    | ((
        offeringId: string,
        actor?: DurableActor,
      ) => Promise<{ connectionId: string; modelId: string }>)
    | undefined;
  #starting: Promise<void> | null = null;
  #closing: Promise<void> | null = null;
  #modelsDevCatalog: Promise<FlatModelCatalog | null> | null = null;

  constructor(
    dataDirectory: string,
    options: {
      fetchImpl?: typeof fetch;
      model?: ModelTransport;
      resolveExecutionPolicy?: ExecutionPolicyResolver;
      shellExecutor?: ShellToolExecutor;
      sessionAccess?: SessionAccessGate;
      resolveModelOffering?: (
        offeringId: string,
        actor?: DurableActor,
      ) => Promise<{ connectionId: string; modelId: string }>;
      homeDirectory?: string;
      skillSourceResolver?: SkillSourceResolver;
      authorizeSkillManagement?: (actor: DurableActor | undefined) => Promise<void>;
      authorizeMcpUse?: (actor: DurableActor | undefined) => Promise<boolean>;
      /** Explicit canary fallback. Defaults to the OpenGUI-owned pi-ai adapter. */
      usePiAiTransport?: boolean;
      usePiAiCodexTransport?: boolean;
      codexPiTransport?: "auto" | "websocket" | "websocket-cached" | "sse";
      openAiResponsesTransport?: "auto" | "websocket" | "sse";
      ownerModelDiagnostics?: boolean;
    } = {},
  ) {
    this.#dataDirectory = dataDirectory;
    this.#settingsPath = join(dataDirectory, SETTINGS_FILENAME);
    this.#secretsPath = join(dataDirectory, SECRETS_FILENAME);
    this.#statePath = join(dataDirectory, HOST_STATE_FILENAME);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#usePiAiTransport = options.usePiAiTransport ?? true;
    this.#usePiAiCodexTransport = options.usePiAiCodexTransport ?? true;
    this.#codexPiTransport = options.codexPiTransport ?? "auto";
    this.#ownerModelDiagnostics = options.ownerModelDiagnostics ?? false;
    this.#piAiTransport = new PiAiTransport({
      openAiResponsesTransport: options.openAiResponsesTransport ?? "auto",
      diagnostics: options.ownerModelDiagnostics
        ? (event) => {
            process.stderr.write(`[OpenGUI model transport] ${JSON.stringify(event)}\n`);
          }
        : undefined,
      resolve: async (request) => {
        const selection = request.context.findLast((item) => item.type === "user_message")?.model;
        if (!selection) throw new Error("Model request has no selected model");
        const connection =
          selection.connectionId === CODEX_CONNECTION.id
            ? CODEX_CONNECTION
            : this.#settings.modelConnections.find((item) => item.id === selection.connectionId);
        if (!connection) throw new Error(`Unknown model connection: ${selection.connectionId}`);
        if (!connection.modelIds.includes(selection.modelId)) {
          throw new Error(`Unknown model ${selection.modelId} for ${connection.id}`);
        }
        const configuredRoute = connection.modelRoutes?.[selection.modelId];
        const capabilities = connection.modelCapabilities?.[selection.modelId];
        if (connection.id === CODEX_CONNECTION.id) {
          const credential = await this.#codexCredential();
          return {
            backendId: connection.id,
            providerId: "openai-codex",
            label: connection.label,
            protocol: "codex-responses" as const,
            baseUrl: connection.baseUrl,
            modelId: selection.modelId,
            apiKey: credential.accessToken,
            headers: {
              "chatgpt-account-id": credential.accountId,
              originator: "opengui",
              "user-agent": "OpenGUI/1.0",
            },
            reasoning: capabilities?.reasoning,
            reasoningEfforts: capabilities?.reasoningEfforts,
            contextWindow: capabilities?.context,
            transport: this.#codexPiTransport,
            websocketConnectTimeoutMs: 15_000,
          };
        }
        const apiKey = this.#apiKeys[connection.id];
        return {
          backendId: connection.id,
          label: connection.label,
          protocol:
            configuredRoute === "responses"
              ? "openai-responses"
              : configuredRoute === "anthropic-messages"
                ? "anthropic-messages"
                : "openai-chat",
          baseUrl: connection.baseUrl,
          modelId: selection.modelId,
          apiKey,
          authHeader: connection.id === OPENCODE_ZEN_CONNECTION_ID && !apiKey ? false : undefined,
          reasoning: capabilities?.reasoning,
          reasoningEfforts: capabilities?.reasoningEfforts,
          contextWindow: capabilities?.context,
        };
      },
    });
    this.#codexTransport = new CodexResponsesTransport({
      fetchImpl: this.#fetch,
      getCredential: (forceRefresh) => this.#codexCredential(forceRefresh),
    });
    this.#xaiTransport = new CodexResponsesTransport({
      fetchImpl: this.#fetch,
      endpoint: "https://cli-chat-proxy.grok.com/v1/responses",
      headers: {
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-identifier": "opengui",
      },
      requestLabel: "SuperGrok experimental subscription proxy",
      unauthorizedMessage:
        "SuperGrok proxy authorization expired. Reconnect the experimental third-party OAuth authorization in Providers.",
      getCredential: (forceRefresh) => this.#subscriptionCredential("xai", forceRefresh),
    });
    this.#xaiApiTransport = new CodexResponsesTransport({
      fetchImpl: this.#fetch,
      endpoint: "https://api.x.ai/v1/responses",
      requestLabel: "xAI API",
      unauthorizedMessage: "The xAI API key was rejected. Save a valid API key in Providers.",
      getCredential: async () => {
        const accessToken = this.#apiKeys[XAI_API_PRESET.id];
        if (!accessToken)
          throw new Error("Add an xAI API key in Providers before using Grok Build");
        return { accessToken, accountId: "" };
      },
    });
    this.#model = options.model;
    this.#resolveExecutionPolicy = options.resolveExecutionPolicy;
    this.#shellExecutor = options.shellExecutor;
    this.#authorizeMcpUse = options.authorizeMcpUse;
    this.#pathAuthorizer = new HostPathAuthorizer(options.resolveExecutionPolicy);
    this.#skillsManager = new SkillsManager({
      homeDirectory: options.homeDirectory ?? homedir(),
      resolver: options.skillSourceResolver,
      authorizeManagement: async (actor, scope, projectDirectory) => {
        await options.authorizeSkillManagement?.(actor);
        if (scope === "project") {
          if (!projectDirectory) throw new Error("Project directory is required");
          await this.#pathAuthorizer.authorizePath(actor, projectDirectory, "write");
        }
      },
    });
    this.#sessionAccess = options.sessionAccess;
    this.#resolveModelOffering = options.resolveModelOffering;
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
    const durableStateAlreadyExists = await readFile(this.#statePath)
      .then(() => true)
      .catch(() => false);
    const fallback = await this.#loadLegacyState();
    this.#stateStore = await openDurableJsonTransaction(this.#statePath, {
      fallback,
      validate: (value) => this.#validateState(value),
      mode: 0o600,
    });
    this.#applyState(this.#stateStore.current());
    if (!this.#settings.hostId) {
      this.#settings.hostId = `host_${randomUUID()}`;
      // Existing Host state is migrated eagerly. A brand-new Host remains
      // write-lazy so start() does not create product state until first use.
      if (durableStateAlreadyExists) await this.#saveSettings();
    }
    await this.#refreshOpenCodeGoCatalog();
    this.#refreshTransport();
    await this.#refreshMcpBroker();
    const harness = createOpenGuiHarness({
      dataDirectory: this.#dataDirectory,
      hostId: this.#settings.hostId,
      model: {
        stream: (request, signal) => this.#streamModel(request, signal),
      } satisfies ModelTransport,
      resolveExecutionPolicy: this.#resolveExecutionPolicy,
      shellExecutor: this.#shellExecutor,
      agentTools: createMcpAgentToolSource(this.#mcpBroker, {
        authorize: async (scope) => {
          if (this.#authorizeMcpUse && !(await this.#authorizeMcpUse(scope.actor))) return false;
          if (!this.#resolveExecutionPolicy) return true;
          return !(await this.#resolveExecutionPolicy(scope.actor)).restricted;
        },
      }),
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
      await this.#mcpBroker.close();
      this.#piAiTransport.close();
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

  async #assertReasoningSupported(
    selection: ModelSelection,
    reasoning: string,
    actor?: DurableActor,
  ) {
    if (reasoning === "none") return;
    const routedSelection =
      selection.connectionId === MODEL_OFFERING_CONNECTION_ID
        ? await this.#resolveModelOffering?.(selection.modelId, actor)
        : selection;
    if (!routedSelection) throw new Error("Model offerings are not available");
    const connection = this.listModelConnections().find(
      (item) => item.id === routedSelection.connectionId,
    );
    if (!connection) throw new Error(`Unknown model connection: ${routedSelection.connectionId}`);
    const configured = connection.modelCapabilities?.[routedSelection.modelId];
    const hasExplicitEfforts = Boolean(configured?.reasoningEfforts?.length);
    if (
      BUILT_IN_CONNECTION_IDS.has(connection.id) &&
      !hasExplicitEfforts &&
      configured?.reasoning !== false
    )
      return;
    const catalog = hasExplicitEfforts
      ? null
      : await (this.#modelsDevCatalog ??= loadModelsDevCatalog(this.#fetch));
    const catalogModel = selectCatalogModel(catalog, routedSelection.modelId, {
      baseUrl: connection.baseUrl,
    });
    // Catalog inference is advisory. If it is unavailable or the model is unknown,
    // preserve existing custom/private model behavior instead of rejecting valid calls.
    if (!hasExplicitEfforts && configured?.reasoning !== false && !catalogModel) return;
    const supported = resolveConnectionReasoningEfforts(
      connection,
      routedSelection.modelId,
      catalog,
    );
    if (!supported.includes(reasoning as (typeof supported)[number])) {
      throw new Error(
        `Model ${routedSelection.modelId} does not support reasoning effort ${reasoning}`,
      );
    }
  }

  async *#streamModel(request: ModelRequest, signal: AbortSignal) {
    const started = Date.now();
    const timeoutSignal = request.delivery?.timeoutMs
      ? AbortSignal.timeout(request.delivery.timeoutMs)
      : undefined;
    const deliverySignal = timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : signal;
    const selectedIndex = request.context.findLastIndex((item) => item.type === "user_message");
    const selected = request.context[selectedIndex];
    let effectiveRequest = request;
    let connectionId = selected?.type === "user_message" ? selected.model.connectionId : "";
    if (
      selected?.type === "user_message" &&
      selected.model.connectionId === MODEL_OFFERING_CONNECTION_ID
    ) {
      if (!this.#resolveModelOffering) throw new Error("Model offerings are not available");
      const resolved = await this.#resolveModelOffering(selected.model.modelId, request.actor);
      connectionId = resolved.connectionId;
      effectiveRequest = {
        ...request,
        context: request.context.map((item, index) =>
          index === selectedIndex && item.type === "user_message"
            ? { ...item, model: resolved }
            : item,
        ),
      };
    }
    const routedSelection = effectiveRequest.context.findLast(
      (item) => item.type === "user_message",
    )?.model;
    const modelId = routedSelection?.modelId ?? "unknown";
    if (selected?.type === "user_message" && routedSelection) {
      await this.#assertReasoningSupported(routedSelection, selected.reasoning, request.actor);
    }
    if (TEXT_ONLY_MODELS.has(`${connectionId}/${modelId}`)) {
      effectiveRequest = {
        ...effectiveRequest,
        context: withoutModelContextImages(effectiveRequest.context),
      };
    }
    const connection = this.#settings.modelConnections.find((item) => item.id === connectionId);
    const protocol: ModelProtocol =
      connectionId === CODEX_CONNECTION.id ||
      connectionId === XAI_CONNECTION.id ||
      connectionId === XAI_API_CONNECTION.id
        ? "codex-responses"
        : connection?.modelRoutes?.[modelId] === "anthropic-messages"
          ? "anthropic-messages"
          : connection?.modelRoutes?.[modelId] === "responses"
            ? "openai-responses"
            : "openai-chat";
    try {
      if (this.#model) {
        yield* this.#model.stream(effectiveRequest, deliverySignal);
        return;
      }
      if (connectionId === CODEX_CONNECTION.id) {
        if (this.#usePiAiCodexTransport) {
          yield* this.#streamCodexPi(effectiveRequest, deliverySignal);
        } else {
          yield* this.#codexTransport.stream(effectiveRequest, deliverySignal);
        }
        return;
      }
      if (connectionId === XAI_CONNECTION.id) {
        yield* this.#xaiTransport.stream(effectiveRequest, deliverySignal);
        return;
      }
      if (connectionId === XAI_API_CONNECTION.id) {
        yield* this.#xaiApiTransport.stream(effectiveRequest, deliverySignal);
        return;
      }
      if (this.#usePiAiTransport) {
        yield* this.#piAiTransport.stream(effectiveRequest, deliverySignal);
        return;
      }
      yield* this.#transport.stream(effectiveRequest, deliverySignal);
    } catch (error) {
      if (error instanceof ModelTransportError) throw error;
      const normalized = timeoutSignal?.aborted
        ? {
            code: "timeout" as const,
            message: `Model request timed out after ${request.delivery?.timeoutMs}ms`,
            retryable: true,
          }
        : normalizeModelError(error, signal);
      const key = deriveModelCacheKey(effectiveRequest, {
        backendId: connectionId,
        upstreamModelId: modelId,
        protocol,
      });
      throw new ModelTransportError(normalized, {
        provider: connectionId || "unknown",
        api: protocol,
        model: modelId,
        protocol,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        stopReason: normalized.code === "aborted" ? "aborted" : "error",
        cache: {
          key,
          generation: effectiveRequest.cache?.generation ?? "legacy",
          readTokens: 0,
          writeTokens: 0,
        },
        timing: {
          startedAt: new Date(started).toISOString(),
          completedMs: Date.now() - started,
          attempts: 1,
        },
        diagnostics: [{ code: normalized.code, message: normalized.message }],
      });
    }
  }

  async *#streamCodexPi(request: ModelRequest, signal: AbortSignal) {
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      let emitted = false;
      try {
        for await (const event of this.#piAiTransport.stream(request, signal)) {
          if (event.type !== "completed") emitted = true;
          if (event.type === "completed" && event.response && attempts > 1) {
            const completed = {
              ...event,
              response: {
                ...event.response,
                timing: { ...event.response.timing, attempts },
              },
            };
            await this.#recordCodexDiagnostic(request, completed.response);
            yield completed;
          } else {
            if (event.type === "completed" && event.response) {
              await this.#recordCodexDiagnostic(request, event.response);
            }
            yield event;
          }
        }
        return;
      } catch (error) {
        if (
          attempts !== 1 ||
          emitted ||
          !(error instanceof ModelTransportError) ||
          error.normalized.code !== "authentication"
        ) {
          if (error instanceof ModelTransportError) {
            await this.#recordCodexDiagnostic(request, error.response);
          }
          throw error;
        }
        // A provider 401 occurs before response output. Refresh exactly once;
        // never replay after any model delta or tool argument has escaped.
        await this.#codexCredential(true);
      }
    }
  }

  async #recordCodexDiagnostic(request: ModelRequest, response: ProviderResponseMetadata) {
    if (!this.#ownerModelDiagnostics) return;
    const path = join(this.#dataDirectory, CODEX_DIAGNOSTICS_FILENAME);
    const session = createHash("sha256")
      .update(request.identity?.sessionId ?? "legacy")
      .digest("hex")
      .slice(0, 24);
    const record = {
      at: new Date().toISOString(),
      session,
      model: createHash("sha256").update(response.model).digest("hex").slice(0, 24),
      stopReason: response.stopReason,
      usage: response.usage,
      cache: {
        readTokens: response.cache.readTokens,
        writeTokens: response.cache.writeTokens,
      },
      timing: response.timing,
      diagnostics: response.diagnostics?.map(({ code }) => ({ code })).slice(0, 8),
    };
    const line = `${JSON.stringify(record)}\n`;
    const write = this.#diagnosticWrite.then(async () => {
      let previous = "";
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) return;
        const length = Math.min(info.size, 64 * 1024);
        const buffer = Buffer.alloc(length);
        const file = await open(path, "r");
        try {
          const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, info.size - length));
          previous = buffer.subarray(0, bytesRead).toString("utf8");
          if (info.size > length) previous = previous.slice(previous.indexOf("\n") + 1);
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
      const records = `${previous}${line}`.split("\n").filter(Boolean);
      while (records.length > 1 && Buffer.byteLength(`${records.join("\n")}\n`) > 64 * 1024) {
        records.shift();
      }
      const bounded = `${records.join("\n")}\n`;
      const temporary = `${path}.tmp-${randomUUID()}`;
      try {
        await writeFile(temporary, bounded, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, path);
        await chmod(path, 0o600);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.#diagnosticWrite = write.catch(() => undefined);
    await write;
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
        hostId: typeof parsed.hostId === "string" ? parsed.hostId : "",
        modelConnections: Array.isArray(parsed.modelConnections) ? parsed.modelConnections : [],
        defaultConnectionId:
          typeof parsed.defaultConnectionId === "string" ? parsed.defaultConnectionId : null,
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.filter((item): item is string => typeof item === "string")
          : [],
        mcpConnections: [],
      };
    } catch {
      return {
        hostId: "",
        modelConnections: [],
        defaultConnectionId: null,
        projects: [],
        mcpConnections: [],
      };
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
      return { apiKeys, codexTokens, subscriptionTokens: xai ? { xai } : {}, mcp: {} };
    } catch {
      return { apiKeys: {}, codexTokens: null, subscriptionTokens: {}, mcp: {} };
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
        hostId: typeof state.settings.hostId === "string" ? state.settings.hostId : "",
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
        mcpConnections: Array.isArray(state.settings.mcpConnections)
          ? (state.settings.mcpConnections as HostMcpConnection[])
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
        mcp:
          state.secrets.mcp && typeof state.secrets.mcp === "object"
            ? structuredClone(state.secrets.mcp)
            : {},
      },
    };
  }

  #applyState(state: HostDurableState) {
    this.#settings = structuredClone(state.settings);
    this.#apiKeys = { ...state.secrets.apiKeys };
    this.#codexTokens = state.secrets.codexTokens ? { ...state.secrets.codexTokens } : null;
    this.#subscriptionTokens = structuredClone(state.secrets.subscriptionTokens);
    this.#mcpSecrets = structuredClone(state.secrets.mcp);
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
      mcp: structuredClone(this.#mcpSecrets),
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

  #mcpRuntimeConnections(): McpConnection[] {
    const result: McpConnection[] = [];
    for (const connection of this.#settings.mcpConnections) {
      if (!connection.enabled) continue;
      const secret = this.#mcpSecrets[connection.id];
      result.push(
        connection.transport.kind === "stdio"
          ? {
              id: connection.id,
              label: connection.label,
              transport: {
                kind: "stdio",
                command: connection.transport.command,
                args: [...connection.transport.args],
                cwd: connection.transport.cwd,
                env: secret?.env,
              },
            }
          : {
              id: connection.id,
              label: connection.label,
              transport: {
                kind: "http",
                url: connection.transport.url,
                bearerToken: secret?.bearerToken,
              },
            },
      );
    }
    return result;
  }

  async #refreshMcpBroker() {
    await this.#mcpBroker.replaceConnections(this.#mcpRuntimeConnections());
    void this.#mcpBroker
      .refresh({ actorId: "local:settings", sessionId: "mcp-settings" })
      .catch(() => undefined);
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
      version: process.env.OPENGUI_VERSION || process.env.npm_package_version || "0.0.0",
      shell: process.env.SHELL || (process.platform === "win32" ? "powershell" : "/bin/sh"),
    };
  }

  async listMcpConnections(): Promise<HostMcpConnection[]> {
    const catalog = await this.#mcpBroker.catalog({
      actorId: "local:settings",
      sessionId: "mcp-settings",
    });
    return structuredClone(
      this.#settings.mcpConnections.map((connection) => {
        const tools = catalog.tools.filter((tool) => tool.ref.connectionId === connection.id);
        const problem = catalog.problems.find((item) => item.connectionId === connection.id);
        const lastCheckedAt = catalog.checkedAt[connection.id];
        const state: HostMcpConnectionStatus["state"] = !connection.enabled
          ? "disabled"
          : problem && tools.length > 0
            ? "degraded"
            : problem
              ? "offline"
              : lastCheckedAt
                ? "ready"
                : "refreshing";
        return {
          ...connection,
          status: {
            state,
            toolCount: tools.length,
            ...(lastCheckedAt ? { lastCheckedAt } : {}),
            ...(problem
              ? {
                  problem: {
                    code: problem.code,
                    stage: problem.stage,
                    message: problem.message,
                    retryable: problem.retryable,
                  },
                }
              : {}),
          },
        };
      }),
    );
  }

  async upsertMcpConnection(input: HostMcpConnectionInput): Promise<HostMcpConnection> {
    const id = input.id.trim();
    const label = input.label.trim();
    if (!/^[a-zA-Z0-9._-]{1,64}$/u.test(id)) {
      throw new Error(
        "MCP connection id must use 1-64 letters, numbers, dots, dashes, or underscores",
      );
    }
    if (!label) throw new Error("MCP connection label is required");
    let publicConnection: HostMcpConnection;
    if (input.transport.kind === "stdio") {
      const command = input.transport.command.trim();
      if (!command) throw new Error("MCP stdio command is required");
      const env = input.transport.env
        ? Object.fromEntries(
            Object.entries(input.transport.env)
              .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && value !== "")
              .map(([key, value]) => [key, String(value)]),
          )
        : undefined;
      const effectiveEnv = env ?? this.#mcpSecrets[id]?.env;
      publicConnection = {
        id,
        label,
        enabled: input.enabled,
        transport: {
          kind: "stdio",
          command,
          args: (input.transport.args ?? []).map((argument) => String(argument)),
          ...(input.transport.cwd?.trim() ? { cwd: input.transport.cwd.trim() } : {}),
          envKeys: effectiveEnv ? Object.keys(effectiveEnv).sort() : [],
        },
      };
      await this.#updateState((state) => ({
        ...state,
        settings: {
          ...state.settings,
          mcpConnections: [
            ...state.settings.mcpConnections.filter((connection) => connection.id !== id),
            publicConnection,
          ],
        },
        secrets: {
          ...state.secrets,
          mcp: {
            ...state.secrets.mcp,
            [id]: effectiveEnv ? { env: effectiveEnv } : {},
          },
        },
      }));
    } else {
      let url: URL;
      try {
        url = new URL(input.transport.url);
      } catch {
        throw new Error("MCP HTTP URL is invalid");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("MCP HTTP URL must use HTTP or HTTPS");
      }
      if (url.username || url.password) {
        throw new Error("MCP HTTP credentials must not be embedded in the URL");
      }
      const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
      const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
      if (url.protocol === "http:" && !loopback) {
        throw new Error("MCP HTTP endpoints must use HTTPS unless they are on loopback");
      }
      if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
        throw new Error("MCP HTTP endpoint is not allowed");
      }
      const existingToken = this.#mcpSecrets[id]?.bearerToken;
      const bearerToken =
        input.transport.bearerToken?.trim().replace(/^Bearer\s+/iu, "") || existingToken;
      publicConnection = {
        id,
        label,
        enabled: input.enabled,
        transport: {
          kind: "http",
          url: url.toString(),
          bearerTokenConfigured: Boolean(bearerToken),
        },
      };
      await this.#updateState((state) => ({
        ...state,
        settings: {
          ...state.settings,
          mcpConnections: [
            ...state.settings.mcpConnections.filter((connection) => connection.id !== id),
            publicConnection,
          ],
        },
        secrets: {
          ...state.secrets,
          mcp: {
            ...state.secrets.mcp,
            [id]: bearerToken ? { bearerToken } : {},
          },
        },
      }));
    }
    await this.#refreshMcpBroker();
    return structuredClone(publicConnection);
  }

  async removeMcpConnection(id: string) {
    await this.#updateState((state) => {
      const mcp = { ...state.secrets.mcp };
      delete mcp[id];
      return {
        ...state,
        settings: {
          ...state.settings,
          mcpConnections: state.settings.mcpConnections.filter(
            (connection) => connection.id !== id,
          ),
        },
        secrets: { ...state.secrets, mcp },
      };
    });
    await this.#refreshMcpBroker();
  }

  async inspectMcpConnection(id: string, actor?: DurableActor) {
    if (this.#authorizeMcpUse && !(await this.#authorizeMcpUse(actor))) {
      throw new Error("MCP tools are unavailable for this actor");
    }
    if (this.#resolveExecutionPolicy && (await this.#resolveExecutionPolicy(actor)).restricted) {
      throw new Error("MCP tools are unavailable for restricted actors");
    }
    const scope = { actorId: "local:settings", sessionId: "mcp-settings" };
    const catalog = await this.#mcpBroker.refresh(scope, id);
    const problem = catalog.problems.find((item) => item.connectionId === id);
    if (problem && !catalog.tools.some((tool) => tool.ref.connectionId === id)) {
      throw new Error(problem.message);
    }
    return catalog.tools
      .filter((tool) => tool.ref.connectionId === id)
      .map((tool) => ({
        name: tool.ref.toolName,
        title: tool.title,
        description: tool.description,
      }));
  }

  listModelConnections() {
    return [
      ...(this.#codexTokens ? [CODEX_CONNECTION] : []),
      ...(this.#subscriptionTokens.xai ? [XAI_CONNECTION] : []),
      ...this.#settings.modelConnections
        .filter(
          (connection) =>
            connection.id !== XAI_API_PRESET.id || Boolean(this.#apiKeys[XAI_API_PRESET.id]),
        )
        .map(({ apiKey: _apiKey, ...connection }) => connection),
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
  async cancelCodexAuth() {
    this.#deviceAuth = null;
    return this.codexAuthStatus();
  }
  async disconnectCodex() {
    const tokens = this.#codexTokens;
    this.#codexTokens = null;
    this.#deviceAuth = null;
    await this.#saveSecrets();
    this.#piAiTransport.close();
    if (tokens) await revokeCodexToken(tokens.refreshToken);
  }
  async #codexCredential(forceRefresh = false) {
    if (!this.#codexTokens) throw new Error("Sign in to ChatGPT in Providers before using Codex");
    if (forceRefresh || this.#codexTokens.expiresAt <= Date.now() + 60_000) {
      const current = this.#codexTokens;
      try {
        this.#codexRefresh ??= refreshCodexTokens(current).finally(() => {
          this.#codexRefresh = null;
        });
        const refreshed = await this.#codexRefresh;
        if (this.#codexTokens !== current) {
          if (
            this.#codexTokens?.accessToken === refreshed.accessToken &&
            this.#codexTokens.refreshToken === refreshed.refreshToken
          )
            return {
              accessToken: this.#codexTokens.accessToken,
              accountId: this.#codexTokens.accountId,
            };
          throw new Error("ChatGPT sign-in changed");
        }
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
    this.#subscriptionPending[provider] = await beginDeviceOAuth({
      ...XAI_OAUTH,
      fetchImpl: this.#fetch,
    });
    return this.subscriptionAuthStatus(provider);
  }
  async pollSubscriptionAuth(provider: "xai") {
    const pending = this.#subscriptionPending[provider];
    if (!pending) throw new Error("No sign-in is pending");
    if (pending.expiresAt <= Date.now()) {
      delete this.#subscriptionPending[provider];
      throw new Error("The device code expired. Start sign-in again.");
    }
    const result = await pollDeviceOAuth({ ...XAI_OAUTH, fetchImpl: this.#fetch }, pending);
    if (result && this.#subscriptionPending[provider] === pending) {
      this.#subscriptionTokens[provider] = result;
      delete this.#subscriptionPending[provider];
      this.#refreshTransport();
      await this.#saveSecrets();
    }
    return this.subscriptionAuthStatus(provider);
  }
  async cancelSubscriptionAuth(provider: "xai") {
    delete this.#subscriptionPending[provider];
    return this.subscriptionAuthStatus(provider);
  }
  async disconnectSubscription(provider: "xai") {
    delete this.#subscriptionTokens[provider];
    delete this.#subscriptionPending[provider];
    this.#refreshTransport();
    await this.#saveSecrets();
  }
  async #subscriptionCredential(provider: "xai", forceRefresh = false) {
    let current = this.#subscriptionTokens[provider];
    if (!current) throw new Error("Sign in to this provider in Settings before using it");
    if (forceRefresh || current.expiresAt <= Date.now() + 60_000) {
      const expected = current;
      try {
        this.#xaiRefresh ??= refreshDeviceOAuth(
          { ...XAI_OAUTH, fetchImpl: this.#fetch },
          current,
        ).finally(() => {
          this.#xaiRefresh = null;
        });
        current = await this.#xaiRefresh;
        const latest = this.#subscriptionTokens[provider];
        if (latest !== expected) {
          if (
            latest?.accessToken === current.accessToken &&
            latest.refreshToken === current.refreshToken
          )
            return { accessToken: latest.accessToken, accountId: "" };
          throw new Error("Provider sign-in changed");
        }
        this.#subscriptionTokens[provider] = current;
        this.#refreshTransport();
        await this.#saveSecrets();
      } catch {
        if (this.#subscriptionTokens[provider] === expected) {
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
      if (connection.id === XAI_API_PRESET.id && !apiKeys[XAI_API_PRESET.id]?.trim())
        throw new Error("An xAI API key is required to enable the xAI API");
      if (connection.id === OPENCODE_GO_PRESET.id) {
        connection = await this.#openCodeGoConnection(
          connection.apiKey ?? apiKeys[OPENCODE_GO_PRESET.id],
        );
      }
      if (connection.id === XAI_API_PRESET.id) connection = connectionFromPreset(XAI_API_PRESET);
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
        const authorized = await this.#pathAuthorizer.authorizePath(actor, directory, "read");
        if (!(await lstat(authorized)).isDirectory()) continue;
        projects.push({ directory: authorized, name: projectName(authorized) });
      } catch {
        // Project enumeration omits denied and currently unavailable paths.
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

  supportedSkillSources(): SkillSourceDescriptor[] {
    return this.#skillsManager.sources();
  }

  async listSkillInstallations(
    projectDirectory: string,
    scope: SkillScope,
    actor?: DurableActor,
  ): Promise<SkillInstallation[]> {
    const directory =
      scope === "project"
        ? await this.#pathAuthorizer.authorizePath(actor, projectDirectory, "read")
        : undefined;
    return this.#skillsManager.list(scope, directory);
  }

  async installSkill(input: {
    source: string;
    projectDirectory: string;
    scope: SkillScope;
    requestId: string;
    expectedGeneration?: number;
    actor?: DurableActor;
  }): Promise<SkillInstallation> {
    const directory =
      input.scope === "project"
        ? await this.#pathAuthorizer.authorizePath(input.actor, input.projectDirectory, "write")
        : undefined;
    return this.#skillsManager.install({ ...input, projectDirectory: directory });
  }

  async updateSkill(input: {
    name: string;
    projectDirectory: string;
    scope: SkillScope;
    requestId: string;
    expectedGeneration?: number;
    actor?: DurableActor;
  }): Promise<SkillInstallation> {
    const directory =
      input.scope === "project"
        ? await this.#pathAuthorizer.authorizePath(input.actor, input.projectDirectory, "write")
        : undefined;
    return this.#skillsManager.update({ ...input, projectDirectory: directory });
  }

  async removeSkill(input: {
    name: string;
    projectDirectory: string;
    scope: SkillScope;
    requestId: string;
    expectedGeneration?: number;
    actor?: DurableActor;
  }) {
    const directory =
      input.scope === "project"
        ? await this.#pathAuthorizer.authorizePath(input.actor, input.projectDirectory, "write")
        : undefined;
    await this.#skillsManager.remove({ ...input, projectDirectory: directory });
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
    await this.#assertReasoningSupported(input.model, input.reasoning, actor);
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
    return publicSessionSnapshot(snapshot);
  }

  async readSession(sessionId: string, actor?: DurableActor): Promise<HostSessionSnapshot> {
    return publicSessionSnapshot(
      (await this.#authorizedSession(sessionId, actor, "view")).snapshot,
    );
  }

  /** Internal read after a view-link token has already been validated. */
  async readSessionForViewLink(sessionId: string): Promise<HostSessionSnapshot> {
    try {
      return publicSessionSnapshot(
        await (await this.#requireHarness().openSession(sessionId)).read(),
      );
    } catch {
      throw new HostSessionNotFoundError();
    }
  }

  async renameSession(sessionId: string, title: string, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "admin");
    await session.rename(title);
    return publicSessionSnapshot(await session.read());
  }

  async deleteSession(sessionId: string, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "delete");
    await session.delete();
    await this.#sessionAccess?.onDeleted(sessionId);
  }

  async setModel(sessionId: string, selection: ModelSelection, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    await session.setModel(selection);
    return publicSessionSnapshot(await session.read());
  }

  async setReasoning(sessionId: string, reasoning: ReasoningLevel, actor?: DurableActor) {
    const { session, snapshot } = await this.#authorizedSession(sessionId, actor, "run");
    if (snapshot.model) await this.#assertReasoningSupported(snapshot.model, reasoning, actor);
    await session.setReasoning(reasoning);
    return publicSessionSnapshot(await session.read());
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
    const publicEvent = publicSessionEvent(event);
    for (const listener of this.#listeners) void listener({ sessionId, event: publicEvent });
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
          console.error("OpenGUI Compaction failed", normalizeModelError(error).code);
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
    options?: { interrupt?: boolean },
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
        if (options?.interrupt) {
          // Abort the live Run under admission, then accept this prompt as the next Run.
          // Existing Follow-ups stay queued and run after this interrupted turn completes.
          if (this.#activeRuns.has(sessionId)) {
            await session.abort();
            await this.#activeRuns.get(sessionId);
          }
        } else {
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
          console.error("OpenGUI Run failed", normalizeModelError(error).code);
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
    // Take the row first so a finishing Run cannot claim the same Follow-up and
    // duplicate it into the transcript while we abort + re-prompt.
    const selected = await session.takeFollowUp(followUpId);
    if (this.#activeRuns.has(sessionId)) {
      await session.abort();
      await this.#activeRuns.get(sessionId);
    }
    // The caller is authorized to operate the Session above, but execution
    // belongs to the actor stored with the accepted prompt. Reauthorize that
    // actor now rather than transferring the caller's grants.
    await this.prompt(sessionId, selected.prompt, selected.prompt.actor);
    return (await session.read()).followUps;
  }

  async abort(sessionId: string, actor?: DurableActor) {
    const { session } = await this.#authorizedSession(sessionId, actor, "run");
    await session.abort();
    await this.#activeRuns.get(sessionId);
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
    shellExecutor?: ShellToolExecutor;
    sessionAccess?: SessionAccessGate;
    model?: ModelTransport;
    resolveModelOffering?: (
      offeringId: string,
      actor?: DurableActor,
    ) => Promise<{ connectionId: string; modelId: string }>;
    usePiAiTransport?: boolean;
    usePiAiCodexTransport?: boolean;
    codexPiTransport?: "auto" | "websocket" | "websocket-cached" | "sse";
    openAiResponsesTransport?: "auto" | "websocket" | "sse";
    ownerModelDiagnostics?: boolean;
    authorizeMcpUse?: (actor: DurableActor | undefined) => Promise<boolean>;
  } = {},
) {
  const host = new OpenGuiHost(dataDirectory, options);
  await host.start();
  return host;
}
