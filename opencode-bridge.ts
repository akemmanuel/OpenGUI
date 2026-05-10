// @ts-nocheck
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
import { readdir, readFile } from "node:fs/promises";
import { Agent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { homedir } from "node:os";
import { basename, join, normalize, sep } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

// ---------------------------------------------------------------------------
// Local server management
// ---------------------------------------------------------------------------

const LOCAL_SERVER_PORT = Number.parseInt(process.env.OPENGUI_OPENCODE_PORT ?? "4096", 10);
const LOCAL_SERVER_URL = `http://127.0.0.1:${LOCAL_SERVER_PORT}`;
const STARTUP_POLL_INTERVAL = 500; // ms
const STARTUP_TIMEOUT = process.platform === "win32" ? 60_000 : 15_000; // ms
const DETACHED_LAUNCH_GRACE_TIMEOUT = 10_000; // ms

/** Resolve the opencode binary path (cross-platform). */
function resolveOpencodeBinary() {
  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? "opencode.exe" : "opencode";
  // Prefer the canonical install location (~/.opencode/bin/)
  const preferred = join(homedir(), ".opencode", "bin", binaryName);
  if (existsSync(preferred)) return preferred;
  // Fall back to PATH
  if (isWindows) {
    // On Windows, `where opencode` may return extensionless bash shims
    // that spawn() cannot execute. Search for .exe first, then .cmd.
    for (const ext of [".exe", ".cmd"]) {
      try {
        const result = execSync(`where opencode${ext}`, {
          encoding: "utf-8",
        })
          .split(/\r?\n/)[0]
          .trim();
        if (result) return result;
      } catch {
        // not found with this extension
      }
    }
  } else {
    try {
      const fromPath = execSync("which opencode", { encoding: "utf-8" }).split(/\r?\n/)[0].trim();
      if (fromPath) return fromPath;
    } catch {
      // not on PATH
    }
  }
  return null;
}

/** Fetch health info from the local server. Returns { healthy, version } or defaults. */
async function fetchLocalHealth() {
  try {
    const res = await fetch(`${LOCAL_SERVER_URL}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { healthy: false, version: null };
    const data = await res.json();
    return { healthy: data.healthy === true, version: data.version ?? null };
  } catch {
    return { healthy: false, version: null };
  }
}

/** Return the version string from a local binary, or null. */
function getBinaryVersion(binaryPath) {
  try {
    return execSync(`"${binaryPath}" --version`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Kill the opencode server process listening on LOCAL_SERVER_PORT. Returns true if killed. */
async function killServerProcess() {
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
      // no process found
    }
  }

  if (!pid || Number.isNaN(pid)) return false;

  try {
    process.kill(pid, isWindows ? "SIGKILL" : "SIGTERM");
  } catch {
    return false;
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));

  if ((await fetchLocalHealth()).healthy) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if ((await fetchLocalHealth()).healthy) return false;
  }

  return true;
}

/** Poll until healthy or timeout. */
function waitForHealthy(timeoutMs = STARTUP_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      if ((await fetchLocalHealth()).healthy) return resolve(true);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server did not become healthy within ${timeoutMs / 1000}s`));
      }
      setTimeout(check, STARTUP_POLL_INTERVAL);
    };
    void check();
  });
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

// Keep-alive agents to prevent idle TCP connections from being dropped.
// Setting keepAlive + very long timeouts prevents OS/proxy idle-timeout kills.
const httpAgent = new Agent({ keepAlive: true, keepAliveMsecs: 15_000 });
const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 15_000 });

function stripMessagePayloadBloat(messages) {
  for (const message of messages) {
    const summary = message?.info?.summary;
    if (summary && typeof summary === "object" && "diffs" in summary) {
      delete summary.diffs;
    }

    if (!Array.isArray(message?.parts)) continue;
    for (const part of message.parts) {
      if (part?.type !== "tool") continue;
      const files = part?.state?.metadata?.files;
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        if (file && typeof file === "object" && typeof file.diff === "string" && file.diff.trim()) {
          delete file.before;
          delete file.after;
        }
      }
    }
  }
  return messages;
}

class OpenCodeConnection {
  constructor(emit) {
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

  async connect(config) {
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
    const res = await this._client.session.list({
      roots: true,
      limit: 10000,
      ...(dir ? { directory: dir } : {}),
    });
    return res.data ?? [];
  }

  async createSession(title) {
    this._requireClient();
    const normalizedTitle = typeof title === "string" ? title.trim() : "";
    const params = normalizedTitle ? { title: normalizedTitle } : undefined;
    const res = await this._client.session.create(params);
    return res.data;
  }

  async deleteSession(id) {
    this._requireClient();
    const res = await this._client.session.delete({ sessionID: id });
    return res.data;
  }

  async updateSession(id, title) {
    this._requireClient();
    const res = await this._client.session.update({ sessionID: id, title });
    return res.data;
  }

  async getSessionStatuses() {
    this._requireClient();
    const res = await this._client.session.status();
    return res.data ?? {};
  }

  // - revert / fork ---------------------------------------------------------

  async revertSession(sessionID, messageID, partID) {
    this._requireClient();
    const params = { sessionID, messageID };
    if (partID) params.partID = partID;
    const res = await this._client.session.revert(params);
    return res.data;
  }

  async unrevertSession(sessionID) {
    this._requireClient();
    const res = await this._client.session.unrevert({ sessionID });
    return res.data;
  }

  async forkSession(sessionID, messageID) {
    this._requireClient();
    const params = { sessionID };
    if (messageID) params.messageID = messageID;
    const res = await this._client.session.fork(params);
    return res.data;
  }

  // - providers / models ----------------------------------------------------

  async getProviders() {
    this._requireClient();
    const res = await this._client.config.providers();
    return res.data ?? { providers: [], default: {} };
  }

  async listAllProviders() {
    this._requireClient();
    const res = await this._client.provider.list();
    return res.data ?? { all: [], default: {}, connected: [] };
  }

  async getProviderAuthMethods() {
    this._requireClient();
    const res = await this._client.provider.auth();
    return res.data ?? {};
  }

  async setProviderAuth(providerID, auth) {
    this._requireClient();
    const res = await this._client.auth.set({ providerID, auth });
    return res.data;
  }

  async removeProviderAuth(providerID) {
    this._requireClient();
    const res = await this._client.auth.remove({ providerID });
    return res.data;
  }

  async oauthAuthorize(providerID, method) {
    this._requireClient();
    const params = { providerID };
    if (method !== undefined) params.method = method;
    const res = await this._client.provider.oauth.authorize(params);
    return res.data;
  }

  async oauthCallback(providerID, method, code) {
    this._requireClient();
    const params = { providerID };
    if (method !== undefined) params.method = method;
    if (code !== undefined) params.code = code;
    const res = await this._client.provider.oauth.callback(params);
    return res.data;
  }

  async disposeInstance() {
    this._requireClient();
    const res = await this._client.instance.dispose();
    return res.data;
  }

  // - agents ---------------------------------------------------------------

  async getAgents() {
    this._requireClient();
    const res = await this._client.app.agents();
    return res.data ?? [];
  }

  // - messages -------------------------------------------------------------

  async getMessages(sessionId, options = {}) {
    this._requireClient();
    const params = { sessionID: sessionId };
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
      params.limit = options.limit;
    }
    if (typeof options.before === "string" && options.before.trim()) {
      params.before = options.before;
    }
    const res = await this._client.session.messages(params);
    const messages = stripMessagePayloadBloat(res.data ?? []);
    // Extract the opaque pagination cursor from the response header.
    const nextCursor = res.response?.headers?.get("X-Next-Cursor") ?? null;
    return { messages, nextCursor };
  }

