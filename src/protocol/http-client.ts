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
  CreateWorkspaceInput,
  OpenGuiCapabilities,
  OpenGuiClient,
  OpenGuiWorkspace,
  ProjectSessionsResult,
  UpdateWorkspaceInput,
} from "@/protocol/client";
import type { IPCResult } from "@/types/electron";

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

export interface HttpOpenGuiClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  rpcImpl?: <T = unknown>(channel: string, args?: unknown[]) => Promise<T>;
  subscribeBackendEvents?: (
    listener: (message: { channel: string; data: unknown }) => void,
  ) => () => void;
  webSocketImpl?: typeof WebSocket;
  location?: Pick<Location, "protocol" | "host">;
  openDirectory?: () => Promise<string | null>;
  localCapabilities?: boolean;
}

const INITIAL_EVENT_RETRY_MS = 1_000;
const MAX_EVENT_RETRY_MS = 30_000;

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function httpRpc<T>(path: string, channel: string, args: unknown[] = []): Promise<T> {
  const response = await fetch(joinUrl(path, "/api/rpc"), {
    method: "POST",
    headers: { "content-type": "application/json" },
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

function appendTarget(target?: AgentBackendTarget, ...args: unknown[]) {
  return [...targetArgs(target), ...args];
}

function createOpenCodePlatform(
  op: <T>(suffix: string, args?: unknown[]) => Promise<T>,
): AgentBackendDescriptor["platform"] {
  return {
    server: {
      start: () => op("server:start"),
      stop: () => op("server:stop"),
      status: () => op("server:status"),
    },
    providers: {
      listAll: (target) => op("provider:list", targetArgs(target)),
      getAuthMethods: (target) => op("provider:auth-methods", targetArgs(target)),
      connect: (target, providerID, auth) =>
        op("provider:connect", appendTarget(target, providerID, auth)),
      disconnect: (target, providerID) =>
        op("provider:disconnect", appendTarget(target, providerID)),
      oauthAuthorize: (target, providerID, method) =>
        op("provider:oauth:authorize", appendTarget(target, providerID, method)),
      oauthCallback: (target, providerID, method, code) =>
        op("provider:oauth:callback", appendTarget(target, providerID, method, code)),
      dispose: (target) => op("instance:dispose", targetArgs(target)),
    },
    mcp: {
      status: (target) => op("mcp:status", targetArgs(target)),
      add: (target, name, config) => op("mcp:add", appendTarget(target, name, config)),
      connect: (target, name) => op("mcp:connect", appendTarget(target, name)),
      disconnect: (target, name) => op("mcp:disconnect", appendTarget(target, name)),
    },
    skills: {
      list: (target) => op("skills", targetArgs(target)),
      marketplace: {
        list: (view, page, perPage, apiKey) =>
          op("skills:marketplace:list", [view, page, perPage, apiKey]),
        search: (query, limit, apiKey) => op("skills:marketplace:search", [query, limit, apiKey]),
        detail: (source, slug, apiKey) => op("skills:marketplace:detail", [source, slug, apiKey]),
        audit: (source, slug, apiKey) => op("skills:marketplace:audit", [source, slug, apiKey]),
        curated: (apiKey) => op("skills:marketplace:curated", [apiKey]),
      },
      install: (source, directory, globalScope) =>
        op("skills:install", [source, directory, globalScope]),
      remove: (skillName, directory, globalScope) =>
        op("skills:remove", [skillName, directory, globalScope]),
      update: (skillName, directory, globalScope) =>
        op("skills:update", [skillName, directory, globalScope]),
      listInstalled: (directory) => op("skills:list-installed", [directory]),
      checkCli: () => op("skills:check-cli"),
    },
    config: {
      get: (target) => op("config:get", targetArgs(target)),
      update: (target, config) => op("config:update", appendTarget(target, config)),
    },
  };
}

function createWebBackendDescriptor(
  backendId: AgentBackendId,
  rpcCall: <T>(channel: string, args?: unknown[]) => Promise<T>,
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
  };
  const op = <T>(suffix: string, args: unknown[] = []) => rpcCall<T>(`opencode:${suffix}`, args);
  const platform = backendId === "opencode" ? createOpenCodePlatform(op) : undefined;

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

function eventUrl(baseUrl: string, currentLocation?: Pick<Location, "protocol" | "host">) {
  if (!baseUrl) {
    if (!currentLocation) {
      throw new OpenGuiRpcError("Cannot derive event URL without baseUrl or browser location");
    }
    const protocol = currentLocation.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${currentLocation.host}/api/events`;
  }
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/events";
  url.search = "";
  return url.toString();
}

export function createHttpOpenGuiClient(options: HttpOpenGuiClientOptions = {}): OpenGuiClient {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);

    const response = await fetchImpl(joinUrl(baseUrl, path), { ...init, headers });
    const body = (await response.json().catch(() => null)) as RpcEnvelope<T> | null;
    if (!response.ok || !body?.ok) {
      throwRpcError(body, `Request failed: ${path}`);
    }
    return body.value as T;
  }

  const rpcCall = <T>(channel: string, args: unknown[] = []) =>
    options.rpcImpl?.<T>(channel, args) ?? httpRpc<T>(baseUrl, channel, args);
  const webBackends = AGENT_BACKEND_IDS.map((backendId) =>
    createWebBackendDescriptor(backendId, rpcCall),
  );
  const list = () => webBackends;
  const get = (backendId: AgentBackendId = "opencode") =>
    webBackends.find((backend) => backend.id === backendId);
  const backendIdsOrAll = (backendIds?: AgentBackendId[]) =>
    backendIds?.length ? backendIds : AGENT_BACKEND_IDS;
  const backendChannel = (backendId: AgentBackendId, suffix: string) => `${backendId}:${suffix}`;
  const backendRpc = async <T>(backendId: AgentBackendId, suffix: string, args: unknown[] = []) =>
    unwrapIpcResult(
      await rpcCall<IPCResult<T>>(backendChannel(backendId, suffix), args),
      `Backend call failed: ${backendId}:${suffix}`,
    );
  const sessionBackendId = (sessionId: string, backendId?: AgentBackendId) =>
    backendId ?? getAgentBackendIdFromSessionId(sessionId) ?? "opencode";
  const sessionRpc = <T>(
    sessionId: string,
    backendId: AgentBackendId | undefined,
    suffix: string,
    args: unknown[] = [],
  ) => {
    const resolvedBackendId = sessionBackendId(sessionId, backendId);
    const rawSessionId = createAgentIdCodec(resolvedBackendId).decompose(sessionId);
    const normalizedArgs = args[0] === sessionId ? [rawSessionId, ...args.slice(1)] : args;
    return backendRpc<T>(resolvedBackendId, suffix, normalizedArgs);
  };

  return {
    capabilities: () =>
      options.localCapabilities
        ? Promise.resolve({
            protocolVersion: 1,
            server: {
              workspaces: false,
              projects: false,
              sessions: false,
              events: "websocket",
              auth: false,
              allowedRoots: false,
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
    agentBackends: {
      list,
      get,
      subscribe: (listener: (event: AgentBackendEvent) => void) => {
        const handleMessage = (message: { channel?: string; data?: unknown }) => {
          try {
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
        let ws: WebSocket | undefined;
        const WebSocketCtor = options.webSocketImpl ?? globalThis.WebSocket;
        const currentLocation =
          options.location ??
          (typeof globalThis.location === "undefined" ? undefined : globalThis.location);
        const url = eventUrl(baseUrl, currentLocation);
        const connect = () => {
          ws = new WebSocketCtor(url);
          ws.onopen = () => {
            retryDelayMs = INITIAL_EVENT_RETRY_MS;
          };
          ws.onmessage = (event) => {
            try {
              handleMessage(JSON.parse(event.data));
            } catch (error) {
              console.error("Bad OpenGUI event payload", error);
            }
          };
          ws.onerror = (error) => {
            console.error("OpenGUI event WebSocket error", error);
          };
          ws.onclose = () => {
            if (closed) return;
            retry = setTimeout(connect, retryDelayMs);
            retryDelayMs = Math.min(retryDelayMs * 2, MAX_EVENT_RETRY_MS);
          };
        };
        connect();
        return () => {
          closed = true;
          if (retry) clearTimeout(retry);
          ws?.close();
        };
      },
      loadResources: async ({ backendId, target }) => {
        const args = targetArgs(target);
        const [providersData, agentsData, commandsData] = await Promise.all([
          backendRpc<BackendResourceBundle["providersData"]>(backendId, "providers", args),
          backendRpc<BackendResourceBundle["agentsData"]>(backendId, "agents", args),
          backendRpc<BackendResourceBundle["commandsData"]>(backendId, "commands", args),
        ]);
        return { providersData, agentsData, commandsData };
      },
      connectProject: async ({ config, backendIds }) => {
        const targetBackends = backendIdsOrAll(backendIds);
        if (!config.directory) {
          return {
            connectedBackendIds: [],
            errors: targetBackends.map((backendId) => ({
              backendId,
              error: "Directory is required",
            })),
          };
        }
        return { connectedBackendIds: targetBackends, errors: [] };
      },
      disconnectProject: async ({ target, backendIds }) => {
        await Promise.all(
          backendIdsOrAll(backendIds).map((backendId) =>
            backendRpc(backendId, "project:remove", targetArgs(target)),
          ),
        );
      },
      listProjectSessions: async ({ backendIds, target }) => {
        const results = await Promise.all(
          backendIds.map(async (backendId) => {
            try {
              const sessions = await backendRpc<ProjectSessionsResult["sessions"]>(
                backendId,
                "session:list",
                targetArgs(target),
              );
              return { backendId, sessions };
            } catch {
              return null;
            }
          }),
        );
        return results.filter((result) => result !== null);
      },
      listProjectSessionStatuses: async ({ backendIds, target }) => {
        const entries = await Promise.all(
          backendIds.map(async (backendId) => {
            try {
              return Object.entries(
                await backendRpc<Record<string, { type: string }>>(
                  backendId,
                  "session:statuses",
                  targetArgs(target),
                ),
              );
            } catch {
              return [] as Array<[string, { type: string }]>;
            }
          }),
        );
        return Object.fromEntries(entries.flat());
      },
    },
    sessions: {
      create: async ({ backendId, title, target }) =>
        await backendRpc(backendId, "session:create", [
          title,
          target?.directory,
          target?.workspaceId,
        ]),
      delete: async ({ sessionId, backendId }) =>
        await sessionRpc(sessionId, backendId, "session:delete", [sessionId]),
      rename: async ({ sessionId, title, backendId }) =>
        await sessionRpc(sessionId, backendId, "session:update", [sessionId, title]),
      getMessages: async ({ sessionId, backendId, options }) =>
        await sessionRpc(sessionId, backendId, "messages", [
          sessionId,
          options,
          ...targetArgs(options),
        ]),
      prompt: async ({ sessionId, text, images, model, agent, variant, target, backendId }) => {
        await sessionRpc(sessionId, backendId, "prompt", [
          sessionId,
          text,
          images,
          model,
          agent,
          variant,
          target?.directory,
          target?.workspaceId,
        ]);
      },
      abort: async ({ sessionId, backendId }) => {
        await sessionRpc(sessionId, backendId, "abort", [sessionId]);
      },
      respondPermission: async ({ sessionId, permissionId, response, backendId }) => {
        await sessionRpc(sessionId, backendId, "permission", [sessionId, permissionId, response]);
      },
      replyQuestion: async ({ requestId, answers, backendId }) => {
        await backendRpc(backendId ?? "opencode", "question:reply", [requestId, answers]);
      },
      rejectQuestion: async ({ requestId, backendId }) => {
        await backendRpc(backendId ?? "opencode", "question:reject", [requestId]);
      },
    },
    files: {
      find: async ({ target, query }) =>
        target.directory ? await rpcCall<string[]>("files:find", [target.directory, query]) : [],
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
