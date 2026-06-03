import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { AgentBackendEvent } from "../src/agents/backend.ts";
import type { HarnessId } from "../src/agents/index.ts";
import {
  BackendEventBus,
  compactSessionThroughHarness,
  createStorageService,
  HarnessService,
  PromptQueueService,
  SessionService,
  ProjectService,
  abortSessionThroughHarness,
  asSessionStatus,
  connectProjectToHarnesses,
  createProjectRecord,
  createSessionThroughHarness,
  deleteSessionThroughHarness,
  disconnectProjectFromHarnesses,
  dispatchNextQueuedPromptThroughHarness,
  enqueueSessionPrompt,
  findFilesInDirectory,
  findOrCreateProjectRecordByPath,
  forkSessionThroughHarness,
  getBackendCapabilities,
  getProjectHarnessStatus,
  getProjectRecordOrThrow,
  getSessionRecordOrThrow,
  listManagedHarnessDescriptors,
  listProjectRecords,
  listProjectSessionQueues,
  listSessionMessagesThroughHarness,
  listSessionQueue,
  listSessionsForRequest,
  loadProjectHarnessResources,
  normalizeCreateProjectInput as normalizeProjectCreateInput,
  normalizeUpdateProjectInput as normalizeProjectUpdateInput,
  parseCreateProjectInput,
  parseUpdateProjectInput,
  promptSessionThroughHarness,
  readJsonBody,
  rejectHarnessQuestion,
  removeSessionPrompt,
  renameSessionThroughHarness,
  reorderSessionPrompt,
  replyToHarnessQuestion,
  respondToHarnessPermission,
  revertSessionThroughHarness,
  sendCommandThroughHarness,
  toOptionalImages,
  toOptionalNullableString,
  toOptionalSelectedModel,
  toOptionalString,
  toQuestionAnswers,
  toQueueMode,
  querySessionsForResolvedProjects,
  unrevertSessionThroughHarness,
  updateProjectRecord,
  updateSessionPrompt,
  updateSessionRecord,
  type BackendServiceContext,
  type ProjectRecord,
  type SessionRecord,
} from "./services/index.ts";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  getHarnessIdFromBridgeChannel,
  isManagedHarnessId,
  MANAGED_HARNESS_IDS,
  normalizeBridgeEvent,
  registerHarnessAdapters,
} from "./harness-runtime.ts";
import { registerShellIpcHandlers } from "./shell-ipc-handlers.ts";

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

interface SseClient {
  send: (payload: string, id?: string) => Promise<void>;
  close: () => Promise<void>;
}

class FakeSender extends EventEmitter {
  id = 1;
  private destroyed = false;
  private readonly broadcast: (channel: string, data: unknown) => void;

  constructor(broadcast: (channel: string, data: unknown) => void) {
    super();
    this.broadcast = broadcast;
  }

