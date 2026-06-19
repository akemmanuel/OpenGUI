import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { HarnessEvent } from "../src/agents/backend.ts";
import type { HarnessId } from "../src/agents/index.ts";
import { composeFrontendSessionId } from "../src/lib/session-identity.ts";
import { publishLiveSessionHarnessEvent } from "./live-session-event-publish.ts";
import { publishProjectedTranscriptEvent } from "./projected-transcript-publish.ts";
import {
  BackendEventBus,
  createStorageService,
  PromptQueueService,
  SessionDispatchIndex,
  ensureSessionFromRuntime,
  findFilesInDirectory,
  resolveSessionRecordForMutation,
  resolveSessionRecordForRead,
  resolveTranscriptScopeForBridgeEvent,
  resolveCanonicalDirectoryInput,
  registerSharedSessionControl,
  toOptionalString,
  type BackendServiceContext,
  type SessionRecord,
} from "./services/index.ts";
import type { DirectoryScopeRef } from "@opengui/runtime";
import { queueScopeForSession, resolveSessionDirectoryScope } from "./services/directory-scope.ts";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createHarnessService,
  createRuntimeHost,
  getHarnessIdFromBridgeChannel,
  isManagedHarnessId,
  normalizeBridgeEvent,
  InProcessIpcMain,
  InProcessIpcSender,
  isWithinAllowedRoot,
  normalizeAllowedRoots,
  resolveSafeDirectory as resolveSafeDirectoryInRoots,
  createSessionTranscripts,
  isTranscriptProjectionInput,
  transcriptSessionId,
  type SessionTranscriptScope,
} from "@opengui/runtime";
import { registerShellIpcHandlers } from "./shell-ipc-handlers.ts";
import { registerProductApiRoutes } from "@opengui/backend";

interface SseClient {
  send: (payload: string, id?: string) => Promise<void>;
  close: () => Promise<void>;
}

function getCanonicalEventType(event: HarnessEvent): string {
  switch (event.type) {
    case "connection.status":
      return "project.connection.status";
    case "session.error":
      return "runtime.error";
    default:
      return event.type;
  }
}

function getBridgeEventRefs(event: HarnessEvent): {
  directory?: string;
  sessionId?: string;
  harnessId?: string;
} {
  switch (event.type) {
    case "connection.status":
      return { directory: event.directory };
    case "session.created":
    case "session.updated":
      return {
        directory: event.directory,
        sessionId: event.session.id,
      };
    case "session.replaced":
      return {
        directory: event.directory,
        sessionId: event.newId,
      };
    case "session.deleted":
      return {
        directory: event.directory,
        sessionId: event.sessionId,
      };
    case "message.updated":
      return { sessionId: event.message.sessionID };
    case "message.replaced":
      return { sessionId: event.sessionID };
    case "message.part.updated":
      return { sessionId: "sessionID" in event.part ? event.part.sessionID : undefined };
    case "message.part.delta":
    case "message.part.removed":
    case "message.removed":
    case "session.status":
    case "permission.cleared":
    case "question.cleared":
      return { sessionId: event.sessionID };
    case "permission.requested":
      return { sessionId: event.request.sessionID };
    case "question.requested":
      return { sessionId: event.request.sessionID };
    case "session.error":
      return { sessionId: event.sessionID };
    default:
      return {};
  }
}

function bridgeDirectoryHintFromRaw(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const directory = (data as { directory?: unknown }).directory;
  return typeof directory === "string" && directory.trim() ? directory.trim() : undefined;
}

async function ensureTranscriptProjectionHydrated(
  services: BackendServiceContext,
  input: { scope: SessionTranscriptScope; session: SessionRecord },
) {
  if (services.transcripts.isHydrated(input.scope)) return;
  await services.transcripts.readPage({
    scope: input.scope,
    fetchHarnessPage: () =>
      services.harnesses.listMessages({
        session: input.session,
        scope: {
          directory: input.scope.directory,
          harnessId: input.session.harnessId,
          sessionId: input.scope.sessionId,
        },
        options: {},
      }),
  });
}

