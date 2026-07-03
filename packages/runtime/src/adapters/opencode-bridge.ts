/**
 * ESM bridge module loaded by main.ts via dynamic import().
 * Hosts OpenCodeConnection instances (one per project) and wires IPC handlers.
 *
 * TypeScript ESM bridge compiled to dist-electron/opencode-bridge.js,
 * allowing imports from the ESM-only @opencode-ai/sdk.
 *
 * Uses v2 SDK which supports variant selection and named parameters.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Agent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { pollUntilEffect, runEffect, sleepEffect } from "../../../../lib/effect-runtime.ts";
import { getOpenCodeProviderAuthKinds } from "./opencode-config.ts";
import { OpencodeProjectRegistry } from "./opencode-project-registry.ts";
import { makeHarnessSessionIdCodec } from "./harness-adapter-kit.ts";
import {
  assertOpenCodeResponseOk,
  extractOpenCodeEventRawSessionId,
  extractOpenCodeEventSessionDirectory,
  getConnectionEntryForSession as routingConnectionEntryForSession,
  getConnectionForSession as resolveConnectionForSession,
  type OpenCodeWindowState,
  normalizeOpenCodeDirectoryHint,
  stripMessagePayloadBloat,
  tagOpenCodeMessageEntry,
  tagOpenCodeSession,
} from "./opencode-bridge-mapping.ts";
import type {
  HarnessWebContentsSender,
  OpenCodeConnectConfig,
  OpenCodeHealthSnapshot,
  OpenCodeLocalServerOpResult,
  OpenCodeMessageEntry,
  OpenCodeMessagesOptions,
  OpenCodeModelRef,
  OpenCodePromptPart,
  OpenCodeProjectAddConfig,
  OpenCodeRunCommandError,
  OpenCodeServerProcessInfo,
  OpenCodeSessionStartInput,
  OpenCodeSdkClient,
  OpenCodeWindowBridgeState,
} from "./opencode-bridge-types.ts";
import {
  makeHarnessBridgeEventSender,
  registerHarnessRpcHandlers,
} from "./harness-adapter-host.ts";

type OpencodeIpcMain = Parameters<typeof registerHarnessRpcHandlers>[1];
type OpencodeIpcEvent = { sender: HarnessWebContentsSender };
import { resolveHarnessCli } from "../../../../server/harness-inventory.ts";
import {
  abortOpenCodeSseBeforeRestart,
  shouldStopOpenCodeSseRead,
} from "./opencode-sse-lifecycle.ts";

// ---------------------------------------------------------------------------
// Local server management
// ---------------------------------------------------------------------------

const LOCAL_SERVER_PORT = Number.parseInt(process.env.OPENGUI_OPENCODE_PORT ?? "4096", 10);
const LOCAL_SERVER_URL = `http://127.0.0.1:${LOCAL_SERVER_PORT}`;
const LOCAL_HEALTH_TIMEOUT = 3000; // ms
const STARTUP_POLL_INTERVAL = 500; // ms
const STARTUP_TIMEOUT = process.platform === "win32" ? 60_000 : 15_000; // ms
const DETACHED_LAUNCH_GRACE_TIMEOUT = 10_000; // ms
const UNHEALTHY_LISTENER_GRACE_TIMEOUT = 5_000; // ms

let localServerStartPromise: Promise<OpenCodeLocalServerOpResult> | null = null;
let localServerStopPromise: Promise<OpenCodeLocalServerOpResult> | null = null;

/** Resolve the opencode binary path (cross-platform). */
function resolveOpencodeBinary() {
  return resolveHarnessCli("opencode").resolvedPath;
}

function isLocalOpenCodeServerUrl(baseUrl: string | null | undefined) {
  return baseUrl?.replace(/\/+$/, "") === LOCAL_SERVER_URL;
}

