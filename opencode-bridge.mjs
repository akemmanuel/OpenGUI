/**
 * ESM bridge module loaded by main.cjs via dynamic import().
 * Hosts OpenCodeConnection instances (one per project) and wires IPC handlers.
 *
 * This file MUST be .mjs so Electron's Node runtime treats it as ESM,
 * allowing us to import the ESM-only @opencode-ai/sdk.
 *
 * Uses v2 SDK which supports variant selection and named parameters.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Agent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

// ---------------------------------------------------------------------------
// Local server management
// ---------------------------------------------------------------------------

const LOCAL_SERVER_PORT = 4096;
const LOCAL_SERVER_URL = `http://127.0.0.1:${LOCAL_SERVER_PORT}`;
const STARTUP_POLL_INTERVAL = 500; // ms
const STARTUP_TIMEOUT = 15_000; // ms

/** Resolve the opencode binary path (cross-platform). */
function resolveOpencodeBinary() {
	const isWindows = process.platform === "win32";
	const whichCmd = isWindows ? "where opencode" : "which opencode";
	try {
		const fromPath = execSync(whichCmd, { encoding: "utf-8" })
			.split(/\r?\n/)[0]
			.trim();
		if (fromPath) return fromPath;
	} catch {
		// not on PATH
	}
	const binaryName = isWindows ? "opencode.exe" : "opencode";
	const fallback = join(homedir(), ".opencode", "bin", binaryName);
	if (existsSync(fallback)) return fallback;
	return null;
}

/** Quick health check against the local server. */
async function isLocalServerHealthy() {
	try {
		const res = await fetch(`${LOCAL_SERVER_URL}/global/health`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return false;
		const data = await res.json();
		return data.healthy === true;
	} catch {
		return false;
	}
}

/** Poll until healthy or timeout. */
function waitForHealthy(timeoutMs = STARTUP_TIMEOUT) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = async () => {
			if (await isLocalServerHealthy()) return resolve(true);
			if (Date.now() - start > timeoutMs) {
				return reject(
					new Error(
						`Server did not become healthy within ${timeoutMs / 1000}s`,
					),
				);
			}
			setTimeout(check, STARTUP_POLL_INTERVAL);
		};
		check();
	});
}

// ---------------------------------------------------------------------------
// URL safety helpers
// ---------------------------------------------------------------------------