  async promptAsync(sessionId, text, images, model, agent, variant) {
    this._requireClient();
    const parts = [{ type: "text", text }];
    if (images) {
      for (const url of images) {
        // Attempt to detect MIME from data-URI header or file extension
        let mime = "image/png";
        const dataMatch = url.match(/^data:(image\/[^;,]+)/);
        if (dataMatch) {
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
    const params = { sessionID: sessionId, parts };
    if (model) {
      params.model = model;
    }
    if (agent) {
      params.agent = agent;
    }
    if (variant) {
      params.variant = variant;
    }
    await this._client.session.promptAsync(params);
  }

  async abortSession(sessionId) {
    this._requireClient();
    await this._client.session.abort({ sessionID: sessionId });
  }

  // - permissions ----------------------------------------------------------

  async respondPermission(sessionId, permissionId, response) {
    this._requireClient();
    await this._client.permission.respond({
      sessionID: sessionId,
      permissionID: permissionId,
      response,
    });
  }

  // - commands -------------------------------------------------------------

  async listCommands() {
    this._requireClient();
    const res = await this._client.command.list();
    return res.data ?? [];
  }

  async sendCommand(sessionId, command, args, model, agent, variant) {
    this._requireClient();
    const params = { sessionID: sessionId, command, arguments: args };
    if (model) params.model = `${model.providerID}/${model.modelID}`;
    if (agent) params.agent = agent;
    if (variant) params.variant = variant;
    await this._client.session.command(params);
  }

  async summarizeSession(sessionId, model) {
    this._requireClient();
    if (!model?.providerID || !model?.modelID) {
      throw new Error("Compaction requires a model to be selected");
    }
    await this._client.session.summarize({
      sessionID: sessionId,
      providerID: model.providerID,
      modelID: model.modelID,
    });
  }

  // - questions ------------------------------------------------------------

  async replyQuestion(requestID, answers) {
    this._requireClient();
    await this._client.question.reply({ requestID, answers });
  }

  async rejectQuestion(requestID) {
    this._requireClient();
    await this._client.question.reject({ requestID });
  }

  // - MCP ------------------------------------------------------------------

  async getMcpStatus() {
    this._requireClient();
    const res = await this._client.mcp.status();
    return res.data ?? {};
  }

  async addMcp(name, config) {
    this._requireClient();
    const res = await this._client.mcp.add({ name, config });
    return res.data ?? {};
  }

  async connectMcp(name) {
    this._requireClient();
    await this._client.mcp.connect({ name });
  }

  async disconnectMcp(name) {
    this._requireClient();
    await this._client.mcp.disconnect({ name });
  }

  // - Config ---------------------------------------------------------------

  async getConfig() {
    this._requireClient();
    const res = await this._client.config.get();
    return res.data ?? {};
  }

  async updateConfig(config) {
    this._requireClient();
    const res = await this._client.config.update({ config });
    return res.data ?? {};
  }

  // - Skills ---------------------------------------------------------------

  async getSkills() {
    this._requireClient();
    const res = await this._client.app.skills();
    return res.data ?? [];
  }

  // - File search ----------------------------------------------------------

  async findFiles(query) {
    this._requireClient();
    const res = await this._client.find.files({ query });
    return res.data ?? [];
  }

  // - internal -------------------------------------------------------------

  _requireClient() {
    if (!this._client) throw new Error("Not connected to any opencode server");
  }

  _makeAuthHeaders(config) {
    const headers = {};
    if (config.password) {
      const user = config.username ?? "opencode";
      headers.Authorization = `Basic ${Buffer.from(`${user}:${config.password}`).toString("base64")}`;
    }
    return headers;
  }

  _makeClient(config) {
    const headers = this._makeAuthHeaders(config);
    const directory = typeof config.directory === "string" ? config.directory.trim() : "";

    // Custom fetch that uses keep-alive agents to prevent idle connection drops.
    const customFetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const agent = url?.startsWith("https") ? httpsAgent : httpAgent;
      return globalThis.fetch(input, { ...init, agent });
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

  async _healthCheck() {
    this._requireClient();
    try {
      const res = await this._client.global.health();
      const data = res.data;
      if (data?.version) this._setStatus({ serverVersion: data.version });
      if (!data?.healthy) throw new Error("Server reports unhealthy");
    } catch (err) {
      // If the v2 global.health() fails with a method-not-found-style error,
      // fall back to raw fetch (older servers may not support this endpoint via SDK)
      if (err?.message?.includes("unhealthy")) throw err;
      const url = `${this._config.baseUrl.replace(/\/+$/, "")}/global/health`;
      const headers = this._makeAuthHeaders(this._config);
      const rawRes = await fetch(url, { headers });
      if (!rawRes.ok) throw new Error(`Health check failed: ${rawRes.status} ${rawRes.statusText}`);
      const data = await rawRes.json();
      if (data.version) this._setStatus({ serverVersion: data.version });
      if (!data.healthy) throw new Error("Server reports unhealthy");
    }
  }

  _isCurrent(lifecycle) {
    return lifecycle === this._lifecycle;
  }

  async _startSSE(lifecycle) {
    if (!this._isCurrent(lifecycle)) return;
    this._requireClient();
    const streamGeneration = ++this._streamGeneration;
    const abortController = new AbortController();
    this._abortController = abortController;

    try {
      const events = await this._client.event.subscribe(
        {},
        {
          signal: abortController.signal,
          // Disable SDK-level retry - we handle reconnection at the app level
          // with our own backoff. Without this, the SDK silently retries with
          // exponential backoff (3s/6s/12s/24s/30s) and the app has no
          // visibility into the disconnect.
          sseMaxRetryAttempts: 1,
          onSseError: (err) => {
            if (abortController.signal.aborted) return;
            console.warn("[OpenCodeConnection] SDK SSE error:", err);
          },
        },
      );

      const stream = events.stream ?? events;
      for await (const event of stream) {
        if (
          abortController.signal.aborted ||
          this._streamGeneration !== streamGeneration ||
          !this._isCurrent(lifecycle)
        ) {
          break;
        }

        const payload = event.properties ? event : event.payload;
        if (payload) {
          this._emit({ type: "opencode:event", payload });
          this._setStatus({ lastEventAt: Date.now() });
        }
        this._reconnectAttempt = 0;
      }

      // Newer OpenCode servers can close the project-scoped /event stream
      // cleanly after sending the initial server.connected event. Treat a
      // clean EOF as non-fatal; otherwise every open project enters a tight
      // reconnect/log loop while the connection itself remains healthy.
      if (!abortController.signal.aborted && this._streamGeneration === streamGeneration) {
        if (this._abortController === abortController) this._abortController = null;
        this._setStatus({ state: "connected", error: null });
      }
    } catch (err) {
      if (
        abortController.signal.aborted ||
        this._streamGeneration !== streamGeneration ||
        !this._isCurrent(lifecycle)
      ) {
        return;
      }
      console.error("[OpenCodeConnection] SSE error:", err);
      this._scheduleReconnect(lifecycle);
    }
  }

  _scheduleReconnect(lifecycle) {
    if (!this._config || !this._isCurrent(lifecycle)) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const delay = BACKOFF_STEPS[Math.min(this._reconnectAttempt, BACKOFF_STEPS.length - 1)];
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

  _startHealthTimer(lifecycle) {
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
          // Abort the old stream and wait briefly for it to unwind
          // before starting a fresh one to avoid overlapping streams.
          this._abortController?.abort();
          await new Promise((r) => setTimeout(r, 100));
          void this._startSSE(lifecycle);
        }
      } catch {
        // Server unreachable - actively trigger reconnect instead of
        // waiting for the SSE stream to eventually break on its own.
        if (this._status.state === "connected") {
          console.warn("[OpenCodeConnection] Health check failed while connected, reconnecting...");
          this._abortController?.abort();
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

  _setStatus(patch) {
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

// ---------------------------------------------------------------------------
// Setup: called from main.ts with (ipcMain, mainWindow)
// ---------------------------------------------------------------------------

export function setupOpenCodeBridge(ipcMain, _getWindows) {
  /** @type {Map<number, {
   *   connections: Map<string, OpenCodeConnection>,
   *   sessionDirectoryMap: Map<string, string>,
   *   questionDirectoryMap: Map<string, string>,
   *   serverConfig: { baseUrl: string, username?: string, password?: string } | null,
   * }>} */
  const windowStates = new Map();

  function getWindowState(sender) {
    const key = sender.id;
    let state = windowStates.get(key);
    if (state) return state;
    state = {
      connections: new Map(),
      sessionDirectoryMap: new Map(),
      questionDirectoryMap: new Map(),
      serverConfig: null,
    };
    windowStates.set(key, state);
    sender.once("destroyed", () => {
      const current = windowStates.get(key);
      if (!current) return;
      for (const conn of current.connections.values()) {
        conn.teardown();
      }
      windowStates.delete(key);
    });
    return state;
  }

  function normalizeServerConfig(config) {
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

  function sendEvent(sender, event) {
    if (!sender.isDestroyed()) {
      sender.send("opencode:bridge-event", event);
    }
  }

  function makeProjectKey(workspaceId, directory) {
    return `${workspaceId?.trim() || ""}\0${normalize(directory.trim())}`;
  }

  function createConnection(windowState, sender, directory, workspaceId) {
    const projectKey = makeProjectKey(workspaceId, directory);
    const conn = new OpenCodeConnection((event) => {
      if (windowState.connections.get(projectKey) !== conn) return;
      if (event?.type === "opencode:event") {
        const payload = event.payload;
        if (payload?.type === "question.asked") {
          const questionId = payload?.properties?.id;
          if (questionId) {
            windowState.questionDirectoryMap.set(questionId, projectKey);
          }
        }
        if (payload?.type === "question.replied" || payload?.type === "question.rejected") {
          const requestID = payload?.properties?.requestID;
          if (requestID) windowState.questionDirectoryMap.delete(requestID);
        }
        if (payload?.type === "session.created" || payload?.type === "session.updated") {
          const info = payload?.properties?.info;
          if (info?.id) {
            windowState.sessionDirectoryMap.set(info.id, projectKey);
          }
        }
      }
      sendEvent(sender, { ...event, directory, workspaceId });
    });
    windowState.connections.set(projectKey, conn);
    return conn;
  }

  function getWorkspaceIdFromProjectKey(projectKey) {
    return projectKey.split("\0", 1)[0] ?? "";
  }

  function getConnectedConnections(windowState, workspaceId) {
    const requestedWorkspaceId = workspaceId?.trim() || "";
    return [...windowState.connections.entries()]
      .filter(([projectKey, conn]) => {
        if (conn.getStatus().state !== "connected") return false;
        if (!requestedWorkspaceId) return true;
        return getWorkspaceIdFromProjectKey(projectKey) === requestedWorkspaceId;
      })
      .map(([, conn]) => conn);
  }

  /** Find which connection owns a session by looking up the cache. */
  function getConnectionForSession(windowState, sessionId) {
    const projectKey = windowState.sessionDirectoryMap.get(sessionId);
    if (projectKey) {
      const conn = windowState.connections.get(projectKey);
      if (conn) return conn;
    }
    const connected = getConnectedConnections(windowState);
    return connected.length === 1 ? connected[0] : null;
  }

  /** Get any connected connection, optionally scoped to one workspace. */
  function getAnyConnection(windowState, workspaceId) {
    return getConnectedConnections(windowState, workspaceId)[0] ?? null;
  }

  /** Resolve a connection for a specific project directory + workspace. */
  function getConnectionForDirectory(windowState, directory, workspaceId) {
    if (typeof directory !== "string" || !directory.trim()) {
      return getAnyConnection(windowState, workspaceId);
    }

    const projectKey = makeProjectKey(workspaceId, directory);
    const exact = windowState.connections.get(projectKey);
    if (exact) return exact;

    const requestedWorkspaceId = workspaceId?.trim() || "";
    const requested = normalize(directory.trim());
    for (const [key, conn] of windowState.connections) {
      if (getWorkspaceIdFromProjectKey(key) !== requestedWorkspaceId) continue;
      const [, dir = ""] = key.split("\0");
      const normalizedDir = normalize(dir);
      if (normalizedDir === requested) return conn;
      if (
        requested.startsWith(normalizedDir) &&
        (requested.length === normalizedDir.length || requested[normalizedDir.length] === sep)
      ) {
        return conn;
      }
    }

    return null;
  }

  // --- IPC handler factories (DRY helpers to eliminate boilerplate) ---

  /**
   * Register a directory-aware IPC handler whose first arg is a directory.
   * @param {string} channel - IPC channel name
   * @param {(conn: OpenCodeConnection, ...args: any[]) => Promise<any>} fn
   */
  function handleDirectoryOp(channel, fn) {
    ipcMain.handle(channel, async (event, directory, workspaceId, ...args) => {
      try {
        const windowState = getWindowState(event.sender);
        const conn = getConnectionForDirectory(windowState, directory, workspaceId);
        if (!conn) return { success: false, error: "No connection available" };
        const data = await fn(conn, ...args);
        return data === undefined ? { success: true } : { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });
  }

  /**
   * Register a session-routed IPC handler that uses getConnectionForSession().
   * The first arg after _event is always sessionId.
   * @param {string} channel - IPC channel name
   * @param {(conn: OpenCodeConnection, sessionId: string, ...args: any[]) => Promise<any>} fn
   */
  function handleSessionOp(channel, fn) {
    ipcMain.handle(channel, async (event, sessionId, ...args) => {
      try {
        const windowState = getWindowState(event.sender);
        const conn = getConnectionForSession(windowState, sessionId);
        if (!conn) return { success: false, error: "Session connection not found" };
        const data = await fn(conn, sessionId, ...args);
        return data === undefined ? { success: true } : { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });
  }

  /**
   * Register an IPC handler for question operations that prefers
   * requestID -> directory routing, then falls back to trying all connections.
   * @param {string} channel - IPC channel name
   * @param {(conn: OpenCodeConnection, requestID: string, ...args: any[]) => Promise<any>} fn
   */
  function handleQuestionOp(channel, fn) {
    ipcMain.handle(channel, async (event, requestID, ...args) => {
      try {
        const windowState = getWindowState(event.sender);
        if (typeof requestID !== "string" || !requestID.trim()) {
          return { success: false, error: "Question requestID is required" };
        }

        const mappedDirectory = windowState.questionDirectoryMap.get(requestID);
        if (mappedDirectory) {
          const mappedConn = windowState.connections.get(mappedDirectory);
          if (mappedConn) {
            const data = await fn(mappedConn, requestID, ...args);
            windowState.questionDirectoryMap.delete(requestID);
            return data === undefined ? { success: true } : { success: true, data };
          }
          windowState.questionDirectoryMap.delete(requestID);
        }

        const conn = getAnyConnection(windowState);
        if (conn && getConnectedConnections(windowState).length === 1) {
          const data = await fn(conn, requestID, ...args);
          windowState.questionDirectoryMap.delete(requestID);
          return data === undefined ? { success: true } : { success: true, data };
        }

        return {
          success: false,
          error: "Question connection not found",
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });
  }

  const WINDOWS_SHELL_COMMANDS = new Set(["bun", "npm", "pnpm", "yarn", "pip"]);
  const WORKTREE_SETUP_CHECKS = [
    {
      file: "bun.lockb",
      command: "bun install",
      executable: "bun",
      args: ["install"],
    },
    {
      file: "bun.lock",
      command: "bun install",
      executable: "bun",
      args: ["install"],
    },
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
      command: "bun install",
      executable: "bun",
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
  function runCommand(executable, args, options) {
    return new Promise((resolve, reject) => {
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
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const fail = (message) => {
        if (settled) return;
        settled = true;
        cleanup();
        const detail = (stderr || stdout || message).trim();
        const error = new Error(detail || message);
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
          const error = new Error(`Command timed out after ${options.timeout ?? 0}ms`);
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
  function runGit(directory, args) {
    return runCommand("git", args, { cwd: directory });
  }

  // --- Project management ---

  ipcMain.handle("opencode:project:add", async (event, config) => {
    const windowState = getWindowState(event.sender);
    if (!config || typeof config !== "object") {
      return { success: false, error: "Invalid config" };
    }
    if (typeof config.baseUrl !== "string" || !config.baseUrl.trim()) {
      return { success: false, error: "Server URL is required" };
    }
    const directory = (config.directory ?? "").trim();
    if (!directory) {
      return { success: false, error: "Directory is required" };
    }
    const normalizedConfig = normalizeServerConfig(config);
    const projectKey = makeProjectKey(config.workspaceId, directory);
    try {
      const existing = windowState.connections.get(projectKey);
      if (existing) {
        existing.teardown();
        windowState.connections.delete(projectKey);
      }
      const conn = createConnection(windowState, event.sender, directory, config.workspaceId);
      await conn.connect(normalizedConfig);
      windowState.serverConfig = normalizedConfig;
      return { success: true, status: conn.getStatus() };
    } catch (err) {
      if (windowState.connections.get(projectKey)) {
        windowState.connections.delete(projectKey);
      }
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("opencode:project:remove", (event, directory, workspaceId) => {
    const windowState = getWindowState(event.sender);
    if (typeof directory !== "string" || !directory.trim()) {
      return { success: false, error: "Directory is required" };
    }
    const projectKey = makeProjectKey(workspaceId, directory);
    const conn = windowState.connections.get(projectKey);
    if (conn) {
      conn.teardown();
      windowState.connections.delete(projectKey);
      for (const [sid, key] of windowState.sessionDirectoryMap) {
        if (key === projectKey) windowState.sessionDirectoryMap.delete(sid);
      }
      for (const [requestID, key] of windowState.questionDirectoryMap) {
        if (key === projectKey) windowState.questionDirectoryMap.delete(requestID);
      }
    }
    if (windowState.connections.size === 0) {
      windowState.serverConfig = null;
    }
    return { success: true };
  });

  ipcMain.handle("opencode:disconnect", (event) => {
    const windowState = getWindowState(event.sender);
    for (const conn of windowState.connections.values()) {
      conn.teardown();
    }
    windowState.connections.clear();
    windowState.sessionDirectoryMap.clear();
    windowState.questionDirectoryMap.clear();
    windowState.serverConfig = null;
    return { success: true };
  });

  // --- Session operations ---

  /** Tag sessions with their directory and cache the mappings. */
  async function listAndCacheSessions(conn, dir, workspaceId) {
    const sessions = (await conn.listSessions()).map((s) => ({
      ...s,
      _projectDir: dir,
      _workspaceId: workspaceId,
    }));
    return sessions;
  }

  function cacheSessions(windowState, sessions, projectKey) {
    for (const s of sessions) {
      windowState.sessionDirectoryMap.set(s.id, projectKey);
    }
  }

  ipcMain.handle("opencode:session:list", async (event, directory, workspaceId) => {
    try {
      const windowState = getWindowState(event.sender);
      if (directory) {
        const conn = getConnectionForDirectory(windowState, directory, workspaceId);
        if (!conn) return { success: false, error: "Project not connected" };
        const projectKey = makeProjectKey(workspaceId, directory);
        const sessions = await listAndCacheSessions(conn, directory, workspaceId);
        cacheSessions(windowState, sessions, projectKey);
        return {
          success: true,
          data: sessions,
        };
      }
      // List sessions from ALL projects
      const allSessions = [];
      for (const [projectKey, conn] of windowState.connections) {
        try {
          const [currentWorkspaceId = "", dir = ""] = projectKey.split("\0");
          const sessions = await listAndCacheSessions(conn, dir, currentWorkspaceId || undefined);
          cacheSessions(windowState, sessions, projectKey);
          allSessions.push(...sessions);
        } catch {
          // Skip failed connections
        }
      }
      return { success: true, data: allSessions };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("opencode:session:create", async (event, title, directory, workspaceId) => {
    try {
      const windowState = getWindowState(event.sender);
      const conn = directory
        ? getConnectionForDirectory(windowState, directory, workspaceId)
        : getAnyConnection(windowState, workspaceId);
      if (!conn) return { success: false, error: "No connection available" };
      const session = await conn.createSession(title);
      if (session) {
        const dir = directory || conn.getDirectory();
        if (dir) {
          windowState.sessionDirectoryMap.set(session.id, makeProjectKey(workspaceId, dir));
        }
      }
      return { success: true, data: session };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("opencode:session:delete", async (event, id) => {
    try {
      const windowState = getWindowState(event.sender);
      const conn = getConnectionForSession(windowState, id);
      if (!conn) {
        return { success: false, error: "Session connection not found" };
      }
      const result = await conn.deleteSession(id);
      windowState.sessionDirectoryMap.delete(id);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handleSessionOp("opencode:session:update", (conn, id, title) => conn.updateSession(id, title));

  ipcMain.handle("opencode:session:statuses", async (event, directory, workspaceId) => {
    try {
      const windowState = getWindowState(event.sender);
      const conn = directory
        ? getConnectionForDirectory(windowState, directory, workspaceId)
        : getAnyConnection(windowState, workspaceId);
      if (!conn) return { success: false, error: "No connection available" };
      const statuses = await conn.getSessionStatuses();
      return { success: true, data: statuses };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handleSessionOp("opencode:session:revert", (conn, id, messageID, partID) =>
    conn.revertSession(id, messageID, partID),
  );
  handleSessionOp("opencode:session:unrevert", (conn, id) => conn.unrevertSession(id));

  ipcMain.handle("opencode:session:fork", async (event, id, messageID) => {
    try {
      const windowState = getWindowState(event.sender);
      const conn = getConnectionForSession(windowState, id);
      if (!conn) return { success: false, error: "Session connection not found" };
      const result = await conn.forkSession(id, messageID);
      // Register the new forked session in the directory map so future
      // operations can find the correct connection.
      if (result?.id) {
        const dir = [...windowState.connections.entries()].find(([, c]) => c === conn)?.[0];
        if (dir) windowState.sessionDirectoryMap.set(result.id, dir);
      }
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- Providers / models (directory-aware) ---

  handleDirectoryOp("opencode:providers", (conn) => conn.getProviders());

  // --- Provider management (directory-aware) ---

  handleDirectoryOp("opencode:provider:list", (conn) => conn.listAllProviders());
  handleDirectoryOp("opencode:provider:auth-methods", (conn) => conn.getProviderAuthMethods());
  handleDirectoryOp("opencode:provider:connect", (conn, providerID, auth) =>
    conn.setProviderAuth(providerID, auth),
  );
  handleDirectoryOp("opencode:provider:disconnect", (conn, providerID) =>
    conn.removeProviderAuth(providerID),
  );
  handleDirectoryOp("opencode:provider:oauth:authorize", (conn, providerID, method) =>
    conn.oauthAuthorize(providerID, method),
  );
  handleDirectoryOp("opencode:provider:oauth:callback", (conn, providerID, method, code) =>
    conn.oauthCallback(providerID, method, code),
  );
  handleDirectoryOp("opencode:instance:dispose", (conn) => conn.disposeInstance());

  // --- Agents (directory-aware) ---

  handleDirectoryOp("opencode:agents", (conn) => conn.getAgents());

  // --- Message operations (routed to session's connection) ---

  ipcMain.handle("opencode:messages", async (event, sessionId, options, directory, workspaceId) => {
    try {
      const windowState = getWindowState(event.sender);
      let conn = getConnectionForSession(windowState, sessionId);
      if (!conn && directory) {
        conn = getConnectionForDirectory(windowState, directory, workspaceId);
        if (conn) {
          windowState.sessionDirectoryMap.set(sessionId, makeProjectKey(workspaceId, directory));
        }
      }
      if (!conn) {
        return { success: false, error: "Session connection not found" };
      }
      return { success: true, data: await conn.getMessages(sessionId, options) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  handleSessionOp("opencode:prompt", (conn, sessionId, text, images, model, agent, variant) =>
    conn.promptAsync(sessionId, text, images, model, agent, variant),
  );
  handleSessionOp("opencode:abort", (conn, sessionId) => conn.abortSession(sessionId));

  // --- Permission response (routed to session's connection) ---

  handleSessionOp("opencode:permission", (conn, sessionId, permissionId, response) =>
    conn.respondPermission(sessionId, permissionId, response),
  );

  // --- Question response (try all connections) ---

  handleQuestionOp("opencode:question:reply", (conn, requestID, answers) =>
    conn.replyQuestion(requestID, answers),
  );

  // --- Commands (global) ---

  handleDirectoryOp("opencode:commands", (conn) => conn.listCommands());
  handleSessionOp(
    "opencode:command:send",
    (conn, sessionId, command, args, model, agent, variant) =>
      conn.sendCommand(sessionId, command, args, model, agent, variant),
  );
  handleSessionOp("opencode:session:summarize", (conn, sessionId, model) =>
    conn.summarizeSession(sessionId, model),
  );
  handleQuestionOp("opencode:question:reject", (conn, requestID) => conn.rejectQuestion(requestID));

  // --- MCP operations (directory-aware) ---

  handleDirectoryOp("opencode:mcp:status", (conn) => conn.getMcpStatus());
  handleDirectoryOp("opencode:mcp:add", (conn, name, config) => conn.addMcp(name, config));
  handleDirectoryOp("opencode:mcp:connect", (conn, name) => conn.connectMcp(name));
  handleDirectoryOp("opencode:mcp:disconnect", (conn, name) => conn.disconnectMcp(name));

  // --- Config operations (directory-aware) ---

  handleDirectoryOp("opencode:config:get", (conn) => conn.getConfig());

  ipcMain.handle("opencode:config:update", async (event, directory, workspaceId, config) => {
    try {
      if (!config || typeof config !== "object") {
        return { success: false, error: "Invalid config" };
      }
      const windowState = getWindowState(event.sender);
      const conn = getConnectionForDirectory(windowState, directory, workspaceId);
      if (!conn) return { success: false, error: "No connection available" };
      return { success: true, data: await conn.updateConfig(config) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- Skills operations (directory-aware) ---

  handleDirectoryOp("opencode:skills", (conn) => conn.getSkills());

  // --- File search (directory-specific) ---

  ipcMain.handle("opencode:find:files", async (event, directory, workspaceId, query) => {
    try {
      const windowState = getWindowState(event.sender);
      const conn = getConnectionForDirectory(windowState, directory, workspaceId);
      if (!conn) return { success: false, error: "No connection available" };

      const data = await conn.findFiles(query);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- Local server management ---

  ipcMain.handle("opencode:server:start", async () => {
    try {
      const binary = resolveOpencodeBinary();

      // If already running, check version matches the local binary
      const health = await fetchLocalHealth();
      if (health.healthy) {
        const serverVer = health.version;
        const binaryVer = binary ? getBinaryVersion(binary) : null;
        if (!serverVer || !binaryVer || serverVer === binaryVer) {
          return { success: true, data: { alreadyRunning: true } };
        }
        // Version mismatch - kill the old server and respawn below
        const killed = await killServerProcess();
        if (!killed) {
          return {
            success: false,
            error: `A stale OpenCode server is already running on port ${LOCAL_SERVER_PORT} with version ${serverVer}, but it could not be stopped so version ${binaryVer} can start. Please stop the existing server and try again.`,
          };
        }
      }
      console.log(
        `[opencode-bridge] Resolved binary: ${binary ?? "(not found)"} (platform: ${process.platform})`,
      );
      if (!binary) {
        return {
          success: false,
          error:
            "Could not find the opencode binary. Make sure it is installed at ~/.opencode/bin/opencode or available on your PATH.",
        };
      }

      // Spawn detached so the server survives app close.
      // Use piped stdio so we can capture logs on startup failure.
      const serverArgs = ["serve", "--port", String(LOCAL_SERVER_PORT)];
      console.log(
        `[opencode-bridge] Spawning: ${binary} ${serverArgs.join(" ")} (platform: ${process.platform})`,
      );

      const MAX_LOG_BYTES = 8192;
      let logBuffer = "";
      /** @type {number | null} */
      let earlyExitCode = null;

      const appendLog = (chunk) => {
        if (logBuffer.length < MAX_LOG_BYTES) {
          logBuffer += chunk.toString().slice(0, MAX_LOG_BYTES - logBuffer.length);
        }
      };

      // .cmd files on Windows require shell:true for spawn() to execute them
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

      // If spawn itself errors (e.g. ENOENT)
      let spawnError = null;
      child.on("error", (err) => {
        spawnError = err;
        console.error("[opencode-bridge] Failed to spawn opencode server:", err);
      });

      // Wait for the server to become healthy
      console.log(
        `[opencode-bridge] Waiting for server to become healthy (timeout: ${STARTUP_TIMEOUT / 1000}s)...`,
      );
      try {
        await waitForHealthy();
      } catch (healthErr) {
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
          console.log("[opencode-bridge] Server became healthy after launcher exited.");
          return { success: true, data: { alreadyRunning: false } };
        }

        // Detach the stdio streams before returning the error
        if (child.stdout) {
          child.stdout.removeAllListeners("data");
          child.stdout.destroy();
        }
        if (child.stderr) {
          child.stderr.removeAllListeners("data");
          child.stderr.destroy();
        }

        let errorMsg = healthErr.message ?? String(healthErr);
        if (spawnError) {
          errorMsg = `Spawn error: ${spawnError.message}`;
        } else if (earlyExitCode !== null && earlyExitCode !== 0) {
          // Non-zero exit means the server actually crashed.
          // Exit code 0 is normal when the binary daemonizes (spawns a
          // background server and the launcher exits cleanly), so we
          // keep the health-check timeout message instead.
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

      console.log("[opencode-bridge] Server is healthy.");
      return { success: true, data: { alreadyRunning: false } };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("opencode:server:stop", async () => {
    try {
      if (!(await fetchLocalHealth()).healthy) {
        return { success: true, data: { alreadyStopped: true } };
      }
      const killed = await killServerProcess();
      if (!killed) {
        return {
          success: false,
          error: "Server process could not be stopped",
        };
      }
      return { success: true, data: {} };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("opencode:server:status", async () => {
    try {
      const running = (await fetchLocalHealth()).healthy;
      return { success: true, data: { running } };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  // --- Git helpers ---

  ipcMain.handle("git:is-repo", async (_event, directory) => {
    try {
      await runGit(directory, ["rev-parse", "--git-dir"]);
      return { success: true, data: true };
    } catch {
      return { success: true, data: false };
    }
  });

  ipcMain.handle("git:branch:list", async (_event, directory) => {
    try {
      const raw = await runGit(directory, ["branch", "--format=%(refname:short)"]);
      const branches = raw
        .split(/\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean);
      return { success: true, data: branches };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("git:current-branch", async (_event, directory) => {
    try {
      const branch = (await runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return { success: true, data: branch };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("git:worktree:list", async (_event, directory) => {
    try {
      const raw = await runGit(directory, ["worktree", "list", "--porcelain"]);
      const worktrees = [];
      let current = {};
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
      return { success: true, data: worktrees };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle(
    "git:worktree:add",
    async (_event, directory, worktreePath, branch, isNewBranch) => {
      try {
        const args = ["worktree", "add"];
        if (isNewBranch) {
          args.push("-b", branch, worktreePath);
        } else {
          args.push(worktreePath, branch);
        }
        await runGit(directory, args);
        return { success: true, data: { path: worktreePath } };
      } catch (err) {
        return { success: false, error: err.message ?? String(err) };
      }
    },
  );

  ipcMain.handle("git:worktree:remove", async (_event, directory, worktreePath) => {
    try {
      await runGit(directory, ["worktree", "remove", worktreePath]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  // -----------------------------------------------------------------------
  // Worktree setup detection & execution
  // -----------------------------------------------------------------------

  ipcMain.handle("worktree:detect-setup", async (_event, worktreePath) => {
    try {
      for (const check of WORKTREE_SETUP_CHECKS) {
        if (existsSync(join(worktreePath, check.file))) {
          return {
            detected: true,
            command: check.command,
            file: check.file,
          };
        }
      }
      return { detected: false };
    } catch (err) {
      return { detected: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("worktree:run-setup", async (_event, worktreePath, command) => {
    try {
      const candidates = WORKTREE_SETUP_CHECKS.filter((check) => check.command === command);
      const matched = candidates.find((check) => existsSync(join(worktreePath, check.file)));
      if (!matched) {
        return {
          success: false,
          error: "Unsupported setup command",
        };
      }
      await runCommand(matched.executable, matched.args, {
        cwd: worktreePath,
        timeout: 120_000,
        shell: process.platform === "win32" && WINDOWS_SHELL_COMMANDS.has(matched.executable),
      });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err.stderr || err.message || String(err),
      };
    }
  });

  ipcMain.handle("git:merge", async (_event, directory, branch) => {
    try {
      await runGit(directory, ["merge", branch, "--no-edit"]);
      return { success: true };
    } catch (err) {
      try {
        const conflicted = (await runGit(directory, ["diff", "--name-only", "--diff-filter=U"]))
          .split(/\r?\n/)
          .map((f) => f.trim())
          .filter(Boolean);
        if (conflicted.length > 0) {
          return { success: false, conflicts: conflicted };
        }
      } catch {
        // Could not determine conflicts
      }
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("git:merge:abort", async (_event, directory) => {
    try {
      await runGit(directory, ["merge", "--abort"]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("git:remote:url", async (_event, directory) => {
    try {
      const url = (await runGit(directory, ["remote", "get-url", "origin"])).trim();
      return { success: true, data: url };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  // -----------------------------------------------------------------------
  // Skills.sh Marketplace API proxy
  // -----------------------------------------------------------------------

  const SKILLS_API_BASE = "https://skills.sh/api/v1";
  const SKILLS_LEGACY_API_BASE = "https://skills.sh";

  function normalizeLegacySkill(skill) {
    const id =
      skill.id ||
      [skill.source, skill.skillId || skill.slug || skill.name].filter(Boolean).join("/");
    const parts = id.split("/");
    const slug = skill.skillId || skill.slug || parts.at(-1) || skill.name;
    const source = skill.source || parts.slice(0, -1).join("/");
    return {
      id,
      slug,
      name: skill.name || slug,
      source,
      installs: skill.installs || 0,
      sourceType: source.includes("/") ? "github" : "well-known",
      installUrl: source.includes("/")
        ? `https://github.com/${source}`
        : source
          ? `https://${source}`
          : null,
      url: `https://skills.sh/${id}`,
    };
  }

  function normalizeLegacySearch(data) {
    const skills = Array.isArray(data.skills) ? data.skills.map(normalizeLegacySkill) : [];
    return {
      data: skills,
      query: data.query || "",
      searchType: data.searchType || "fuzzy",
      count: data.count ?? skills.length,
      durationMs: data.durationMs ?? data.duration_ms ?? 0,
    };
  }

  async function skillsFetch(path, apiKey) {
    const headers = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${SKILLS_API_BASE}${path}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`skills.sh API ${res.status}: ${body || res.statusText}`);
    }
    return res.json();
  }

  async function legacySkillsSearch(query, limit) {
    const params = new URLSearchParams({ q: query, limit: String(limit || 50) });
    const res = await fetch(`${SKILLS_LEGACY_API_BASE}/api/search?${params}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`skills.sh search API ${res.status}: ${body || res.statusText}`);
    }
    return normalizeLegacySearch(await res.json());
  }

  async function legacySkillDownload(source, slug) {
    const [owner, repo] = source.split("/");
    if (!owner || !repo) return null;
    const res = await fetch(
      `${SKILLS_LEGACY_API_BASE}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    return res.json();
  }

  ipcMain.handle(
    "opencode:skills:marketplace:list",
    async (_event, view, page, perPage, _apiKey) => {
      try {
        // Match the official `skills` npm package: it uses the public legacy
        // /api/search endpoint. The documented /api/v1 endpoints currently
        // return 401 without an API key despite the docs saying auth is optional.
        const data = await legacySkillsSearch("skill", perPage || 50);
        return {
          success: true,
          data: {
            data: data.data,
            pagination: {
              page: page || 0,
              perPage: perPage || data.data.length,
              total: data.data.length,
              hasMore: false,
            },
          },
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  );

  ipcMain.handle("opencode:skills:marketplace:search", async (_event, query, limit, _apiKey) => {
    try {
      const data = await legacySkillsSearch(query, limit || 50);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("opencode:skills:marketplace:detail", async (_event, source, slug, apiKey) => {
    try {
      const legacy = await legacySkillDownload(source, slug);
      if (legacy) {
        return {
          success: true,
          data: {
            id: `${source}/${slug}`,
            source,
            slug,
            installs: 0,
            hash: legacy.hash || null,
            files: legacy.files || null,
          },
        };
      }

      // Fallback for API-key users / non-GitHub sources.
      const data = await skillsFetch(
        `/skills/${encodeURIComponent(source)}/${encodeURIComponent(slug)}`,
        apiKey,
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("opencode:skills:marketplace:audit", async (_event, source, slug, apiKey) => {
    try {
      if (!apiKey) {
        return { success: true, data: { id: `${source}/${slug}`, source, slug, audits: [] } };
      }
      const data = await skillsFetch(
        `/skills/audit/${encodeURIComponent(source)}/${encodeURIComponent(slug)}`,
        apiKey,
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("opencode:skills:marketplace:curated", async (_event, _apiKey) => {
    try {
      // No equivalent public curated endpoint is used by the official CLI.
      // Use legacy public search so the marketplace remains usable without an API key.
      const data = await legacySkillsSearch("official", 50);
      return {
        success: true,
        data: {
          data: [
            {
              owner: "skills.sh",
              totalInstalls: data.data.reduce((sum, skill) => sum + (skill.installs || 0), 0),
              featuredRepo: "search",
              featuredSkill: data.data[0]?.name || "Skills",
              skills: data.data,
            },
          ],
          totalOwners: 1,
          totalSkills: data.data.length,
          generatedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // -----------------------------------------------------------------------
  // Skills CLI integration (install, remove, update, list)
  // -----------------------------------------------------------------------

  function getSkillsCli() {
    try {
      execSync("bunx skills --version", { stdio: "ignore", timeout: 10_000 });
      return "bunx";
    } catch {
      try {
        execSync("npx skills --version", { stdio: "ignore", timeout: 10_000 });
        return "npx";
      } catch {
        return null;
      }
    }
  }

  ipcMain.handle("opencode:skills:check-cli", async () => {
    const cli = getSkillsCli();
    return { success: true, data: { available: cli !== null, command: cli } };
  });

  function spawnSkillsInstall(event, cli, source, cwd, globalScope) {
    return new Promise((resolve) => {
      const args = ["skills", "add", source, "-y"];
      if (globalScope) args.push("-g");
      const env = { ...process.env, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
      const child = spawn(cli, args, {
        cwd: globalScope ? homedir() : cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });

      const sendChunk = (chunk, type) => {
        try {
          if (event && !event.sender.isDestroyed()) {
            event.sender.send("opencode:skills:install-progress", {
              chunk: String(chunk),
              type,
            });
          }
        } catch {}
      };

      if (child.stdout) child.stdout.on("data", (data) => sendChunk(data, "stdout"));
      if (child.stderr) child.stderr.on("data", (data) => sendChunk(data, "stderr"));
      child.on("close", (code) => {
        sendChunk(`\n--- Process exited with code ${code} ---\n`, "system");
        resolve({ success: code === 0, exitCode: code });
      });
      child.on("error", (err) => {
        sendChunk(`\n--- Error: ${err.message} ---\n`, "system");
        resolve({ success: false, error: err.message });
      });
    });
  }

  ipcMain.handle("opencode:skills:install", async (event, source, directory, globalScope) => {
    try {
      const cli = getSkillsCli();
      if (!cli)
        return {
          success: false,
          error: "Neither bunx nor npx found. Install Node.js or Bun first.",
        };
      return await spawnSkillsInstall(event, cli, source, directory, !!globalScope);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("opencode:skills:remove", async (event, skillName, directory, globalScope) => {
    try {
      const cli = getSkillsCli();
      if (!cli) return { success: false, error: "Neither bunx nor npx found." };
      const args = ["skills", "rm", skillName, "-y"];
      if (globalScope) args.push("-g");
      const env = { ...process.env, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
      const child = spawn(cli, args, {
        cwd: globalScope ? homedir() : directory,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });

      const sendChunk = (chunk, type) => {
        try {
          if (event && !event.sender.isDestroyed()) {
            event.sender.send("opencode:skills:install-progress", {
              chunk: String(chunk),
              type,
            });
          }
        } catch {}
      };

      if (child.stdout) child.stdout.on("data", (data) => sendChunk(data, "stdout"));
      if (child.stderr) child.stderr.on("data", (data) => sendChunk(data, "stderr"));
      const code = await new Promise((resolve) => {
        child.on("close", resolve);
        child.on("error", (err) => {
          sendChunk(`\n--- Error: ${err.message} ---\n`, "system");
          resolve(null);
        });
      });
      return { success: code === 0, exitCode: code };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("opencode:skills:update", async (event, skillName, directory, globalScope) => {
    try {
      const cli = getSkillsCli();
      if (!cli) return { success: false, error: "Neither bunx nor npx found." };
      const args = ["skills", "update"];
      if (skillName && skillName !== "*") args.push(skillName);
      if (globalScope) args.push("-g");
      args.push("-y");
      const env = { ...process.env, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
      const child = spawn(cli, args, {
        cwd: globalScope ? homedir() : directory,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });

      const sendChunk = (chunk, type) => {
        try {
          if (event && !event.sender.isDestroyed()) {
            event.sender.send("opencode:skills:install-progress", {
              chunk: String(chunk),
              type,
            });
          }
        } catch {}
      };

      if (child.stdout) child.stdout.on("data", (data) => sendChunk(data, "stdout"));
      if (child.stderr) child.stderr.on("data", (data) => sendChunk(data, "stderr"));
      const code = await new Promise((resolve) => {
        child.on("close", resolve);
        child.on("error", (err) => {
          sendChunk(`\n--- Error: ${err.message} ---\n`, "system");
          resolve(null);
        });
      });
      return { success: code === 0, exitCode: code };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Parse YAML frontmatter from SKILL.md
  function parseSkillFrontmatter(text) {
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!match) return { name: basename(process.cwd()), description: "" };
    const frontmatter = match[1];
    const nameMatch = frontmatter.match(/^name\s*:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description\s*:\s*(.+)$/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : "",
      description: descMatch ? descMatch[1].trim() : "",
    };
  }

  async function readSkillsLock(lockPath) {
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf-8"));
      return parsed && typeof parsed === "object" && parsed.skills ? parsed.skills : {};
    } catch {
      return {};
    }
  }

  function toSkillSlug(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function normalizeLockSource(source) {
    if (!source || typeof source !== "string") return undefined;
    let value = source.trim();
    if (value.startsWith("https://github.com/")) value = value.replace("https://github.com/", "");
    value = value.replace(/\.git$/, "").toLowerCase();
    if (value.includes("github.com/")) value = value.split("github.com/").pop();
    return value;
  }

  // Scan filesystem for installed skills
  async function scanSkillsDir(dir, lockSkills = {}) {
    const skills = [];
    if (!dir || !existsSync(dir)) return skills;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return skills;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      try {
        const content = await readFile(skillMdPath, "utf-8");
        const { name, description } = parseSkillFrontmatter(content);
        const skillName = name || entry.name;
        const slug = toSkillSlug(skillName || entry.name);
        const lockEntry = lockSkills[skillName] || lockSkills[entry.name] || lockSkills[slug] || {};
        const source = normalizeLockSource(lockEntry.source);
        skills.push({
          name: skillName,
          slug,
          description,
          location: skillMdPath,
          content,
          source,
          remoteKey: source ? `${source}@${slug}` : undefined,
          sourceType: lockEntry.sourceType,
          sourceUrl: lockEntry.sourceUrl,
          skillPath: lockEntry.skillPath,
          skillFolderHash: lockEntry.skillFolderHash,
          computedHash: lockEntry.computedHash,
        });
      } catch {}
    }
    return skills;
  }

  ipcMain.handle("opencode:skills:list-installed", async (_event, directory) => {
    try {
      const projectLock = directory
        ? await readSkillsLock(join(directory, "skills-lock.json"))
        : {};
      const globalLock = await readSkillsLock(join(homedir(), ".agents", ".skill-lock.json"));
      const projectSkills = (
        await scanSkillsDir(directory ? join(directory, ".agents", "skills") : null, projectLock)
      ).map((skill) => ({ ...skill, scope: "project" }));
      const globalSkills = (
        await scanSkillsDir(join(homedir(), ".agents", "skills"), globalLock)
      ).map((skill) => ({ ...skill, scope: "global" }));
      const all = [...projectSkills, ...globalSkills];
      const seen = new Set();
      const deduped = [];
      for (const s of all) {
        const key = s.remoteKey || `${s.scope}:${s.location}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(s);
      }
      return { success: true, data: deduped };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}