  send(channel: string, data: unknown) {
    this.broadcast(channel, data);
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

interface IpcEvent {
  sender: FakeSender;
}

class FakeIpcMain {
  private handlers = new Map<string, Handler>();
  private listeners = new Map<string, Handler>();

  handle(channel: string, handler: Handler) {
    if (this.handlers.has(channel)) {
      console.warn(`[web] Replacing RPC handler ${channel}`);
    }
    this.handlers.set(channel, handler);
  }

  on(channel: string, handler: Handler) {
    this.listeners.set(channel, handler);
  }

  send(channel: string, event: IpcEvent, args: unknown[] = []) {
    const listener = this.listeners.get(channel);
    if (!listener) return;
    listener(event, ...args);
  }

  async invoke(channel: string, event: IpcEvent, args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No RPC handler registered for ${channel}`);
    return await handler(event, ...args);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getCanonicalEventType(event: AgentBackendEvent): string {
  switch (event.type) {
    case "connection.status":
      return "project.connection.status";
    case "session.error":
      return "runtime.error";
    default:
      return event.type;
  }
}

function getBridgeEventRefs(event: AgentBackendEvent): {
  projectId?: string;
  sessionId?: string;
  harnessId?: string;
} {
  switch (event.type) {
    case "connection.status":
      return { projectId: event.directory };
    case "session.created":
    case "session.updated":
      return {
        projectId: event.directory,
        sessionId: event.session.id,
      };
    case "session.replaced":
      return {
        projectId: event.directory,
        sessionId: event.newId,
      };
    case "session.deleted":
      return {
        projectId: event.directory,
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
  ipcMain: FakeIpcMain,
  sender: FakeSender,
  broadcast: (channel: string, data: unknown) => void,
): Promise<BackendServiceContext> {
  const dataDir = resolve(
    process.env.OPENGUI_DATA_DIR || join(homedir(), ".config", "OpenGUI-web"),
  );
  await mkdir(dataDir, { recursive: true });

  const storage = await createStorageService(dataDir);
  const events = new BackendEventBus();
  const sessions = new SessionService(storage, events);
  const projects = new ProjectService(storage, events);
  const queues = new PromptQueueService(storage, sessions, events);
  const bridgeControls = registerHarnessAdapters({ ipcMain, sender, dataDir, broadcast });

  const harnesses = new HarnessService(
    <T>(channel: string, args: unknown[] = []) =>
      ipcMain.invoke(channel, { sender }, args) as Promise<T>,
    bridgeControls,
    MANAGED_HARNESS_IDS,
    events,
  );

  return {
    dataDir,
    storage,
    events,
    projects,
    sessions,
    queues,
    harnesses,
    restartHarness: (harnessId: string) => harnesses.restartHarness(harnessId),
    restartAllHarnesses: () => harnesses.restartAllHarnesses(),
  };
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

  const client: SseClient = {
    send: async (payload: string, id?: string) => {
      await writer.write(encoder.encode(formatSseMessage(payload, id)));
    },
    close: async () => {
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
  const normalizedEvent = normalizeBridgeEvent({ harnessId, event: data });
  if (!normalizedEvent) return;

  if (!servicesReady) return;
  void servicesReady.then((services) => {
    services.events.publish(getCanonicalEventType(normalizedEvent), normalizedEvent, {
      ...getBridgeEventRefs(normalizedEvent),
      harnessId,
    });
  });
};

const ipcMain = new FakeIpcMain();
const sender = new FakeSender(broadcast);
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
  return raw
    .split(",")
    .map((entry) => resolve(entry.trim()))
    .filter(Boolean);
}

const allowedRoots = parseAllowedRoots();

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
  const requested = resolve(inputPath?.trim() || allowedRoots[0] || homedir());
  const actual = await realpath(requested);
  const info = await stat(actual);
  if (!info.isDirectory()) throw new Error("Path is not a directory");
  const allowed = allowedRoots.some((root) => actual === root || actual.startsWith(`${root}/`));
  if (!allowed) throw new Error("Path outside OPENGUI_ALLOWED_ROOTS");
  return actual;
}

async function listServerDirectories(inputPath: string | null) {
  const path = await resolveSafeDirectory(inputPath);
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name), type: "dir" as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  const canGoUp = allowedRoots.some((root) => parent === root || parent.startsWith(`${root}/`));
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

async function getProjectOrThrow(
  services: BackendServiceContext,
  projectId: string,
): Promise<ProjectRecord> {
  return await getProjectRecordOrThrow({ services, projectId });
}

async function getSessionOrThrow(
  services: BackendServiceContext,
  sessionId: string,
  scope: { projectId?: string; harnessId?: HarnessId } = {},
): Promise<SessionRecord> {
  return await getSessionRecordOrThrow({ services, sessionId, scope });
}

async function handleProjectRequest(request: Request) {
  const services = await servicesReady;
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/api/projects") {
    try {
      if (request.method === "GET") {
        return Response.json({ ok: true, value: await listProjectRecords({ services }) });
      }
      if (request.method === "POST") {
        const input = await normalizeProjectCreateInput(
          parseCreateProjectInput(await readJsonBody(request)),
          resolveSafeDirectory,
          realpath,
        );
        return Response.json({
          ok: true,
          value: await createProjectRecord({ services, project: input }),
        });
      }
      return new Response("Method Not Allowed", { status: 405 });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (!pathname.startsWith("/api/projects/")) return null;

  const subpath = pathname.slice("/api/projects/".length);
  const [projectIdEncoded, child] = subpath.split("/");
  const projectId = decodeURIComponent(projectIdEncoded ?? "");
  if (!projectId) return new Response("Not found", { status: 404 });

  try {
    const project = await getProjectOrThrow(services, projectId);

    if (!child) {
      if (request.method === "GET") {
        return Response.json({ ok: true, value: project });
      }
      if (request.method === "PATCH") {
        const input = await normalizeProjectUpdateInput(
          parseUpdateProjectInput(await readJsonBody(request)),
          resolveSafeDirectory,
          realpath,
        );
        const updated = await updateProjectRecord({ services, projectId, patch: input });
        if (!updated) return jsonError(new Error("Project not found"), 404);
        return Response.json({ ok: true, value: updated });
      }
      if (request.method === "DELETE") {
        // Project removal in OpenGUI is a frontend-local Project connection action.
        // The OpenGUI Backend must not destructively delete Projects, Sessions, or files.
        return Response.json({ ok: true, value: true });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (child === "connect") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const backendIds =
        isPlainObject(body) && Array.isArray(body.backendIds)
          ? body.backendIds.filter((value): value is HarnessId => typeof value === "string")
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
        value: await connectProjectToHarnesses({
          services,
          project,
          backendIds,
          config: {
            directory: project.path,
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

    if (child === "disconnect") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const backendIds =
        isPlainObject(body) && Array.isArray(body.backendIds)
          ? body.backendIds.filter((value): value is HarnessId => typeof value === "string")
          : undefined;
      await disconnectProjectFromHarnesses({
        services,
        project,
        backendIds,
      });
      return Response.json({ ok: true, value: true });
    }

    if (child === "status") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
      return Response.json({
        ok: true,
        value: await getProjectHarnessStatus({
          services,
          project,
          harnessId,
        }),
      });
    }

    if (["providers", "models", "agents", "commands"].includes(child)) {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const harnessId = url.searchParams.get("harnessId") as HarnessId | null;
      if (!harnessId) return jsonError(new Error("harnessId is required"), 400);
      const resources = await loadProjectHarnessResources({
        services,
        project,
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

async function resolveFrontendProjectForSessions(
  services: BackendServiceContext,
  input: { directory: string },
): Promise<ProjectRecord> {
  const normalized = await normalizeProjectCreateInput(
    parseCreateProjectInput({ path: input.directory, displayName: basename(input.directory) }),
    resolveSafeDirectory,
    realpath,
  );
  return await findOrCreateProjectRecordByPath({ services, project: normalized });
}

function parseSessionScopeFromUrl(url: URL): {
  projectId?: string;
  harnessId?: HarnessId;
} {
  const projectId = url.searchParams.get("projectId") || undefined;
  const harnessIdRaw = url.searchParams.get("harnessId");
  const harnessId = harnessIdRaw && isManagedHarnessId(harnessIdRaw) ? harnessIdRaw : undefined;
  return { projectId, harnessId };
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
      const projectsInput = Array.isArray(body.projects) ? body.projects : [];
      const harnessIds = Array.isArray(body.harnessIds)
        ? body.harnessIds.filter(isManagedHarnessId)
        : [];
      const sync = body.sync === true;
      const resolvedProjects = await Promise.all(
        projectsInput.map(async (projectInput) => {
          if (!isPlainObject(projectInput)) return null;
          const frontendProjectId = toOptionalString(
            projectInput.frontendProjectId,
            "frontendProjectId",
          );
          const directory = toOptionalString(projectInput.directory, "directory");
          if (!frontendProjectId || !directory) return null;

          try {
            const project = await resolveFrontendProjectForSessions(services, { directory });
            return { ok: true as const, frontendProjectId, directory, project };
          } catch (error) {
            return {
              ok: false as const,
              error: {
                frontendProjectId,
                directory,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }),
      );

      const errors = resolvedProjects
        .filter((result): result is Extract<NonNullable<typeof result>, { ok: false }> =>
          Boolean(result && !result.ok),
        )
        .map((result) => result.error);
      const resolved = resolvedProjects
        .filter((result): result is Extract<NonNullable<typeof result>, { ok: true }> =>
          Boolean(result && result.ok),
        )
        .map(({ frontendProjectId, project }) => ({ frontendProjectId, project }));
      const queried = await querySessionsForResolvedProjects({
        services,
        projects: resolved,
        harnessIds,
        sync,
      });
      errors.push(...queried.errors);

      return Response.json({ ok: true, value: { items: queried.items, errors } });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (pathname === "/api/queues") {
    try {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const projectId = url.searchParams.get("projectId") || undefined;
      const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
      if (!projectId || !harnessId) {
        throw new Error("projectId and harnessId are required");
      }
      return Response.json({
        ok: true,
        value: await listProjectSessionQueues({ services, projectId, harnessId }),
      });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (pathname === "/api/sessions") {
    try {
      if (request.method === "GET") {
        const projectId = url.searchParams.get("projectId") || undefined;
        const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
        const sync = url.searchParams.get("sync");
        return Response.json({
          ok: true,
          value: await listSessionsForRequest({
            services,
            projectId,
            harnessId,
            sync: sync !== "0" && sync !== "false",
            cursor: url.searchParams.get("cursor"),
            limit: url.searchParams.get("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          }),
        });
      }

      if (request.method === "POST") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        const projectId = toOptionalString(body.projectId, "projectId");
        const harnessId = toOptionalString(body.harnessId, "harnessId") as HarnessId | undefined;
        if (!projectId || !harnessId) throw new Error("projectId and harnessId are required");
        const project = await getProjectOrThrow(services, projectId);
        const session = await createSessionThroughHarness({
          services,
          project,
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
          value: await getSessionOrThrow(services, sessionId, sessionScope),
        });
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        const existing = await getSessionOrThrow(services, sessionId, sessionScope);
        const project = await getProjectOrThrow(services, existing.projectId);
        const updated =
          typeof body.title === "string"
            ? await renameSessionThroughHarness({
                services,
                project,
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
        const queuedPrompts = await listSessionQueue({ services, sessionId: existing.id });
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
          project: await getProjectOrThrow(services, existing.projectId),
          session: existing,
        });
        return Response.json({ ok: true, value: true });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    const existing = await getSessionOrThrow(services, sessionId, sessionScope);
    const project = await getProjectOrThrow(services, existing.projectId);

    if (child === "queue") {
      if (!grandchild) {
        if (request.method === "GET") {
          return Response.json({
            ok: true,
            value: await listSessionQueue({ services, sessionId }),
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
              images: toOptionalImages(body.images),
              model: toOptionalSelectedModel(body.model),
              agent: toOptionalString(body.agent, "agent"),
              variant: toOptionalString(body.variant, "variant"),
              mode: toQueueMode(body.mode, "queue"),
            }),
          });
        }
        return new Response("Method Not Allowed", { status: 405 });
      }

      if (grandchild === "dispatch") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
        return Response.json({
          ok: true,
          value: await dispatchNextQueuedPromptThroughHarness({
            services,
            project,
            session: existing,
          }),
        });
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
          value: await reorderSessionPrompt({ services, sessionId, entryId, index: body.index }),
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
            images: toOptionalImages(body.images),
            model: toOptionalSelectedModel(body.model),
            agent: toOptionalNullableString(body.agent, "agent"),
            variant: toOptionalNullableString(body.variant, "variant"),
            mode: toQueueMode(body.mode),
          }),
        });
      }

      if (request.method === "DELETE") {
        return Response.json({
          ok: true,
          value: await removeSessionPrompt({ services, sessionId, entryId }),
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
          project,
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
      await promptSessionThroughHarness({
        services,
        project,
        session: existing,
        text: body.text,
        images: toOptionalImages(body.images),
        model: toOptionalSelectedModel(body.model),
        agent: toOptionalString(body.agent, "agent"),
        variant: toOptionalString(body.variant, "variant"),
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
        project,
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
      await abortSessionThroughHarness({ services, session: existing });
      return Response.json({ ok: true, value: true });
    }

    if (child === "fork") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const session = await forkSessionThroughHarness({
        services,
        project,
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
        project,
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
        session: existing,
        messageId: body.messageId,
        partId: toOptionalString(body.partId, "partId"),
      });
      if (session) return Response.json({ ok: true, value: session });
      return Response.json({ ok: true, value: true });
    }

    if (child === "unrevert") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const session = await unrevertSessionThroughHarness({ services, session: existing });
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
    const session = await getSessionOrThrow(services, body.sessionId, {
      projectId: toOptionalString(body.projectId, "projectId") ?? undefined,
      harnessId:
        (toOptionalString(body.backendId, "backendId") as HarnessId | undefined) ?? undefined,
    });
    await respondToHarnessPermission({
      services,
      session,
      permissionId,
      response: body.response as "once" | "always" | "reject",
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
        ? (toOptionalString(body.backendId, "backendId") ?? "opencode")
        : "opencode"
    ) as HarnessId;
    if (action === "reply") {
      await replyToHarnessQuestion({
        services,
        harnessId,
        requestId: questionId,
        answers: isPlainObject(body) ? toQuestionAnswers(body.answers) : [],
      });
    } else {
      await rejectHarnessQuestion({ services, harnessId, requestId: questionId });
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
app.all("/api/projects", (c) => forwardRoute(handleProjectRequest)(c.req.raw));
app.all("/api/projects/*", (c) => forwardRoute(handleProjectRequest)(c.req.raw));
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
app.get("/api/fs/search", async (c) => {
  try {
    const projectId = c.req.query("projectId");
    const query = c.req.query("query") ?? "";
    const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
    if (!projectId) throw new Error("projectId is required");
    const project = await getProjectOrThrow(await servicesReady, projectId);
    const files = await findFilesInDirectory(project.path, query);
    return Response.json({ ok: true, value: files.slice(0, limit) });
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