async function createBackendServiceContext(
  ipcMain: InProcessIpcMain,
  sender: InProcessIpcSender,
  broadcast: (channel: string, data: unknown) => void,
): Promise<BackendServiceContext> {
  const dataDir = resolve(
    process.env.OPENGUI_DATA_DIR || join(homedir(), ".config", "OpenGUI-web"),
  );
  await mkdir(dataDir, { recursive: true });

  const storage = await createStorageService(dataDir);
  const events = new BackendEventBus();
  const sessions = new SessionDispatchIndex(storage, events);
  const runtimeHost = createRuntimeHost({ ipcMain, sender, dataDir, broadcast });
  const servicesStub: Partial<BackendServiceContext> & {
    dataDir: string;
    storage: Awaited<ReturnType<typeof createStorageService>>;
    events: BackendEventBus;
    sessions: SessionDispatchIndex;
    transcripts: ReturnType<typeof createSessionTranscripts>;
  } = {
    dataDir,
    storage,
    events,
    sessions,
    transcripts: createSessionTranscripts(),
  };
  const harnesses = createHarnessService({
    invoke: <T>(channel: string, args: unknown[] = []) =>
      ipcMain.invoke(channel, { sender }, args) as Promise<T>,
    controls: runtimeHost.controls,
    managedHarnessIds: runtimeHost.managedHarnessIds,
    events,
  });
  servicesStub.harnesses = harnesses;
  servicesStub.restartHarness = (harnessId: string) => harnesses.restartHarness(harnessId);
  servicesStub.restartAllHarnesses = () => harnesses.restartAllHarnesses();
  const queues = new PromptQueueService(
    servicesStub as BackendServiceContext,
    resolveSafeDirectory,
  );
  servicesStub.queues = queues;

  const services = servicesStub as BackendServiceContext;
  registerSharedSessionControl({ services, resolveSafeDirectory });
  return services;
}

const rawClients = new Set<SseClient>();
const canonicalClients = new Set<SseClient>();
let servicesReady!: Promise<BackendServiceContext>;

function formatSseMessage(payload: string, id?: string) {
  const lines = payload.split(/\r?\n/).map((line) => `data: ${line}`);
  return `${id ? `id: ${id}\n` : ""}${lines.join("\n")}\n\n`;
}

