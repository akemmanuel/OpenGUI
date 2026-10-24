import { KeyedSerialLock } from "../effect/serial-lock.ts";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  combineAgentToolSources,
  createOpenGuiHarness,
  createPiModels,
  discoverSkills,
  ISOLATED_AUTH_CONTEXT,
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
  ModelCatalog,
  piProvider,
  piProviderDescriptors,
  protocolForPiApi,
  withoutModelContextImages,
  type ModelProtocol,
  type ModelStreamEvent,
  type ProviderResponseMetadata,
  type OpenAiCompatibleConnection,
  type OpenGuiHarness,
  type PiAiRoute,
  type PiModels,
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
  PI_PROVIDER_DEFAULT_MODELS,
  piProviderConnectionId,
  RETIRED_PROVIDER_CONNECTION_IDS,
  type HostProviderInfo,
  type ProviderAuthMethod,
  type ProviderLoginStatus,
} from "@opengui/protocol";
import { revokeCodexToken } from "./codex-oauth.ts";
import {
  createHostCredentialStore,
  migrateLegacyProviderCredentials,
  ProviderLogins,
  providerCredentialConnectionId,
  validProviderCredentials,
  type ProviderCredentialEntry,
  type ProviderCredentials,
} from "./provider-auth.ts";
import {
  composeInstructions,
  normalizeScopedInstructions,
  personalInstructionKey,
  type ScopedInstructions,
} from "./scoped-instructions.ts";
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
import {
  createCodexAgentToolSource,
  normalizeCodexToolsSettings,
  type CodexToolRoute,
  type CodexToolsSettings,
} from "../codex-tools/codex-agent-tool-source.ts";
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
  /** True when the data directory's filesystem is nearly full; SQLite writes then fail. */
  lowDiskSpace?: boolean;
}

/** Below this, warn: either under 1 GiB or under 5 % of the filesystem free. */
const LOW_DISK_FREE_BYTES = 1024 ** 3;
const LOW_DISK_FREE_RATIO = 0.05;

export function isLowDiskSpace(freeBytes: number, totalBytes: number) {
  return (
    freeBytes < LOW_DISK_FREE_BYTES ||
    (totalBytes > 0 && freeBytes / totalBytes < LOW_DISK_FREE_RATIO)
  );
}

export interface HostModelConnection extends OpenAiCompatibleConnection {
  /** Set for pi provider connections; those are managed through the provider sign-in API. */
  providerId?: string;
  authType?: ProviderAuthMethod;
}

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

const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 32_000;

function normalizeCustomInstructions(value: unknown, options: { rejectOverLimit?: boolean } = {}) {
  if (typeof value !== "string") return "";
  const customInstructions = value.trim();
  if (customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
    if (options.rejectOverLimit) {
      throw new Error(
        `Custom instructions must be at most ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} characters`,
      );
    }
    return "";
  }
  return customInstructions;
}

interface HostSettingsFile {
  hostId: string;
  modelConnections: HostModelConnection[];
  defaultConnectionId: string | null;
  projects: string[];
  mcpConnections: HostMcpConnection[];
  customInstructions: string;
  scopedInstructions: ScopedInstructions;
  codexTools: CodexToolsSettings;
}

type HostMailSecrets = {
  smtpPassword: string;
};

function validMailSecrets(value: unknown): HostMailSecrets | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const smtpPassword = (value as Record<string, unknown>).smtpPassword;
  return typeof smtpPassword === "string" && smtpPassword.length > 0 ? { smtpPassword } : null;
}

