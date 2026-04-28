import { createServer } from "node:http";
import { PiBridgeManager } from "./pi-bridge.mjs";

const MAX_BODY_BYTES = 100 * 1024 * 1024;

const ALLOWED_METHODS = new Set([
	"addProject",
	"removeProject",
	"disconnect",
	"listSessions",
	"createSession",
	"deleteSession",
	"updateSession",
	"getSessionStatuses",
	"forkSession",
	"getProviders",
	"getAgents",
	"getCommands",
	"getMessages",
	"startSession",
	"prompt",
	"abort",
	"sendCommand",
	"summarizeSession",
	"findFiles",
]);

function parseArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
	return fallback;
}

function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

function ok(data) {
	return { success: true, data };
}

function fail(error) {
	return {
		success: false,
		error: error instanceof Error ? error.message : String(error),
	};
}

async function readJson(req) {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > MAX_BODY_BYTES) throw new Error("Request body too large");
	}
	if (!body.trim()) return {};
	return JSON.parse(body);
}

class EventHub {
	constructor() {
		this.clients = new Set();
	}

	add(res) {
		this.clients.add(res);
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		return () => {
			this.clients.delete(res);
		};
	}

	broadcast(event) {
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of this.clients) {
			try {
				client.write(payload);
			} catch {
				this.clients.delete(client);
			}
		}
	}
}

function makeManager(eventHub) {
	const fakeWindow = {
		isDestroyed: () => false,
		webContents: {
			send: (_channel, event) => eventHub.broadcast(event),
		},
	};
	return new PiBridgeManager(() => [fakeWindow]);
}

export async function runPiDaemon({ port, token } = {}) {
	const resolvedPort = Number(port ?? parseArg("--port", process.env.OPENGUI_PI_DAEMON_PORT ?? "0"));
	const resolvedToken = String(token ?? parseArg("--token", process.env.OPENGUI_PI_DAEMON_TOKEN ?? ""));
	if (!resolvedPort || !resolvedToken) {
		throw new Error("Pi daemon requires --port and --token");
	}

	const eventHub = new EventHub();
	const manager = makeManager(eventHub);

	const isAuthorized = (req) => req.headers["x-opengui-pi-token"] === resolvedToken;

	const server = createServer(async (req, res) => {
		try {
			if (!isAuthorized(req)) {
				json(res, 401, fail("Unauthorized"));
				return;
			}

			if (req.method === "GET" && req.url === "/health") {
				json(res, 200, ok({
					pid: process.pid,
					port: resolvedPort,
					daemonVersion: process.env.OPENGUI_PI_DAEMON_VERSION || "standalone",
				}));
				return;
			}

			if (req.method === "GET" && req.url?.startsWith("/events")) {
				const remove = eventHub.add(res);
				req.on("close", remove);
				return;
			}

			if (req.method === "POST" && req.url === "/rpc") {
				const body = await readJson(req);
				const method = body?.method;
				const args = Array.isArray(body?.args) ? body.args : [];
				if (!ALLOWED_METHODS.has(method) || typeof manager[method] !== "function") {
					json(res, 400, fail(`Unknown Pi daemon method: ${method}`));
					return;
				}
				const data = await manager[method](...args);
				json(res, 200, ok(data));
				return;
			}

			if (req.method === "POST" && req.url === "/shutdown") {
				await manager.disconnect();
				json(res, 200, ok(true));
				server.close(() => process.exit(0));
				return;
			}

			json(res, 404, fail("Not found"));
		} catch (error) {
			json(res, 500, fail(error));
		}
	});

	server.listen(resolvedPort, "127.0.0.1", () => {
		console.error(`[pi-daemon] listening on 127.0.0.1:${resolvedPort}`);
	});

	process.on("SIGTERM", () => {
		// Do not dispose sessions on parent app shutdown. Explicit /shutdown handles that.
		server.close(() => process.exit(0));
	});

	return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runPiDaemon().catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exit(1);
	});
}
