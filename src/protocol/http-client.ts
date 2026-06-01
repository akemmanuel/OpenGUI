import type { AgentBackendId } from "@/agents";
import {
  AGENT_BACKEND_IDS,
  AGENT_BACKEND_LABELS,
  createAgentIdCodec,
  getAgentBackendIdFromSessionId,
} from "@/agents";
import type {
  AgentBackendDescriptor,
  AgentBackendEvent,
  AgentBackendTarget,
} from "@/agents/backend";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_WORKSPACE,
  normalizeClaudeCodeEvent,
} from "@/agents/claude-code";
import { CODEX_CAPABILITIES, CODEX_WORKSPACE, normalizeCodexEvent } from "@/agents/codex";
import {
  normalizeOpenCodeEvent,
  OPENCODE_CAPABILITIES,
  OPENCODE_WORKSPACE,
} from "@/agents/opencode";
import { normalizePiEvent, PI_CAPABILITIES, PI_WORKSPACE } from "@/agents/pi";
import type {
  BackendResourceBundle,
  CreateProjectInput,
  CreateWorkspaceInput,
  MessagePageResult,
  OpenGuiCapabilities,
  OpenGuiClient,
  OpenGuiQueueEntry,
  OpenGuiProject,
  OpenGuiWorkspace,
  ProjectConnectResult,
  ProjectSessionsResult,
  SessionQueryResult,
  UpdateProjectInput,
  UpdateWorkspaceInput,
} from "@/protocol/client";
import type {
  BackendDetectionResult,
  GitMergeResult,
  GitWorktree,
  InstallResult,
  IPCResult,
  WorktreeSetupDetection,
} from "@/types/electron";

interface RpcEnvelope<T> {
  ok: boolean;
  value?: T;
  error?: string;
  code?: string;
  recoverable?: boolean;
}

export class OpenGuiRpcError extends Error {
  constructor(
    message: string,
    readonly code = "UNKNOWN",
    readonly recoverable = false,
  ) {
    super(message);
    this.name = "OpenGuiRpcError";
  }
}

function throwRpcError<T>(body: RpcEnvelope<T> | null, fallback: string): never {
  throw new OpenGuiRpcError(body?.error || fallback, body?.code, body?.recoverable);
}

interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

interface EventSourceConstructorLike {
  new (url: string): EventSourceLike;
}

export interface HttpOpenGuiClientOptions {
  baseUrl?: string;
  token?: string;
  resolveToken?: () => string | undefined;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  rpcImpl?: <T = unknown>(channel: string, args?: unknown[]) => Promise<T>;
  subscribeBackendEvents?: (
    listener: (message: { channel: string; data: unknown }) => void,
  ) => () => void;
  eventSourceImpl?: EventSourceConstructorLike;
  location?: Pick<Location, "protocol" | "host">;
  resolveBaseUrl?: () => string | undefined;
  openDirectory?: () => Promise<string | null>;
  localCapabilities?: boolean;
}

const INITIAL_EVENT_RETRY_MS = 1_000;
const MAX_EVENT_RETRY_MS = 30_000;

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function httpRpc<T>(
  path: string,
  token: string | undefined,
  channel: string,
  args: unknown[] = [],
): Promise<T> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(joinUrl(path, "/api/rpc"), {
    method: "POST",
    headers,
    body: JSON.stringify({ channel, args }),
  });
  const body = (await response.json().catch(() => null)) as RpcEnvelope<T> | null;
  if (!response.ok || !body?.ok) throwRpcError(body, `RPC failed: ${channel}`);
  return body.value as T;
}

const WEB_BACKEND_META = {
  opencode: {
    capabilities: OPENCODE_CAPABILITIES,
    workspace: OPENCODE_WORKSPACE,
    normalizeEvent: normalizeOpenCodeEvent,
  },
  "claude-code": {
    capabilities: CLAUDE_CODE_CAPABILITIES,
    workspace: CLAUDE_CODE_WORKSPACE,
    normalizeEvent: normalizeClaudeCodeEvent,
  },
  pi: { capabilities: PI_CAPABILITIES, workspace: PI_WORKSPACE, normalizeEvent: normalizePiEvent },
  codex: {
    capabilities: CODEX_CAPABILITIES,
    workspace: CODEX_WORKSPACE,
    normalizeEvent: normalizeCodexEvent,
  },
} satisfies Record<
  AgentBackendId,
  Pick<AgentBackendDescriptor, "capabilities" | "workspace"> & {
    normalizeEvent: (event: never) => AgentBackendEvent | null;
  }
>;

function targetArgs(target?: AgentBackendTarget) {
  return [target?.directory, target?.workspaceId];
}

function unwrapIpcResult<T>(result: IPCResult<T>, fallback: string): T {
  if (!result?.success) throw new Error(result?.error || fallback);
  return result.data as T;
}

function unwrapBridgeResult<T>(result: T | IPCResult<T>, fallback: string): T {
  if (
    result &&
    typeof result === "object" &&
    "success" in result &&
    typeof (result as IPCResult<T>).success === "boolean"
  ) {
    return unwrapIpcResult(result as IPCResult<T>, fallback);
  }
  return result as T;
}