type HostSecretsFile = {
  /** Custom OpenAI-compatible connection keys, by connection id. */
  apiKeys: Record<string, string>;
  /** pi provider credentials, by connection id. */
  providerCredentials: ProviderCredentials;
  mail: HostMailSecrets | null;
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
/** Custom connections must not shadow a pi provider connection or a retired alias. */
function reservedConnectionId(id: string) {
  return (
    id in RETIRED_PROVIDER_CONNECTION_IDS ||
    piProviderDescriptors().some((provider) => piProviderConnectionId(provider.id) === id) ||
    id.startsWith("personal-")
  );
}

function projectName(directory: string) {
  const parts = directory.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || directory;
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
  #lowDiskWarned = false;
  readonly #settingsPath: string;
  readonly #secretsPath: string;
  readonly #statePath: string;
  readonly #transport = new OpenAiChatTransport();
  readonly #piAiTransport: PiAiTransport;
  #harness: OpenGuiHarness | null = null;
  #settings: HostSettingsFile = {
    hostId: "",
    modelConnections: [],
    defaultConnectionId: null,
    projects: [],
    mcpConnections: [],
    customInstructions: "",
    scopedInstructions: { personal: {}, projects: {} },
    codexTools: normalizeCodexToolsSettings(undefined),
  };
  #apiKeys: Record<string, string> = {};
  #providerCredentials: ProviderCredentials = {};
  #mcpSecrets: HostSecretsFile["mcp"] = {};
  #mailSecrets: HostSecretsFile["mail"] = null;
  /** pi `Models` per credential scope: "" for the Host, otherwise a personal actor id. */
  readonly #piModels = new Map<string, PiModels>();
  readonly #credentialLock = new KeyedSerialLock();
  readonly #providerLogins = new ProviderLogins();
  #stateStore: DurableJsonTransaction<HostDurableState> | null = null;
  readonly #listeners = new Set<(event: HostEvent) => void | Promise<void>>();
  readonly #activeRuns = new Map<string, Promise<void>>();
  /** Admits one prompt or compaction per Session at a time, in arrival order. */
  readonly #promptAdmissions = new KeyedSerialLock();
  readonly #fetch: typeof fetch;
  readonly #model: ModelTransport | undefined;
  readonly #mcpBroker: McpBroker = createMcpBroker({ connections: [] });
  readonly #usePiAiTransport: boolean;
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
      ) => Promise<{ connectionId: string; modelId: string; executionScope: "host" }>)
    | undefined;
  #starting: Promise<void> | null = null;
  #closing: Promise<void> | null = null;
  readonly #catalog: ModelCatalog;

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
      ) => Promise<{ connectionId: string; modelId: string; executionScope: "host" }>;
      homeDirectory?: string;
      skillSourceResolver?: SkillSourceResolver;
      authorizeSkillManagement?: (actor: DurableActor | undefined) => Promise<void>;
      authorizeMcpUse?: (actor: DurableActor | undefined) => Promise<boolean>;
      /** Explicit canary fallback for custom connections. Defaults to the pi-ai adapter. */
      usePiAiTransport?: boolean;
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
    this.#catalog = new ModelCatalog(join(dataDirectory, "model-catalog"), this.#fetch);
    this.#usePiAiTransport = options.usePiAiTransport ?? true;
    this.#codexPiTransport = options.codexPiTransport ?? "auto";
    this.#ownerModelDiagnostics = options.ownerModelDiagnostics ?? false;
    this.#piAiTransport = new PiAiTransport({
      openAiResponsesTransport: options.openAiResponsesTransport ?? "auto",
      diagnostics: options.ownerModelDiagnostics
        ? (event) => {
            process.stderr.write(`[OpenGUI model transport] ${JSON.stringify(event)}\n`);
          }
        : undefined,
      resolve: (request) => this.#resolveModelRoute(request),
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
    await this.refreshModelCatalogs();
    this.#refreshTransport();
    await this.#refreshMcpBroker();
    const harness = createOpenGuiHarness({
      dataDirectory: this.#dataDirectory,
      hostId: this.#settings.hostId,
      model: {
        stream: (request, signal) => this.#streamModel(request, signal),
      } satisfies ModelTransport,
      resolveExecutionPolicy: this.#resolveExecutionPolicy,
      resolveCustomInstructions: async ({ actor, projectDirectory }) => {
        const directory = await this.#pathAuthorizer.authorizePath(actor, projectDirectory, "read");
        return composeInstructions(
          this.#settings.customInstructions,
          this.#settings.scopedInstructions.projects[directory]?.text ?? "",
          actor?.type === "api_key" ? "" : this.getPersonalInstructions(actor),
        );
      },
      shellExecutor: this.#shellExecutor,
      agentTools: combineAgentToolSources([
        createMcpAgentToolSource(this.#mcpBroker, {
          authorize: async (scope) => {
            if (this.#authorizeMcpUse && !(await this.#authorizeMcpUse(scope.actor))) return false;
            if (!this.#resolveExecutionPolicy) return true;
            return !(await this.#resolveExecutionPolicy(scope.actor)).restricted;
          },
        }),
        createCodexAgentToolSource({
          route: (scope) => this.#codexToolRoute(scope.model, scope.actor),
          settings: () => this.#settings.codexTools,
          authorizePath: (scope, path, access, options) =>
            this.#pathAuthorizer.authorizePath(scope.actor, path, access, options),
          fetchImpl: this.#fetch,
        }),
      ]),
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
      try {
        await harness.close();
        await this.#mcpBroker.close();
        this.#providerLogins.clear();
        this.#piAiTransport.close();
      } finally {
        // Always release the durable state lock, or the next start finds it held.
        await this.#stateStore?.close();
        this.#stateStore = null;
        this.#activeRuns.clear();
        this.#promptAdmissions.clear();
        this.#listeners.clear();
      }
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
    executionScope: "actor" | "host" = "actor",
  ) {
    if (reasoning === "none") return;
    const resolved =
      selection.connectionId === MODEL_OFFERING_CONNECTION_ID
        ? await this.#resolveModelOffering?.(selection.modelId, actor)
        : undefined;
    const routedSelection = resolved ?? selection;
    if (!routedSelection) throw new Error("Model offerings are not available");
    const credentialActor =
      (resolved?.executionScope ?? executionScope) === "host" ? undefined : actor;
    const connection = this.#findConnection(routedSelection.connectionId, credentialActor);
    if (!connection) throw new Error(`Unknown model connection: ${routedSelection.connectionId}`);
    const configured = connection.modelCapabilities?.[routedSelection.modelId];
    // Custom models without explicit metadata remain configurable.
    if (!configured || (configured.reasoning && !configured.reasoningEfforts?.length)) return;
    const supported = configured.reasoning ? (configured.reasoningEfforts ?? []) : [];
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
      const { executionScope, ...model } = resolved;
      connectionId = model.connectionId;
      effectiveRequest = {
        ...request,
        executionScope,
        context: request.context.map((item, index) =>
          index === selectedIndex && item.type === "user_message" ? { ...item, model } : item,
        ),
      };
    }
    const routedSelection = effectiveRequest.context.findLast(
      (item) => item.type === "user_message",
    )?.model;
    const modelId = routedSelection?.modelId ?? "unknown";
    if (selected?.type === "user_message" && routedSelection) {
      await this.#assertReasoningSupported(
        routedSelection,
        selected.reasoning,
        request.actor,
        effectiveRequest.executionScope,
      );
    }
    const credentialActor = effectiveRequest.executionScope === "host" ? undefined : request.actor;
    const connection = this.#findConnection(connectionId, credentialActor);
    const input = connection?.modelCapabilities?.[modelId]?.input;
    if (input && !input.includes("image")) {
      effectiveRequest = {
        ...effectiveRequest,
        context: withoutModelContextImages(effectiveRequest.context),
      };
    }
    const piModel = connection?.providerId
      ? this.#catalog.model(connection.providerId, modelId)
      : undefined;
    const protocol: ModelProtocol = piModel
      ? protocolForPiApi(piModel.api)
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
      if (connection?.providerId) {
        yield* this.#streamProvider(effectiveRequest, deliverySignal, connection);
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

  /** The connection a selection names, following retired first-party connection ids. */
  #findConnection(connectionId: string, actor?: DurableActor) {
    const connections = this.listModelConnections(actor);
    const direct = connections.find((item) => item.id === connectionId);
    if (direct) return direct;
    const providerId = RETIRED_PROVIDER_CONNECTION_IDS[connectionId];
    return providerId ? connections.find((item) => item.providerId === providerId) : undefined;
  }

  #piModelsFor(ownerId?: string) {
    const scope = ownerId ?? "";
    let models = this.#piModels.get(scope);
    if (!models) {
      models = createPiModels({
        credentials: createHostCredentialStore({
          ownerId,
          current: () => this.#providerCredentials,
          update: (change) =>
            this.#updateState((state) => ({
              ...state,
              secrets: {
                ...state.secrets,
                providerCredentials: change(state.secrets.providerCredentials),
              },
            })).then(() => undefined),
          lock: this.#credentialLock,
        }),
        // Personal credentials never fall back to the Host's environment or credential files.
        authContext: ownerId ? ISOLATED_AUTH_CONTEXT : undefined,
      });
      this.#piModels.set(scope, models);
    }
    return models;
  }

  async #resolveModelRoute(request: ModelRequest): Promise<PiAiRoute> {
    const selection = request.context.findLast((item) => item.type === "user_message")?.model;
    if (!selection) throw new Error("Model request has no selected model");
    const credentialActor = request.executionScope === "host" ? undefined : request.actor;
    const connection = this.#findConnection(selection.connectionId, credentialActor);
    if (!connection) throw new Error(`Unknown model connection: ${selection.connectionId}`);
    if (!connection.modelIds.includes(selection.modelId)) {
      throw new Error(`Unknown model ${selection.modelId} for ${connection.id}`);
    }
    const capabilities = connection.modelCapabilities?.[selection.modelId];
    if (connection.providerId) {
      const model = this.#catalog.model(connection.providerId, selection.modelId);
      if (!model) throw new Error(`Unknown model ${selection.modelId} for ${connection.id}`);
      const entry = this.#providerCredentials[connection.id];
      const codex = connection.providerId === "openai-codex";
      return {
        backendId: connection.id,
        providerId: connection.providerId,
        label: connection.label,
        protocol: protocolForPiApi(model.api),
        baseUrl: model.baseUrl,
        modelId: model.id,
        reasoning: model.reasoning,
        reasoningEfforts: capabilities?.reasoningEfforts,
        pi: { models: this.#piModelsFor(entry?.ownerId), model },
        // Keyless OpenCode Zen requests carry no credential at all.
        ...(this.#keylessOpenCode(entry)
          ? { apiKey: "unused", headers: { authorization: null } }
          : {}),
        ...(codex
          ? {
              headers: { originator: "opengui", "user-agent": "OpenGUI/1.0" },
              transport: this.#codexPiTransport,
              websocketConnectTimeoutMs: 15_000,
            }
          : {}),
      };
    }
    const configuredRoute = connection.modelRoutes?.[selection.modelId];
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
      apiKey: this.#apiKeys[connection.id],
      reasoning: capabilities?.reasoning,
      reasoningEfforts: capabilities?.reasoningEfforts,
      contextWindow: capabilities?.context,
      maxTokens: capabilities?.maxTokens,
      thinkingLevelMap: capabilities?.thinkingLevelMap,
      compat: capabilities?.compat,
    };
  }

  #keylessOpenCode(entry?: ProviderCredentialEntry) {
    return (
      entry?.providerId === "opencode" &&
      entry.credential.type === "api_key" &&
      !entry.credential.key
    );
  }

  /** A pi provider rejected an OAuth token before any output: refresh it once and replay. */
  async *#streamProvider(
    request: ModelRequest,
    signal: AbortSignal,
    connection: HostModelConnection,
  ): AsyncGenerator<ModelStreamEvent> {
    const codex = connection.providerId === "openai-codex";
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
            if (codex) await this.#recordCodexDiagnostic(request, completed.response);
            yield completed;
          } else {
            if (codex && event.type === "completed" && event.response) {
              await this.#recordCodexDiagnostic(request, event.response);
            }
            yield event;
          }
        }
        return;
      } catch (error) {
        const entry = this.#providerCredentials[connection.id];
        if (
          attempts !== 1 ||
          emitted ||
          entry?.credential.type !== "oauth" ||
          !(error instanceof ModelTransportError) ||
          error.normalized.code !== "authentication"
        ) {
          if (codex && error instanceof ModelTransportError) {
            await this.#recordCodexDiagnostic(request, error.response);
          }
          throw error;
        }
        // Never replay after any model delta or tool argument has escaped. Expiring the
        // stored token makes pi refresh it under its credential lock on the retry.
        await this.#expireProviderCredential(connection.id);
      }
    }
  }

  async #expireProviderCredential(connectionId: string) {
    await this.#updateState((state) => {
      const entry = state.secrets.providerCredentials[connectionId];
      if (entry?.credential.type !== "oauth") return state;
      return {
        ...state,
        secrets: {
          ...state.secrets,
          providerCredentials: {
            ...state.secrets.providerCredentials,
            [connectionId]: { ...entry, credential: { ...entry.credential, expires: 0 } },
          },
        },
      };
    });
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
        customInstructions: normalizeCustomInstructions(parsed.customInstructions),
        scopedInstructions: normalizeScopedInstructions(parsed.scopedInstructions),
        codexTools: normalizeCodexToolsSettings(parsed.codexTools),
      };
    } catch {
      return {
        hostId: "",
        modelConnections: [],
        defaultConnectionId: null,
        projects: [],
        mcpConnections: [],
        customInstructions: "",
        scopedInstructions: { personal: {}, projects: {} },
        codexTools: normalizeCodexToolsSettings(undefined),
      };
    }
  }

  async #loadLegacySecrets(): Promise<HostSecretsFile & { legacy?: Record<string, unknown> }> {
    try {
      const raw = await readFile(this.#secretsPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const apiKeys = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            entry[0] !== "codex" && entry[0] !== "subscriptions" && typeof entry[1] === "string",
        ),
      );
      const subscriptions =
        parsed.subscriptions && typeof parsed.subscriptions === "object"
          ? (parsed.subscriptions as Record<string, unknown>)
          : {};
      return {
        apiKeys,
        providerCredentials: {},
        mcp: {},
        mail: null,
        legacy: { codexTokens: parsed.codex, subscriptionTokens: subscriptions },
      };
    } catch {
      return { apiKeys: {}, providerCredentials: {}, mcp: {}, mail: null };
    }
  }

  async #loadLegacyState(): Promise<HostDurableState> {
    const settings = await this.#loadLegacySettings();
    const { legacy, ...secrets } = await this.#loadLegacySecrets();
    const migrated = migrateLegacyProviderCredentials({
      ...legacy,
      providerCredentials: secrets.providerCredentials,
      apiKeys: secrets.apiKeys,
      modelConnections: settings.modelConnections,
    });
    return {
      version: 1,
      settings: { ...settings, modelConnections: migrated.modelConnections },
      secrets: {
        ...secrets,
        apiKeys: migrated.apiKeys,
        providerCredentials: migrated.providerCredentials,
      },
    };
  }

  #validateState(value: unknown): HostDurableState {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid state");
    const state = value as Partial<HostDurableState>;
    if (state.version !== 1 || !state.settings || !state.secrets) throw new Error("Invalid state");
    // Pre-pi Hosts stored first-party OAuth tokens beside the API keys.
    const legacySecrets = state.secrets as Record<string, unknown>;
    const migrated = migrateLegacyProviderCredentials({
      providerCredentials: validProviderCredentials(state.secrets.providerCredentials),
      apiKeys:
        state.secrets.apiKeys && typeof state.secrets.apiKeys === "object"
          ? Object.fromEntries(
              Object.entries(state.secrets.apiKeys).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : {},
      modelConnections: Array.isArray(state.settings.modelConnections)
        ? state.settings.modelConnections
        : [],
      codexTokens: legacySecrets.codexTokens,
      subscriptionTokens: legacySecrets.subscriptionTokens,
      personalCodexTokens: legacySecrets.personalCodexTokens,
      personalSubscriptionTokens: legacySecrets.personalSubscriptionTokens,
    });
    const defaultConnectionId =
      typeof state.settings.defaultConnectionId === "string"
        ? (RETIRED_PROVIDER_CONNECTION_IDS[state.settings.defaultConnectionId] ??
          state.settings.defaultConnectionId)
        : null;
    return {
      version: 1,
      settings: {
        hostId: typeof state.settings.hostId === "string" ? state.settings.hostId : "",
        modelConnections: migrated.modelConnections,
        defaultConnectionId,
        projects: Array.isArray(state.settings.projects)
          ? state.settings.projects.filter((item): item is string => typeof item === "string")
          : [],
        mcpConnections: Array.isArray(state.settings.mcpConnections)
          ? (state.settings.mcpConnections as HostMcpConnection[])
          : [],
        customInstructions: normalizeCustomInstructions(state.settings.customInstructions),
        scopedInstructions: normalizeScopedInstructions(state.settings.scopedInstructions),
        codexTools: normalizeCodexToolsSettings(state.settings.codexTools),
      },
      secrets: {
        apiKeys: migrated.apiKeys,
        providerCredentials: migrated.providerCredentials,
        mcp:
          state.secrets.mcp && typeof state.secrets.mcp === "object"
            ? structuredClone(state.secrets.mcp)
            : {},
        mail: validMailSecrets(state.secrets.mail),
      },
    };
  }

  #applyState(state: HostDurableState) {
    this.#settings = structuredClone(state.settings);
    this.#apiKeys = { ...state.secrets.apiKeys };
    this.#providerCredentials = structuredClone(state.secrets.providerCredentials);
    this.#mcpSecrets = structuredClone(state.secrets.mcp);
    this.#mailSecrets = validMailSecrets(state.secrets.mail);
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

  #refreshTransport() {
    this.#transport.setConnections(
      this.listModelConnections()
        .filter((connection) => !connection.providerId)
        .map((connection) => ({ ...connection, apiKey: this.#apiKeys[connection.id] })),
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

  async refreshModelCatalogs(force = false) {
    const providers = new Set(
      Object.values(this.#providerCredentials).map((entry) => entry.providerId),
    );
    await Promise.all([...providers].map((providerId) => this.#catalog.refresh(providerId, force)));
    this.#refreshTransport();
  }

  health(): HostHealth {
    return {
      ok: true,
      version: process.env.OPENGUI_VERSION || process.env.npm_package_version || "0.0.0",
      shell: process.env.SHELL || (process.platform === "win32" ? "powershell" : "/bin/sh"),
    };
  }

  /** Health plus storage pressure. Never fails: an unreadable filesystem reports no warning. */
  async healthWithStorage(): Promise<HostHealth> {
    const health = this.health();
    try {
      const stats = await statfs(this.#dataDirectory);
      const lowDiskSpace = isLowDiskSpace(stats.bavail * stats.bsize, stats.blocks * stats.bsize);
      if (lowDiskSpace && !this.#lowDiskWarned) {
        console.warn(`OpenGUI data directory is low on disk space: ${this.#dataDirectory}`);
      }
      this.#lowDiskWarned = lowDiskSpace;
      return { ...health, lowDiskSpace };
    } catch {
      return health;
    }
  }

  /**
   * Owner-configured SMTP password for Host mail delivery. The secret lives in
   * Host secret storage alongside the other Host secrets; it is never exposed
   * through settings reads, events, or diagnostics. `null` means no password.
   */
  getMailSmtpPassword(): string | null {
    return this.#mailSecrets?.smtpPassword ?? null;
  }

  async setMailSmtpPassword(password: string | null): Promise<void> {
    if (password !== null && (password.length < 1 || password.length > 1024)) {
      throw new Error("SMTP password must be 1-1024 characters or cleared");
    }
    await this.#updateState((state) => ({
      ...state,
      secrets: { ...state.secrets, mail: password === null ? null : { smtpPassword: password } },
    }));
  }

  getCustomInstructions() {
    return this.#settings.customInstructions;
  }

  getCodexToolsSettings(): CodexToolsSettings {
    return { ...this.#settings.codexTools };
  }

  async setCodexToolsSettings(value: Partial<Record<keyof CodexToolsSettings, unknown>>) {
    if (
      value.webSearch !== undefined &&
      value.webSearch !== "off" &&
      value.webSearch !== "cached" &&
      value.webSearch !== "live"
    )
      throw new Error("webSearch must be off, cached, or live");
    for (const key of ["imageGeneration", "sharedOfferings"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "boolean")
        throw new Error(`${key} must be a boolean`);
    }
    const codexTools = normalizeCodexToolsSettings({ ...this.#settings.codexTools, ...value });
    await this.#updateState((state) => ({
      ...state,
      settings: { ...state.settings, codexTools },
    }));
    return this.getCodexToolsSettings();
  }

  /**
   * The ChatGPT credential behind a run's Codex model, following shared offerings
   * to the Host connection. Any other provider yields no ChatGPT tools.
   */
  async #codexToolRoute(
    selection: ModelSelection | null | undefined,
    actor: DurableActor | undefined,
  ): Promise<CodexToolRoute | null> {
    if (!selection) return null;
    let routed = selection;
    let shared = false;
    if (selection.connectionId === MODEL_OFFERING_CONNECTION_ID) {
      const resolved = await this.#resolveModelOffering?.(selection.modelId, actor).catch(
        () => undefined,
      );
      if (!resolved) return null;
      routed = { connectionId: resolved.connectionId, modelId: resolved.modelId };
      shared = true;
    }
    const connection = this.#findConnection(routed.connectionId, shared ? undefined : actor);
    if (connection?.providerId !== "openai-codex") return null;
    const entry = this.#providerCredentials[connection.id];
    if (entry?.credential.type !== "oauth") return null;
    const model = this.#catalog.model(connection.providerId, routed.modelId);
    if (!model) return null;
    const connectionId = connection.id;
    const models = this.#piModelsFor(entry.ownerId);
    return {
      modelId: model.id,
      shared,
      credential: async (forceRefresh) => {
        // Expiring the stored token makes pi refresh it under its credential lock.
        if (forceRefresh) await this.#expireProviderCredential(connectionId);
        const resolved = await models.getAuth(model);
        const accessToken = resolved?.auth.apiKey;
        if (!accessToken) throw new Error("ChatGPT sign-in is unavailable. Reconnect Codex.");
        return { accessToken };
      },
    };
  }

  async setCustomInstructions(value: string) {
    const customInstructions = normalizeCustomInstructions(value, { rejectOverLimit: true });
    if (this.#settings.customInstructions === customInstructions) return customInstructions;
    await this.#updateState((state) => ({
      ...state,
      settings: { ...state.settings, customInstructions },
    }));
    return customInstructions;
  }

  getPersonalInstructions(actor?: DurableActor) {
    return this.#settings.scopedInstructions.personal[personalInstructionKey(actor)] ?? "";
  }

  async setPersonalInstructions(value: string, actor?: DurableActor) {
    const text = normalizeCustomInstructions(value, { rejectOverLimit: true });
    await this.#updateState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        scopedInstructions: {
          ...state.settings.scopedInstructions,
          personal: {
            ...state.settings.scopedInstructions.personal,
            [personalInstructionKey(actor)]: text,
          },
        },
      },
    }));
    return text;
  }

  async getProjectInstructions(directory: string, actor?: DurableActor) {
    directory = await this.#pathAuthorizer.authorizePath(actor, directory, "read");
    if (!this.#settings.projects.includes(directory)) throw new Error("Project is not registered");
    return {
      directory,
      ...structuredClone(
        this.#settings.scopedInstructions.projects[directory] ?? { text: "", teamEditors: {} },
      ),
    };
  }

  async setProjectInstructions(directory: string, value: string, actor?: DurableActor) {
    const project = await this.getProjectInstructions(directory, actor);
    const text = normalizeCustomInstructions(value, { rejectOverLimit: true });
    await this.#updateState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        scopedInstructions: {
          ...state.settings.scopedInstructions,
          projects: {
            ...state.settings.scopedInstructions.projects,
            [project.directory]: {
              ...state.settings.scopedInstructions.projects[project.directory],
              text,
              teamEditors:
                state.settings.scopedInstructions.projects[project.directory]?.teamEditors ?? {},
            },
          },
        },
      },
    }));
    return text;
  }

  async setProjectInstructionEditor(
    directory: string,
    teamId: string,
    allowed: boolean,
    actor?: DurableActor,
  ) {
    const project = await this.getProjectInstructions(directory, actor);
    await this.#updateState((state) => {
      const current = state.settings.scopedInstructions.projects[project.directory] ?? {
        text: "",
        teamEditors: {},
      };
      return {
        ...state,
        settings: {
          ...state.settings,
          scopedInstructions: {
            ...state.settings.scopedInstructions,
            projects: {
              ...state.settings.scopedInstructions.projects,
              [project.directory]: {
                ...current,
                teamEditors: { ...current.teamEditors, [teamId]: allowed },
              },
            },
          },
        },
      };
    });
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

  listModelConnections(actor?: DurableActor): HostModelConnection[] {
    const actorId = this.#personalActorId(actor);
    const entries = Object.entries(this.#providerCredentials);
    const personal = actorId ? entries.filter(([, entry]) => entry.ownerId === actorId) : [];
    // A personal credential replaces the Host's connection to the same provider for its owner.
    const personalProviders = new Set(personal.map(([, entry]) => entry.providerId));
    const shared = entries.filter(
      ([, entry]) => !entry.ownerId && !personalProviders.has(entry.providerId),
    );
    const providerConnections = [...shared, ...personal].flatMap(([connectionId, entry]) => {
      const provider = piProvider(entry.providerId);
      if (!provider) return [];
      return [
        {
          ...this.#catalog.connection(
            entry.providerId,
            {
              id: connectionId,
              label: provider.name,
              baseUrl: provider.baseUrl ?? "",
              defaultModelId: PI_PROVIDER_DEFAULT_MODELS[entry.providerId],
            },
            this.#keylessOpenCode(entry),
          ),
          providerId: entry.providerId,
          authType: entry.credential.type,
        },
      ];
    });
    const providerIds = new Set(providerConnections.map((connection) => connection.id));
    return [
      ...providerConnections,
      ...this.#settings.modelConnections
        .filter((connection) => !providerIds.has(connection.id))
        .map(({ apiKey: _apiKey, ...connection }) => connection),
    ];
  }

  #personalActorId(actor?: DurableActor) {
    return actor?.type === "user" ? actor.id : null;
  }

  /** The actor's personal connection to a pi provider, if they have one. */
  personalProviderConnection(providerId: string, actor?: DurableActor) {
    const actorId = this.#personalActorId(actor);
    if (!actorId) return undefined;
    const connectionId = providerCredentialConnectionId(
      this.#providerCredentials,
      providerId,
      actorId,
    );
    return connectionId
      ? this.listModelConnections(actor).find((connection) => connection.id === connectionId)
      : undefined;
  }

  #requireProvider(providerId: string) {
    const provider = piProvider(providerId);
    if (!provider) throw new Error(`Unknown model provider: ${providerId}`);
    return provider;
  }

  #loginKey(providerId: string, actor?: DurableActor) {
    return JSON.stringify([this.#personalActorId(actor), providerId]);
  }

  /** Every pi provider, with the actor's connection and any sign-in in progress. */
  listProviders(actor?: DurableActor): HostProviderInfo[] {
    const actorId = this.#personalActorId(actor) ?? undefined;
    return piProviderDescriptors().map((provider) => {
      const connectionId =
        (actorId &&
          providerCredentialConnectionId(this.#providerCredentials, provider.id, actorId)) ||
        providerCredentialConnectionId(this.#providerCredentials, provider.id);
      const entry = connectionId ? this.#providerCredentials[connectionId] : undefined;
      const login = this.#providerLogins.status(this.#loginKey(provider.id, actor));
      return {
        ...provider,
        ...(connectionId && entry
          ? {
              connection: {
                id: connectionId,
                authType: entry.credential.type,
                personal: Boolean(entry.ownerId),
              },
            }
          : {}),
        ...(login && (login.state === "running" || login.state === "awaiting_input")
          ? { login }
          : {}),
      };
    });
  }

  providerLoginStatus(providerId: string, actor?: DurableActor): ProviderLoginStatus | undefined {
    this.#requireProvider(providerId);
    return this.#providerLogins.status(this.#loginKey(providerId, actor));
  }

  /** Starts pi's sign-in flow. Prompts and progress surface through `providerLoginStatus`. */
  beginProviderLogin(providerId: string, method: ProviderAuthMethod, actor?: DurableActor) {
    const provider = this.#requireProvider(providerId);
    const auth = method === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    if (!auth?.login) throw new Error(`${provider.name} does not support this sign-in method`);
    const ownerId = this.#personalActorId(actor) ?? undefined;
    const models = this.#piModelsFor(ownerId);
    return this.#providerLogins.begin(
      this.#loginKey(providerId, actor),
      { providerId, method },
      async (interaction) => {
        await models.login(providerId, method, interaction, {
          getDeviceId: () => this.#settings.hostId,
        });
        await this.refreshModelCatalogs();
        return providerCredentialConnectionId(this.#providerCredentials, providerId, ownerId);
      },
    );
  }

  async respondProviderLogin(
    providerId: string,
    promptId: string,
    value: string,
    actor?: DurableActor,
  ) {
    this.#requireProvider(providerId);
    return await this.#providerLogins.respond(this.#loginKey(providerId, actor), promptId, value);
  }

  cancelProviderLogin(providerId: string, actor?: DurableActor) {
    this.#requireProvider(providerId);
    return this.#providerLogins.cancel(this.#loginKey(providerId, actor));
  }

  /** Signs out of a provider in the actor's scope, removing that connection. */
  async disconnectProvider(providerId: string, actor?: DurableActor) {
    this.#requireProvider(providerId);
    const ownerId = this.#personalActorId(actor) ?? undefined;
    this.#providerLogins.cancel(this.#loginKey(providerId, actor));
    const connectionId = providerCredentialConnectionId(
      this.#providerCredentials,
      providerId,
      ownerId,
    );
    const credential = connectionId
      ? this.#providerCredentials[connectionId]?.credential
      : undefined;
    await this.#piModelsFor(ownerId).logout(providerId);
    if (connectionId) await this.#forgetDefaultConnection(connectionId);
    this.#piAiTransport.close();
    if (providerId === "openai-codex" && credential?.type === "oauth") {
      await revokeCodexToken(credential.refresh, this.#fetch);
    }
    return connectionId;
  }

  async #forgetDefaultConnection(connectionId: string) {
    if (this.#settings.defaultConnectionId !== connectionId) return;
    await this.#updateState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        defaultConnectionId: this.listModelConnections()[0]?.id ?? null,
      },
    }));
  }

  async upsertModelConnection(connection: HostModelConnection) {
    if (reservedConnectionId(connection.id)) {
      throw new Error(
        `Connection id ${connection.id} is reserved for a model provider. Sign in to it under Providers.`,
      );
    }
    let publicConnection: HostModelConnection | undefined;
    await this.#updateState(async (state) => {
      const apiKeys = { ...state.secrets.apiKeys };
      if (connection.apiKey) apiKeys[connection.id] = connection.apiKey;
      const { providerId: _providerId, authType: _authType, ...custom } = connection;
      publicConnection = { ...custom, apiKey: undefined };
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
      const providerCredentials = { ...state.secrets.providerCredentials };
      delete providerCredentials[connectionId];
      const remaining = [
        ...Object.keys(providerCredentials).filter((id) => !providerCredentials[id]!.ownerId),
        ...modelConnections.map((item) => item.id),
      ];
      return {
        ...state,
        settings: {
          ...state.settings,
          modelConnections,
          defaultConnectionId:
            state.settings.defaultConnectionId === connectionId
              ? (remaining[0] ?? null)
              : state.settings.defaultConnectionId,
        },
        secrets: { ...state.secrets, apiKeys, providerCredentials },
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
    return this.#promptAdmissions.run(sessionId, async () => {
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
    });
  }

  async prompt(
    sessionId: string,
    prompt: PromptInput,
    actor: DurableActor | undefined = prompt.actor,
    options?: { interrupt?: boolean },
  ) {
    return this.#promptAdmissions.run(sessionId, async () => {
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
    });
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
    await this.#promptAdmissions.idle(sessionId);
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
    ) => Promise<{ connectionId: string; modelId: string; executionScope: "host" }>;
    usePiAiTransport?: boolean;
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
