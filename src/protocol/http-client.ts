import type { HarnessId } from "@/agents";
import { HARNESS_IDS, HARNESS_LABELS, getHarnessIdFromSessionId } from "@/agents";
import type { HarnessDescriptor, HarnessEvent, HarnessTarget } from "@/agents/backend";
import { HARNESS_BACKEND_META } from "@/agents/cli-harness-factory";
import type {
  HarnessResourceBundle,
  MessagePageResult,
  OpenGuiCapabilities,
  OpenGuiClient,
  OpenGuiQueueEntry,
  DirectoryRegisterResult,
  HarnessDirectorySessionsResult,
  SessionQueryResult,
} from "@/protocol/client";
import { mergeCanonicalEventForListener } from "@/hooks/backend-event-normalization";
import { composeFrontendSessionId } from "@/lib/session-identity";
import { normalizeProjectPath } from "@/lib/path";
import { createHarnessPlatform, targetArgs, unwrapIpcResult } from "@/protocol/http-platform";
import type {
  GitMergeResult,
  GitWorktree,
  ConnectionConfig,
  HarnessInventory,
  IPCResult,
  WorktreeSetupDetection,
} from "@/types/electron";
import { OpenGuiRpcError, type RpcEnvelope, throwRpcError } from "@/protocol/http-rpc";
export { OpenGuiRpcError } from "@/protocol/http-rpc";

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
  resolveHarnessIds?: () => HarnessId[] | undefined;
  openDirectory?: () => Promise<string | null>;
  localCapabilities?: boolean;
}

const INITIAL_EVENT_RETRY_MS = 1_000;
const MAX_EVENT_RETRY_MS = 30_000;
// Compatibility channel exposed by older OpenGUI Backends.
const RESTART_ALL_HARNESSES_CHANNEL = "agent-backends:restart";

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function isLoopbackBaseUrl(value: string | undefined) {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}

function backendProjectConnectionConfig(
  config: ConnectionConfig,
): Omit<ConnectionConfig, "workspaceId" | "baseUrl" | "authToken"> {
  const { workspaceId, baseUrl, authToken, ...backendConfig } = config;
  void workspaceId;
  void baseUrl;
  void authToken;
  return backendConfig;
}

async function httpRpc<T>(
  path: string,
  token: string | undefined,
  channel: string,
  args: unknown[] = [],
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<T> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetchImpl(joinUrl(path, "/api/rpc"), {
    method: "POST",
    headers,
    body: JSON.stringify({ channel, args }),
  });
  const body = (await response.json().catch(() => null)) as RpcEnvelope<T> | null;
  if (!response.ok || !body?.ok) throwRpcError(body, `RPC failed: ${channel}`);
  return body.value as T;
}