/** Fetch health info from the local server. Returns { healthy, version } or defaults. */
async function fetchLocalHealth(timeoutMs = LOCAL_HEALTH_TIMEOUT) {
  try {
    const res = await fetch(`${LOCAL_SERVER_URL}/global/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { healthy: false, version: null };
    const data: unknown = await res.json();
    const record =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    const version =
      record && typeof record.version === "string" ? record.version : null;
    return {
      healthy: record?.healthy === true,
      version,
    } satisfies OpenCodeHealthSnapshot;
  } catch {
    return { healthy: false, version: null };
  }
}

/** Return the version string from a local binary, or null. */
function getBinaryVersion(binaryPath: string) {
  try {
    return execSync(`"${binaryPath}" --version`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function getServerProcessCommand(pid: number) {
  if (!pid || Number.isNaN(pid)) return null;
  try {
    if (process.platform === "win32") {
      const out = execSync(`wmic process where processid=${pid} get CommandLine /value`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.match(/CommandLine=(.*)/i)?.[1]?.trim() || null;
    }

    const out = execSync(`ps -p ${pid} -o command=`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function findServerProcess() {
  const isWindows = process.platform === "win32";
  let pid = null;

  if (isWindows) {
    try {
      const out = execSync(`netstat -ano | findstr :${LOCAL_SERVER_PORT} | findstr LISTENING`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = out.trim().split(/\s+/).pop();
      if (match) pid = Number.parseInt(match, 10);
    } catch {
      // no process found
    }
  } else {
    try {
      const out = execSync(`lsof -tiTCP:${LOCAL_SERVER_PORT} -sTCP:LISTEN`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const first = out.trim().split(/\s+/)[0];
      if (first) pid = Number.parseInt(first, 10);
    } catch {
      // lsof is not installed in the Docker image by default. Fall back to ss,
      // which is available in the image, then fuser for other Linux hosts.
      try {
        const out = execSync(`ss -ltnp 'sport = :${LOCAL_SERVER_PORT}'`, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const match = out.match(/pid=(\d+)/);
        if (match?.[1]) pid = Number.parseInt(match[1], 10);
      } catch {
        try {
          const out = execSync(`fuser -n tcp ${LOCAL_SERVER_PORT}`, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          });
          const first = out.trim().split(/\s+/)[0];
          if (first) pid = Number.parseInt(first, 10);
        } catch {
          // no process found
        }
      }
    }
  }

  if (!pid || Number.isNaN(pid)) return null;
  return { pid, command: getServerProcessCommand(pid) };
}

function isLikelyOpenCodeProcess(processInfo: OpenCodeServerProcessInfo | null) {
  return /(^|[\\/\s])opencode(\.exe)?([\s]|$)/i.test(processInfo?.command ?? "");
}

function formatServerProcess(processInfo: OpenCodeServerProcessInfo | null) {
  if (!processInfo) return `port ${LOCAL_SERVER_PORT}`;
  const command = processInfo.command ? ` (${processInfo.command})` : "";
  return `PID ${processInfo.pid}${command}`;
}

/** Kill the opencode server process listening on LOCAL_SERVER_PORT. Returns true if killed. */
async function killServerProcess(pid: number | null = null) {
  const isWindows = process.platform === "win32";
  const processInfo = pid ? { pid, command: getServerProcessCommand(pid) } : findServerProcess();
  if (!processInfo?.pid || Number.isNaN(processInfo.pid)) return false;

  try {
    process.kill(processInfo.pid, isWindows ? "SIGKILL" : "SIGTERM");
  } catch {
    return false;
  }

  await runEffect(sleepEffect(1000));

  if ((await fetchLocalHealth(1000)).healthy) {
    try {
      process.kill(processInfo.pid, "SIGKILL");
    } catch {
      // already dead
    }
    await runEffect(sleepEffect(500));
    if ((await fetchLocalHealth(1000)).healthy) return false;
  }

  return true;
}

/** Poll until healthy or timeout. */
async function waitForHealthy(timeoutMs = STARTUP_TIMEOUT) {
  await runEffect(
    pollUntilEffect({
      attempt: async () => (await fetchLocalHealth(1000)).healthy,
      intervalMs: STARTUP_POLL_INTERVAL,
      timeoutMs,
      timeoutMessage: `Server did not become healthy within ${timeoutMs / 1000}s`,
    }),
  );
  return true;
}

// ---------------------------------------------------------------------------
// URL safety helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline connection manager (avoids needing to transpile TS in main process)
// ---------------------------------------------------------------------------

const BACKOFF_STEPS = [500, 1000, 2000, 5000]; // ms – fast first attempt
const HEALTH_INTERVAL = 30_000; // ms
const SSE_STALE_THRESHOLD = 45_000; // ms – restart SSE if no event for this long
const OPENCODE_SESSION_PREFIX = "opencode:";
const { toFrontendSessionId, toRawSessionId } = makeHarnessSessionIdCodec(OPENCODE_SESSION_PREFIX);

// Keep-alive agents to prevent idle TCP connections from being dropped.
// Setting keepAlive + very long timeouts prevents OS/proxy idle-timeout kills.
const httpAgent = new Agent({ keepAlive: true, keepAliveMsecs: 15_000 });
const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 15_000 });

export class OpenCodeConnection {
  _emit: (event: Record<string, unknown>) => void;
  _lifecycle: number;
  _streamGeneration: number;
  _client: OpenCodeSdkClient | null;
  _config: OpenCodeConnectConfig | null;
  _abortController: AbortController | null;
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _healthTimer: ReturnType<typeof setInterval> | null;
  _reconnectAttempt: number;
  _status: {
    state: string;
    serverUrl: string | null;
    serverVersion: string | null;
    error: string | null;
    lastEventAt: number | null;
  };

  constructor(emit: (event: Record<string, unknown>) => void) {
    this._emit = emit;
    this._lifecycle = 0;
    this._streamGeneration = 0;
    this._client = null;
    this._config = null;
    this._abortController = null;
    this._reconnectTimer = null;
    this._healthTimer = null;
    this._reconnectAttempt = 0;
    this._status = {
      state: "idle",
      serverUrl: null,
      serverVersion: null,
      error: null,
      lastEventAt: null,
    };
  }

  // - public ---------------------------------------------------------------

  async connect(config: OpenCodeConnectConfig) {
    this.teardown();
    const lifecycle = ++this._lifecycle;
    this._config = config;
    this._client = this._makeClient(config);
    this._setStatus({
      state: "connecting",
      serverUrl: config.baseUrl,
      error: null,
    });

    try {
      await this._healthCheck();
      if (!this._isCurrent(lifecycle)) return;
      this._setStatus({ state: "connected" });
      void this._startSSE(lifecycle);
      this._startHealthTimer(lifecycle);
    } catch (err) {
      if (!this._isCurrent(lifecycle)) return;
      const msg = err instanceof Error ? err.message : String(err);
      this._setStatus({ state: "error", error: msg });
      throw err;
    }
  }

  disconnect() {
    this.teardown();
    this._setStatus({
      state: "idle",
      serverUrl: null,
      serverVersion: null,
      error: null,
      lastEventAt: null,
    });
  }

  getStatus() {
    return { ...this._status };
  }

  getDirectory() {
    return this._config?.directory ?? null;
  }

  // - sessions -------------------------------------------------------------

  async listSessions() {
    this._requireClient();
    // The server defaults to LIMIT 100. Request a high limit so all
    // sessions are returned regardless of how many the user has.
    // Pass the connection directory so sessions are scoped to this
    // project directory only – without this, the server returns ALL
    // sessions sharing the same git repo (project_id), which causes
    // cross-directory duplicates in the sidebar.
    const dir = this.getDirectory();
    const res = await this._sdk.session.list({
      roots: true,
      limit: 10000,
      ...(dir ? { directory: dir } : {}),
    });
    return res.data ?? [];
  }

  async createSession(title?: string) {
    this._requireClient();
    const normalizedTitle = typeof title === "string" ? title.trim() : "";
    const params = normalizedTitle ? { title: normalizedTitle } : undefined;
    const res = await this._sdk.session.create(params);
    return res.data;
  }

  async deleteSession(id: string) {
    this._requireClient();
    const res = await this._sdk.session.delete({ sessionID: id });
    return res.data;
  }

  async updateSession(id: string, title: string) {
    this._requireClient();
    const res = await this._sdk.session.update({ sessionID: id, title });
    return res.data;
  }

  async getSessionStatuses() {
    this._requireClient();
    const res = await this._sdk.session.status();
    return res.data ?? {};
  }

  // - revert / fork ---------------------------------------------------------

  async revertSession(sessionID: string, messageID: string, partID?: string) {
    this._requireClient();
    const params: { sessionID: string; messageID: string; partID?: string } = {
      sessionID,
      messageID,
    };
    if (partID) params.partID = partID;
    const res = await this._sdk.session.revert(params);
    return res.data;
  }

  async unrevertSession(sessionID: string) {
    this._requireClient();
    const res = await this._sdk.session.unrevert({ sessionID });
    return res.data;
  }

  async forkSession(sessionID: string, messageID?: string) {
    this._requireClient();
    const params: { sessionID: string; messageID?: string } = { sessionID };
    if (messageID) params.messageID = messageID;
    const res = await this._sdk.session.fork(params);
    return res.data;
  }

  // - providers / models ----------------------------------------------------

  async getProviders() {
    this._requireClient();
    const res = await this._sdk.config.providers();
    return res.data ?? { providers: [], default: {} };
  }

  async listAllProviders() {
    this._requireClient();
    const res = await this._sdk.provider.list();
    const data = res.data ?? { all: [], default: {}, connected: [] };
    return {
      ...data,
      authKindByProvider: await getOpenCodeProviderAuthKinds(
        this.getDirectory(),
        data.all,
        data.connected,
      ),
    };
  }

  async getProviderAuthMethods() {
    this._requireClient();
    const res = await this._sdk.provider.auth();
    return res.data ?? {};
  }

  async setProviderAuth(providerID: string, auth: unknown) {
    this._requireClient();
    const res = await this._sdk.auth.set({
      providerID,
      auth: auth as Parameters<OpenCodeSdkClient["auth"]["set"]>[0]["auth"],
    });
    return res.data;
  }

  async removeProviderAuth(providerID: string) {
    this._requireClient();
    const res = await this._sdk.auth.remove({ providerID });
    return res.data;
  }

  async oauthAuthorize(providerID: string, method?: string) {
    this._requireClient();
    const params: { providerID: string; method?: string } = { providerID };
    if (method !== undefined) params.method = method;
    const res = await this._sdk.provider.oauth.authorize(
      params as Parameters<OpenCodeSdkClient["provider"]["oauth"]["authorize"]>[0],
    );
    return res.data;
  }

  async oauthCallback(providerID: string, method?: string, code?: string) {
    this._requireClient();
    const params: { providerID: string; method?: string; code?: string } = { providerID };
    if (method !== undefined) params.method = method;
    if (code !== undefined) params.code = code;
    const res = await this._sdk.provider.oauth.callback(
      params as Parameters<OpenCodeSdkClient["provider"]["oauth"]["callback"]>[0],
    );
    return res.data;
  }

  async disposeInstance() {
    this._requireClient();
    const res = await this._sdk.instance.dispose();
    return res.data;
  }

  // - agents ---------------------------------------------------------------

  async getAgents() {
    this._requireClient();
    const res = await this._sdk.app.agents();
    return res.data ?? [];
  }

  // - messages -------------------------------------------------------------

  async getMessages(sessionId: string, options: OpenCodeMessagesOptions = {}) {
    this._requireClient();
    const params: { sessionID: string; limit?: number; before?: string } = { sessionID: sessionId };
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
      params.limit = options.limit;
    }
    if (typeof options.before === "string" && options.before.trim()) {
      params.before = options.before;
    }
    const res = await this._sdk.session.messages(params);
    const messages = stripMessagePayloadBloat((res.data ?? []) as OpenCodeMessageEntry[]);
    // Extract the opaque pagination cursor from the response header.
    const nextCursor = res.response?.headers?.get("X-Next-Cursor") ?? null;
    return { messages, nextCursor };
  }

  async promptAsync(
    sessionId: string,
    text: string,
    images?: string[],
    model?: OpenCodeModelRef,
    agent?: string,
    variant?: string,
  ) {
    this._requireClient();
    const parts: OpenCodePromptPart[] = [{ type: "text", text }];
    if (images) {
      for (const url of images) {
        // Attempt to detect MIME from data-URI header or file extension
        let mime = "image/png";
        const dataMatch = url.match(/^data:(image\/[^;,]+)/);
        if (dataMatch?.[1]) {
          mime = dataMatch[1];
        } else {
          const ext = url.split(".").pop()?.toLowerCase();
          if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
          else if (ext === "gif") mime = "image/gif";
          else if (ext === "webp") mime = "image/webp";
          else if (ext === "svg") mime = "image/svg+xml";
        }
        parts.push({ type: "file", mime, url });
      }
    }
    const params: {
      sessionID: string;
      parts: OpenCodePromptPart[];
      model?: OpenCodeModelRef;
      agent?: string;
      variant?: string;
    } = { sessionID: sessionId, parts };
    if (model) params.model = model;
    if (agent) params.agent = agent;
    if (variant) params.variant = variant;
    await this._sdk.session.promptAsync(
      params as Parameters<OpenCodeSdkClient["session"]["promptAsync"]>[0],
    );
  }

  async abortSession(sessionId: string) {
    this._requireClient();
    await this._sdk.session.abort({ sessionID: sessionId });
  }

  // - permissions ----------------------------------------------------------

  async respondPermission(
    sessionId: string,
    permissionId: string,
    response: "always" | "once" | "reject",
    workspaceId?: string,
  ) {
    this._requireClient();
    const directory = this.getDirectory();
    const workspace =
      typeof workspaceId === "string" && workspaceId.trim() && workspaceId !== "local"
        ? workspaceId.trim()
        : undefined;
    try {
      assertOpenCodeResponseOk(
        (await this._sdk.permission.reply({
          requestID: permissionId,
          reply: response,
          ...(directory ? { directory } : {}),
          ...(workspace ? { workspace } : {}),
        })) as Parameters<typeof assertOpenCodeResponseOk>[0],
        `Permission reply failed for ${permissionId}`,
      );
    } catch (replyError) {
      // Fallback for older OpenCode servers which only expose deprecated
      // session-scoped permission responses.
      try {
        assertOpenCodeResponseOk(
          (await this._sdk.permission.respond({
            sessionID: sessionId,
            permissionID: permissionId,
            response,
            ...(directory ? { directory } : {}),
            ...(workspace ? { workspace } : {}),
          })) as Parameters<typeof assertOpenCodeResponseOk>[0],
          `Permission response failed for ${permissionId}`,
        );
      } catch {
        throw replyError;
      }
    }
  }

  // - commands -------------------------------------------------------------

  async listCommands() {
    this._requireClient();
    const res = await this._sdk.command.list();
    return res.data ?? [];
  }

  async sendCommand(
    sessionId: string,
    command: string,
    args: unknown,
    model?: OpenCodeModelRef,
    agent?: string,
    variant?: string,
  ) {
    this._requireClient();
    const params: {
      sessionID: string;
      command: string;
      arguments: unknown;
      model?: string;
      agent?: string;
      variant?: string;
    } = { sessionID: sessionId, command, arguments: args };
    if (model) params.model = `${model.providerID}/${model.modelID}`;
    if (agent) params.agent = agent;
    if (variant) params.variant = variant;
    await this._sdk.session.command(
      params as Parameters<OpenCodeSdkClient["session"]["command"]>[0],
    );
  }

  async summarizeSession(sessionId: string, model: OpenCodeModelRef | null | undefined) {
    this._requireClient();
    if (!model?.providerID || !model?.modelID) {
      throw new Error("Compaction requires a model to be selected");
    }
    await this._sdk.session.summarize({
      sessionID: sessionId,
      providerID: model.providerID,
      modelID: model.modelID,
    });
  }

  // - questions ------------------------------------------------------------

  async replyQuestion(
    requestID: string,
    answers: Parameters<OpenCodeSdkClient["question"]["reply"]>[0]["answers"],
  ) {
    this._requireClient();
    const directory = this.getDirectory();
    await this._sdk.question.reply({
      requestID,
      answers,
      ...(directory ? { directory } : {}),
    });
  }

  async rejectQuestion(requestID: string) {
    this._requireClient();
    const directory = this.getDirectory();
    await this._sdk.question.reject({
      requestID,
      ...(directory ? { directory } : {}),
    });
  }

  // - MCP ------------------------------------------------------------------

  async getMcpStatus() {
    this._requireClient();
    const res = await this._sdk.mcp.status();
    return res.data ?? {};
  }

  async addMcp(name: string, config: unknown) {
    this._requireClient();
    const res = await this._sdk.mcp.add({
      name,
      config,
    } as Parameters<OpenCodeSdkClient["mcp"]["add"]>[0]);
    return res.data ?? {};
  }

  async connectMcp(name: string) {
    this._requireClient();
    await this._sdk.mcp.connect({ name });
  }

  async disconnectMcp(name: string) {
    this._requireClient();
    await this._sdk.mcp.disconnect({ name });
  }

  // - Config ---------------------------------------------------------------

  async getConfig() {
    this._requireClient();
    const res = await this._sdk.config.get();
    return res.data ?? {};
  }

  async updateConfig(config: unknown) {
    this._requireClient();
    const res = await this._sdk.config.update({ config } as Parameters<
      OpenCodeSdkClient["config"]["update"]
    >[0]);
    return res.data ?? {};
  }

  // - internal -------------------------------------------------------------

  _requireClient(): OpenCodeSdkClient {
    if (!this._client) throw new Error("Not connected to any opencode server");
    return this._client;
  }

  get _sdk(): OpenCodeSdkClient {
    return this._requireClient();
  }

  _makeAuthHeaders(config: OpenCodeConnectConfig) {
    const headers: Record<string, string> = {};
    if (config.password) {
      const user = config.username ?? "opencode";
      headers.Authorization = `Basic ${Buffer.from(`${user}:${config.password}`).toString("base64")}`;
    }
    return headers;
  }

  _makeClient(config: OpenCodeConnectConfig): OpenCodeSdkClient {
    const headers = this._makeAuthHeaders(config);
    const directory = typeof config.directory === "string" ? config.directory.trim() : "";

    // Custom fetch that uses keep-alive agents to prevent idle connection drops.
    const customFetch: typeof fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const agent = url?.startsWith("https") ? httpsAgent : httpAgent;
      return globalThis.fetch(input, { ...init, agent } as RequestInit);
    };

    return createOpencodeClient({
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      headers,
      fetch: customFetch,
      ...(directory ? { directory } : {}),
      // Do NOT send workspace header to OpenCode server.
      // OpenGUI workspace IDs are local UI/persistence concepts, while many
      // existing sessions on local/remote servers live in default workspace
      // scope. Sending x-opencode-workspace hides those sessions from
      // session.list() and sidebar loading.
    });
  }

  _makeGlobalEventClient(config: OpenCodeConnectConfig): OpenCodeSdkClient {
    const headers = this._makeAuthHeaders(config);

    // The OpenCode SDK rewrites GET requests from directory-scoped clients by
    // adding ?directory=... . That is correct for most reads, but it breaks
    // /global/event: OpenCode only emits session.status/session.idle on the
    // truly global stream. If /global/event is directory-scoped, the frontend
    // never sees idle and keeps the stop button/timer running forever.
    const customFetch: typeof fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const agent = url?.startsWith("https") ? httpsAgent : httpAgent;
      return globalThis.fetch(input, { ...init, agent } as RequestInit);
    };

    return createOpencodeClient({
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      headers,
      fetch: customFetch,
    });
  }

  async _healthCheck() {
    this._requireClient();
    try {
      const res = await this._sdk.global.health();
      const data = res.data;
      if (data?.version) this._setStatus({ serverVersion: data.version });
      if (!data?.healthy) throw new Error("Server reports unhealthy");
    } catch (err: unknown) {
      // If the v2 global.health() fails with a method-not-found-style error,
      // fall back to raw fetch (older servers may not support this endpoint via SDK)
      if (err instanceof Error && err.message.includes("unhealthy")) throw err;
      const config = this._config;
      if (!config) throw err instanceof Error ? err : new Error(String(err));
      const url = `${config.baseUrl.replace(/\/+$/, "")}/global/health`;
      const headers = this._makeAuthHeaders(config);
      const rawRes = await fetch(url, { headers });
      if (!rawRes.ok) throw new Error(`Health check failed: ${rawRes.status} ${rawRes.statusText}`);
      const data: unknown = await rawRes.json();
      const record =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : null;
      if (typeof record?.version === "string") this._setStatus({ serverVersion: record.version });
      if (record?.healthy !== true) throw new Error("Server reports unhealthy");
    }
  }

  _isCurrent(lifecycle: number) {
    return lifecycle === this._lifecycle;
  }

  async _startSSE(lifecycle: number) {
    if (!this._isCurrent(lifecycle)) return;
    const config = this._config;
    if (!config) return;
    this._requireClient();
    await abortOpenCodeSseBeforeRestart(this._abortController);
    if (!this._isCurrent(lifecycle)) return;
    const streamGeneration = ++this._streamGeneration;
    const abortController = new AbortController();
    this._abortController = abortController;

    try {
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/global/event`, {
        headers: { ...this._makeAuthHeaders(config), accept: "text/event-stream" },
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error(`OpenCode SSE failed: ${response.status}`);
      if (!response.body) throw new Error("OpenCode SSE response had no body");

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          if (
            shouldStopOpenCodeSseRead({
              aborted: abortController.signal.aborted,
              streamGeneration: this._streamGeneration,
              expectedGeneration: streamGeneration,
              lifecycle,
              currentLifecycle: this._lifecycle,
            })
          ) {
            break;
          }
          const raw = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s*/, ""))
            .join("\n");
          if (!raw) continue;
          const event = JSON.parse(raw);
          const payload = event.payload ?? event;
          if (payload) {
            this._emit({ type: "opencode:event", payload });
            this._status.lastEventAt = Date.now();
          }
          this._reconnectAttempt = 0;
        }
      }

      // Global stream should stay open. If it ends, reconnect; otherwise prompts
      // still work but renderer loses streaming/status events.
      if (!abortController.signal.aborted && this._streamGeneration === streamGeneration) {
        if (this._abortController === abortController) this._abortController = null;
        this._scheduleReconnect(lifecycle, new Error("OpenCode global event stream ended"));
      }
    } catch (err) {
      if (
        shouldStopOpenCodeSseRead({
          aborted: abortController.signal.aborted,
          streamGeneration: this._streamGeneration,
          expectedGeneration: streamGeneration,
          lifecycle,
          currentLifecycle: this._lifecycle,
        })
      ) {
        return;
      }
      console.error("[OpenCodeConnection] SSE error:", err);
      this._scheduleReconnect(lifecycle);
    }
  }

  _scheduleReconnect(lifecycle: number, _reason?: Error) {
    if (!this._config || !this._isCurrent(lifecycle)) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const stepIndex = Math.min(this._reconnectAttempt, BACKOFF_STEPS.length - 1);
    const delay = BACKOFF_STEPS[stepIndex] ?? 500;
    this._reconnectAttempt++;
    this._setStatus({
      state: "reconnecting",
      error: `Reconnecting in ${delay / 1000}s...`,
    });

    this._reconnectTimer = setTimeout(async () => {
      if (!this._isCurrent(lifecycle)) return;
      try {
        await this._healthCheck();
        if (!this._isCurrent(lifecycle)) return;
        this._setStatus({ state: "connected", error: null });
        void this._startSSE(lifecycle);
      } catch {
        this._scheduleReconnect(lifecycle);
      }
    }, delay);
  }

  _startHealthTimer(lifecycle: number) {
    if (!this._isCurrent(lifecycle)) return;
    this._stopHealthTimer();
    this._healthTimer = setInterval(async () => {
      if (!this._isCurrent(lifecycle)) {
        this._stopHealthTimer();
        return;
      }
      try {
        await this._healthCheck();
        if (!this._isCurrent(lifecycle)) return;

        // If the server is healthy but SSE has gone stale (no events
        // for longer than the stale threshold), proactively restart.
        const lastEvent = this._status.lastEventAt;
        if (
          this._abortController &&
          lastEvent &&
          Date.now() - lastEvent > SSE_STALE_THRESHOLD &&
          this._status.state === "connected"
        ) {
          console.warn("[OpenCodeConnection] SSE stream appears stale, restarting...");
          await abortOpenCodeSseBeforeRestart(this._abortController);
          if (!this._isCurrent(lifecycle)) return;
          void this._startSSE(lifecycle);
        }
      } catch {
        // Server unreachable - actively trigger reconnect instead of
        // waiting for the SSE stream to eventually break on its own.
        if (this._status.state === "connected") {
          console.warn("[OpenCodeConnection] Health check failed while connected, reconnecting...");
          await abortOpenCodeSseBeforeRestart(this._abortController);
          if (!this._isCurrent(lifecycle)) return;
          this._stopHealthTimer();
          this._scheduleReconnect(lifecycle);
        }
      }
    }, HEALTH_INTERVAL);
  }

  _stopHealthTimer() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  _setStatus(patch: Partial<OpenCodeConnection["_status"]>) {
    this._status = { ...this._status, ...patch };
    this._emit({ type: "connection:status", payload: { ...this._status } });
  }

  teardown() {
    this._lifecycle++;
    this._abortController?.abort();
    this._abortController = null;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopHealthTimer();
    this._reconnectAttempt = 0;
    this._client = null;
    this._config = null;
  }
}