function createSseResponse(
  signal: AbortSignal,
  register: (client: SseClient) => void | Promise<void>,
  unregister: (client: SseClient) => void,
) {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  let pendingWrite = Promise.resolve();
  const client: SseClient = {
    send: async (payload: string, id?: string) => {
      pendingWrite = pendingWrite.then(() =>
        writer.write(encoder.encode(formatSseMessage(payload, id))),
      );
      await pendingWrite;
    },
    close: async () => {
      await pendingWrite.catch(() => undefined);
      await writer.close();
    },
  };

  const cleanup = () => {
    unregister(client);
    void client.close().catch(() => undefined);
  };

  signal.addEventListener("abort", cleanup, { once: true });
  void register(client);
  void client.send(JSON.stringify({ ok: true, connected: true })).catch(() => undefined);

  return new Response(stream.readable, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

const broadcast = (channel: string, data: unknown) => {
  const payload = JSON.stringify({ channel, data });
  for (const client of rawClients) void client.send(payload).catch(() => rawClients.delete(client));

  const harnessId = getHarnessIdFromBridgeChannel(channel);
  if (!harnessId) return;
  let normalizedEvent: ReturnType<typeof normalizeBridgeEvent>;
  try {
    normalizedEvent = normalizeBridgeEvent({ harnessId, event: data });
  } catch (error) {
    const eventType =
      typeof data === "object" && data !== null && "type" in data
        ? String((data as { type?: unknown }).type)
        : "unknown";
    console.error("[bridge] failed to normalize harness event", { harnessId, eventType, error });
    return;
  }
  if (!normalizedEvent) return;

  if (!servicesReady) return;
  void servicesReady.then(async (services) => {
    await applyCanonicalEventSideEffects(services, harnessId, normalizedEvent);

    if (!isTranscriptProjectionInput(normalizedEvent)) {
      services.events.publish(getCanonicalEventType(normalizedEvent), normalizedEvent, {
        ...getBridgeEventRefs(normalizedEvent),
        harnessId,
      });
      return;
    }

    const transcriptContext = await resolveTranscriptScopeForBridgeEvent(
      services,
      harnessId,
      normalizedEvent,
      resolveSafeDirectory,
      bridgeDirectoryHintFromRaw(data),
    );
    if (!transcriptContext) {
      const bridgeDirectory = bridgeDirectoryHintFromRaw(data);
      services.events.publish(getCanonicalEventType(normalizedEvent), normalizedEvent, {
        ...getBridgeEventRefs(normalizedEvent),
        harnessId,
        ...(bridgeDirectory ? { directory: bridgeDirectory } : {}),
      });
      if (normalizedEvent.type !== "session.status") {
        console.warn("[transcript] published canonical fallback for unscoped transcript event", {
          harnessId,
          type: normalizedEvent.type,
          sessionId: transcriptSessionId(normalizedEvent),
        });
      }
      return;
    }

    const livePublished = publishLiveSessionHarnessEvent(services, {
      directory: transcriptContext.scope.directory,
      harnessId,
      event: normalizedEvent,
    });

    if (
      normalizedEvent.type === "session.status" &&
      (livePublished.length === 0 || normalizedEvent.status?.type === "retry")
    ) {
      services.events.publish(getCanonicalEventType(normalizedEvent), normalizedEvent, {
        ...getBridgeEventRefs(normalizedEvent),
        harnessId,
        directory: transcriptContext.scope.directory,
      });
    }

    try {
      await ensureTranscriptProjectionHydrated(services, transcriptContext);
    } catch (error) {
      console.warn("[transcript] failed to hydrate projection before live event", {
        harnessId,
        type: normalizedEvent.type,
        sessionId: transcriptSessionId(normalizedEvent),
        error,
      });
    }

    for (const projected of services.transcripts.ingest({
      scope: transcriptContext.scope,
      event: normalizedEvent,
    })) {
      publishProjectedTranscriptEvent(services, projected);
    }
  });
};

async function applyCanonicalEventSideEffects(
  services: BackendServiceContext,
  harnessId: HarnessId,
  event: HarnessEvent,
) {
  try {
    if ((event.type === "session.created" || event.type === "session.updated") && event.session) {
      await ensureSessionFromRuntime({
        sessions: services.sessions,
        runtimeSession: event.session,
        directory: event.directory,
        harnessId,
      });
      return;
    }

    if (event.type === "session.replaced") {
      const oldWire = composeFrontendSessionId(harnessId, event.oldId);
      const newWire = composeFrontendSessionId(harnessId, event.newId);
      await services.storage.migratePromptQueueSessionId(oldWire, newWire);
      await services.sessions.deleteSession(oldWire, {
        directory: event.directory,
        harnessId,
      });
      await ensureSessionFromRuntime({
        sessions: services.sessions,
        runtimeSession: event.session,
        directory: event.directory,
        harnessId,
      });
      return;
    }

    if (event.type === "session.status") {
      const status =
        event.status?.type === "busy" || event.status?.type === "running"
          ? "running"
          : event.status?.type === "idle"
            ? "idle"
            : event.status?.type === "error"
              ? "error"
              : undefined;
      if (!status) return;
      await services.sessions.updateSession(event.sessionID, { status }, { harnessId });
      return;
    }

    if (event.type === "session.error") {
      if (!event.sessionID) return;
      await services.sessions.updateSession(event.sessionID, { status: "error" }, { harnessId });
    }
  } catch {
    // Keep SSE delivery independent from the REST session-index cache.
  }
}

const ipcMain = new InProcessIpcMain();
const sender = new InProcessIpcSender(broadcast);
servicesReady = createBackendServiceContext(ipcMain, sender, broadcast);
const ready = servicesReady.then(async (services) => {
  services.events.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const client of canonicalClients) {
      void client.send(payload, event.id).catch(() => canonicalClients.delete(client));
    }
  });
  registerShellIpcHandlers({ ipcMain, broadcast, services });
});

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";
const serverMode = (process.env.OPENGUI_SERVER_MODE || process.env.OPENGUI_MODE || "combined")
  .trim()
  .toLowerCase();
const servesFrontend = !["api", "api-only", "backend", "backend-only"].includes(serverMode);
const authToken = process.env.OPENGUI_AUTH_TOKEN?.trim() || "";
const allowedCorsOrigin = process.env.OPENGUI_CORS_ORIGIN?.trim() || "*";

function parseAllowedRoots() {
  const raw = process.env.OPENGUI_ALLOWED_ROOTS || homedir();
  return normalizeAllowedRoots(raw.split(","));
}

