import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { HarnessEvent } from "../src/agents/backend.ts";
import type { HarnessId } from "../src/agents/index.ts";
import { composeFrontendSessionId } from "../src/lib/session-identity.ts";
import {
  BackendEventBus,
  compactSessionThroughHarness,
  createStorageService,
  PromptQueueService,
  SessionService,
  abortSessionThroughHarness,
  asSessionStatus,
  createDirectorySessionThroughHarness,
  deleteSessionThroughHarness,
  enqueueSessionPrompt,
  ensureSessionFromRuntime,
  findFilesInDirectory,
  forkSessionThroughHarness,
  getBackendCapabilities,
  getDirectoryHarnessStatus,
  listManagedHarnessDescriptors,
  listDirectorySessionQueues,
  listSessionMessagesThroughHarness,
  listSessionQueue,
  listSessionsForRequest,
  loadDirectoryHarnessResources,
  resolveSessionRecordForMutation,
  resolveSessionRecordForRead,
  resolveCanonicalDirectoryInput,
  readJsonBody,
  registerDirectoryWithHarnesses,
  rejectHarnessQuestion,
  registerSharedSessionControl,
  releaseDirectoryFromHarnesses,
  removeSessionPrompt,
  renameSessionThroughHarness,
  reorderSessionPrompt,
  replyToHarnessQuestion,
  respondToHarnessPermission,
  revertSessionThroughHarness,
  sendCommandThroughHarness,
  sendQueuedPromptNow,
  submitSessionPrompt,
  toOptionalNullableString,
  toOptionalSelectedModel,
  toOptionalString,
  toQuestionAnswers,
  toQueueMode,
  querySessionsFromFrontendProjects,
  unrevertSessionThroughHarness,
  updateSessionPrompt,
  updateSessionRecord,
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
} from "@opengui/runtime";
import { registerShellIpcHandlers } from "./shell-ipc-handlers.ts";

interface SseClient {
  send: (payload: string, id?: string) => Promise<void>;
  close: () => Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  const sessions = new SessionService(storage, events);
  const runtimeHost = createRuntimeHost({ ipcMain, sender, dataDir, broadcast });
  const servicesStub: Partial<BackendServiceContext> & {
    dataDir: string;
    storage: Awaited<ReturnType<typeof createStorageService>>;
    events: BackendEventBus;
    sessions: SessionService;
  } = {
    dataDir,
    storage,
    events,
    sessions,
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
    services.events.publish(getCanonicalEventType(normalizedEvent), normalizedEvent, {
      ...getBridgeEventRefs(normalizedEvent),
      harnessId,
    });
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

async function handleDirectoryRequest(request: Request) {
  const services = await servicesReady;
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/directories/")) return null;

  const subpath = pathname.slice("/api/directories/".length);
  const [directoryEncoded, child] = subpath.split("/");
  const directoryRaw = decodeURIComponent(directoryEncoded ?? "");
  if (!directoryRaw) return new Response("Not found", { status: 404 });

  try {
    const directory = (await resolveHarnessDirectoryForSessions({ directory: directoryRaw }))
      .canonicalPath;

    if (child === "register") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const harnessIds =
        isPlainObject(body) && Array.isArray(body.harnessIds)
          ? body.harnessIds.filter((value): value is HarnessId => typeof value === "string")
          : undefined;
      const config = isPlainObject(body) && isPlainObject(body.config) ? body.config : body;
      const rawBaseUrl = isPlainObject(config)
        ? toOptionalString(config.baseUrl, "baseUrl")
        : undefined;
      const harnessBaseUrl = rawBaseUrl
        ? new URL(rawBaseUrl).origin === url.origin
          ? `http://127.0.0.1:${process.env.OPENGUI_OPENCODE_PORT?.trim() || "4096"}`
          : rawBaseUrl
        : undefined;
      return Response.json({
        ok: true,
        value: await registerDirectoryWithHarnesses({
          services,
          directory,
          harnessIds,
          config: {
            directory,
            baseUrl: harnessBaseUrl,
            username: isPlainObject(config)
              ? toOptionalString(config.username, "username")
              : undefined,
            password: isPlainObject(config)
              ? toOptionalString(config.password, "password")
              : undefined,
          },
        }),
      });
    }

    if (child === "release") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const harnessIds =
        isPlainObject(body) && Array.isArray(body.harnessIds)
          ? body.harnessIds.filter((value): value is HarnessId => typeof value === "string")
          : undefined;
      await releaseDirectoryFromHarnesses({ services, directory, harnessIds });
      return Response.json({ ok: true, value: true });
    }

    if (child === "status") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
      return Response.json({
        ok: true,
        value: await getDirectoryHarnessStatus({ services, directory, harnessId }),
      });
    }