async function doStartLocalOpenCodeServer(): Promise<OpenCodeLocalServerOpResult> {
  try {
    const binary = resolveOpencodeBinary();

    // If already running, check version matches the local binary.
    const health = await fetchLocalHealth();
    if (health.healthy) {
      const serverVer = health.version;
      const binaryVer = binary ? getBinaryVersion(binary) : null;
      if (!serverVer || !binaryVer || serverVer === binaryVer) {
        return { success: true, data: { alreadyRunning: true } };
      }
      // Version mismatch - kill the old server and respawn below.
      const killed = await killServerProcess();
      if (!killed) {
        return {
          success: false,
          error: `A stale OpenCode server is already running on port ${LOCAL_SERVER_PORT} with version ${serverVer}, but it could not be stopped so version ${binaryVer} can start. Please stop the existing server and try again.`,
        };
      }
    } else {
      const listener = findServerProcess();
      if (listener) {
        if (!isLikelyOpenCodeProcess(listener)) {
          return {
            success: false,
            error: `Port ${LOCAL_SERVER_PORT} is already in use by ${formatServerProcess(listener)}, but it is not a healthy OpenCode server. Stop that process or set OPENGUI_OPENCODE_PORT to a free port.`,
          };
        }

        console.warn(
          `[opencode-bridge] Found an OpenCode process listening on port ${LOCAL_SERVER_PORT} before the health endpoint was ready (${formatServerProcess(listener)}). Waiting briefly before deciding it is stale...`,
        );
        try {
          await waitForHealthy(UNHEALTHY_LISTENER_GRACE_TIMEOUT);
          const recoveredHealth = await fetchLocalHealth(1000);
          if (recoveredHealth.healthy) {
            const serverVer = recoveredHealth.version;
            const binaryVer = binary ? getBinaryVersion(binary) : null;
            if (!serverVer || !binaryVer || serverVer === binaryVer) {
              return { success: true, data: { alreadyRunning: true } };
            }
          }
        } catch {
          // Fall through and stop the stale listener below.
        }

        console.warn(
          `[opencode-bridge] Stopping stale OpenCode process on port ${LOCAL_SERVER_PORT}: ${formatServerProcess(listener)}`,
        );
        const killed = await killServerProcess(listener.pid);
        if (!killed) {
          return {
            success: false,
            error: `An unhealthy OpenCode process is already listening on port ${LOCAL_SERVER_PORT} (${formatServerProcess(listener)}), but OpenGUI could not stop it. Stop it manually and try again.`,
          };
        }
      }
    }

    console.info(
      `[opencode-bridge] Resolved binary: ${binary ?? "(not found)"} (platform: ${process.platform})`,
    );
    if (!binary) {
      return {
        success: false,
        error:
          "Could not find the opencode binary. OpenGUI checked the Harness Inventory resolver paths, including Homebrew, user-local bins, OpenCode's bin directory, and your login shell PATH.",
      };
    }

    // Spawn detached so the server survives app close.
    // Use piped stdio so we can capture logs on startup failure.
    const serverArgs = ["serve", "--port", String(LOCAL_SERVER_PORT)];
    console.info(
      `[opencode-bridge] Spawning: ${binary} ${serverArgs.join(" ")} (platform: ${process.platform})`,
    );

    const MAX_LOG_BYTES = 8192;
    let logBuffer = "";
    let earlyExitCode = null;

    const appendLog = (chunk: Buffer | string) => {
      if (logBuffer.length < MAX_LOG_BYTES) {
        logBuffer += chunk.toString().slice(0, MAX_LOG_BYTES - logBuffer.length);
      }
    };

    // .cmd files on Windows require shell:true for spawn() to execute them.
    const needsShell = process.platform === "win32" && binary.toLowerCase().endsWith(".cmd");
    const child = spawn(binary, serverArgs, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: needsShell,
      env: { ...process.env },
    });

    if (child.stdout) child.stdout.on("data", appendLog);
    if (child.stderr) child.stderr.on("data", appendLog);

    child.on("close", (code) => {
      earlyExitCode = code;
    });

    child.unref();

    // If spawn itself errors (e.g. ENOENT).
    let spawnError: Error | null = null;
    child.on("error", (err: Error) => {
      spawnError = err;
      console.error("[opencode-bridge] Failed to spawn opencode server:", err);
    });

    // Wait for the server to become healthy.
    console.info(
      `[opencode-bridge] Waiting for server to become healthy (timeout: ${STARTUP_TIMEOUT / 1000}s)...`,
    );
    try {
      await waitForHealthy();
    } catch (healthErr: unknown) {
      // Some opencode builds daemonize successfully but still let the
      // launcher exit non-zero after printing a misleading startup error.
      if (
        earlyExitCode !== null &&
        earlyExitCode !== 0 &&
        /Failed to start server on port/i.test(logBuffer)
      ) {
        try {
          await waitForHealthy(DETACHED_LAUNCH_GRACE_TIMEOUT);
        } catch {
          // Fall through to the normal error path below.
        }
      }

      if ((await fetchLocalHealth()).healthy) {
        if (child.stdout) {
          child.stdout.removeAllListeners("data");
          child.stdout.destroy();
        }
        if (child.stderr) {
          child.stderr.removeAllListeners("data");
          child.stderr.destroy();
        }
        console.info("[opencode-bridge] Server became healthy after launcher exited.");
        return { success: true, data: { alreadyRunning: false } };
      }

      // Detach the stdio streams before returning the error.
      if (child.stdout) {
        child.stdout.removeAllListeners("data");
        child.stdout.destroy();
      }
      if (child.stderr) {
        child.stderr.removeAllListeners("data");
        child.stderr.destroy();
      }

      let errorMsg = healthErr instanceof Error ? healthErr.message : String(healthErr);
      if (spawnError) {
        errorMsg = `Spawn error: ${(spawnError as Error).message}`;
      } else if (earlyExitCode !== null && earlyExitCode !== 0) {
        errorMsg = `Server process exited with code ${Number(earlyExitCode)}`;
      }
      return {
        success: false,
        error: errorMsg,
        logs: logBuffer || null,
      };
    }

    // Server is healthy - detach the stdio streams so the process
    // can survive app close without keeping pipes open.
    if (child.stdout) {
      child.stdout.removeAllListeners("data");
      child.stdout.destroy();
    }
    if (child.stderr) {
      child.stderr.removeAllListeners("data");
      child.stderr.destroy();
    }

    console.info("[opencode-bridge] Server is healthy.");
    return { success: true, data: { alreadyRunning: false } };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function startLocalOpenCodeServer(): Promise<OpenCodeLocalServerOpResult> {
  if (localServerStopPromise) {
    console.info("[opencode-bridge] Waiting for in-flight OpenCode stop before starting...");
    await localServerStopPromise.catch(() => {});
  }

  if (localServerStartPromise) {
    console.info("[opencode-bridge] Joining in-flight OpenCode server start...");
    return await localServerStartPromise;
  }

  localServerStartPromise = doStartLocalOpenCodeServer().finally(() => {
    localServerStartPromise = null;
  });
  return await localServerStartPromise;
}

async function doStopLocalOpenCodeServer(): Promise<OpenCodeLocalServerOpResult> {
  try {
    const health = await fetchLocalHealth();
    if (!health.healthy) {
      const listener = findServerProcess();
      if (!listener) return { success: true, data: { alreadyStopped: true } };
      if (!isLikelyOpenCodeProcess(listener)) {
        return {
          success: false,
          error: `Port ${LOCAL_SERVER_PORT} is in use by ${formatServerProcess(listener)}, but it is not a healthy OpenCode server. Stop that process manually or set OPENGUI_OPENCODE_PORT to a free port.`,
        };
      }

      const killedUnhealthy = await killServerProcess(listener.pid);
      if (!killedUnhealthy) {
        return {
          success: false,
          error: `Unhealthy OpenCode process could not be stopped: ${formatServerProcess(listener)}`,
        };
      }
      return { success: true, data: { stoppedUnhealthy: true } };
    }

    const killed = await killServerProcess();
    if (!killed) {
      return {
        success: false,
        error: "Server process could not be stopped",
      };
    }
    return { success: true, data: {} };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function stopLocalOpenCodeServer(): Promise<OpenCodeLocalServerOpResult> {
  if (localServerStartPromise) {
    console.info("[opencode-bridge] Waiting for in-flight OpenCode start before stopping...");
    await localServerStartPromise.catch(() => {});
  }

  if (localServerStopPromise) return await localServerStopPromise;

  localServerStopPromise = doStopLocalOpenCodeServer().finally(() => {
    localServerStopPromise = null;
  });
  return await localServerStopPromise;
}

// ---------------------------------------------------------------------------
// Setup: called from main.ts with (ipcMain, mainWindow)
// ---------------------------------------------------------------------------

export function setupOpenCodeBridge(ipcMain: OpencodeIpcMain, _getWindows: () => Iterable<unknown>) {
  const windowStates = new Map<number, OpenCodeWindowBridgeState<OpenCodeConnection>>();

  function getWindowState(sender: HarnessWebContentsSender) {
    const key = sender.id;
    let state = windowStates.get(key);
    if (state) return state;
    state = {
      projectRegistry: new OpencodeProjectRegistry<OpenCodeConnection>(),
      pendingConnections: new Map(),
      sessionDirectories: new Map(),
      serverConfig: null,
    };
    windowStates.set(key, state);
    sender.once("destroyed", () => {
      const current = windowStates.get(key);
      if (!current) return;
      current.pendingConnections.clear();
      current.sessionDirectories.clear();
      for (const conn of current.projectRegistry.values()) {
        conn.teardown();
      }
      windowStates.delete(key);
    });
    return state;
  }

  function normalizeServerConfig(config: OpenCodeConnectConfig): OpenCodeConnectConfig {
    let baseUrl = config.baseUrl.replace(/\/+$/, "");
    const webLocalPort = process.env.OPENGUI_OPENCODE_PORT?.trim();
    if (
      webLocalPort &&
      (baseUrl === "http://127.0.0.1:4096" || baseUrl === "http://localhost:4096")
    ) {
      baseUrl = `http://127.0.0.1:${webLocalPort}`;
    }
    return {
      baseUrl,
      username: config.username?.trim() || undefined,
      password: config.password?.trim() || undefined,
      directory:
        typeof config.directory === "string" && config.directory.trim()
          ? config.directory.trim()
          : undefined,
    };
  }

  const sendEvent = makeHarnessBridgeEventSender("opencode");

  const ipcStr = (value: unknown): string => (typeof value === "string" ? value : "");
  const ipcOptStr = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

  function makeProjectKey(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    workspaceId: string | undefined,
    directory: string,
  ) {
    return windowState.projectRegistry.createProjectKey(workspaceId, directory);
  }

  function rememberOpenCodeSessionDirectory(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    sessionId: string,
    directory: unknown,
  ) {
    const rawSessionId = typeof sessionId === "string" ? toRawSessionId(sessionId) : "";
    const normalizedDirectory = normalizeOpenCodeDirectoryHint(directory);
    if (rawSessionId && normalizedDirectory) {
      windowState.sessionDirectories.set(rawSessionId, normalizedDirectory);
    }
  }

  function shouldForwardOpenCodeDaemonEvent(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    event: Record<string, unknown>,
    connectionDirectory: unknown,
  ) {
    if (event?.type !== "opencode:event") return true;

    const rawSessionId = extractOpenCodeEventRawSessionId(event.payload);
    const payloadDirectory = extractOpenCodeEventSessionDirectory(
      event.payload,
      normalizeOpenCodeDirectoryHint,
    );
    if (rawSessionId && payloadDirectory) {
      windowState.sessionDirectories.set(rawSessionId, payloadDirectory);
    }

    const sessionDirectory =
      payloadDirectory ?? (rawSessionId ? windowState.sessionDirectories.get(rawSessionId) : null);
    if (!sessionDirectory) return true;

    const normalizedConnectionDirectory = normalizeOpenCodeDirectoryHint(connectionDirectory);
    if (!normalizedConnectionDirectory) return true;
    return normalizedConnectionDirectory === sessionDirectory;
  }

  function createConnection(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    sender: HarnessWebContentsSender,
    directory: string,
    workspaceId: string | undefined,
  ) {
    const projectKey = makeProjectKey(windowState, workspaceId, directory);
    const conn = new OpenCodeConnection((event) => {
      if (windowState.projectRegistry.getConnection(projectKey) !== conn) return;
      if (!shouldForwardOpenCodeDaemonEvent(windowState, event, directory)) return;
      if (event?.type === "opencode:event") {
        const payload =
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        const props =
          payload.properties && typeof payload.properties === "object"
            ? (payload.properties as Record<string, unknown>)
            : {};
        const questionId = props.id ?? props.requestID;
        if (payload.type === "question.asked" && questionId) {
          windowState.projectRegistry.rememberQuestion(projectKey, String(questionId));
        }
        if (
          (payload.type === "question.replied" || payload.type === "question.rejected") &&
          questionId
        ) {
          windowState.projectRegistry.deleteQuestion(String(questionId));
        }
      }
      sendEvent(sender, { ...event, directory, workspaceId });
    });
    windowState.projectRegistry.setConnection({ directory, workspaceId }, conn);
    return conn;
  }

  function getConnectedConnections(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    workspaceId?: string,
  ) {
    const requestedWorkspaceId = workspaceId?.trim() || "";
    return [...windowState.projectRegistry.entries()]
      .filter(([projectKey, conn]) => {
        if (conn.getStatus().state !== "connected") return false;
        if (!requestedWorkspaceId) return true;
        return (
          windowState.projectRegistry.getWorkspaceIdFromProjectKey(projectKey) ===
          requestedWorkspaceId
        );
      })
      .map(([projectKey, connection]) => ({ projectKey, connection }));
  }

  function getConnectionEntryForSession(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    _sessionId: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    return routingConnectionEntryForSession(
      windowState as unknown as OpenCodeWindowState<OpenCodeConnection>,
      () => getConnectedConnections(windowState),
      directory,
      workspaceId,
    );
  }

  function getConnectionForSession(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    sessionId: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    return resolveConnectionForSession(
      windowState as unknown as OpenCodeWindowState<OpenCodeConnection>,
      () => getConnectedConnections(windowState),
      sessionId,
      directory,
      workspaceId,
    );
  }

  /** Get any connected connection, optionally scoped to one workspace. */
  function getAnyConnectionEntry(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    workspaceId?: string,
  ) {
    return getConnectedConnections(windowState, workspaceId)[0] ?? null;
  }

  function getAnyConnection(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    workspaceId?: string,
  ) {
    return getAnyConnectionEntry(windowState, workspaceId)?.connection ?? null;
  }

  /** Resolve a connection for a specific project directory + workspace. */
  function getConnectionEntryForDirectory(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    if (typeof directory !== "string" || !directory.trim()) {
      return getAnyConnectionEntry(windowState, workspaceId);
    }
    return windowState.projectRegistry.getDirectoryConnectionEntry({ directory, workspaceId });
  }

  function getConnectionForDirectory(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    return getConnectionEntryForDirectory(windowState, directory, workspaceId)?.connection ?? null;
  }

  function teardownConnectionIfCurrent(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    projectKey: string,
    conn: OpenCodeConnection | null,
  ) {
    if (!conn) return;
    if (windowState.projectRegistry.getConnection(projectKey) === conn) {
      windowState.projectRegistry.deleteConnection(projectKey);
    }
    conn.teardown();
  }

  async function connectConnectionForDirectory(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    sender: HarnessWebContentsSender,
    directory: string,
    workspaceId: string | undefined,
    config: OpenCodeConnectConfig,
    { replaceExisting = false }: { replaceExisting?: boolean } = {},
  ) {
    if (typeof directory !== "string" || !directory.trim()) return null;

    const normalizedDirectory = directory.trim();
    const projectKey = makeProjectKey(windowState, workspaceId, normalizedDirectory);

    if (!replaceExisting) {
      const pending = windowState.pendingConnections.get(projectKey);
      if (pending) return await pending;

      const existing = getConnectionEntryForDirectory(
        windowState,
        normalizedDirectory,
        workspaceId,
      );
      if (existing) return existing.connection;
    } else {
      const pending = windowState.pendingConnections.get(projectKey);
      if (pending) await pending.catch(() => {});
    }

    const connectionPromise = (async (): Promise<OpenCodeConnection | null> => {
      let conn: OpenCodeConnection | null = null;
      try {
        if (replaceExisting) {
          const existing = windowState.projectRegistry.deleteConnection(projectKey);
          if (existing) existing.teardown();
        } else {
          const existing = getConnectionEntryForDirectory(
            windowState,
            normalizedDirectory,
            workspaceId,
          );
          if (existing) return existing.connection;
        }

        const normalizedConfig = normalizeServerConfig({
          ...config,
          directory: normalizedDirectory,
        });
        if (isLocalOpenCodeServerUrl(normalizedConfig.baseUrl)) {
          const started = await startLocalOpenCodeServer();
          if (!started?.success) {
            throw new Error(started?.error || "Failed to start local OpenCode server");
          }
        }

        conn = createConnection(windowState, sender, normalizedDirectory, workspaceId);
        await conn.connect(normalizedConfig);
        windowState.serverConfig = normalizedConfig;
        return conn;
      } catch (err) {
        teardownConnectionIfCurrent(windowState, projectKey, conn);
        throw err;
      }
    })();

    windowState.pendingConnections.set(projectKey, connectionPromise);
    try {
      return await connectionPromise;
    } finally {
      if (windowState.pendingConnections.get(projectKey) === connectionPromise) {
        windowState.pendingConnections.delete(projectKey);
      }
    }
  }

  async function ensureConnectionForDirectory(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    sender: HarnessWebContentsSender,
    directory: string,
    workspaceId: string | undefined,
  ) {
    if (typeof directory !== "string" || !directory.trim()) return null;
    const baseConfig = windowState.serverConfig ?? { baseUrl: LOCAL_SERVER_URL };
    return await connectConnectionForDirectory(
      windowState,
      sender,
      directory,
      workspaceId,
      baseConfig,
    );
  }

  // --- IPC handler factories (DRY helpers to eliminate boilerplate) ---

  /**
   * Register a directory-aware IPC handler whose first arg is a directory.
   * @param {string} channel - IPC channel name
   * @param {(conn: OpenCodeConnection, ...args: unknown[]) => Promise<unknown>} fn
   */
  function handleDirectoryOp(
    channel: string,
    fn: (conn: OpenCodeConnection, ...args: unknown[]) => Promise<unknown> | unknown,
  ) {
    ipcMain.handle(channel, async (event: unknown, directory, workspaceId, ...args) => {
      const ipcEvent = event as OpencodeIpcEvent;
      try {
        const windowState = getWindowState(ipcEvent.sender);
        const conn = await ensureConnectionForDirectory(
          windowState,
          ipcEvent.sender,
          directory as string,
          workspaceId as string | undefined,
        );
        if (!conn) return { success: false, error: "No connection available" };
        const data = await fn(conn, ...args);
        return data === undefined ? { success: true } : { success: true, data };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  /**
   * Register a session-routed IPC handler that uses getConnectionForSession().
   * The first arg after _event is always sessionId.
   * @param {string} channel - IPC channel name
   * @param {(conn: OpenCodeConnection, sessionId: string, ...args: unknown[]) => Promise<unknown>} fn
   */
  function handleSessionOp(
    channel: string,
    fn: (
      conn: OpenCodeConnection,
      sessionId: string,
      ...args: unknown[]
    ) => Promise<unknown> | unknown,
  ) {
    ipcMain.handle(channel, async (event: unknown, sessionId, ...args) => {
      const ipcEvent = event as OpencodeIpcEvent;
      try {
        const windowState = getWindowState(ipcEvent.sender);
        const maybeWorkspaceId = args.at(-1);
        const maybeDirectory = args.at(-2);
        const workspaceId = typeof maybeWorkspaceId === "string" ? maybeWorkspaceId : undefined;
        const directory = typeof maybeDirectory === "string" ? maybeDirectory : undefined;
        const conn = getConnectionForSession(
          windowState,
          sessionId as string,
          directory,
          workspaceId,
        );
        if (!conn) return { success: false, error: "Session connection not found" };
        const rawSessionId = toRawSessionId(sessionId as string);
        const data = await fn(conn, rawSessionId, ...args);
        return data === undefined ? { success: true } : { success: true, data };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  /**
   * Register an IPC handler for question operations that prefers
   * explicit target routing, then requestID -> directory routing,
   * then falls back to a single connected connection.
   * @param {string} channel - IPC channel name
   * @param {(conn: OpenCodeConnection, requestID: string, ...args: unknown[]) => Promise<unknown>} fn
   */
  function handleQuestionOp(
    channel: string,
    fn: (
      conn: OpenCodeConnection,
      requestID: string,
      ...args: unknown[]
    ) => Promise<unknown> | unknown,
  ) {
    ipcMain.handle(channel, async (event: unknown, requestID, ...args) => {
      const ipcEvent = event as OpencodeIpcEvent;
      try {
        const windowState = getWindowState(ipcEvent.sender);
        if (typeof requestID !== "string" || !requestID.trim()) {
          return { success: false, error: "Question requestID is required" };
        }
        const maybeDirectory = args.length >= 2 ? args[args.length - 2] : undefined;
        const maybeWorkspaceId = args.length >= 1 ? args[args.length - 1] : undefined;
        const directory = typeof maybeDirectory === "string" ? maybeDirectory : undefined;
        const workspaceId = typeof maybeWorkspaceId === "string" ? maybeWorkspaceId : undefined;

        const targetEntry = directory
          ? getConnectionEntryForDirectory(windowState, directory, workspaceId)
          : null;
        if (targetEntry) {
          const data = await fn(targetEntry.connection, requestID, ...args);
          windowState.projectRegistry.deleteQuestion(requestID);
          return data === undefined ? { success: true } : { success: true, data };
        }

        const mappedEntry = windowState.projectRegistry.getMappedQuestionConnectionEntry(requestID);
        if (mappedEntry) {
          const data = await fn(mappedEntry.connection, requestID, ...args);
          windowState.projectRegistry.deleteQuestion(requestID);
          return data === undefined ? { success: true } : { success: true, data };
        }

        const connected = getConnectedConnections(windowState, workspaceId);
        const entry = connected[0];
        if (entry && connected.length === 1) {
          const data = await fn(entry.connection, requestID, ...args);
          windowState.projectRegistry.deleteQuestion(requestID);
          return data === undefined ? { success: true } : { success: true, data };
        }

        return {
          success: false,
          error: "Question connection not found",
        };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  function successResult(data: unknown) {
    return data === undefined ? { success: true } : { success: true, data };
  }

  function failureResult(error: unknown) {
    return {
      success: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  function isResultEnvelope(value: unknown): value is { success: boolean } {
    return value !== null && typeof value === "object" && "success" in value;
  }

  function handleResultOp(
    channel: string,
    fn: (event: OpencodeIpcEvent, ...args: unknown[]) => Promise<unknown> | unknown,
  ) {
    ipcMain.handle(channel, async (event: unknown, ...args) => {
      const ipcEvent = event as OpencodeIpcEvent;
      try {
        const result = await fn(ipcEvent, ...args);
        return isResultEnvelope(result) ? result : successResult(result);
      } catch (error) {
        return failureResult(error);
      }
    });
  }

  const WINDOWS_SHELL_COMMANDS = new Set(["npm", "pnpm", "yarn", "pip"]);
  const WORKTREE_SETUP_CHECKS = [
    {
      file: "pnpm-lock.yaml",
      command: "pnpm install",
      executable: "pnpm",
      args: ["install"],
    },
    {
      file: "yarn.lock",
      command: "yarn install",
      executable: "yarn",
      args: ["install"],
    },
    {
      file: "package-lock.json",
      command: "npm install",
      executable: "npm",
      args: ["install"],
    },
    {
      file: "package.json",
      command: "npm install",
      executable: "npm",
      args: ["install"],
    },
    {
      file: "Cargo.toml",
      command: "cargo build",
      executable: "cargo",
      args: ["build"],
    },
    {
      file: "go.mod",
      command: "go mod download",
      executable: "go",
      args: ["mod", "download"],
    },
    {
      file: "pyproject.toml",
      command: "uv sync",
      executable: "uv",
      args: ["sync"],
    },
    {
      file: "requirements.txt",
      command: "pip install -r requirements.txt",
      executable: "pip",
      args: ["install", "-r", "requirements.txt"],
    },
  ];

  /**
   * Run child process without shell interpolation.
   * @param {string} executable
   * @param {string[]} args
   * @param {{ cwd: string, timeout?: number, shell?: boolean }} options
   * @returns {Promise<string>} Raw stdout
   */
  function runCommand(
    executable: string,
    args: string[],
    options: { cwd: string; timeout?: number; shell?: boolean },
  ) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: options.shell === true,
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        const detail = (stderr || stdout || message).trim();
        const error = new Error(detail || message) as OpenCodeRunCommandError;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      };

      if (child.stdout) {
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
      }

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        cleanup();
        if (timedOut) {
          settled = true;
          const error = new Error(
            `Command timed out after ${options.timeout ?? 0}ms`,
          ) as OpenCodeRunCommandError;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        if (code === 0) {
          settled = true;
          resolve(stdout);
          return;
        }
        fail(
          signal
            ? `Command terminated by signal ${signal}`
            : `Command exited with code ${code ?? "unknown"}`,
        );
      });

      if (options.timeout && options.timeout > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeout);
      }
    });
  }

  /**
   * Run git command without shell interpolation.
   * @param {string} directory - cwd for git
   * @param {string[]} args - git arguments
   * @returns {Promise<string>} Raw stdout
   */
  function runGit(directory: string, args: string[]) {
    return runCommand("git", args, { cwd: directory });
  }

  // --- Project management ---

  handleResultOp("opencode:project:add", async (event, config) => {
    const windowState = getWindowState(event.sender);
    if (!config || typeof config !== "object") {
      return failureResult("Invalid config");
    }
    const cfg = config as OpenCodeProjectAddConfig & Record<string, unknown>;
    const directory = String(cfg.directory ?? "").trim();
    if (!directory) {
      return failureResult("Directory is required");
    }
    const normalizedConfig = normalizeServerConfig({
      baseUrl:
        typeof cfg.baseUrl === "string" && cfg.baseUrl.trim() ? cfg.baseUrl : LOCAL_SERVER_URL,
      username: cfg.username,
      password: cfg.password,
      directory,
    });
    const conn = await connectConnectionForDirectory(
      windowState,
      event.sender,
      directory,
      cfg.workspaceId,
      normalizedConfig,
      { replaceExisting: true },
    );
    if (!conn) return failureResult("No connection available");
    return { success: true, status: conn.getStatus() };
  });

  handleResultOp("opencode:project:remove", async (event, directory, workspaceId) => {
    const windowState = getWindowState(event.sender);
    if (typeof directory !== "string" || !directory.trim()) {
      return failureResult("Directory is required");
    }
    const projectKey = makeProjectKey(windowState, ipcOptStr(workspaceId), directory);
    const pending = windowState.pendingConnections.get(projectKey);
    if (pending) await pending.catch(() => {});
    const { connection } = windowState.projectRegistry.removeProject(projectKey);
    if (connection) {
      connection.teardown();
    }
    if (windowState.projectRegistry.size === 0) {
      windowState.serverConfig = null;
    }
  });

  handleResultOp("opencode:disconnect", async (event) => {
    const windowState = getWindowState(event.sender);
    await Promise.all(
      [...windowState.pendingConnections.values()].map((pending) => pending.catch(() => {})),
    );
    windowState.pendingConnections.clear();
    windowState.sessionDirectories.clear();
    for (const conn of windowState.projectRegistry.values()) {
      conn.teardown();
    }
    windowState.projectRegistry.clear();
    windowState.serverConfig = null;
  });

  // --- Session operations ---

  /** Tag Sessions with their execution Project directory. */
  async function listAndCacheSessions(
    windowState: OpenCodeWindowBridgeState<OpenCodeConnection>,
    conn: OpenCodeConnection,
    dir: string,
    workspaceId: string | undefined,
  ) {
    return (await conn.listSessions()).map((s) => {
      const tagged = tagOpenCodeSession(s as Record<string, unknown>, dir, workspaceId);
      if (!tagged) return tagged;
      rememberOpenCodeSessionDirectory(
        windowState,
        tagged._rawId ?? tagged.id,
        tagged._projectDir ?? dir,
      );
      return tagged;
    });
  }

  handleResultOp("opencode:session:list", async (event, directory, workspaceId) => {
    const windowState = getWindowState(event.sender);
    const dirArg = ipcStr(directory);
    const wsArg = ipcOptStr(workspaceId);
    if (dirArg) {
      const conn = await ensureConnectionForDirectory(
        windowState,
        event.sender,
        dirArg,
        wsArg,
      );
      return conn
        ? await listAndCacheSessions(windowState, conn, dirArg, wsArg)
        : failureResult("No connection available");
    }
    const allSessions = [];
    for (const [projectKey, conn] of windowState.projectRegistry.entries()) {
      try {
        const currentWorkspaceId =
          windowState.projectRegistry.getWorkspaceIdFromProjectKey(projectKey) || undefined;
        const dir = conn.getDirectory() ?? "";
        allSessions.push(
          ...(await listAndCacheSessions(windowState, conn, dir, currentWorkspaceId)),
        );
      } catch {
        // Skip failed connections
      }
    }
    return allSessions;
  });

  handleResultOp("opencode:session:create", async (event, title, directory, workspaceId) => {
    const windowState = getWindowState(event.sender);
    const dirArg = ipcOptStr(directory);
    const wsArg = ipcOptStr(workspaceId);
    const conn = dirArg
      ? await ensureConnectionForDirectory(windowState, event.sender, dirArg, wsArg)
      : getAnyConnection(windowState, wsArg);
    if (!conn) return failureResult("No connection available");
    const session = await conn.createSession(typeof title === "string" ? title : undefined);
    const dir = dirArg || conn.getDirectory() || "";
    const taggedSession = tagOpenCodeSession(session as Record<string, unknown>, dir, wsArg);
    if (!taggedSession) return failureResult("Failed to tag session");
    rememberOpenCodeSessionDirectory(
      windowState,
      taggedSession._rawId ?? taggedSession.id,
      taggedSession._projectDir ?? dir,
    );
    return taggedSession;
  });

  handleResultOp("opencode:session:delete", async (event, id, directory, workspaceId) => {
    const windowState = getWindowState(event.sender);
    const rawId = toRawSessionId(ipcStr(id));
    const dirArg = ipcOptStr(directory);
    const wsArg = ipcOptStr(workspaceId);
    const entry = dirArg
      ? await (async () => {
          const conn = await ensureConnectionForDirectory(
            windowState,
            event.sender,
            dirArg,
            wsArg,
          );
          return conn ? { connection: conn } : null;
        })()
      : getConnectionEntryForSession(windowState, rawId, dirArg, wsArg);
    const conn = entry?.connection ?? null;
    return conn ? await conn.deleteSession(rawId) : failureResult("Session connection not found");
  });

  handleSessionOp("opencode:session:update", async (conn, id, title, _directory, _workspaceId) => {
    const dir = conn.getDirectory() ?? "";
    return tagOpenCodeSession(
      (await conn.updateSession(id, String(title))) as Record<string, unknown>,
      dir,
      undefined,
    );
  });

  handleResultOp("opencode:session:statuses", async (event, directory, workspaceId) => {
    const windowState = getWindowState(event.sender);
    const dirArg = ipcOptStr(directory);
    const wsArg = ipcOptStr(workspaceId);
    const conn = dirArg
      ? getConnectionForDirectory(windowState, dirArg, wsArg)
      : getAnyConnection(windowState, wsArg);
    if (!conn) return failureResult("No connection available");
    const statuses = await conn.getSessionStatuses();
    return Object.fromEntries(
      Object.entries(statuses ?? {}).map(([id, status]) => [toFrontendSessionId(id), status]),
    );
  });

  handleSessionOp("opencode:session:revert", async (conn, id, messageID, partID, _directory, _ws) => {
    const dir = conn.getDirectory() ?? "";
    return tagOpenCodeSession(
      (await conn.revertSession(id, String(messageID), ipcOptStr(partID))) as Record<
        string,
        unknown
      >,
      dir,
      undefined,
    );
  });
  handleSessionOp("opencode:session:unrevert", async (conn, id, _directory, _ws) => {
    const dir = conn.getDirectory() ?? "";
    return tagOpenCodeSession(
      (await conn.unrevertSession(id)) as Record<string, unknown>,
      dir,
      undefined,
    );
  });

  handleResultOp("opencode:session:fork", async (event, id, messageID, directory, workspaceId) => {
    const windowState = getWindowState(event.sender);
    const entry = getConnectionEntryForSession(
      windowState,
      ipcStr(id),
      ipcOptStr(directory),
      ipcOptStr(workspaceId),
    );
    if (!entry) return failureResult("Session connection not found");
    const dir = entry.connection.getDirectory() ?? "";
    return tagOpenCodeSession(
      (await entry.connection.forkSession(
        toRawSessionId(ipcStr(id)),
        ipcOptStr(messageID),
      )) as Record<string, unknown>,
      dir,
      undefined,
    );
  });

  // --- Providers / models (directory-aware) ---

  handleDirectoryOp("opencode:providers", (conn) => conn.getProviders());

  // --- Provider management (directory-aware) ---

  handleDirectoryOp("opencode:provider:list", (conn) => conn.listAllProviders());
  handleDirectoryOp("opencode:provider:auth-methods", (conn) => conn.getProviderAuthMethods());
  handleDirectoryOp("opencode:provider:connect", (conn, providerID, auth) =>
    conn.setProviderAuth(ipcStr(providerID), auth),
  );
  handleDirectoryOp("opencode:provider:disconnect", (conn, providerID) =>
    conn.removeProviderAuth(ipcStr(providerID)),
  );
  handleDirectoryOp("opencode:provider:oauth:authorize", (conn, providerID, method) =>
    conn.oauthAuthorize(ipcStr(providerID), ipcOptStr(method)),
  );
  handleDirectoryOp("opencode:provider:oauth:callback", (conn, providerID, method, code) =>
    conn.oauthCallback(ipcStr(providerID), ipcOptStr(method), ipcOptStr(code)),
  );
  handleDirectoryOp("opencode:instance:dispose", (conn) => conn.disposeInstance());

  // --- Agents (directory-aware) ---

  handleDirectoryOp("opencode:agents", (conn) => conn.getAgents());

  // --- Message operations (routed to session's connection) ---

  handleResultOp("opencode:messages", async (event, sessionId, options, directory, workspaceId) => {
    const windowState = getWindowState(event.sender);
    const rawSessionId = toRawSessionId(ipcStr(sessionId));
    const dirArg = ipcOptStr(directory);
    const wsArg = ipcOptStr(workspaceId);
    let conn = getConnectionForSession(windowState, rawSessionId, dirArg, wsArg);
    if (!conn && dirArg) conn = getConnectionForDirectory(windowState, dirArg, wsArg);
    if (!conn) return failureResult("Session connection not found");
    const data = await conn.getMessages(
      rawSessionId,
      (options ?? {}) as OpenCodeMessagesOptions,
    );
    return { ...data, messages: (data.messages ?? []).map(tagOpenCodeMessageEntry) };
  });
  handleSessionOp("opencode:prompt", (conn, sessionId, text, images, model, agent, variant) =>
    conn.promptAsync(
      sessionId,
      String(text),
      Array.isArray(images) ? (images as string[]) : undefined,
      model as OpenCodeModelRef | undefined,
      ipcOptStr(agent),
      ipcOptStr(variant),
    ),
  );
  handleSessionOp("opencode:abort", (conn, sessionId) => conn.abortSession(sessionId));

  // --- Permission response (routed to session's connection) ---

  handleSessionOp(
    "opencode:permission",
    (conn, sessionId, permissionId, response, _directory, workspaceId) =>
      conn.respondPermission(
        sessionId,
        String(permissionId),
        response as "always" | "once" | "reject",
        ipcOptStr(workspaceId),
      ),
  );

  // --- Question response (target/question routed) ---

  handleQuestionOp("opencode:question:reply", (conn, requestID, answers) =>
    conn.replyQuestion(
      requestID,
      answers as Parameters<OpenCodeSdkClient["question"]["reply"]>[0]["answers"],
    ),
  );

  // --- Commands (global) ---

  handleDirectoryOp("opencode:commands", (conn) => conn.listCommands());
  handleSessionOp(
    "opencode:command:send",
    (conn, sessionId, command, args, model, agent, variant) =>
      conn.sendCommand(
        sessionId,
        String(command),
        args,
        model as OpenCodeModelRef | undefined,
        ipcOptStr(agent),
        ipcOptStr(variant),
      ),
  );
  handleSessionOp("opencode:session:summarize", (conn, sessionId, model) =>
    conn.summarizeSession(sessionId, model as OpenCodeModelRef | null | undefined),
  );

  handleResultOp("opencode:session:start", async (event, input = {}) => {
    const windowState = getWindowState(event.sender);
    const startInput = (input ?? {}) as OpenCodeSessionStartInput;
    const directory = ipcOptStr(startInput.directory);
    const workspaceId = ipcOptStr(startInput.workspaceId);
    const conn = directory
      ? await ensureConnectionForDirectory(windowState, event.sender, directory, workspaceId)
      : getAnyConnection(windowState, workspaceId);
    if (!conn) return failureResult("No connection available");
    const session = await conn.createSession(startInput.title);
    const dir = directory || conn.getDirectory() || "";
    const taggedSession = tagOpenCodeSession(
      session as Record<string, unknown>,
      dir,
      workspaceId,
    );
    if (!taggedSession) return failureResult("Failed to tag session");
    rememberOpenCodeSessionDirectory(
      windowState,
      taggedSession._rawId ?? taggedSession.id,
      taggedSession._projectDir ?? dir,
    );
    const sessionId =
      typeof session === "object" && session && "id" in session
        ? String((session as { id: string }).id)
        : taggedSession.id;
    await conn.promptAsync(
      sessionId,
      startInput.text ?? "",
      startInput.images,
      startInput.model,
      startInput.agent,
      startInput.variant,
    );
    return taggedSession;
  });
  handleQuestionOp("opencode:question:reject", (conn, requestID) => conn.rejectQuestion(requestID));

  // --- MCP operations (directory-aware) ---

  handleDirectoryOp("opencode:mcp:status", (conn) => conn.getMcpStatus());
  handleDirectoryOp("opencode:mcp:add", (conn, name, config) => conn.addMcp(ipcStr(name), config));
  handleDirectoryOp("opencode:mcp:connect", (conn, name) => conn.connectMcp(ipcStr(name)));
  handleDirectoryOp("opencode:mcp:disconnect", (conn, name) => conn.disconnectMcp(ipcStr(name)));

  // --- Config operations (directory-aware) ---

  handleDirectoryOp("opencode:config:get", (conn) => conn.getConfig());

  handleResultOp("opencode:config:update", async (event, directory, workspaceId, config) => {
    if (!config || typeof config !== "object") return failureResult("Invalid config");
    const windowState = getWindowState(event.sender);
    const conn = getConnectionForDirectory(
      windowState,
      ipcStr(directory),
      ipcOptStr(workspaceId),
    );
    return conn ? await conn.updateConfig(config) : failureResult("No connection available");
  });

  // --- Local server management ---

  ipcMain.handle("opencode:server:start", startLocalOpenCodeServer);

  ipcMain.handle("opencode:server:stop", stopLocalOpenCodeServer);

  handleResultOp("opencode:server:status", async () => ({
    running: (await fetchLocalHealth()).healthy,
  }));

  // --- Git helpers ---

  ipcMain.handle("git:is-repo", async (_event, directory) => {
    try {
      await runGit(ipcStr(directory), ["rev-parse", "--git-dir"]);
      return { success: true, data: true };
    } catch {
      return { success: true, data: false };
    }
  });

  handleResultOp("git:branch:list", async (_event, directory) =>
    (await runGit(ipcStr(directory), ["branch", "--format=%(refname:short)"]))
      .split(/\r?\n/)
      .map((branch) => branch.trim())
      .filter(Boolean),
  );

  handleResultOp("git:current-branch", async (_event, directory) =>
    (await runGit(ipcStr(directory), ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
  );

  handleResultOp("git:worktree:list", async (_event, directory) => {
    const raw = await runGit(ipcStr(directory), ["worktree", "list", "--porcelain"]);
    const worktrees: Array<Record<string, unknown>> = [];
    let current: Record<string, unknown> = {};
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.detached = true;
      } else if (line === "") {
        if (current.path) worktrees.push(current);
        current = {};
      }
    }
    if (current.path) worktrees.push(current);
    return worktrees;
  });

  handleResultOp(
    "git:worktree:add",
    async (_event, directory, worktreePath, branch, isNewBranch) => {
      const args = ["worktree", "add"];
      const wt = ipcStr(worktreePath);
      const br = ipcStr(branch);
      args.push(...(isNewBranch ? ["-b", br, wt] : [wt, br]));
      await runGit(ipcStr(directory), args);
      return { path: wt };
    },
  );

  handleResultOp("git:worktree:remove", async (_event, directory, worktreePath) => {
    await runGit(ipcStr(directory), ["worktree", "remove", ipcStr(worktreePath)]);
  });

  // -----------------------------------------------------------------------
  // Worktree setup detection & execution
  // -----------------------------------------------------------------------

  ipcMain.handle("worktree:detect-setup", async (_event, worktreePath) => {
    const wtPath = ipcStr(worktreePath);
    try {
      for (const check of WORKTREE_SETUP_CHECKS) {
        if (existsSync(join(wtPath, check.file))) {
          return {
            detected: true,
            command: check.command,
            file: check.file,
          };
        }
      }
      return { detected: false };
    } catch (err: unknown) {
      return {
        detected: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("worktree:run-setup", async (_event, worktreePath, command) => {
    const wtPath = ipcStr(worktreePath);
    const cmd = ipcStr(command);
    try {
      const candidates = WORKTREE_SETUP_CHECKS.filter((check) => check.command === cmd);
      const matched = candidates.find((check) => existsSync(join(wtPath, check.file)));
      if (!matched) {
        return {
          success: false,
          error: "Unsupported setup command",
        };
      }
      await runCommand(matched.executable, matched.args, {
        cwd: wtPath,
        timeout: 120_000,
        shell: process.platform === "win32" && WINDOWS_SHELL_COMMANDS.has(matched.executable),
      });
      return { success: true };
    } catch (err: unknown) {
      const runErr = err as OpenCodeRunCommandError;
      return {
        success: false,
        error: runErr.stderr || (err instanceof Error ? err.message : String(err)),
      };
    }
  });

  ipcMain.handle("git:merge", async (_event, directory, branch) => {
    const dir = ipcStr(directory);
    const br = ipcStr(branch);
    try {
      await runGit(dir, ["merge", br, "--no-edit"]);
      return { success: true };
    } catch (err: unknown) {
      try {
        const conflicted = (await runGit(dir, ["diff", "--name-only", "--diff-filter=U"]))
          .split(/\r?\n/)
          .map((f) => f.trim())
          .filter(Boolean);
        if (conflicted.length > 0) {
          return { success: false, conflicts: conflicted };
        }
      } catch {
        // Could not determine conflicts
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  handleResultOp("git:merge:abort", async (_event, directory) => {
    await runGit(ipcStr(directory), ["merge", "--abort"]);
  });

  handleResultOp("git:remote:url", async (_event, directory) =>
    (await runGit(ipcStr(directory), ["remote", "get-url", "origin"])).trim(),
  );

  return {
    async restart() {
      for (const state of windowStates.values()) {
        await Promise.all(
          [...state.pendingConnections.values()].map((pending) => pending.catch(() => {})),
        );
        state.pendingConnections.clear();
        for (const conn of state.projectRegistry.values()) conn.teardown();
        state.projectRegistry.clear();
      }
      const stopped = await stopLocalOpenCodeServer();
      if (!stopped.success) throw new Error(stopped.error || "Failed to stop OpenCode server");
      const started = await startLocalOpenCodeServer();
      if (!started.success) throw new Error(started.error || "Failed to start OpenCode server");
      return true;
    },
  };
}