function createHarnessDescriptor(
  harnessId: HarnessId,
  rpcCall: <T>(channel: string, args?: unknown[]) => Promise<T>,
  runtimeOverrides: Partial<HarnessDescriptor["runtime"]> = {},
): HarnessDescriptor {
  if (!(harnessId in HARNESS_BACKEND_META)) {
    throw new Error(`Harness is not available: ${harnessId}`);
  }
  const meta = HARNESS_BACKEND_META[harnessId as keyof typeof HARNESS_BACKEND_META];
  const callHarnessRpc = async <T>(suffix: string, args: unknown[] = []) =>
    unwrapIpcResult(
      await rpcCall<IPCResult<T>>(`${harnessId}:${suffix}`, args),
      `Harness call failed: ${harnessId}:${suffix}`,
    );
  const runtime: HarnessDescriptor["runtime"] = {
    createSession: ({ title, directory, workspaceId } = {}) =>
      callHarnessRpc("session:create", [title, directory, workspaceId]),
    startSession: (input) => callHarnessRpc("session:start", [input]),
    deleteSession: (sessionId) => callHarnessRpc("session:delete", [sessionId]),
    renameSession: (sessionId, title) => callHarnessRpc("session:update", [sessionId, title]),
    compactSession: (sessionId, model, target) =>
      callHarnessRpc("session:summarize", [sessionId, model, ...targetArgs(target)]),
    forkSession: (sessionId, messageID, target) =>
      callHarnessRpc("session:fork", [sessionId, messageID, ...targetArgs(target)]),
    revertSession: (sessionId, messageID, partID, target) =>
      callHarnessRpc("session:revert", [sessionId, messageID, partID, ...targetArgs(target)]),
    unrevertSession: (sessionId, target) =>
      callHarnessRpc("session:unrevert", [sessionId, ...targetArgs(target)]),
    sendCommand: (input) =>
      callHarnessRpc("command:send", [
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
    rpcCall<T>(`${harnessId}:${suffix}`, args);
  const platform = createHarnessPlatform(meta.capabilities, op);

  return {
    id: harnessId,
    label: HARNESS_LABELS[harnessId],
    capabilities: meta.capabilities,
    connection: meta.connection,
    runtime,
    platform,
    normalizeEvent: meta.normalizeEvent as (event: unknown) => HarnessEvent | null,
  } as HarnessDescriptor & { normalizeEvent: (event: unknown) => HarnessEvent | null };
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
  directory: string;
  harnessId: HarnessId;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "error" | "unknown";
  metadata?: Record<string, unknown>;
}

function directoryApiSegment(directory: string) {
  return encodeURIComponent(directory);
}

interface SessionQueryResponse {
  items: Array<{
    directory: string;
    harnessId: HarnessId;
    sessions: SessionRecordResponse[];
  }>;
  errors?: Array<{
    directory: string;
    harnessId?: HarnessId;
    error: string;
  }>;
}

interface SessionLookupInput {
  sessionId: string;
  harnessId?: HarnessId;
  target?: HarnessTarget;
  workspaceId?: string;
  directory?: string;
  baseUrl?: string;
}

interface CanonicalEventEnvelope {
  id: string;
  type: string;
  createdAt: string;
  projectId?: string;
  sessionId?: string;
  harnessId?: string;
  payload: unknown;
}

function isCanonicalEventEnvelope(value: unknown): value is CanonicalEventEnvelope {
  return !!value && typeof value === "object" && "type" in value && "payload" in value;
}

export function createHttpOpenGuiClient(options: HttpOpenGuiClientOptions = {}): OpenGuiClient {
  const baseUrl = options.baseUrl ?? "";
  const getDefaultBaseUrl = () => options.resolveBaseUrl?.() ?? baseUrl;
  const getToken = () => options.resolveToken?.() ?? options.token;
  const fetchImpl = options.fetchImpl ?? fetch;
  const workspaceConnections = new Map<string, { baseUrl?: string; token?: string }>();

  const tokenForBaseUrl = (requestBaseUrl: string) => {
    const normalized = normalizeBaseUrl(requestBaseUrl);
    for (const connection of workspaceConnections.values()) {
      if (connection.baseUrl === normalized && connection.token) return connection.token;
    }
    return getToken();
  };

  async function requestAt<T>(
    requestBaseUrl: string,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const scopedToken = tokenForBaseUrl(requestBaseUrl);
    if (scopedToken) headers.set("authorization", `Bearer ${scopedToken}`);

    const response = await fetchImpl(joinUrl(requestBaseUrl, path), { ...init, headers });
    const body = (await response.json().catch(() => null)) as RpcEnvelope<T> | null;
    if (!response.ok || !body?.ok) {
      if (import.meta.env.DEV) {
        console.error(
          "[http] failed " +
            JSON.stringify({
              method: init.method ?? "GET",
              url: joinUrl(requestBaseUrl, path),
              status: response.status,
              error: body?.error,
              responseBody: body,
              requestBody: typeof init.body === "string" ? init.body : undefined,
            }),
        );
      }
      throwRpcError(body, `Request failed: ${path}`);
    }
    return body.value as T;
  }

  const request = <T>(path: string, init: RequestInit = {}) =>
    requestAt<T>(getDefaultBaseUrl(), path, init);

  const rpcCall = <T>(channel: string, args: unknown[] = []) =>
    options.rpcImpl?.<T>(channel, args) ??
    httpRpc<T>(getDefaultBaseUrl(), getToken(), channel, args, fetchImpl);
  const ipcResult = async <T>(channel: string, args: unknown[] = [], message: string) =>
    unwrapIpcResult(await rpcCall<IPCResult<T>>(channel, args), message);
  const harnessIdsOrAll = (harnessIds?: HarnessId[]) =>
    harnessIds?.length ? harnessIds : HARNESS_IDS;
  const harnessChannel = (harnessId: HarnessId, suffix: string) => `${harnessId}:${suffix}`;
  const sessionRecordByCanonicalId = new Map<string, SessionRecordResponse>();
  const sessionCanonicalIdsByFrontendId = new Map<string, Set<string>>();

  const rememberWorkspaceConnection = (target?: HarnessTarget) => {
    if (!target?.workspaceId) return;
    const previous = workspaceConnections.get(target.workspaceId) ?? {};
    workspaceConnections.set(target.workspaceId, {
      baseUrl: target.baseUrl ? normalizeBaseUrl(target.baseUrl) : previous.baseUrl,
      token: target.authToken ?? previous.token,
    });
  };

  const routeForTarget = (target?: HarnessTarget) => {
    rememberWorkspaceConnection(target);
    const workspaceConnection = target?.workspaceId
      ? workspaceConnections.get(target.workspaceId)
      : undefined;
    const baseUrl = target?.baseUrl
      ? normalizeBaseUrl(target.baseUrl)
      : (workspaceConnection?.baseUrl ?? getDefaultBaseUrl());
    return {
      baseUrl,
      token: target?.authToken ?? workspaceConnection?.token ?? getToken(),
      preferHttp: Boolean(target?.baseUrl && !isLoopbackBaseUrl(target.baseUrl)),
    };
  };

  const requestBaseUrlForTarget = (target?: HarnessTarget) => routeForTarget(target).baseUrl;

  const harnessRpcForTarget = async <T>(
    harnessId: HarnessId,
    suffix: string,
    target?: HarnessTarget,
    args: unknown[] = [],
  ) => {
    const route = routeForTarget(target);
    const channel = harnessChannel(harnessId, suffix);
    return unwrapIpcResult(
      await (!route.preferHttp && options.rpcImpl
        ? options.rpcImpl<IPCResult<T>>(channel, args)
        : httpRpc<IPCResult<T>>(route.baseUrl, route.token, channel, args, fetchImpl)),
      `Harness call failed: ${channel}`,
    );
  };

  const requestBaseUrlForSession = (input: SessionLookupInput) => {
    const target = input.target ?? input;
    return requestBaseUrlForTarget(target);
  };

  const sessionRequest = async <T>(
    input: SessionLookupInput,
    suffix = "",
    init: RequestInit = {},
  ) =>
    await requestAt<T>(
      requestBaseUrlForSession(input),
      await resolveSessionPath(input, suffix),
      init,
    );

  const queueEntryPath = (entryId: string, action = "") =>
    `/queue/${encodeURIComponent(entryId)}${action}`;

  const interactionTargetBody = (target?: HarnessTarget) => ({
    workspaceId: target?.workspaceId,
    directory: target?.directory,
  });

  const frontendSessionIdFromRecord = (record: SessionRecordResponse) =>
    composeFrontendSessionId(record.harnessId, record.rawId);

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
    const harnessId = input.harnessId ?? getHarnessIdFromSessionId(input.sessionId) ?? undefined;
    return candidates.filter((record, index) => {
      if (candidates.findIndex((candidate) => candidate.id === record.id) !== index) return false;
      return !harnessId || record.harnessId === harnessId;
    });
  };

  const sessionScopeFromInput = (
    input: SessionLookupInput,
    record?: SessionRecordResponse,
  ): { directory?: string; harnessId?: HarnessId } => {
    const harnessId =
      input.harnessId ??
      record?.harnessId ??
      getHarnessIdFromSessionId(input.sessionId) ??
      undefined;
    const directory =
      input.target?.directory ??
      input.directory ??
      record?.directory ??
      (typeof record?.metadata?.directory === "string" ? record.metadata.directory : undefined);
    return { directory, harnessId };
  };

  const withSessionScopeQuery = (
    path: string,
    input: SessionLookupInput,
    record?: SessionRecordResponse,
  ): string => {
    const { directory, harnessId } = sessionScopeFromInput(input, record);
    const params = new URLSearchParams();
    if (harnessId) params.set("harnessId", harnessId);
    if (directory) params.set("directory", directory);
    if (!params.size) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}${params.toString()}`;
  };

  const resolveSessionPath = async (input: SessionLookupInput, suffix = ""): Promise<string> => {
    const direct = sessionRecordByCanonicalId.get(input.sessionId);
    if (direct) {
      return withSessionScopeQuery(
        `/api/sessions/${encodeURIComponent(direct.id)}${suffix}`,
        input,
        direct,
      );
    }

    let candidates = listSessionRecordCandidates(input);
    if (candidates.length === 1) {
      return withSessionScopeQuery(
        `/api/sessions/${encodeURIComponent(candidates[0]!.id)}${suffix}`,
        input,
        candidates[0],
      );
    }

    const directory = input.target?.directory ?? input.directory;
    const harnessId = input.harnessId ?? getHarnessIdFromSessionId(input.sessionId) ?? undefined;

    if (directory) {
      candidates = candidates.filter(
        (record) =>
          (record.directory === directory || record.metadata?.directory === directory) &&
          (!harnessId || record.harnessId === harnessId),
      );
      if (candidates.length === 1) {
        return withSessionScopeQuery(
          `/api/sessions/${encodeURIComponent(candidates[0]!.id)}${suffix}`,
          input,
          candidates[0],
        );
      }
    }

    return withSessionScopeQuery(
      `/api/sessions/${encodeURIComponent(input.sessionId)}${suffix}`,
      input,
    );
  };

  const toFrontendSessionFromDirectory = (
    record: SessionRecordResponse,
    directory: string,
    workspaceId?: string,
  ): HarnessDirectorySessionsResult["sessions"][number] => {
    rememberSessionRecord(record);
    const resolvedWorkspaceId = workspaceId ?? "local";
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
      _harnessId: record.harnessId,
      _rawId: record.rawId,
    } as HarnessDirectorySessionsResult["sessions"][number];
  };

  const toFrontendSession = (
    record: SessionRecordResponse,
    directory: string,
    workspaceId?: string,
  ) => toFrontendSessionFromDirectory(record, directory, workspaceId);

  const getSessionRecord = async (sessionId: string, input: SessionLookupInput = { sessionId }) =>
    await requestAt<SessionRecordResponse>(
      requestBaseUrlForSession({ ...input, sessionId }),
      await resolveSessionPath({ ...input, sessionId }),
    );

  const createSessionRecord = async ({
    harnessId,
    title,
    target,
  }: {
    harnessId: HarnessId;
    title?: string;
    target: HarnessTarget & { directory: string };
  }) =>
    await requestAt<SessionRecordResponse>(requestBaseUrlForTarget(target), "/api/sessions", {
      method: "POST",
      ...jsonBody({ directory: target.directory, harnessId, title }),
    });

  const sessionAction = async <T>(
    input: SessionLookupInput,
    suffix: string,
    body?: Record<string, unknown>,
  ) =>
    await sessionRequest<T>(input, suffix, {
      method: "POST",
      ...(body ? jsonBody(body) : {}),
    });

  const runtimeOverridesForBackend = (
    harnessId: HarnessId,
  ): Partial<HarnessDescriptor["runtime"]> => ({
    createSession: async ({ title, directory, workspaceId, baseUrl: targetBaseUrl } = {}) => {
      if (!directory) throw new OpenGuiRpcError("Directory is required", "INVALID_INPUT", true);
      const target = { directory, workspaceId, baseUrl: targetBaseUrl };
      const record = await createSessionRecord({ harnessId, title, target });
      return toFrontendSessionFromDirectory(record, directory, workspaceId);
    },
    startSession: async (input) => {
      if (!input.directory)
        throw new OpenGuiRpcError("Directory is required", "INVALID_INPUT", true);
      const record = await createSessionRecord({
        harnessId,
        title: input.title,
        target: { ...input, directory: input.directory },
      });
      await sessionAction<boolean>({ sessionId: record.id, harnessId, target: input }, "/prompt", {
        text: input.text,
        model: input.model,
        agent: input.agent,
        variant: input.variant,
      });
      return toFrontendSessionFromDirectory(record, input.directory, input.workspaceId);
    },
    deleteSession: async (sessionId) =>
      await request<boolean>(await resolveSessionPath({ sessionId, harnessId }, ""), {
        method: "DELETE",
      }),
    renameSession: async (sessionId, title) => {
      const record = await request<SessionRecordResponse>(
        await resolveSessionPath({ sessionId, harnessId }),
        {
          method: "PATCH",
          ...jsonBody({ title }),
        },
      );
      const dir = typeof record.metadata?.directory === "string" ? record.metadata.directory : "";
      return toFrontendSession(record, dir, undefined);
    },
    compactSession: async (sessionId, model, target) => {
      await sessionAction<boolean>({ sessionId, harnessId, target }, "/compact", { model });
    },
    forkSession: async (sessionId, messageID, target) => {
      const record = await sessionAction<SessionRecordResponse>(
        { sessionId, harnessId, target },
        "/fork",
        { messageId: messageID },
      );
      return toFrontendSession(record, target?.directory ?? "", target?.workspaceId);
    },
    revertSession: async (sessionId, messageID, partID, target) => {
      const value = await sessionAction<SessionRecordResponse | boolean>(
        { sessionId, harnessId, target },
        "/revert",
        { messageId: messageID, partId: partID },
      );
      const resolved =
        typeof value === "boolean"
          ? await getSessionRecord(sessionId, { sessionId, harnessId, target })
          : value;
      return toFrontendSession(resolved, target?.directory ?? "", target?.workspaceId);
    },
    unrevertSession: async (sessionId, target) => {
      const value = await sessionAction<SessionRecordResponse | boolean>(
        { sessionId, harnessId, target },
        "/unrevert",
      );
      const resolved =
        typeof value === "boolean"
          ? await getSessionRecord(sessionId, { sessionId, harnessId, target })
          : value;
      return toFrontendSession(resolved, target?.directory ?? "", target?.workspaceId);
    },
    sendCommand: async (input) => {
      await request<boolean>(
        await resolveSessionPath(
          {
            sessionId: input.sessionId,
            harnessId,
            target: { directory: input.directory, workspaceId: input.workspaceId },
          },
          "/command",
        ),
        {
          method: "POST",
          ...jsonBody({
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

  const harnessDescriptors = HARNESS_IDS.map((harnessId) =>
    createHarnessDescriptor(harnessId, rpcCall, runtimeOverridesForBackend(harnessId)),
  );
  const list = () => {
    const resolvedHarnessIds = options.resolveHarnessIds?.();
    if (!resolvedHarnessIds?.length) return harnessDescriptors;
    const allowed = new Set(resolvedHarnessIds);
    return harnessDescriptors.filter((descriptor) => allowed.has(descriptor.id as HarnessId));
  };
  const get = (harnessId: HarnessId = "claude-code") =>
    list().find((descriptor) => descriptor.id === harnessId);

  return {
    capabilities: () =>
      options.localCapabilities
        ? Promise.resolve({
            protocolVersion: 1,
            server: {
              workspaces: false,
              projects: false,
              sessions: true,
              events: "sse",
              auth: false,
              allowedRoots: true,
            },
            harnesses: HARNESS_IDS,
          } satisfies OpenGuiCapabilities)
        : request<OpenGuiCapabilities>("/api/capabilities"),
    harnesses: {
      list,
      get,
      subscribe: (listener: (event: HarnessEvent) => void) => {
        const handleMessage = (
          message: { channel?: string; data?: unknown } | CanonicalEventEnvelope,
        ) => {
          try {
            if (isCanonicalEventEnvelope(message)) {
              const merged = mergeCanonicalEventForListener(message);
              if (merged) listener(merged as unknown as HarnessEvent);
              return;
            }
            if (!message?.channel?.endsWith(":bridge-event")) return;
            const descriptor = list().find(
              (candidate) => message.channel === `${candidate.id}:bridge-event`,
            );
            const harnessEvent = (
              descriptor as { normalizeEvent?: (event: unknown) => HarnessEvent | null } | undefined
            )?.normalizeEvent?.(message.data);
            if (harnessEvent) listener(harnessEvent);
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
            stream?.close();
            if (closed) return;
            console.error("OpenGUI event stream error", error);
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
          await rpcCall<IPCResult<Record<HarnessId, { success: boolean; error?: string }>>>(
            RESTART_ALL_HARNESSES_CHANNEL,
            [],
          ),
          "Failed to restart Harnesses",
        ),
      loadResources: async ({ harnessId, target }) => {
        const args = targetArgs(target);
        const [providersData, agentsData, commandsData] = await Promise.all([
          harnessRpcForTarget<HarnessResourceBundle["providersData"]>(
            harnessId,
            "providers",
            target,
            args,
          ),
          harnessRpcForTarget<HarnessResourceBundle["agentsData"]>(
            harnessId,
            "agents",
            target,
            args,
          ),
          harnessRpcForTarget<HarnessResourceBundle["commandsData"]>(
            harnessId,
            "commands",
            target,
            args,
          ),
        ]);
        return { providersData, agentsData, commandsData };
      },
      registerDirectory: async ({ config, harnessIds }) => {
        const targetBackends = harnessIdsOrAll(harnessIds);
        if (!config.directory) {
          return {
            connectedHarnessIds: [],
            errors: targetBackends.map((harnessId) => ({
              harnessId,
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
        rememberWorkspaceConnection(target);
        return await requestAt<DirectoryRegisterResult>(
          requestBaseUrlForTarget(target),
          `/api/directories/${directoryApiSegment(config.directory)}/register`,
          {
            method: "POST",
            ...jsonBody({
              harnessIds: targetBackends,
              config: backendProjectConnectionConfig(config),
            }),
          },
        );
      },
      releaseDirectory: async ({ target, harnessIds }) => {
        if (!target.directory) return;
        await requestAt<boolean>(
          requestBaseUrlForTarget(target),
          `/api/directories/${directoryApiSegment(target.directory)}/release`,
          {
            method: "POST",
            ...jsonBody({ harnessIds: harnessIdsOrAll(harnessIds) }),
          },
        );
      },
      listDirectorySessions: async ({ harnessIds, target }) => {
        if (!target?.directory) return [];
        const response = await requestAt<SessionQueryResponse>(
          requestBaseUrlForTarget(target),
          "/api/sessions/query",
          {
            method: "POST",
            ...jsonBody({
              projects: [
                {
                  directory: target.directory,
                },
              ],
              harnessIds,
            }),
          },
        );
        return response.items.map((item) => ({
          harnessId: item.harnessId,
          sessions: item.sessions.map((session) =>
            toFrontendSessionFromDirectory(session, item.directory, target.workspaceId),
          ),
        }));
      },
      listDirectorySessionStatuses: async ({ harnessIds, target }) => {
        if (!target?.directory) return {};
        const entries = await Promise.all(
          harnessIds.map(async (harnessId) => {
            try {
              const statuses = await harnessRpcForTarget<Record<string, { type: string }>>(
                harnessId,
                "session:statuses",
                target,
                targetArgs(target),
              );
              return Object.entries(statuses);
            } catch {
              return [];
            }
          }),
        );
        return Object.fromEntries(entries.flat());
      },
    },
    sessions: {
      query: async ({ projects, harnessIds }): Promise<SessionQueryResult> => {
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
              ...jsonBody({
                projects: group.projects.map(({ directory }) => ({ directory })),
                harnessIds,
              }),
            }),
          ),
        );
        return {
          items: responses
            .flatMap((response, index) =>
              response.items.flatMap((item) =>
                (groupedRequests[index]?.projects ?? [])
                  .filter(
                    (project) =>
                      normalizeProjectPath(project.directory) ===
                      normalizeProjectPath(item.directory),
                  )
                  .map((requestProject) => ({ item, requestProject })),
              ),
            )
            .map(({ item, requestProject }) => ({
              ...item,
              workspaceId: requestProject?.workspaceId,
              sessions: item.sessions.map((session) =>
                toFrontendSessionFromDirectory(
                  session,
                  item.directory,
                  requestProject?.workspaceId,
                ),
              ),
            })),
          errors: responses.flatMap((response, index) =>
            (response.errors ?? []).flatMap((error) =>
              (groupedRequests[index]?.projects ?? [])
                .filter(
                  (project) =>
                    normalizeProjectPath(project.directory) ===
                    normalizeProjectPath(error.directory),
                )
                .map((project) => ({ ...error, workspaceId: project.workspaceId })),
            ),
          ),
        };
      },
      create: async ({ harnessId, title, target }) => {
        if (!target?.directory)
          throw new OpenGuiRpcError("Directory is required", "INVALID_INPUT", true);
        const record = await createSessionRecord({
          harnessId,
          title,
          target: { ...target, directory: target.directory },
        });
        return toFrontendSessionFromDirectory(record, target.directory, target.workspaceId);
      },
      delete: async ({ sessionId, harnessId, target, confirmQueue }) => {
        const path = await resolveSessionPath({ sessionId, harnessId, target });
        const url = new URL(path, "http://opengui.local");
        if (confirmQueue) url.searchParams.set("confirmQueue", "true");
        return await requestAt<boolean>(
          requestBaseUrlForSession({ sessionId, harnessId, target }),
          `${url.pathname}${url.search}`,
          {
            method: "DELETE",
          },
        );
      },
      rename: async ({ sessionId, title, harnessId, target }) => {
        const requestBaseUrl = requestBaseUrlForSession({ sessionId, harnessId, target });
        const record = await requestAt<SessionRecordResponse>(
          requestBaseUrl,
          await resolveSessionPath({ sessionId, harnessId, target }),
          {
            method: "PATCH",
            ...jsonBody({ title }),
          },
        );
        return toFrontendSession(
          record,
          target?.directory ??
            (typeof record.metadata?.directory === "string" ? record.metadata.directory : ""),
          target?.workspaceId,
        );
      },
      getMessages: async ({ sessionId, harnessId, options }) => {
        const path = await resolveSessionPath(
          {
            sessionId,
            harnessId,
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
            harnessId,
            directory: options?.directory,
            workspaceId: options?.workspaceId,
            baseUrl: options?.baseUrl,
          }),
          `${url.pathname}${url.search}`,
        );
      },
      prompt: async ({ sessionId, text, model, agent, variant, mode, target, harnessId }) => {
        await sessionRequest<boolean>({ sessionId, harnessId, target }, "/prompt", {
          method: "POST",
          ...jsonBody({ text, model, agent, variant, mode }),
        });
      },
      abort: async ({ sessionId, harnessId, target }) => {
        await sessionRequest<boolean>({ sessionId, harnessId, target }, "/abort", {
          method: "POST",
        });
      },
      respondPermission: async ({ sessionId, permissionId, response, harnessId, target }) => {
        const targetBody = interactionTargetBody(target);
        await requestAt<boolean>(
          requestBaseUrlForTarget(target),
          `/api/permissions/${encodeURIComponent(permissionId)}/respond`,
          {
            method: "POST",
            ...jsonBody({
              sessionId,
              response,
              harnessId,
              ...targetBody,
            }),
          },
        );
      },
      replyQuestion: async ({ sessionId, requestId, answers, harnessId, target }) => {
        const targetBody = interactionTargetBody(target);
        await requestAt<boolean>(
          requestBaseUrlForTarget(target),
          `/api/questions/${encodeURIComponent(requestId)}/reply`,
          {
            method: "POST",
            ...jsonBody({
              sessionId,
              answers,
              harnessId,
              ...targetBody,
            }),
          },
        );
      },
      rejectQuestion: async ({ sessionId, requestId, harnessId, target }) => {
        const targetBody = interactionTargetBody(target);
        await requestAt<boolean>(
          requestBaseUrlForTarget(target),
          `/api/questions/${encodeURIComponent(requestId)}/reject`,
          {
            method: "POST",
            ...jsonBody({
              sessionId,
              harnessId,
              ...targetBody,
            }),
          },
        );
      },
      queue: {
        list: async ({ sessionId, harnessId, target }) =>
          await sessionRequest<OpenGuiQueueEntry[]>({ sessionId, harnessId, target }, "/queue"),
        listProject: async ({ harnessId, target }) => {
          if (!target.directory) return {};
          return await requestAt<Record<string, OpenGuiQueueEntry[]>>(
            requestBaseUrlForTarget(target),
            `/api/queues?directory=${encodeURIComponent(target.directory)}&harnessId=${encodeURIComponent(harnessId)}`,
          );
        },
        enqueue: async ({
          sessionId,
          text,
          model,
          agent,
          variant,
          mode,
          insertAt,
          harnessId,
          target,
        }) =>
          await sessionRequest<OpenGuiQueueEntry[]>({ sessionId, harnessId, target }, "/queue", {
            method: "POST",
            ...jsonBody({ text, model, agent, variant, mode, insertAt }),
          }),
        remove: async ({ sessionId, entryId, harnessId, target }) =>
          await sessionRequest<OpenGuiQueueEntry[]>(
            { sessionId, harnessId, target },
            queueEntryPath(entryId),
            { method: "DELETE" },
          ),
        update: async ({
          sessionId,
          entryId,
          text,
          model,
          agent,
          variant,
          mode,
          harnessId,
          target,
        }) =>
          await sessionRequest<OpenGuiQueueEntry[]>(
            { sessionId, harnessId, target },
            queueEntryPath(entryId),
            {
              method: "PATCH",
              ...jsonBody({ text, model, agent, variant, mode }),
            },
          ),
        reorder: async ({ sessionId, entryId, index, harnessId, target }) =>
          await sessionRequest<OpenGuiQueueEntry[]>(
            { sessionId, harnessId, target },
            queueEntryPath(entryId, "/reorder"),
            {
              method: "PATCH",
              ...jsonBody({ index }),
            },
          ),
        sendNow: async ({ sessionId, entryId, harnessId, target }) =>
          await sessionRequest<OpenGuiQueueEntry[]>(
            { sessionId, harnessId, target },
            queueEntryPath(entryId, "/send-now"),
            { method: "POST" },
          ),
      },
    },
    files: {
      find: async ({ target, query }) => {
        if (!target.directory) return [];
        return await requestAt<string[]>(
          requestBaseUrlForTarget(target),
          `/api/fs/search?directory=${encodeURIComponent(target.directory)}&query=${encodeURIComponent(query)}`,
        );
      },
    },
    git: {
      isRepo: async (directory: string) =>
        await ipcResult<boolean>("git:is-repo", [directory], "Failed to detect git repository"),
      listBranches: async (directory: string) =>
        await ipcResult<string[]>("git:branch:list", [directory], "Failed to list git branches"),
      currentBranch: async (directory: string) =>
        await ipcResult<string>(
          "git:current-branch",
          [directory],
          "Failed to get current git branch",
        ),
      listWorktrees: async (directory: string) =>
        await ipcResult<GitWorktree[]>(
          "git:worktree:list",
          [directory],
          "Failed to list git worktrees",
        ),
      addWorktree: async (
        directory: string,
        worktreePath: string,
        branch: string,
        isNewBranch: boolean,
      ) =>
        await ipcResult<{ path: string }>(
          "git:worktree:add",
          [directory, worktreePath, branch, isNewBranch],
          "Failed to create git worktree",
        ),
      removeWorktree: async (directory: string, worktreePath: string) => {
        await ipcResult(
          "git:worktree:remove",
          [directory, worktreePath],
          "Failed to remove git worktree",
        );
      },
      merge: async (directory: string, branch: string) =>
        await rpcCall<GitMergeResult>("git:merge", [directory, branch]),
      mergeAbort: async (directory: string) => {
        await ipcResult("git:merge:abort", [directory], "Failed to abort git merge");
      },
      getRemoteUrl: async (directory: string) =>
        await ipcResult<string>("git:remote:url", [directory], "Failed to load git remote URL"),
    },
    worktree: {
      detectSetup: async (worktreePath: string) =>
        await rpcCall<WorktreeSetupDetection>("worktree:detect-setup", [worktreePath]),
      runSetup: async (worktreePath: string, command: string) => {
        await ipcResult(
          "worktree:run-setup",
          [worktreePath, command],
          "Failed to run worktree setup",
        );
      },
    },
    runtime: {
      getHomeDir: async () => await rpcCall<string>("platform:homeDir"),
      getHarnessInventories: async () =>
        await rpcCall<HarnessInventory[]>("platform:harnessInventory"),
    },
    desktop: {
      openDirectory: async () =>
        options.openDirectory
          ? await options.openDirectory()
          : await rpcCall<string | null>("dialog:openDirectory"),
    },
  };
}

export type { HarnessId };