const allowedRoots = parseAllowedRoots();

function parsePositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const uploadMaxFileBytes = parsePositiveIntegerEnv(
  "OPENGUI_UPLOAD_MAX_FILE_BYTES",
  100 * 1024 * 1024,
);
const uploadMaxBatchBytes = parsePositiveIntegerEnv(
  "OPENGUI_UPLOAD_MAX_BATCH_BYTES",
  500 * 1024 * 1024,
);

function getRequestToken(request: Request) {
  const header = request.headers.get("authorization") || request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return new URL(request.url).searchParams.get("token")?.trim() || "";
}

function isAuthorizedRequest(request: Request) {
  if (!authToken) return true;
  return getRequestToken(request) === authToken;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": allowedCorsOrigin,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  };
}

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unauthorizedResponse() {
  return withCors(
    Response.json(
      { ok: false, error: "Unauthorized", code: "AUTH_REQUIRED", recoverable: true },
      { status: 401 },
    ),
  );
}

function optionsResponse() {
  return withCors(new Response(null, { status: 204 }));
}

async function resolveSafeDirectory(inputPath: string | null) {
  try {
    return await resolveSafeDirectoryInRoots(inputPath, allowedRoots);
  } catch (error) {
    if (error instanceof Error && error.message === "Path outside allowedRoots") {
      throw new Error("Path outside OPENGUI_ALLOWED_ROOTS");
    }
    throw error;
  }
}