    if (child && ["providers", "models", "agents", "commands"].includes(child)) {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const harnessId = url.searchParams.get("harnessId") as HarnessId | null;
      if (!harnessId) return jsonError(new Error("harnessId is required"), 400);
      const resources = await loadDirectoryHarnessResources({
        services,
        directory,
        harnessId,
      });
      if (child === "providers") return Response.json({ ok: true, value: resources.providersData });
      if (child === "agents") return Response.json({ ok: true, value: resources.agentsData });
      if (child === "commands") return Response.json({ ok: true, value: resources.commandsData });
      const models = Array.isArray(resources.providersData?.providers)
        ? resources.providersData.providers.flatMap((provider) =>
            Object.entries(provider.models ?? {}).map(([modelId, model]) => ({
              ...model,
              providerID: provider.id,
              modelID: modelId,
            })),
          )
        : [];
      return Response.json({ ok: true, value: models });
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    return jsonError(error, 400);
  }
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

async function handleSessionRequest(request: Request) {
  const services = await servicesReady;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const sessionScope = parseSessionScopeFromUrl(url);

  if (pathname === "/api/sessions/query") {
    try {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const value = await querySessionsFromFrontendProjects({
        services,
        body,
        isHarnessId: isManagedHarnessId,
        resolveDirectory: (directory) => resolveHarnessDirectoryForSessions({ directory }),
      });
      return Response.json({ ok: true, value });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (pathname === "/api/queues") {
    try {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const directoryParam =
        url.searchParams.get("directory")?.trim() ||
        url.searchParams.get("projectId")?.trim() ||
        undefined;
      const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
      if (!directoryParam || !harnessId) {
        throw new Error("directory and harnessId are required");
      }
      const resolvedDirectory = (
        await resolveHarnessDirectoryForSessions({ directory: directoryParam })
      ).canonicalPath;
      return Response.json({
        ok: true,
        value: await listDirectorySessionQueues({
          services,
          directory: resolvedDirectory,
          harnessId,
        }),
      });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (pathname === "/api/sessions") {
    try {
      if (request.method === "GET") {
        const directory = url.searchParams.get("directory")?.trim() || undefined;
        const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
        const directoryParam =
          directory ?? (url.searchParams.get("projectId")?.trim() || undefined);
        return Response.json({
          ok: true,
          value: await listSessionsForRequest({
            services,
            directory: directoryParam,
            harnessId,
            resolveDirectory: (dir) => resolveHarnessDirectoryForSessions({ directory: dir }),
          }),
        });
      }

      if (request.method === "POST") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        const directory =
          toOptionalString(body.directory, "directory") ??
          toOptionalString(body.projectId, "projectId");
        const harnessId = toOptionalString(body.harnessId, "harnessId") as HarnessId | undefined;
        if (!harnessId) throw new Error("harnessId is required");
        if (!directory) throw new Error("directory is required");
        const resolvedDirectory = await resolveHarnessDirectoryForSessions({ directory });
        const session = await createDirectorySessionThroughHarness({
          services,
          ...resolvedDirectory,
          harnessId,
          title: toOptionalString(body.title, "title"),
        });
        return Response.json({ ok: true, value: session });
      }

      return new Response("Method Not Allowed", { status: 405 });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (!pathname.startsWith("/api/sessions/")) return null;
  const subpath = pathname.slice("/api/sessions/".length);
  const [sessionIdEncoded, child, grandchild, action] = subpath.split("/");
  const sessionId = decodeURIComponent(sessionIdEncoded ?? "");
  if (!sessionId) return new Response("Not found", { status: 404 });

  try {
    if (!child) {
      if (request.method === "GET") {
        return Response.json({
          ok: true,
          value: await getSessionForRead(services, sessionId, sessionScope),
        });
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        const existing = await getSessionOrThrow(services, sessionId, sessionScope);
        const scopeRef = await getSessionDirectoryScopeOrThrow(services, existing);
        const updated =
          typeof body.title === "string"
            ? await renameSessionThroughHarness({
                services,
                scopeRef,
                session: existing,
                title: body.title,
              })
            : await updateSessionRecord({
                services,
                sessionId,
                patch: {
                  title: toOptionalString(body.title, "title"),
                  status: asSessionStatus(body.status),
                  metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
                },
              });
        if (!updated) return jsonError(new Error("Session not found"), 404);
        return Response.json({ ok: true, value: updated });
      }
      if (request.method === "DELETE") {
        const existing = await getSessionOrThrow(services, sessionId, sessionScope);
        const qScope = await sessionQueueScope(existing);
        const queuedPrompts = await listSessionQueue({
          services,
          sessionId: existing.id,
          directory: qScope.directory,
          harnessId: qScope.harnessId,
        });
        const confirmedQueueDelete =
          url.searchParams.get("confirmQueue") === "1" ||
          url.searchParams.get("confirmQueue") === "true";
        if (queuedPrompts.length > 0 && !confirmedQueueDelete) {
          return jsonError(
            new Error("Session has queued prompts; confirmQueue=true is required"),
            409,
          );
        }
        await deleteSessionThroughHarness({
          services,
          scopeRef: await getSessionDirectoryScopeOrThrow(services, existing),
          session: existing,
        });
        return Response.json({ ok: true, value: true });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    const existing =
      child === "messages" && request.method === "GET"
        ? await getSessionForRead(services, sessionId, sessionScope)
        : await getSessionOrThrow(services, sessionId, sessionScope);
    const scopeRef = await getSessionDirectoryScopeOrThrow(services, existing);
    const qScope = await sessionQueueScope(existing);

    if (child === "queue") {
      if (!grandchild) {
        if (request.method === "GET") {
          return Response.json({
            ok: true,
            value: await listSessionQueue({
              services,
              sessionId,
              directory: qScope.directory,
              harnessId: qScope.harnessId,
            }),
          });
        }
        if (request.method === "POST") {
          const body = await readJsonBody(request);
          if (!isPlainObject(body) || typeof body.text !== "string") {
            throw new Error("text is required");
          }
          return Response.json({
            ok: true,
            value: await enqueueSessionPrompt({
              services,
              sessionId,
              text: body.text,
              model: toOptionalSelectedModel(body.model),
              agent: toOptionalString(body.agent, "agent"),
              variant: toOptionalString(body.variant, "variant"),
              mode: toQueueMode(body.mode, "queue"),
              insertAt: body.insertAt === "front" ? "front" : "back",
              directory: qScope.directory,
              harnessId: qScope.harnessId,
            }),
          });
        }
        return new Response("Method Not Allowed", { status: 405 });
      }

      const entryId = decodeURIComponent(grandchild);
      if (!entryId) return new Response("Not found", { status: 404 });

      if (action === "reorder") {
        if (request.method !== "PATCH") return new Response("Method Not Allowed", { status: 405 });
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || typeof body.index !== "number") {
          throw new Error("index is required");
        }
        return Response.json({
          ok: true,
          value: await reorderSessionPrompt({
            services,
            sessionId,
            entryId,
            index: body.index,
            directory: qScope.directory,
            harnessId: qScope.harnessId,
          }),
        });
      }

      if (action === "send-now") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
        return Response.json({
          ok: true,
          value: await sendQueuedPromptNow({
            services,
            scopeRef,
            session: existing,
            entryId,
          }),
        });
      }

      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        return Response.json({
          ok: true,
          value: await updateSessionPrompt({
            services,
            sessionId,
            entryId,
            text: toOptionalString(body.text, "text"),
            model: toOptionalSelectedModel(body.model),
            agent: toOptionalNullableString(body.agent, "agent"),
            variant: toOptionalNullableString(body.variant, "variant"),
            mode: toQueueMode(body.mode),
            directory: qScope.directory,
            harnessId: qScope.harnessId,
          }),
        });
      }

      if (request.method === "DELETE") {
        return Response.json({
          ok: true,
          value: await removeSessionPrompt({
            services,
            sessionId,
            entryId,
            directory: qScope.directory,
            harnessId: qScope.harnessId,
          }),
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    if (child === "messages") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const direction = url.searchParams.get("direction") || "older";
      const cursor = url.searchParams.get("cursor");
      const limit = url.searchParams.get("limit");
      return Response.json({
        ok: true,
        value: await listSessionMessagesThroughHarness({
          services,
          scopeRef,
          session: existing,
          options: {
            limit: limit ? Number(limit) : undefined,
            before: direction === "older" ? cursor : null,
          },
        }),
      });
    }

    if (child === "prompt") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      if (!isPlainObject(body) || typeof body.text !== "string")
        throw new Error("text is required");
      await submitSessionPrompt({
        services,
        scopeRef,
        session: existing,
        text: body.text,
        model: toOptionalSelectedModel(body.model),
        agent: toOptionalString(body.agent, "agent"),
        variant: toOptionalString(body.variant, "variant"),
        mode: toQueueMode(body.mode, "queue"),
      });
      return Response.json({ ok: true, value: true });
    }

    if (child === "command") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      if (!isPlainObject(body) || typeof body.command !== "string") {
        throw new Error("command is required");
      }
      await sendCommandThroughHarness({
        services,
        scopeRef,
        session: existing,
        command: body.command,
        args: typeof body.args === "string" ? body.args : "",
        model: toOptionalSelectedModel(body.model),
        agent: toOptionalString(body.agent, "agent"),
        variant: toOptionalString(body.variant, "variant"),
      });
      return Response.json({ ok: true, value: true });
    }

    if (child === "abort") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      await abortSessionThroughHarness({ services, scopeRef, session: existing });
      return Response.json({ ok: true, value: true });
    }

    if (child === "fork") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const session = await forkSessionThroughHarness({
        services,
        scopeRef,
        session: existing,
        messageId: isPlainObject(body) ? toOptionalString(body.messageId, "messageId") : undefined,
      });
      return Response.json({ ok: true, value: session });
    }

    if (child === "compact") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      await compactSessionThroughHarness({
        services,
        scopeRef,
        session: existing,
        model: isPlainObject(body) ? toOptionalSelectedModel(body.model) : undefined,
      });
      return Response.json({ ok: true, value: true });
    }

    if (child === "revert") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      if (!isPlainObject(body) || typeof body.messageId !== "string") {
        throw new Error("messageId is required");
      }
      const session = await revertSessionThroughHarness({
        services,
        scopeRef,
        session: existing,
        messageId: body.messageId,
        partId: toOptionalString(body.partId, "partId"),
      });
      if (session) return Response.json({ ok: true, value: session });
      return Response.json({ ok: true, value: true });
    }

    if (child === "unrevert") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const session = await unrevertSessionThroughHarness({
        services,
        scopeRef,
        session: existing,
      });
      if (session) return Response.json({ ok: true, value: session });
      return Response.json({ ok: true, value: true });
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    return jsonError(error, 400);
  }
}

async function handlePermissionRequest(request: Request) {
  const pathname = new URL(request.url).pathname;
  if (!pathname.endsWith("/respond") || !pathname.startsWith("/api/permissions/")) return null;
  const services = await servicesReady;
  const permissionId = decodeURIComponent(
    pathname.slice("/api/permissions/".length, pathname.length - "/respond".length),
  );
  if (!permissionId) return new Response("Not found", { status: 404 });

  try {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await readJsonBody(request);
    if (
      !isPlainObject(body) ||
      typeof body.sessionId !== "string" ||
      typeof body.response !== "string"
    ) {
      throw new Error("sessionId and response are required");
    }
    const { session, scopeRef } = await resolvePermissionSessionScope(services, body);
    await respondToHarnessPermission({
      services,
      session,
      permissionId,
      response: body.response as "once" | "always" | "reject",
      scope: { directory: scopeRef.canonicalPath || scopeRef.path },
    });
    return Response.json({ ok: true, value: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}

async function handleQuestionRequest(request: Request) {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/^\/api\/questions\/([^/]+)\/(reply|reject)$/);
  if (!match) return null;
  const services = await servicesReady;
  const questionId = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  if (!questionId || !action) return new Response("Not found", { status: 404 });

  try {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await readJsonBody(request);
    const harnessId = (
      isPlainObject(body)
        ? (toOptionalString(body.harnessId, "harnessId") ?? "claude-code")
        : "claude-code"
    ) as HarnessId;
    const sessionId = isPlainObject(body)
      ? toOptionalString(body.sessionId, "sessionId")
      : undefined;
    const bodyDirectory = isPlainObject(body)
      ? (toOptionalString(body.directory, "directory") ??
        toOptionalString(body.projectId, "projectId"))
      : undefined;
    let directory = bodyDirectory;
    if (!directory && sessionId) {
      const session = await getSessionOrThrow(services, sessionId, {
        harnessId,
      });
      directory = (await getSessionDirectoryScopeOrThrow(services, session)).path;
    } else if (directory) {
      directory = (await resolveHarnessDirectoryForSessions({ directory })).canonicalPath;
    }
    const target = directory ? { directory } : undefined;
    if (action === "reply") {
      if (!isPlainObject(body) || body.answers === undefined) {
        throw new Error("answers is required for question reply");
      }
      const answers = toQuestionAnswers(body.answers);
      if (answers.length === 0) {
        throw new Error("answers must be a non-empty array");
      }
      await replyToHarnessQuestion({
        services,
        harnessId,
        requestId: questionId,
        answers,
        target,
      });
    } else {
      await rejectHarnessQuestion({ services, harnessId, requestId: questionId, target });
    }
    return Response.json({ ok: true, value: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}

async function handleHarnessRequest(request: Request) {
  const services = await servicesReady;
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/api/harnesses") return null;
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  return Response.json({
    ok: true,
    value: listManagedHarnessDescriptors({ services }),
  });
}

type ForwardedHandler = (request: Request) => Response | Promise<Response | null> | null;

function forwardRoute(handler: ForwardedHandler) {
  return async (request: Request) =>
    (await handler(request)) ?? new Response("Not found", { status: 404 });
}

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
app.get("/api/capabilities", () => Response.json({ ok: true, value: getBackendCapabilities() }));
app.get("/api/version", () =>
  Response.json({
    ok: true,
    value: {
      protocolVersion: 1,
      appVersion: process.env.npm_package_version || "0.0.0",
    },
  }),
);
app.all("/api/directories/*", (c) => forwardRoute(handleDirectoryRequest)(c.req.raw));
app.all("/api/queues", (c) => forwardRoute(handleSessionRequest)(c.req.raw));
app.all("/api/sessions", (c) => forwardRoute(handleSessionRequest)(c.req.raw));
app.all("/api/sessions/*", (c) => forwardRoute(handleSessionRequest)(c.req.raw));
app.all("/api/permissions/*", (c) => forwardRoute(handlePermissionRequest)(c.req.raw));
app.all("/api/questions/*", (c) => forwardRoute(handleQuestionRequest)(c.req.raw));
app.all("/api/harnesses", (c) => forwardRoute(handleHarnessRequest)(c.req.raw));
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