function normalizeSkillList<T>(value: T[] | Record<string, T> | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function appendTarget(target?: AgentBackendTarget, ...args: unknown[]) {
  return [...targetArgs(target), ...args];
}

function createOpenCodePlatform(
  op: <T>(suffix: string, args?: unknown[]) => Promise<T>,
): AgentBackendDescriptor["platform"] {
  const platformOp = async <T>(suffix: string, fallback: string, args: unknown[] = []) =>
    unwrapBridgeResult(await op<T | IPCResult<T>>(suffix, args), fallback);

  return {
    server: {
      start: () => platformOp("server:start", "Failed to start server"),
      stop: () => platformOp("server:stop", "Failed to stop server"),
      status: () => platformOp("server:status", "Failed to get server status"),
    },
    providers: {
      listAll: (target) =>
        platformOp("provider:list", "Failed to list providers", targetArgs(target)),
      getAuthMethods: (target) =>
        platformOp(
          "provider:auth-methods",
          "Failed to load provider auth methods",
          targetArgs(target),
        ),
      connect: (target, providerID, auth) =>
        platformOp(
          "provider:connect",
          `Failed to connect provider: ${providerID}`,
          appendTarget(target, providerID, auth),
        ),
      disconnect: (target, providerID) =>
        platformOp(
          "provider:disconnect",
          `Failed to disconnect provider: ${providerID}`,
          appendTarget(target, providerID),
        ),
      oauthAuthorize: (target, providerID, method) =>
        platformOp(
          "provider:oauth:authorize",
          `Failed to start OAuth for provider: ${providerID}`,
          appendTarget(target, providerID, method),
        ),
      oauthCallback: (target, providerID, method, code) =>
        platformOp(
          "provider:oauth:callback",
          `Failed to complete OAuth for provider: ${providerID}`,
          appendTarget(target, providerID, method, code),
        ),
      dispose: (target) =>
        platformOp("instance:dispose", "Failed to dispose provider instance", targetArgs(target)),
    },
    mcp: {
      status: (target) => platformOp("mcp:status", "Failed to load MCP status", targetArgs(target)),
      add: (target, name, config) =>
        platformOp(
          "mcp:add",
          `Failed to add MCP server: ${name}`,
          appendTarget(target, name, config),
        ),
      connect: (target, name) =>
        platformOp(
          "mcp:connect",
          `Failed to connect MCP server: ${name}`,
          appendTarget(target, name),
        ),
      disconnect: (target, name) =>
        platformOp(
          "mcp:disconnect",
          `Failed to disconnect MCP server: ${name}`,
          appendTarget(target, name),
        ),
    },
    skills: {
      list: async (target) =>
        normalizeSkillList(
          unwrapBridgeResult(await op("skills", targetArgs(target)), "Failed to list skills"),
        ),
      marketplace: {
        list: async (view, page, perPage, apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:list", [view, page, perPage, apiKey]),
            "Failed to list marketplace skills",
          ),
        search: async (query, limit, apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:search", [query, limit, apiKey]),
            "Failed to search marketplace skills",
          ),
        detail: async (source, slug, apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:detail", [source, slug, apiKey]),
            "Failed to load marketplace skill",
          ),
        audit: async (source, slug, apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:audit", [source, slug, apiKey]),
            "Failed to audit marketplace skill",
          ),
        curated: async (apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:curated", [apiKey]),
            "Failed to load curated marketplace skills",
          ),
      },
      install: async (source, directory, globalScope) =>
        unwrapBridgeResult(
          await op("skills:install", [source, directory, globalScope]),
          "Failed to install skill",
        ),
      remove: async (skillName, directory, globalScope) =>
        unwrapBridgeResult(
          await op("skills:remove", [skillName, directory, globalScope]),
          "Failed to remove skill",
        ),
      update: async (skillName, directory, globalScope) =>
        unwrapBridgeResult(
          await op("skills:update", [skillName, directory, globalScope]),
          "Failed to update skill",
        ),
      listInstalled: async (directory) =>
        normalizeSkillList(
          unwrapBridgeResult(
            await op("skills:list-installed", [directory]),
            "Failed to list installed skills",
          ),
        ),
      checkCli: async () =>
        unwrapBridgeResult(await op("skills:check-cli"), "Failed to check skills CLI"),
    },
    config: {
      get: (target) => platformOp("config:get", "Failed to load config", targetArgs(target)),
      update: (target, config) =>
        platformOp("config:update", "Failed to update config", appendTarget(target, config)),
    },
  };
}

function createPiPlatform(
  op: <T>(suffix: string, args?: unknown[]) => Promise<T>,
): AgentBackendDescriptor["platform"] {
  const platformOp = async <T>(suffix: string, fallback: string, args: unknown[] = []) =>
    unwrapBridgeResult(await op<T | IPCResult<T>>(suffix, args), fallback);

  return {
    providers: {
      listAll: (target) =>
        platformOp("provider:list", "Failed to list providers", targetArgs(target)),
      getAuthMethods: (target) =>
        platformOp(
          "provider:auth-methods",
          "Failed to load provider auth methods",
          targetArgs(target),
        ),
      connect: (target, providerID, auth) =>
        platformOp(
          "provider:connect",
          `Failed to connect provider: ${providerID}`,
          appendTarget(target, providerID, auth),
        ),
      disconnect: (target, providerID) =>
        platformOp(
          "provider:disconnect",
          `Failed to disconnect provider: ${providerID}`,
          appendTarget(target, providerID),
        ),
      oauthAuthorize: (target, providerID, method) =>
        platformOp(
          "provider:oauth:authorize",
          `Failed to start OAuth for provider: ${providerID}`,
          appendTarget(target, providerID, method),
        ),
      oauthCallback: (target, providerID, method, code) =>
        platformOp(
          "provider:oauth:callback",
          `Failed to complete OAuth for provider: ${providerID}`,
          appendTarget(target, providerID, method, code),
        ),
      dispose: (target) =>
        platformOp("instance:dispose", "Failed to dispose provider instance", targetArgs(target)),
    },
  };
}

function createWebBackendDescriptor(
  backendId: AgentBackendId,
  rpcCall: <T>(channel: string, args?: unknown[]) => Promise<T>,
  runtimeOverrides: Partial<AgentBackendDescriptor["runtime"]> = {},
): AgentBackendDescriptor {
  const meta = WEB_BACKEND_META[backendId];
  const backendCall = async <T>(suffix: string, args: unknown[] = []) =>
    unwrapIpcResult(
      await rpcCall<IPCResult<T>>(`${backendId}:${suffix}`, args),
      `Backend call failed: ${backendId}:${suffix}`,
    );
  const runtime: AgentBackendDescriptor["runtime"] = {
    createSession: ({ title, directory, workspaceId } = {}) =>
      backendCall("session:create", [title, directory, workspaceId]),
    startSession: (input) => backendCall("session:start", [input]),
    deleteSession: (sessionId) => backendCall("session:delete", [sessionId]),
    renameSession: (sessionId, title) => backendCall("session:update", [sessionId, title]),
    compactSession: (sessionId, model, target) =>
      backendCall("session:summarize", [sessionId, model, ...targetArgs(target)]),
    forkSession: (sessionId, messageID) => backendCall("session:fork", [sessionId, messageID]),
    revertSession: (sessionId, messageID, partID) =>
      backendCall("session:revert", [sessionId, messageID, partID]),
    unrevertSession: (sessionId) => backendCall("session:unrevert", [sessionId]),
    sendCommand: (input) =>
      backendCall("command:send", [
        input.sessionId,
        input.command,
        input.args,
        input.model,
        input.agent,
        input.variant,
        input.directory,
        input.workspaceId,
      ]),
    ...runtimeOverrides,
  };
  const op = <T>(suffix: string, args: unknown[] = []) =>
    rpcCall<T>(`${backendId}:${suffix}`, args);
  const platform =
    backendId === "opencode"
      ? createOpenCodePlatform(op)
      : backendId === "pi"
        ? createPiPlatform(op)
        : undefined;

  return {
    id: backendId,
    label: AGENT_BACKEND_LABELS[backendId],
    capabilities: meta.capabilities,
    workspace: meta.workspace,
    runtime,
    platform,
    normalizeEvent: meta.normalizeEvent as (event: unknown) => AgentBackendEvent | null,
  } as AgentBackendDescriptor & { normalizeEvent: (event: unknown) => AgentBackendEvent | null };
}

function eventUrl(
  baseUrl: string,
  token?: string,
  currentLocation?: Pick<Location, "protocol" | "host">,
) {
  if (!baseUrl) {
    if (!currentLocation) {
      throw new OpenGuiRpcError("Cannot derive event URL without baseUrl or browser location");
    }
    const url = new URL(`${currentLocation.protocol}//${currentLocation.host}/api/events/v2`);
    if (token) url.searchParams.set("token", token);
    return url.toString();
  }
  const url = new URL(baseUrl);
  url.pathname = "/api/events/v2";
  url.search = "";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

interface SessionRecordResponse {
  id: string;
  rawId: string;
  workspaceId: string;
  projectId: string;
  harnessId: AgentBackendId;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "error" | "unknown";
  metadata?: Record<string, unknown>;
}

interface SessionListResponse {
  sessions: SessionRecordResponse[];
  nextCursor: string | null;
}

interface SessionQueryResponse {
  items: Array<{
    frontendProjectId: string;
    directory: string;
    workspaceId?: string;
    harnessId: AgentBackendId;
    sessions: SessionRecordResponse[];
  }>;
  errors?: Array<{
    frontendProjectId: string;
    directory: string;
    workspaceId?: string;
    harnessId?: AgentBackendId;
    error: string;
  }>;
}

interface SessionLookupInput {
  sessionId: string;
  backendId?: AgentBackendId;
  target?: AgentBackendTarget;
  workspaceId?: string;
  directory?: string;
  baseUrl?: string;
}

interface CanonicalEventEnvelope {
  id: string;
  type: string;
  createdAt: string;
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  harnessId?: string;
  payload: unknown;
}

function toProjectDisplayName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path || "Project";
}

function isCanonicalEventEnvelope(value: unknown): value is CanonicalEventEnvelope {
  return !!value && typeof value === "object" && "type" in value && "payload" in value;
}

export function createHttpOpenGuiClient(options: HttpOpenGuiClientOptions = {}): OpenGuiClient {
  const baseUrl = options.baseUrl ?? "";
  const getDefaultBaseUrl = () => options.resolveBaseUrl?.() ?? baseUrl;
  const getToken = () => options.resolveToken?.() ?? options.token;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function requestAt<T>(
    requestBaseUrl: string,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const scopedToken = baseUrlTokens.get(requestBaseUrl.replace(/\/+$/, "")) ?? getToken();
    if (scopedToken) headers.set("authorization", `Bearer ${scopedToken}`);

    const response = await fetchImpl(joinUrl(requestBaseUrl, path), { ...init, headers });
    const body = (await response.json().catch(() => null)) as RpcEnvelope<T> | null;
    if (!response.ok || !body?.ok) {
      throwRpcError(body, `Request failed: ${path}`);
    }
    return body.value as T;
  }

  const request = <T>(path: string, init: RequestInit = {}) =>
    requestAt<T>(getDefaultBaseUrl(), path, init);

  const rpcCall = <T>(channel: string, args: unknown[] = []) =>
    options.rpcImpl?.<T>(channel, args) ??
    httpRpc<T>(getDefaultBaseUrl(), getToken(), channel, args);
  const backendIdsOrAll = (backendIds?: AgentBackendId[]) =>
    backendIds?.length ? backendIds : AGENT_BACKEND_IDS;
  const backendChannel = (backendId: AgentBackendId, suffix: string) => `${backendId}:${suffix}`;
  const backendRpc = async <T>(backendId: AgentBackendId, suffix: string, args: unknown[] = []) =>
    unwrapIpcResult(
      await rpcCall<IPCResult<T>>(backendChannel(backendId, suffix), args),
      `Backend call failed: ${backendId}:${suffix}`,
    );
  const projectById = new Map<string, Promise<OpenGuiProject | null>>();
  const workspaceBaseUrls = new Map<string, string>();
  const workspaceTokens = new Map<string, string>();
  const baseUrlTokens = new Map<string, string>();
  const sessionBaseUrls = new Map<string, string>();
  const sessionRecordByCanonicalId = new Map<string, SessionRecordResponse>();
  const sessionCanonicalIdsByFrontendId = new Map<string, Set<string>>();

  const getProject = async (id: string): Promise<OpenGuiProject | null> => {
    if (!id) return null;
    const existing = projectById.get(id);
    if (existing) return existing;
    const promise = request<OpenGuiProject>(`/api/projects/${encodeURIComponent(id)}`)
      .then((project) => project)
      .catch((error) => {
        if (error instanceof Error && error.message === "Project not found") return null;
        throw error;
      });
    projectById.set(id, promise);
    return promise;
  };

  const requestBaseUrlForTarget = (target?: AgentBackendTarget) => {
    const normalizedBaseUrl = target?.baseUrl?.replace(/\/+$/, "");
    if (target?.workspaceId && normalizedBaseUrl) {
      workspaceBaseUrls.set(target.workspaceId, normalizedBaseUrl);
    }
    if (target?.workspaceId && target.authToken) {
      workspaceTokens.set(target.workspaceId, target.authToken);
    }
    const resolvedBaseUrl =
      normalizedBaseUrl ??
      (target?.workspaceId
        ? (workspaceBaseUrls.get(target.workspaceId) ?? getDefaultBaseUrl())
        : getDefaultBaseUrl());
    const resolvedToken =
      target?.authToken ??
      (target?.workspaceId ? workspaceTokens.get(target.workspaceId) : undefined);
    if (resolvedToken) baseUrlTokens.set(resolvedBaseUrl.replace(/\/+$/, ""), resolvedToken);
    return resolvedBaseUrl;
  };

  const rememberSessionBaseUrl = (record: SessionRecordResponse, requestBaseUrl: string) => {
    if (!requestBaseUrl) return;
    sessionBaseUrls.set(record.id, requestBaseUrl);
    sessionBaseUrls.set(frontendSessionIdFromRecord(record), requestBaseUrl);
  };

  const requestBaseUrlForSession = (input: SessionLookupInput) => {
    const targetBaseUrl = requestBaseUrlForTarget(input.target ?? input);
    if (targetBaseUrl) return targetBaseUrl;
    const direct = sessionRecordByCanonicalId.get(input.sessionId);
    if (direct) return sessionBaseUrls.get(direct.id) ?? getDefaultBaseUrl();
    const canonicalIds = sessionCanonicalIdsByFrontendId.get(input.sessionId);
    for (const canonicalId of canonicalIds ?? []) {
      const sessionBaseUrl = sessionBaseUrls.get(canonicalId);
      if (sessionBaseUrl) return sessionBaseUrl;
    }
    return sessionBaseUrls.get(input.sessionId) ?? getDefaultBaseUrl();
  };

  const findProjectForTarget = async (
    target?: AgentBackendTarget,
  ): Promise<OpenGuiProject | null> => {
    const directory = target?.directory;
    if (!directory) return null;
    const normalizedDirectory = directory.replace(/[\\/]+$/, "");
    const projects = await requestAt<OpenGuiProject[]>(
      requestBaseUrlForTarget(target),
      "/api/projects",
    );
    return (
      projects.find(
        (project) =>
          project.path === directory ||
          project.canonicalPath === directory ||
          project.path === normalizedDirectory ||
          project.canonicalPath === normalizedDirectory,
      ) ?? null
    );
  };

  const ensureProjectForTarget = async (
    target?: AgentBackendTarget,
  ): Promise<OpenGuiProject | null> => {
    if (!target?.directory) return null;
    const existing = await findProjectForTarget(target);
    if (existing) return existing;
    return await requestAt<OpenGuiProject>(requestBaseUrlForTarget(target), "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        path: target.directory,
        displayName: toProjectDisplayName(target.directory),
      } satisfies CreateProjectInput),
    });
  };

  const frontendSessionIdFromRecord = (record: SessionRecordResponse) =>
    createAgentIdCodec(record.harnessId).compose(record.rawId);

  const rememberSessionRecord = (record: SessionRecordResponse) => {
    sessionRecordByCanonicalId.set(record.id, record);
    const frontendId = frontendSessionIdFromRecord(record);
    const canonicalIds = sessionCanonicalIdsByFrontendId.get(frontendId) ?? new Set<string>();
    canonicalIds.add(record.id);
    sessionCanonicalIdsByFrontendId.set(frontendId, canonicalIds);
  };

  const listSessionRecordCandidates = (input: SessionLookupInput): SessionRecordResponse[] => {
    const direct = sessionRecordByCanonicalId.get(input.sessionId);
    const canonicalIds = sessionCanonicalIdsByFrontendId.get(input.sessionId);
    const candidates = [
      ...(direct ? [direct] : []),
      ...[...(canonicalIds ?? [])]
        .map((canonicalId) => sessionRecordByCanonicalId.get(canonicalId))
        .filter((record): record is SessionRecordResponse => Boolean(record)),
    ];
    const backendId =
      input.backendId ?? getAgentBackendIdFromSessionId(input.sessionId) ?? undefined;
    return candidates.filter((record, index) => {
      if (candidates.findIndex((candidate) => candidate.id === record.id) !== index) return false;
      return !backendId || record.harnessId === backendId;
    });
  };

  const resolveSessionPath = async (input: SessionLookupInput, suffix = ""): Promise<string> => {
    const direct = sessionRecordByCanonicalId.get(input.sessionId);
    if (direct) return `/api/sessions/${encodeURIComponent(direct.id)}${suffix}`;

    let candidates = listSessionRecordCandidates(input);
    if (candidates.length === 1) {
      return `/api/sessions/${encodeURIComponent(candidates[0]!.id)}${suffix}`;
    }

    const workspaceId = input.target?.workspaceId ?? input.workspaceId;
    const directory = input.target?.directory ?? input.directory;
    const backendId =
      input.backendId ?? getAgentBackendIdFromSessionId(input.sessionId) ?? undefined;
    const params = new URLSearchParams();
    if (backendId) params.set("harnessId", backendId);

    if (directory) {
      const project = await ensureProjectForTarget({ directory, workspaceId });
      if (project) {
        params.set("projectId", project.id);
        candidates = candidates.filter(
          (record) =>
            record.projectId === project.id && (!backendId || record.harnessId === backendId),
        );
        if (candidates.length === 1) {
          return `/api/sessions/${encodeURIComponent(candidates[0]!.id)}${suffix}`;
        }
      }
    }

    const search = params.size ? `?${params.toString()}` : "";
    return `/api/sessions/${encodeURIComponent(input.sessionId)}${suffix}${search}`;
  };

  const toFrontendSessionFromDirectory = (
    record: SessionRecordResponse,
    directory: string,
    workspaceId?: string,
    requestBaseUrl?: string,
  ): ProjectSessionsResult["sessions"][number] => {
    rememberSessionRecord(record);
    if (requestBaseUrl) rememberSessionBaseUrl(record, requestBaseUrl);
    const resolvedWorkspaceId = workspaceId ?? record.workspaceId;
    return {
      id: frontendSessionIdFromRecord(record),
      slug: record.rawId,
      title: record.title,
      directory,
      projectID: directory,
      workspaceID: resolvedWorkspaceId,
      time: {
        created: Date.parse(record.createdAt),
        updated: Date.parse(record.updatedAt),
      },
      _projectDir: directory || undefined,
      _workspaceId: resolvedWorkspaceId,
      _backendId: record.harnessId,
      _rawId: record.rawId,
    } as ProjectSessionsResult["sessions"][number];
  };

  const toFrontendSession = async (
    record: SessionRecordResponse,
    project?: OpenGuiProject | null,
    requestBaseUrl?: string,
  ): Promise<ProjectSessionsResult["sessions"][number]> => {
    const resolvedProject = project ?? (await getProject(record.projectId));
    const directory = resolvedProject?.path ?? resolvedProject?.canonicalPath ?? "";
    return toFrontendSessionFromDirectory(record, directory, record.workspaceId, requestBaseUrl);
  };

  const getSessionRecord = async (sessionId: string, input: SessionLookupInput = { sessionId }) =>
    await requestAt<SessionRecordResponse>(
      requestBaseUrlForSession({ ...input, sessionId }),
      await resolveSessionPath({ ...input, sessionId }),
    );

  const runtimeOverridesForBackend = (
    backendId: AgentBackendId,
  ): Partial<AgentBackendDescriptor["runtime"]> => ({
    createSession: async ({ title, directory, workspaceId, baseUrl: targetBaseUrl } = {}) => {
      const target = { directory, workspaceId, baseUrl: targetBaseUrl };
      const project = await ensureProjectForTarget(target);
      if (!project) throw new OpenGuiRpcError("Directory is required", "INVALID_INPUT", true);
      const requestBaseUrl = requestBaseUrlForTarget(target);
      const record = await requestAt<SessionRecordResponse>(requestBaseUrl, "/api/sessions", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id, harnessId: backendId, title }),
      });
      rememberSessionBaseUrl(record, requestBaseUrl);
      return await toFrontendSession(record, project);
    },
    startSession: async (input) => {
      const project = await ensureProjectForTarget(input);
      if (!project) throw new OpenGuiRpcError("Directory is required", "INVALID_INPUT", true);
      const requestBaseUrl = requestBaseUrlForTarget(input);
      const record = await requestAt<SessionRecordResponse>(requestBaseUrl, "/api/sessions", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id, harnessId: backendId, title: input.title }),
      });
      rememberSessionBaseUrl(record, requestBaseUrl);
      await requestAt<boolean>(
        requestBaseUrl,
        `/api/sessions/${encodeURIComponent(record.id)}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({
            text: input.text,
            images: input.images,
            model: input.model,
            agent: input.agent,
            variant: input.variant,
          }),
        },
      );
      return await toFrontendSession(record, project);
    },
    deleteSession: async (sessionId) =>
      await request<boolean>(await resolveSessionPath({ sessionId, backendId }, ""), {
        method: "DELETE",
      }),
    renameSession: async (sessionId, title) => {
      const record = await request<SessionRecordResponse>(
        await resolveSessionPath({ sessionId, backendId }),
        {
          method: "PATCH",
          body: JSON.stringify({ title }),
        },
      );
      return await toFrontendSession(record);
    },
    compactSession: async (sessionId, model) => {
      await request<boolean>(await resolveSessionPath({ sessionId, backendId }, "/compact"), {
        method: "POST",
        body: JSON.stringify({ model }),
      });
    },
    forkSession: async (sessionId, messageID) => {
      const record = await request<SessionRecordResponse>(
        await resolveSessionPath({ sessionId, backendId }, "/fork"),
        {
          method: "POST",
          body: JSON.stringify({ messageId: messageID }),
        },
      );
      return await toFrontendSession(record);
    },
    revertSession: async (sessionId, messageID, partID) => {
      const value = await request<SessionRecordResponse | boolean>(
        await resolveSessionPath({ sessionId, backendId }, "/revert"),
        {
          method: "POST",
          body: JSON.stringify({ messageId: messageID, partId: partID }),
        },
      );
      return await toFrontendSession(
        typeof value === "boolean"
          ? await getSessionRecord(sessionId, { sessionId, backendId })
          : value,
      );
    },
    unrevertSession: async (sessionId) => {
      const value = await request<SessionRecordResponse | boolean>(
        await resolveSessionPath({ sessionId, backendId }, "/unrevert"),
        { method: "POST" },
      );
      return await toFrontendSession(
        typeof value === "boolean"
          ? await getSessionRecord(sessionId, { sessionId, backendId })
          : value,
      );
    },
    sendCommand: async (input) => {
      await request<boolean>(
        await resolveSessionPath(
          {
            sessionId: input.sessionId,
            backendId,
            target: { directory: input.directory, workspaceId: input.workspaceId },
          },
          "/command",
        ),
        {
          method: "POST",
          body: JSON.stringify({
            command: input.command,
            args: input.args,
            model: input.model,
            agent: input.agent,
            variant: input.variant,
          }),
        },
      );
    },
  });

  const webBackends = AGENT_BACKEND_IDS.map((backendId) =>
    createWebBackendDescriptor(backendId, rpcCall, runtimeOverridesForBackend(backendId)),
  );
  const list = () => webBackends;
  const get = (backendId: AgentBackendId = "opencode") =>
    webBackends.find((backend) => backend.id === backendId);

  return {
    capabilities: () =>
      options.localCapabilities
        ? Promise.resolve({
            protocolVersion: 1,
            server: {
              workspaces: false,
              projects: true,
              sessions: true,
              events: "sse",
              auth: false,
              allowedRoots: true,
            },
            agentBackends: AGENT_BACKEND_IDS,
          } satisfies OpenGuiCapabilities)
        : request<OpenGuiCapabilities>("/api/capabilities"),
    workspaces: {
      list: () => request<OpenGuiWorkspace[]>("/api/workspaces"),
      get: async (id: string) => {
        try {
          return await request<OpenGuiWorkspace>(`/api/workspaces/${encodeURIComponent(id)}`);
        } catch (error) {
          if (error instanceof Error && error.message === "Workspace not found") return null;
          throw error;
        }
      },
      create: (input: CreateWorkspaceInput = {}) =>
        request<OpenGuiWorkspace>("/api/workspaces", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: async (id: string, input: UpdateWorkspaceInput) => {
        try {
          return await request<OpenGuiWorkspace>(`/api/workspaces/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify(input),
          });
        } catch (error) {
          if (error instanceof Error && error.message === "Workspace not found") return null;
          throw error;
        }
      },
      delete: async (id: string) => {
        try {
          return await request<boolean>(`/api/workspaces/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
        } catch (error) {
          if (error instanceof Error && error.message === "Workspace not found") return false;
          throw error;
        }
      },
    },
    projects: {
      list: (_workspaceId: string) => request<OpenGuiProject[]>("/api/projects"),
      get: async (id: string) => {
        try {
          return await request<OpenGuiProject>(`/api/projects/${encodeURIComponent(id)}`);
        } catch (error) {
          if (error instanceof Error && error.message === "Project not found") return null;
          throw error;
        }
      },
      create: (_workspaceId: string, input: CreateProjectInput) =>
        request<OpenGuiProject>("/api/projects", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: async (id: string, input: UpdateProjectInput) => {
        try {
          return await request<OpenGuiProject>(`/api/projects/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify(input),
          });
        } catch (error) {
          if (error instanceof Error && error.message === "Project not found") return null;
          throw error;
        }
      },
      delete: async (id: string) => {
        try {
          return await request<boolean>(`/api/projects/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
        } catch (error) {
          if (error instanceof Error && error.message === "Project not found") return false;
          throw error;
        }
      },
    },
    agentBackends: {
      list,
      get,
      subscribe: (listener: (event: AgentBackendEvent) => void) => {
        const handleMessage = (
          message: { channel?: string; data?: unknown } | CanonicalEventEnvelope,
        ) => {
          try {
            if (isCanonicalEventEnvelope(message)) {
              if (message.payload && typeof message.payload === "object") {
                listener({
                  type: message.type,
                  ...(message.payload as object),
                  ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}),
                  ...(message.projectId ? { projectId: message.projectId } : {}),
                  ...(message.sessionId ? { sessionId: message.sessionId } : {}),
                  ...(message.harnessId ? { harnessId: message.harnessId } : {}),
                } as AgentBackendEvent);
              }
              return;
            }
            if (!message?.channel?.endsWith(":bridge-event")) return;
            const backend = list().find(
              (candidate) => message.channel === `${candidate.id}:bridge-event`,
            );
            const backendEvent = (
              backend as
                | { normalizeEvent?: (event: unknown) => AgentBackendEvent | null }
                | undefined
            )?.normalizeEvent?.(message.data);
            if (backendEvent) listener(backendEvent);
          } catch (error) {
            console.error("Bad OpenGUI event", error);
          }
        };

        if (options.subscribeBackendEvents) return options.subscribeBackendEvents(handleMessage);

        let closed = false;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let retryDelayMs = INITIAL_EVENT_RETRY_MS;
        let stream: EventSourceLike | undefined;
        let lastEventId: string | null = null;
        const EventSourceCtor = options.eventSourceImpl ?? globalThis.EventSource;
        const currentLocation =
          options.location ??
          (typeof globalThis.location === "undefined" ? undefined : globalThis.location);
        if (!EventSourceCtor) {
          throw new OpenGuiRpcError("EventSource is not available", "BACKEND_UNAVAILABLE", true);
        }
        const connect = () => {
          const url = new URL(eventUrl(getDefaultBaseUrl(), getToken(), currentLocation));
          if (lastEventId) url.searchParams.set("cursor", lastEventId);
          stream = new EventSourceCtor(url.toString());
          stream.onopen = () => {
            retryDelayMs = INITIAL_EVENT_RETRY_MS;
          };
          stream.onmessage = (event) => {
            if (event.lastEventId) lastEventId = event.lastEventId;
            try {
              handleMessage(JSON.parse(event.data));
            } catch (error) {
              console.error("Bad OpenGUI event payload", error);
            }
          };
          stream.onerror = (error) => {
            console.error("OpenGUI event stream error", error);
            stream?.close();
            if (closed) return;
            retry = setTimeout(connect, retryDelayMs);
            retryDelayMs = Math.min(retryDelayMs * 2, MAX_EVENT_RETRY_MS);
          };
        };
        connect();
        return () => {
          closed = true;
          if (retry) clearTimeout(retry);
          stream?.close();
        };
      },
      restart: async () =>
        unwrapIpcResult(
          await rpcCall<IPCResult<Record<AgentBackendId, { success: boolean; error?: string }>>>(
            "agent-backends:restart",
            [],
          ),
          "Failed to restart agent backends",
        ),
      loadResources: async ({ backendId, target }) => {
        if (!target?.directory) {
          const args = targetArgs(target);
          const [providersData, agentsData, commandsData] = await Promise.all([
            backendRpc<BackendResourceBundle["providersData"]>(backendId, "providers", args),
            backendRpc<BackendResourceBundle["agentsData"]>(backendId, "agents", args),
            backendRpc<BackendResourceBundle["commandsData"]>(backendId, "commands", args),
          ]);
          return { providersData, agentsData, commandsData };
        }
        const project = await ensureProjectForTarget(target);
        if (!project) throw new OpenGuiRpcError("Directory is required", "INVALID_INPUT", true);
        const [providersData, agentsData, commandsData] = await Promise.all([
          requestAt<BackendResourceBundle["providersData"]>(
            requestBaseUrlForTarget(target),
            `/api/projects/${encodeURIComponent(project.id)}/providers?harnessId=${encodeURIComponent(backendId)}`,
          ),
          requestAt<BackendResourceBundle["agentsData"]>(
            requestBaseUrlForTarget(target),
            `/api/projects/${encodeURIComponent(project.id)}/agents?harnessId=${encodeURIComponent(backendId)}`,
          ),
          requestAt<BackendResourceBundle["commandsData"]>(
            requestBaseUrlForTarget(target),
            `/api/projects/${encodeURIComponent(project.id)}/commands?harnessId=${encodeURIComponent(backendId)}`,
          ),
        ]);
        return { providersData, agentsData, commandsData };
      },
      connectProject: async ({ config, backendIds }) => {
        const targetBackends = backendIdsOrAll(backendIds);
        if (config.workspaceId && config.baseUrl) {
          workspaceBaseUrls.set(config.workspaceId, config.baseUrl);
        }
        if (!config.directory) {
          return {
            connectedBackendIds: [],
            errors: targetBackends.map((backendId) => ({
              backendId,
              error: "Directory is required",
            })),
          };
        }
        const target = {
          directory: config.directory,
          workspaceId: config.workspaceId,
          baseUrl: config.baseUrl,
          authToken: config.authToken,
        };
        const project = await ensureProjectForTarget(target);
        if (!project) {
          return {
            connectedBackendIds: [],
            errors: targetBackends.map((backendId) => ({
              backendId,
              error: "Directory is required",
            })),
          };
        }
        return await requestAt<ProjectConnectResult>(
          requestBaseUrlForTarget(target),
          `/api/projects/${encodeURIComponent(project.id)}/connect`,
          {
            method: "POST",
            body: JSON.stringify({ backendIds: targetBackends, config }),
          },
        );
      },
      disconnectProject: async ({ target, backendIds }) => {
        const project = await findProjectForTarget(target);
        if (!project) return;
        await requestAt<boolean>(
          requestBaseUrlForTarget(target),
          `/api/projects/${encodeURIComponent(project.id)}/disconnect`,
          {
            method: "POST",
            body: JSON.stringify({ backendIds: backendIdsOrAll(backendIds) }),
          },
        );
      },
      listProjectSessions: async ({ backendIds, target }) => {
        const project = await ensureProjectForTarget(target);
        if (!project) return [];
        const results = await Promise.all(
          backendIds.map(async (backendId) => {
            const requestBaseUrl = requestBaseUrlForTarget(target);
            const page = await requestAt<SessionListResponse>(
              requestBaseUrl,
              `/api/sessions?workspaceId=${encodeURIComponent(project.workspaceId)}&projectId=${encodeURIComponent(project.id)}&harnessId=${encodeURIComponent(backendId)}&sync=true`,
            );
            return {
              backendId,
              sessions: await Promise.all(
                page.sessions.map((session) => toFrontendSession(session, project, requestBaseUrl)),
              ),
            };
          }),
        );
        return results;
      },
      listProjectSessionStatuses: async ({ backendIds, target }) => {
        const project = await ensureProjectForTarget(target);
        if (!project) return {};
        const status = await requestAt<
          Record<string, { connected: boolean; statuses: Record<string, { type: string }> }>
        >(
          requestBaseUrlForTarget(target),
          `/api/projects/${encodeURIComponent(project.id)}/status`,
        );
        return Object.fromEntries(
          backendIds.flatMap((backendId) => Object.entries(status[backendId]?.statuses ?? {})),
        );
      },
    },
    sessions: {
      query: async ({ projects, harnessIds, sync = false }): Promise<SessionQueryResult> => {
        const groups = new Map<string, typeof projects>();
        for (const project of projects) {
          const baseUrl = requestBaseUrlForTarget(project);
          const key = `${baseUrl}\u0000${project.authToken ?? ""}`;
          groups.set(key, [...(groups.get(key) ?? []), project]);
        }
        const groupedRequests = [...groups.values()].map((groupProjects) => ({
          projects: groupProjects,
          requestBaseUrl: requestBaseUrlForTarget(groupProjects[0]),
        }));
        const responses = await Promise.all(
          groupedRequests.map((group) =>
            requestAt<SessionQueryResponse>(group.requestBaseUrl, "/api/sessions/query", {
              method: "POST",
              body: JSON.stringify({ projects: group.projects, harnessIds, sync }),
            }),
          ),
        );
        return {
          items: responses
            .flatMap((response, index) =>
              response.items.map((item) => ({
                item,
                requestBaseUrl: groupedRequests[index]?.requestBaseUrl,
              })),
            )
            .map(({ item, requestBaseUrl }) => ({
              ...item,
              sessions: item.sessions.map((session) =>
                toFrontendSessionFromDirectory(
                  session,
                  item.directory,
                  item.workspaceId,
                  requestBaseUrl,
                ),
              ),
            })),
          errors: responses.flatMap((response) => response.errors ?? []),
        };
      },
      create: async ({ backendId, title, target }) => {
        const project = await ensureProjectForTarget(target);
        if (!project) throw new OpenGuiRpcError("Directory is required", "INVALID_INPUT", true);
        const requestBaseUrl = requestBaseUrlForTarget(target);
        const record = await requestAt<SessionRecordResponse>(requestBaseUrl, "/api/sessions", {
          method: "POST",
          body: JSON.stringify({ projectId: project.id, harnessId: backendId, title }),
        });
        rememberSessionBaseUrl(record, requestBaseUrl);
        return await toFrontendSession(record, project, requestBaseUrl);
      },
      delete: async ({ sessionId, backendId, target, confirmQueue }) => {
        const path = await resolveSessionPath({ sessionId, backendId, target });
        const url = new URL(path, "http://opengui.local");
        if (confirmQueue) url.searchParams.set("confirmQueue", "true");
        return await requestAt<boolean>(
          requestBaseUrlForSession({ sessionId, backendId, target }),
          `${url.pathname}${url.search}`,
          {
            method: "DELETE",
          },
        );
      },
      rename: async ({ sessionId, title, backendId, target }) => {
        const requestBaseUrl = requestBaseUrlForSession({ sessionId, backendId, target });
        const record = await requestAt<SessionRecordResponse>(
          requestBaseUrl,
          await resolveSessionPath({ sessionId, backendId, target }),
          {
            method: "PATCH",
            body: JSON.stringify({ title }),
          },
        );
        return await toFrontendSession(record, null, requestBaseUrl);
      },
      getMessages: async ({ sessionId, backendId, options }) => {
        const path = await resolveSessionPath(
          {
            sessionId,
            backendId,
            workspaceId: options?.workspaceId,
            directory: options?.directory,
            baseUrl: options?.baseUrl,
          },
          "/messages",
        );
        const url = new URL(path, "http://opengui.local");
        if (options?.before) {
          url.searchParams.set("cursor", options.before);
          url.searchParams.set("direction", "older");
        }
        if (options?.limit) url.searchParams.set("limit", String(options.limit));
        return await requestAt<MessagePageResult>(
          requestBaseUrlForSession({
            sessionId,
            backendId,
            directory: options?.directory,
            workspaceId: options?.workspaceId,
            baseUrl: options?.baseUrl,
          }),
          `${url.pathname}${url.search}`,
        );
      },
      prompt: async ({ sessionId, text, images, model, agent, variant, target, backendId }) => {
        await requestAt<boolean>(
          requestBaseUrlForSession({ sessionId, backendId, target }),
          await resolveSessionPath({ sessionId, backendId, target }, "/prompt"),
          {
            method: "POST",
            body: JSON.stringify({ text, images, model, agent, variant }),
          },
        );
      },
      abort: async ({ sessionId, backendId, target }) => {
        await requestAt<boolean>(
          requestBaseUrlForSession({ sessionId, backendId, target }),
          await resolveSessionPath({ sessionId, backendId, target }, "/abort"),
          {
            method: "POST",
          },
        );
      },
      respondPermission: async ({ sessionId, permissionId, response, backendId, target }) => {
        const project = target ? await ensureProjectForTarget(target) : null;
        await requestAt<boolean>(
          requestBaseUrlForTarget(target),
          `/api/permissions/${encodeURIComponent(permissionId)}/respond`,
          {
            method: "POST",
            body: JSON.stringify({
              sessionId,
              response,
              backendId,
              workspaceId: project?.workspaceId ?? target?.workspaceId,
              projectId: project?.id,
            }),
          },
        );
      },
      replyQuestion: async ({ requestId, answers, backendId }) => {
        await request<boolean>(`/api/questions/${encodeURIComponent(requestId)}/reply`, {
          method: "POST",
          body: JSON.stringify({ answers, backendId }),
        });
      },
      rejectQuestion: async ({ requestId, backendId }) => {
        await request<boolean>(`/api/questions/${encodeURIComponent(requestId)}/reject`, {
          method: "POST",
          body: JSON.stringify({ backendId }),
        });
      },
      queue: {
        list: async ({ sessionId, backendId, target }) =>
          await requestAt<OpenGuiQueueEntry[]>(
            requestBaseUrlForSession({ sessionId, backendId, target }),
            await resolveSessionPath({ sessionId, backendId, target }, "/queue"),
          ),
        listProject: async ({ backendId, target }) => {
          const project = await ensureProjectForTarget(target);
          if (!project) return {};
          return await requestAt<Record<string, OpenGuiQueueEntry[]>>(
            requestBaseUrlForTarget(target),
            `/api/queues?projectId=${encodeURIComponent(project.id)}&harnessId=${encodeURIComponent(backendId)}`,
          );
        },
        enqueue: async ({
          sessionId,
          text,
          images,
          model,
          agent,
          variant,
          mode,
          backendId,
          target,
        }) =>
          await requestAt<OpenGuiQueueEntry[]>(
            requestBaseUrlForSession({ sessionId, backendId, target }),
            await resolveSessionPath({ sessionId, backendId, target }, "/queue"),
            {
              method: "POST",
              body: JSON.stringify({ text, images, model, agent, variant, mode }),
            },
          ),
        remove: async ({ sessionId, entryId, backendId, target }) =>
          await requestAt<OpenGuiQueueEntry[]>(
            requestBaseUrlForSession({ sessionId, backendId, target }),
            await resolveSessionPath(
              { sessionId, backendId, target },
              `/queue/${encodeURIComponent(entryId)}`,
            ),
            { method: "DELETE" },
          ),
        update: async ({
          sessionId,
          entryId,
          text,
          images,
          model,
          agent,
          variant,
          mode,
          backendId,
          target,
        }) =>
          await requestAt<OpenGuiQueueEntry[]>(
            requestBaseUrlForSession({ sessionId, backendId, target }),
            await resolveSessionPath(
              { sessionId, backendId, target },
              `/queue/${encodeURIComponent(entryId)}`,
            ),
            {
              method: "PATCH",
              body: JSON.stringify({ text, images, model, agent, variant, mode }),
            },
          ),
        reorder: async ({ sessionId, entryId, index, backendId, target }) =>
          await requestAt<OpenGuiQueueEntry[]>(
            requestBaseUrlForSession({ sessionId, backendId, target }),
            await resolveSessionPath(
              { sessionId, backendId, target },
              `/queue/${encodeURIComponent(entryId)}/reorder`,
            ),
            {
              method: "PATCH",
              body: JSON.stringify({ index }),
            },
          ),
        dispatchNext: async ({ sessionId, backendId, target }) =>
          await requestAt<OpenGuiQueueEntry[]>(
            requestBaseUrlForSession({ sessionId, backendId, target }),
            await resolveSessionPath({ sessionId, backendId, target }, "/queue/dispatch"),
            { method: "POST" },
          ),
      },
    },
    files: {
      find: async ({ target, query }) => {
        const project = await ensureProjectForTarget(target);
        if (!project)
          return target.directory
            ? await rpcCall<string[]>("files:find", [target.directory, query])
            : [];
        return await requestAt<string[]>(
          requestBaseUrlForTarget(target),
          `/api/fs/search?projectId=${encodeURIComponent(project.id)}&query=${encodeURIComponent(query)}`,
        );
      },
    },
    git: {
      isRepo: async (directory: string) =>
        unwrapIpcResult(
          await rpcCall<IPCResult<boolean>>("git:is-repo", [directory]),
          "Failed to detect git repository",
        ),
      listBranches: async (directory: string) =>
        unwrapIpcResult(
          await rpcCall<IPCResult<string[]>>("git:branch:list", [directory]),
          "Failed to list git branches",
        ),
      currentBranch: async (directory: string) =>
        unwrapIpcResult(
          await rpcCall<IPCResult<string>>("git:current-branch", [directory]),
          "Failed to get current git branch",
        ),
      listWorktrees: async (directory: string) =>
        unwrapIpcResult(
          await rpcCall<IPCResult<GitWorktree[]>>("git:worktree:list", [directory]),
          "Failed to list git worktrees",
        ),
      addWorktree: async (
        directory: string,
        worktreePath: string,
        branch: string,
        isNewBranch: boolean,
      ) =>
        unwrapIpcResult(
          await rpcCall<IPCResult<{ path: string }>>("git:worktree:add", [
            directory,
            worktreePath,
            branch,
            isNewBranch,
          ]),
          "Failed to create git worktree",
        ),
      removeWorktree: async (directory: string, worktreePath: string) => {
        unwrapIpcResult(
          await rpcCall<IPCResult>("git:worktree:remove", [directory, worktreePath]),
          "Failed to remove git worktree",
        );
      },
      merge: async (directory: string, branch: string) =>
        await rpcCall<GitMergeResult>("git:merge", [directory, branch]),
      mergeAbort: async (directory: string) => {
        unwrapIpcResult(
          await rpcCall<IPCResult>("git:merge:abort", [directory]),
          "Failed to abort git merge",
        );
      },
      getRemoteUrl: async (directory: string) =>
        unwrapIpcResult(
          await rpcCall<IPCResult<string>>("git:remote:url", [directory]),
          "Failed to load git remote URL",
        ),
    },
    worktree: {
      detectSetup: async (worktreePath: string) =>
        await rpcCall<WorktreeSetupDetection>("worktree:detect-setup", [worktreePath]),
      runSetup: async (worktreePath: string, command: string) => {
        unwrapIpcResult(
          await rpcCall<IPCResult>("worktree:run-setup", [worktreePath, command]),
          "Failed to run worktree setup",
        );
      },
    },
    runtime: {
      getHomeDir: async () => await rpcCall<string>("platform:homeDir"),
      detectBackends: async () => await rpcCall<BackendDetectionResult>("platform:detectBackends"),
      installBackend: async (backendId: AgentBackendId) =>
        await rpcCall<InstallResult>("backend:install", [backendId]),
    },
    desktop: {
      openDirectory: async () =>
        options.openDirectory
          ? await options.openDirectory()
          : await rpcCall<string | null>("dialog:openDirectory"),
    },
  };
}

export type { AgentBackendId };