async function listServerDirectories(inputPath: string | null) {
  const path = await resolveSafeDirectory(inputPath);
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name), type: "dir" as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  const canGoUp = isWithinAllowedRoot(parent, allowedRoots);
  return { path, parent: canGoUp ? parent : null, roots: allowedRoots, entries: dirs };
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function serveBuiltFile(request: Request) {
  const url = new URL(request.url);
  const requestedPath = decodeURIComponent(url.pathname);
  const safePath = requestedPath.includes("..") ? "/index.html" : requestedPath;
  const distPath = resolve("dist", safePath === "/" ? "index.html" : safePath.slice(1));
  const distRoot = resolve("dist");
  const filePath =
    distPath.startsWith(distRoot) && existsSync(distPath) ? distPath : join(distRoot, "index.html");
  return new Response(await readFile(filePath), {
    headers: { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" },
  });
}

async function serveDevIndex() {
  const filePath = resolve("src", "index.html");
  return new Response(await readFile(filePath), {
    headers: { "content-type": contentTypes[extname(filePath)] ?? "text/html; charset=utf-8" },
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rpcErrorCode(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("not available") || message.includes("not found"))
    return "BACKEND_UNAVAILABLE";
  if (message.includes("auth") || message.includes("login")) return "AUTH_REQUIRED";
  if (message.includes("permission") || message.includes("denied")) return "PERMISSION_DENIED";
  if (message.includes("timeout") || message.includes("timed out")) return "BACKEND_TIMEOUT";
  return "UNKNOWN";
}

function normalizeRpcArgs(channel: string, args: unknown[]) {
  // OpenCode resource RPCs are directory-aware. In web mode the app can ask for
  // models/providers before a project is selected; without a directory the bridge
  // returns "No connection available", so the model selector stays hidden.
  if (
    (channel === "opencode:providers" ||
      channel === "opencode:agents" ||
      channel === "opencode:commands" ||
      channel === "opencode:provider:list" ||
      channel === "opencode:provider:auth-methods") &&
    (typeof args[0] !== "string" || !args[0].trim())
  ) {
    return [allowedRoots[0] || homedir(), args[1], ...args.slice(2)];
  }
  return args;
}

function logRpc(channel: string, startedAt: number, ok: boolean, error?: unknown) {
  const durationMs = Date.now() - startedAt;
  const status = ok ? "ok=true" : `ok=false code=${rpcErrorCode(error)}`;
  console.info(`[rpc] channel=${channel || "<missing>"} duration=${durationMs}ms ${status}`);
}

function jsonError(error: unknown, status = 500) {
  const message = getErrorMessage(error);
  return Response.json(
    { ok: false, error: message, code: rpcErrorCode(error), recoverable: status < 500 },
    { status },
  );
}

async function getSessionDirectoryScopeOrThrow(
  _services: BackendServiceContext,
  session: SessionRecord,
): Promise<DirectoryScopeRef> {
  return await resolveSessionDirectoryScope({
    session,
    resolveSafeDirectory,
  });
}

async function sessionQueueScope(session: SessionRecord) {
  const canonicalDirectory = await resolveSessionDirectoryScope({
    session,
    resolveSafeDirectory,
  }).then((p) => p.canonicalPath);
  return queueScopeForSession(session, canonicalDirectory);
}

async function getSessionForRead(
  services: BackendServiceContext,
  sessionId: string,
  scope: { directory?: string; harnessId?: HarnessId } = {},
): Promise<SessionRecord> {
  return await resolveSessionRecordForRead({
    services,
    sessionId,
    scope,
    resolveSafeDirectory,
  });
}

async function getSessionOrThrow(
  services: BackendServiceContext,
  sessionId: string,
  scope: { directory?: string; harnessId?: HarnessId } = {},
): Promise<SessionRecord> {
  return await resolveSessionRecordForMutation({
    services,
    sessionId,
    scope,
    resolveSafeDirectory,
  });
}

async function resolvePermissionSessionScope(
  services: BackendServiceContext,
  body: Record<string, unknown>,
): Promise<{ session: SessionRecord; scopeRef: DirectoryScopeRef }> {
  const sessionId = toOptionalString(body.sessionId, "sessionId");
  if (!sessionId) throw new Error("sessionId and response are required");
  const harnessId =
    (toOptionalString(body.harnessId, "harnessId") as HarnessId | undefined) ?? undefined;
  const directory =
    toOptionalString(body.directory, "directory") ??
    toOptionalString(body.projectId, "projectId") ??
    undefined;

  const session = await getSessionOrThrow(services, sessionId, {
    directory,
    harnessId,
  });
  return {
    session,
    scopeRef: await getSessionDirectoryScopeOrThrow(services, session),
  };
}

async function resolveHarnessDirectoryForSessions(input: {
  directory: string;
}): Promise<{ directory: string; canonicalPath: string }> {
  return await resolveCanonicalDirectoryInput(input.directory, resolveSafeDirectory, realpath);
}

function parseSessionScopeFromUrl(url: URL): {
  directory?: string;
  harnessId?: HarnessId;
} {
  const directory =
    url.searchParams.get("directory")?.trim() ||
    url.searchParams.get("projectId")?.trim() ||
    undefined;
  const harnessIdRaw = url.searchParams.get("harnessId");
  const harnessId = harnessIdRaw && isManagedHarnessId(harnessIdRaw) ? harnessIdRaw : undefined;
  return { directory, harnessId };
}

const apiRouteDeps = {
  getServices: () => servicesReady,
  resolveSafeDirectory,
  resolveHarnessDirectoryForSessions,
  parseSessionScopeFromUrl,
  getSessionDirectoryScopeOrThrow,
  sessionQueueScope,
  getSessionForRead,
  getSessionOrThrow,
  resolvePermissionSessionScope,
};

const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    c.res = optionsResponse();
    return;
  }

  await next();
  c.res = withCors(c.res ?? new Response("Not found", { status: 404 }));
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") {
    await next();
    return;
  }

  if (!isAuthorizedRequest(c.req.raw)) {
    c.res = unauthorizedResponse();
    return;
  }

  await next();
});

registerProductApiRoutes(app, apiRouteDeps);