/** Only allow http:// for local addresses; require https:// for everything else. */
function isBaseUrlSafe(rawUrl) {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol === "https:") return true;
		if (parsed.protocol === "http:") {
			const host = parsed.hostname;
			return (
				host === "127.0.0.1" ||
				host === "localhost" ||
				host === "[::1]" ||
				host === "0.0.0.0"
			);
		}
		return false;
	} catch {
		return false;
	}
}

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
		if (!isBaseUrlSafe(config.baseUrl)) {
			throw new Error(
				"Unsafe server URL: use HTTPS for remote servers, or HTTP only for localhost/127.0.0.1",
			);
		}
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
			this._startSSE(lifecycle);
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
		const res = await this._client.session.list({
			roots: true,
			limit: 10000,
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

	async getMessages(sessionId) {
		this._requireClient();
		const res = await this._client.session.messages({ sessionID: sessionId });
		return res.data ?? [];
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

	// - internal -------------------------------------------------------------

	_requireClient() {
		if (!this._client) throw new Error("Not connected to any opencode server");
	}

	_makeClient(config) {
		const headers = {};
		if (config.password) {
			const user = config.username ?? "opencode";
			headers.Authorization = `Basic ${Buffer.from(`${user}:${config.password}`).toString("base64")}`;
		}
		const directory =
			typeof config.directory === "string" ? config.directory.trim() : "";

		// Custom fetch that uses keep-alive agents to prevent idle connection drops.
		const customFetch = (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const agent = url?.startsWith("https") ? httpsAgent : httpAgent;
			return globalThis.fetch(input, { ...init, agent });
		};

		return createOpencodeClient({
			baseUrl: config.baseUrl.replace(/\/+$/, ""),
			headers,
			fetch: customFetch,
			...(directory ? { directory } : {}),
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
			const headers = {};
			if (this._config.password) {
				const user = this._config.username ?? "opencode";
				headers.Authorization = `Basic ${Buffer.from(`${user}:${this._config.password}`).toString("base64")}`;
			}
			const rawRes = await fetch(url, { headers });
			if (!rawRes.ok)
				throw new Error(
					`Health check failed: ${rawRes.status} ${rawRes.statusText}`,
				);
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
			const events = await this._client.event.subscribe({
				signal: abortController.signal,
				// Disable SDK-level retry - we handle reconnection at the app level
				// with our own backoff. Without this, the SDK silently retries with
				// exponential backoff (3s/6s/12s/24s/30s) and the app has no
				// visibility into the disconnect.
				sseMaxRetryAttempts: 1,
				onSseError: (err) =>
					console.warn("[OpenCodeConnection] SDK SSE error:", err),
			});

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

			// Stream ended cleanly (server closed the connection).
			// Reconnect unless we intentionally aborted.
			if (
				!abortController.signal.aborted &&
				this._streamGeneration === streamGeneration
			) {
				console.warn(
					"[OpenCodeConnection] SSE stream ended cleanly, reconnecting...",
				);
				this._scheduleReconnect(lifecycle);
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
		const delay =
			BACKOFF_STEPS[Math.min(this._reconnectAttempt, BACKOFF_STEPS.length - 1)];
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
				this._startSSE(lifecycle);
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
					lastEvent &&
					Date.now() - lastEvent > SSE_STALE_THRESHOLD &&
					this._status.state === "connected"
				) {
					console.warn(
						"[OpenCodeConnection] SSE stream appears stale, restarting...",
					);
					// Abort the old stream and wait briefly for it to unwind
					// before starting a fresh one to avoid overlapping streams.
					this._abortController?.abort();
					await new Promise((r) => setTimeout(r, 100));
					this._startSSE(lifecycle);
				}
			} catch {
				// Server unreachable - actively trigger reconnect instead of
				// waiting for the SSE stream to eventually break on its own.
				if (this._status.state === "connected") {
					console.warn(
						"[OpenCodeConnection] Health check failed while connected, reconnecting...",
					);
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
// Setup: called from main.cjs with (ipcMain, mainWindow)
// ---------------------------------------------------------------------------

export function setupOpenCodeBridge(ipcMain, getMainWindow) {
	/** @type {Map<string, OpenCodeConnection>} directory -> connection */
	const connections = new Map();

	/** Map sessionId -> directory for routing session-specific operations */
	const sessionDirectoryMap = new Map();

	function sendEvent(event) {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send("opencode:bridge-event", event);
		}
	}

	function createConnection(directory) {
		const conn = new OpenCodeConnection((event) => {
			if (connections.get(directory) !== conn) return;
			// Tag every event with the directory it came from
			sendEvent({ ...event, directory });
		});
		connections.set(directory, conn);
		return conn;
	}

	/** Find which connection owns a session by looking up the cache. */
	function getConnectionForSession(sessionId) {
		const dir = sessionDirectoryMap.get(sessionId);
		if (dir) {
			const conn = connections.get(dir);
			if (conn) return conn;
		}
		// No fallback -- routing to an arbitrary connection is dangerous in
		// multi-project mode and can send operations to the wrong backend.
		return null;
	}

	/** Get any connected connection (for global operations like providers/agents). */
	function getAnyConnection() {
		for (const conn of connections.values()) {
			if (conn.getStatus().state === "connected") return conn;
		}
		return null;
	}

	// --- Project management ---

	ipcMain.handle("opencode:project:add", async (_event, config) => {
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
		try {
			// Tear down existing connection for this directory if any
			const existing = connections.get(directory);
			if (existing) {
				existing.teardown();
				connections.delete(directory);
			}
			const conn = createConnection(directory);
			await conn.connect(config);
			return { success: true, status: conn.getStatus() };
		} catch (err) {
			if (connections.get(directory)) {
				connections.delete(directory);
			}
			return { success: false, error: err.message ?? String(err) };
		}
	});

	ipcMain.handle("opencode:project:remove", (_event, directory) => {
		if (typeof directory !== "string" || !directory.trim()) {
			return { success: false, error: "Directory is required" };
		}
		const conn = connections.get(directory);
		if (conn) {
			conn.teardown();
			connections.delete(directory);
			// Clean up session mappings for this directory
			for (const [sid, dir] of sessionDirectoryMap) {
				if (dir === directory) sessionDirectoryMap.delete(sid);
			}
		}
		return { success: true };
	});

	ipcMain.handle("opencode:disconnect", () => {
		for (const conn of connections.values()) {
			conn.teardown();
		}
		connections.clear();
		sessionDirectoryMap.clear();
		return { success: true };
	});

	// --- Session operations ---

	ipcMain.handle("opencode:session:list", async (_event, directory) => {
		try {
			if (directory) {
				// List sessions for a specific project
				const conn = connections.get(directory);
				if (!conn) return { success: false, error: "Project not connected" };
				// The server already scopes sessions to this project via the
				// x-opencode-directory header, so we don't need to filter by
				// directory string (which can differ due to symlinks, trailing
				// slashes, etc.). Instead we tag each session with _projectDir
				// so the UI can group them by connection directory.
				const sessions = (await conn.listSessions()).map((s) => ({
					...s,
					_projectDir: directory,
				}));
				// Cache session->directory mappings
				for (const s of sessions) {
					sessionDirectoryMap.set(s.id, directory);
				}
				return { success: true, data: sessions };
			}
			// List sessions from ALL projects
			const allSessions = [];
			for (const [dir, conn] of connections) {
				try {
					const sessions = (await conn.listSessions()).map((s) => ({
						...s,
						_projectDir: dir,
					}));
					for (const s of sessions) {
						sessionDirectoryMap.set(s.id, dir);
					}
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

	ipcMain.handle(
		"opencode:session:create",
		async (_event, title, directory) => {
			try {
				const conn = directory
					? connections.get(directory)
					: getAnyConnection();
				if (!conn) return { success: false, error: "No connection available" };
				const session = await conn.createSession(title);
				if (session) {
					const dir = directory || conn.getDirectory();
					if (dir) sessionDirectoryMap.set(session.id, dir);
				}
				return { success: true, data: session };
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	ipcMain.handle("opencode:session:delete", async (_event, id) => {
		try {
			const conn = getConnectionForSession(id);
			if (!conn)
				return { success: false, error: "Session connection not found" };
			const result = await conn.deleteSession(id);
			sessionDirectoryMap.delete(id);
			return { success: true, data: result };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle("opencode:session:update", async (_event, id, title) => {
		try {
			const conn = getConnectionForSession(id);
			if (!conn)
				return { success: false, error: "Session connection not found" };
			const result = await conn.updateSession(id, title);
			return { success: true, data: result };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle("opencode:session:statuses", async (_event, directory) => {
		try {
			const conn = directory ? connections.get(directory) : getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			const statuses = await conn.getSessionStatuses();
			return { success: true, data: statuses };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle(
		"opencode:session:revert",
		async (_event, id, messageID, partID) => {
			try {
				const conn = getConnectionForSession(id);
				if (!conn)
					return { success: false, error: "Session connection not found" };
				const result = await conn.revertSession(id, messageID, partID);
				return { success: true, data: result };
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	ipcMain.handle("opencode:session:unrevert", async (_event, id) => {
		try {
			const conn = getConnectionForSession(id);
			if (!conn)
				return { success: false, error: "Session connection not found" };
			const result = await conn.unrevertSession(id);
			return { success: true, data: result };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle("opencode:session:fork", async (_event, id, messageID) => {
		try {
			const conn = getConnectionForSession(id);
			if (!conn)
				return { success: false, error: "Session connection not found" };
			const result = await conn.forkSession(id, messageID);
			// Register the new forked session in the directory map so future
			// operations can find the correct connection.
			if (result?.id) {
				const dir = [...connections.entries()].find(([, c]) => c === conn)?.[0];
				if (dir) sessionDirectoryMap.set(result.id, dir);
			}
			return { success: true, data: result };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- Providers / models (global - use any connection) ---

	ipcMain.handle("opencode:providers", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.getProviders() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- Provider management (global) ---

	ipcMain.handle("opencode:provider:list", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.listAllProviders() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle("opencode:provider:auth-methods", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.getProviderAuthMethods() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle(
		"opencode:provider:connect",
		async (_event, providerID, auth) => {
			try {
				const conn = getAnyConnection();
				if (!conn) return { success: false, error: "No connection available" };
				await conn.setProviderAuth(providerID, auth);
				return { success: true };
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	ipcMain.handle("opencode:provider:disconnect", async (_event, providerID) => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			await conn.removeProviderAuth(providerID);
			return { success: true };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle(
		"opencode:provider:oauth:authorize",
		async (_event, providerID, method) => {
			try {
				const conn = getAnyConnection();
				if (!conn) return { success: false, error: "No connection available" };
				return {
					success: true,
					data: await conn.oauthAuthorize(providerID, method),
				};
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	ipcMain.handle(
		"opencode:provider:oauth:callback",
		async (_event, providerID, method, code) => {
			try {
				const conn = getAnyConnection();
				if (!conn) return { success: false, error: "No connection available" };
				return {
					success: true,
					data: await conn.oauthCallback(providerID, method, code),
				};
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	ipcMain.handle("opencode:instance:dispose", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.disposeInstance() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- Agents (global) ---

	ipcMain.handle("opencode:agents", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.getAgents() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- Message operations (routed to session's connection) ---

	ipcMain.handle("opencode:messages", async (_event, sessionId) => {
		try {
			const conn = getConnectionForSession(sessionId);
			if (!conn)
				return { success: false, error: "Session connection not found" };
			return { success: true, data: await conn.getMessages(sessionId) };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle(
		"opencode:prompt",
		async (_event, sessionId, text, images, model, agent, variant) => {
			try {
				const conn = getConnectionForSession(sessionId);
				if (!conn)
					return { success: false, error: "Session connection not found" };
				await conn.promptAsync(sessionId, text, images, model, agent, variant);
				return { success: true };
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	ipcMain.handle("opencode:abort", async (_event, sessionId) => {
		try {
			const conn = getConnectionForSession(sessionId);
			if (!conn)
				return { success: false, error: "Session connection not found" };
			await conn.abortSession(sessionId);
			return { success: true };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- Permission response (routed to session's connection) ---

	ipcMain.handle(
		"opencode:permission",
		async (_event, sessionId, permissionId, response) => {
			try {
				const conn = getConnectionForSession(sessionId);
				if (!conn)
					return { success: false, error: "Session connection not found" };
				await conn.respondPermission(sessionId, permissionId, response);
				return { success: true };
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	// --- Question response (try all connections) ---

	ipcMain.handle(
		"opencode:question:reply",
		async (_event, requestID, answers) => {
			try {
				// Questions don't carry sessionId context in the IPC call,
				// try all connected connections
				let lastErr;
				for (const conn of connections.values()) {
					try {
						await conn.replyQuestion(requestID, answers);
						return { success: true };
					} catch (err) {
						lastErr = err;
					}
				}
				return {
					success: false,
					error: lastErr?.message ?? "No connection available",
				};
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	// --- Commands (global) ---

	ipcMain.handle("opencode:commands", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.listCommands() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle(
		"opencode:command:send",
		async (_event, sessionId, command, args, model, agent, variant) => {
			try {
				const conn = getConnectionForSession(sessionId);
				if (!conn)
					return { success: false, error: "Session connection not found" };
				await conn.sendCommand(sessionId, command, args, model, agent, variant);
				return { success: true };
			} catch (err) {
				return { success: false, error: err.message };
			}
		},
	);

	ipcMain.handle("opencode:question:reject", async (_event, requestID) => {
		try {
			let lastErr;
			for (const conn of connections.values()) {
				try {
					await conn.rejectQuestion(requestID);
					return { success: true };
				} catch (err) {
					lastErr = err;
				}
			}
			return {
				success: false,
				error: lastErr?.message ?? "No connection available",
			};
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- MCP operations (global) ---

	ipcMain.handle("opencode:mcp:status", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.getMcpStatus() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle("opencode:mcp:add", async (_event, name, config) => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.addMcp(name, config) };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle("opencode:mcp:connect", async (_event, name) => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			await conn.connectMcp(name);
			return { success: true };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle("opencode:mcp:disconnect", async (_event, name) => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			await conn.disconnectMcp(name);
			return { success: true };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- Config operations (global) ---

	ipcMain.handle("opencode:config:get", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.getConfig() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	ipcMain.handle("opencode:config:update", async (_event, config) => {
		try {
			if (!config || typeof config !== "object") {
				return { success: false, error: "Invalid config" };
			}
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.updateConfig(config) };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- Skills operations (global) ---

	ipcMain.handle("opencode:skills", async () => {
		try {
			const conn = getAnyConnection();
			if (!conn) return { success: false, error: "No connection available" };
			return { success: true, data: await conn.getSkills() };
		} catch (err) {
			return { success: false, error: err.message };
		}
	});

	// --- Local server management ---

	ipcMain.handle("opencode:server:start", async () => {
		try {
			// If already running, skip spawn
			if (await isLocalServerHealthy()) {
				return { success: true, data: { alreadyRunning: true } };
			}

			const binary = resolveOpencodeBinary();
			if (!binary) {
				return {
					success: false,
					error:
						"Could not find the opencode binary. Make sure it is installed at ~/.opencode/bin/opencode or available on your PATH.",
				};
			}

			// Spawn detached so the server survives app close
			const child = spawn(
				binary,
				["serve", "--port", String(LOCAL_SERVER_PORT)],
				{
					detached: true,
					stdio: "ignore",
					env: { ...process.env },
				},
			);

			child.unref();

			// If spawn itself errors (e.g. ENOENT)
			child.on("error", (err) => {
				console.error(
					"[opencode-bridge] Failed to spawn opencode server:",
					err,
				);
			});

			// Wait for the server to become healthy
			await waitForHealthy();
			return { success: true, data: { alreadyRunning: false } };
		} catch (err) {
			return { success: false, error: err.message ?? String(err) };
		}
	});

	ipcMain.handle("opencode:server:stop", async () => {
		try {
			// Check if server is actually running first
			if (!(await isLocalServerHealthy())) {
				return { success: true, data: { alreadyStopped: true } };
			}

			// Find the PID listening on the server port
			const isWindows = process.platform === "win32";
			let pid = null;

			if (isWindows) {
				try {
					const out = execSync(
						`netstat -ano | findstr :${LOCAL_SERVER_PORT} | findstr LISTENING`,
						{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
					);
					const match = out.trim().split(/\s+/).pop();
					if (match) pid = Number.parseInt(match, 10);
				} catch {
					// no process found
				}
			} else {
				try {
					const out = execSync(`lsof -ti tcp:${LOCAL_SERVER_PORT}`, {
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "ignore"],
					});
					const first = out.trim().split(/\s+/)[0];
					if (first) pid = Number.parseInt(first, 10);
				} catch {
					// no process found
				}
			}

			if (!pid || Number.isNaN(pid)) {
				return {
					success: false,
					error: `Could not find process on port ${LOCAL_SERVER_PORT}`,
				};
			}

			// Kill the process
			try {
				process.kill(pid, isWindows ? "SIGKILL" : "SIGTERM");
			} catch (killErr) {
				return {
					success: false,
					error: `Failed to kill process ${pid}: ${killErr.message}`,
				};
			}

			// Wait briefly for the process to die, then verify
			await new Promise((resolve) => setTimeout(resolve, 1000));
			const stillRunning = await isLocalServerHealthy();
			if (stillRunning) {
				// Force kill as fallback
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already dead or permission error
				}
				await new Promise((resolve) => setTimeout(resolve, 500));
				const stillAlive = await isLocalServerHealthy();
				if (stillAlive) {
					return {
						success: false,
						error: "Server process did not stop after SIGKILL",
					};
				}
			}

			return { success: true, data: { pid } };
		} catch (err) {
			return { success: false, error: err.message ?? String(err) };
		}
	});

	ipcMain.handle("opencode:server:status", async () => {
		try {
			const running = await isLocalServerHealthy();
			return { success: true, data: { running } };
		} catch (err) {
			return { success: false, error: err.message ?? String(err) };
		}
	});

	// --- Git helpers ---

	ipcMain.handle("git:is-repo", async (_event, directory) => {
		try {
			execSync("git rev-parse --git-dir", {
				cwd: directory,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			return { success: true, data: true };
		} catch {
			return { success: true, data: false };
		}
	});

	ipcMain.handle("git:branch:list", async (_event, directory) => {
		try {
			const raw = execSync('git branch -a --format="%(refname:short)"', {
				cwd: directory,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			});
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
			const branch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: directory,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return { success: true, data: branch };
		} catch (err) {
			return { success: false, error: err.message ?? String(err) };
		}
	});

	ipcMain.handle("git:worktree:list", async (_event, directory) => {
		try {
			const raw = execSync("git worktree list --porcelain", {
				cwd: directory,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			const worktrees = [];
			let current = {};
			for (const line of raw.split(/\r?\n/)) {
				if (line.startsWith("worktree ")) {
					if (current.path) worktrees.push(current);
					current = { path: line.slice("worktree ".length) };
				} else if (line.startsWith("HEAD ")) {
					current.head = line.slice("HEAD ".length);
				} else if (line.startsWith("branch ")) {
					// Convert refs/heads/main -> main
					current.branch = line
						.slice("branch ".length)
						.replace(/^refs\/heads\//, "");
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
				execSync(`git ${args.join(" ")}`, {
					cwd: directory,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				});
				return { success: true, data: { path: worktreePath } };
			} catch (err) {
				return { success: false, error: err.message ?? String(err) };
			}
		},
	);

	ipcMain.handle(
		"git:worktree:remove",
		async (_event, directory, worktreePath) => {
			try {
				execSync(`git worktree remove "${worktreePath}"`, {
					cwd: directory,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				});
				return { success: true };
			} catch (err) {
				return { success: false, error: err.message ?? String(err) };
			}
		},
	);

	ipcMain.handle("git:merge", async (_event, directory, branch) => {
		try {
			execSync(`git merge "${branch}" --no-edit`, {
				cwd: directory,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { success: true };
		} catch (err) {
			// Check if it's a merge conflict (vs other errors)
			try {
				const conflicted = execSync("git diff --name-only --diff-filter=U", {
					cwd: directory,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				})
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
			execSync("git merge --abort", {
				cwd: directory,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { success: true };
		} catch (err) {
			return { success: false, error: err.message ?? String(err) };
		}
	});

	ipcMain.handle("git:remote:url", async (_event, directory) => {
		try {
			const url = execSync("git remote get-url origin", {
				cwd: directory,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return { success: true, data: url };
		} catch (err) {
			return { success: false, error: err.message ?? String(err) };
		}
	});
}