app.get("/api/events", (c) =>
  createSseResponse(
    c.req.raw.signal,
    (client) => {
      rawClients.add(client);
    },
    (client) => {
      rawClients.delete(client);
    },
  ),
);
app.get("/api/events/v2", async (c) =>
  createSseResponse(
    c.req.raw.signal,
    async (client) => {
      canonicalClients.add(client);
      const services = await servicesReady;
      const cursor =
        c.req.query("cursor") || c.req.header("last-event-id") || c.req.header("Last-Event-ID");
      if (cursor) {
        for (const event of services.events.listEventsAfter(cursor)) {
          await client.send(JSON.stringify(event), event.id);
        }
      }
    },
    (client) => {
      canonicalClients.delete(client);
    },
  ),
);
app.post("/api/rpc", async (c) => {
  const startedAt = Date.now();
  let channel = "";
  await ready;
  try {
    const body = await c.req.raw.json();
    channel = String(body?.channel ?? "");
    const rawArgs = Array.isArray(body?.args) ? body.args : [];
    const args = normalizeRpcArgs(channel, rawArgs);
    const value =
      channel === "files:find"
        ? await findFilesInDirectory(
            await resolveSafeDirectory(typeof args[0] === "string" ? args[0] : ""),
            typeof args[1] === "string" ? args[1] : "",
          )
        : await ipcMain.invoke(channel, { sender }, args);
    logRpc(channel, startedAt, true);
    return Response.json({ ok: true, value });
  } catch (error) {
    logRpc(channel, startedAt, false, error);
    return jsonError(error);
  }
});
app.get("/api/fs/list", async (c) => {
  try {
    return Response.json({
      ok: true,
      value: await listServerDirectories(c.req.query("path") ?? null),
    });
  } catch (error) {
    return jsonError(error, 400);
  }
});
app.get("/api/fs/roots", () => Response.json({ ok: true, value: allowedRoots }));
app.get("/api/fs/file", async (c) => {
  try {
    const inputPath = c.req.query("path")?.trim();
    if (!inputPath) throw new Error("path is required");
    const directory = c.req.query("directory")?.trim() || null;
    const requestedPath = inputPath.startsWith("/")
      ? inputPath
      : join(await resolveSafeDirectory(directory), inputPath);
    const actual = await realpath(requestedPath);
    const allowed = allowedRoots.some((root) => actual === root || actual.startsWith(`${root}/`));
    if (!allowed) throw new Error("Path outside OPENGUI_ALLOWED_ROOTS");
    const info = await stat(actual);
    if (!info.isFile()) throw new Error("Path is not a file");
    return new Response(await readFile(actual), {
      headers: {
        "content-type": contentTypes[extname(actual).toLowerCase()] ?? "application/octet-stream",
      },
    });
  } catch (error) {
    return jsonError(error, 400);
  }
});
app.get("/api/fs/search", async (c) => {
  try {
    const directoryParam =
      c.req.query("directory")?.trim() || c.req.query("projectId")?.trim() || "";
    const query = c.req.query("query") ?? "";
    const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
    if (!directoryParam) throw new Error("directory is required");
    const searchDirectory = (
      await resolveHarnessDirectoryForSessions({ directory: directoryParam })
    ).canonicalPath;
    const files = await findFilesInDirectory(searchDirectory, query);
    return Response.json({ ok: true, value: files.slice(0, limit) });
  } catch (error) {
    return jsonError(error, 400);
  }
});
app.post("/api/fs/upload", async (c) => {
  try {
    const form = await c.req.raw.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    if (files.length === 0) throw new Error("At least one file is required");
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > uploadMaxBatchBytes) throw new Error("Upload batch exceeds size limit");
    for (const file of files) {
      if (file.size > uploadMaxFileBytes) throw new Error("File exceeds size limit");
    }

    const dir = join(tmpdir(), "opengui-uploads");
    await mkdir(dir, { recursive: true });

    const uploaded: string[] = [];
    for (const file of files) {
      const originalName = typeof file.name === "string" ? basename(file.name) : "file";
      const extension = extname(originalName)
        .replace(/[^a-zA-Z0-9.]/g, "")
        .slice(0, 24);
      const filePath = join(dir, `${randomUUID()}${extension}`);
      await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
      uploaded.push(filePath);
    }

    return Response.json({ ok: true, value: uploaded });
  } catch (error) {
    return jsonError(error, 400);
  }
});
app.get("/api/health", () =>
  Response.json({
    ok: true,
    mode: serverMode,
    servesFrontend,
    allowedRoots,
    authRequired: Boolean(authToken),
  }),
);
app.all("/api/*", () => new Response("Not found", { status: 404 }));
app.all("*", async (c) => {
  if (!servesFrontend) {
    return Response.json(
      { ok: false, error: "OpenGUI Backend is running in API-only mode" },
      { status: 404 },
    );
  }
  if (isProduction) return await serveBuiltFile(c.req.raw);
  return await serveDevIndex();
});

serve(
  {
    fetch: app.fetch,
    hostname,
    port,
    overrideGlobalObjects: false,
  },
  () => {
    console.info(
      `OpenGUI ${servesFrontend ? "combined" : "API-only"} running at http://${hostname}:${port}`,
    );
  },
);
