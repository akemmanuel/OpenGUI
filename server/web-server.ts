import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import type { AgentBackendEvent } from "../src/agents/backend.ts";
import { HARNESS_LABELS, type HarnessId } from "../src/agents/index.ts";
import {
  BackendEventBus,
  createStorageService,
  getBackendCapabilities,
  HarnessService,
  PromptQueueService,
  SessionService,
  ProjectService,
  type BackendServiceContext,
  type CreateProjectInput,
  type CreateSessionInput,
  type OpenGuiCapabilities,
  type ProjectRecord,
  type SessionRecord,
  type UpdateProjectInput,
} from "./services/index.ts";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { findFilesInDirectory } from "./services/file-search.ts";
import type { QueueMode } from "../src/lib/session-drafts.ts";
import type { SelectedModel } from "../src/types/electron.d.ts";
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

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function toOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toOptionalNullableString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string or null`);
  const trimmed = value.trim();
  return trimmed || null;
}

function toOptionalImages(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function toOptionalSelectedModel(value: unknown): SelectedModel | undefined {
  return isPlainObject(value) ? (value as unknown as SelectedModel) : undefined;
}

function toQueueMode(value: unknown, fallback: QueueMode): QueueMode;
function toQueueMode(value: unknown, fallback?: QueueMode): QueueMode | undefined;
function toQueueMode(value: unknown, fallback?: QueueMode): QueueMode | undefined {
  const mode = toOptionalString(value, "mode");
  if (mode !== "queue" && mode !== "interrupt" && mode !== "after-part") return fallback;
  return mode;
}

function toQuestionAnswers(value: unknown): QuestionAnswer[] {
  return Array.isArray(value) ? (value.filter(isPlainObject) as unknown as QuestionAnswer[]) : [];
}

function parseCreateProjectInput(body: unknown): CreateProjectInput {
  if (!isPlainObject(body)) throw new Error("Request body must be an object");
  if (typeof body.path !== "string" || !body.path.trim()) {
    throw new Error("Project path is required");
  }
  if (body.git !== undefined && !isPlainObject(body.git)) {
    throw new Error("Project git must be an object");
  }

  return {
    path: body.path,
    canonicalPath: toOptionalString(body.canonicalPath, "canonicalPath"),
    displayName:
      toOptionalString(body.displayName, "displayName") ??
      basename(body.path.replace(/[\\/]+$/, "")) ??
      "Project",
    allowedRootId: toOptionalString(body.allowedRootId, "allowedRootId"),
    git: body.git as CreateProjectInput["git"],
  };
}

function parseUpdateProjectInput(body: unknown): UpdateProjectInput {
  if (!isPlainObject(body)) throw new Error("Request body must be an object");
  if (body.git !== undefined && !isPlainObject(body.git)) {
    throw new Error("Project git must be an object");
  }

  return {
    displayName: toOptionalString(body.displayName, "displayName"),
    path: toOptionalString(body.path, "path"),
    canonicalPath: toOptionalString(body.canonicalPath, "canonicalPath"),
    allowedRootId: toOptionalNullableString(body.allowedRootId, "allowedRootId"),
    git: body.git as UpdateProjectInput["git"],
  };
}

async function normalizeCreateProjectInput(input: CreateProjectInput): Promise<CreateProjectInput> {
  const path = await resolveSafeDirectory(input.path);
  const canonicalPath = input.canonicalPath
    ? await resolveSafeDirectory(input.canonicalPath)
    : await realpath(path);
  return {
    ...input,
    path,
    canonicalPath,
    displayName:
      input.displayName?.trim() || basename(canonicalPath) || basename(path) || "Project",
  };
}

async function normalizeUpdateProjectInput(input: UpdateProjectInput): Promise<UpdateProjectInput> {
  const path = input.path ? await resolveSafeDirectory(input.path) : undefined;
  const canonicalPath = input.canonicalPath
    ? await resolveSafeDirectory(input.canonicalPath)
    : path
      ? await realpath(path)
      : undefined;
  return {
    ...input,
    path,
    canonicalPath,
    displayName: input.displayName?.trim() || undefined,
  };
}

function asSessionStatus(value: unknown): SessionRecord["status"] | undefined {
  return value === "idle" || value === "running" || value === "error" || value === "unknown"
    ? value
    : undefined;
}

function numberFromTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (value instanceof Date) return value.getTime();
  return null;
}

function extractRuntimeSessionTitle(session: unknown): string {
  if (!isPlainObject(session)) return "Untitled";
  const candidates = [session.title, session.name, session.slug, session.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "Untitled";
}

function extractRuntimeSessionTimestamps(session: unknown) {
  const record = isPlainObject(session) ? session : {};
  const time = isPlainObject(record.time) ? record.time : {};
  const createdMs =
    numberFromTimestamp(time.created) ??
    numberFromTimestamp(record.createdAt) ??
    numberFromTimestamp(record.created) ??
    Date.now();
  const updatedMs =
    numberFromTimestamp(time.updated) ??
    numberFromTimestamp(record.updatedAt) ??
    numberFromTimestamp(record.modified) ??
    createdMs;
  return {
    createdAt: new Date(createdMs).toISOString(),
    updatedAt: new Date(updatedMs).toISOString(),
  };
}

function extractRuntimeSessionMetadata(session: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(session)) return undefined;
  const metadata: Record<string, unknown> = {};
  for (const key of ["model", "version", "parentID", "projectID", "directory", "workspaceID"]) {
    if (key in session) metadata[key] = session[key];
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function toSessionRecordInputFromRuntime(
  session: unknown,
  scope: {
    projectId: string;
    harnessId: HarnessId;
  },
): CreateSessionInput {
  const runtimeSession = isPlainObject(session) ? session : {};
  const rawIdValue = runtimeSession._rawId ?? runtimeSession.id ?? runtimeSession.slug;
  const rawId = typeof rawIdValue === "string" ? rawIdValue.replace(/^[^:]+:/, "") : "";
  if (!rawId) throw new Error("Runtime session is missing id");
  const timestamps = extractRuntimeSessionTimestamps(session);
  return {
    rawId,
    projectId: scope.projectId,
    harnessId: scope.harnessId,
    title: extractRuntimeSessionTitle(session),
    status:
      asSessionStatus(
        isPlainObject(runtimeSession.status) ? runtimeSession.status.type : runtimeSession.status,
      ) ?? "unknown",
    metadata: extractRuntimeSessionMetadata(session),
    ...timestamps,
  };
}

async function getProjectOrThrow(
  services: BackendServiceContext,
  projectId: string,
): Promise<ProjectRecord> {
  const project = await services.projects.getProject(projectId);
  if (!project) throw new Error("Project not found");
  return project;
}

async function getSessionOrThrow(
  services: BackendServiceContext,
  sessionId: string,
  scope: { projectId?: string; harnessId?: HarnessId } = {},
): Promise<SessionRecord> {
  const session = await services.sessions.getSession(sessionId, scope);
  if (!session) throw new Error("Session not found");
  return session;
}

function buildHarnessScope(input: {
  project: ProjectRecord;
  harnessId: HarnessId;
  sessionId?: string;
}) {
  return {
    projectId: input.project.id,
    sessionId: input.sessionId,
    harnessId: input.harnessId,
    directory: input.project.path,
  };
}

function runtimeSessionBelongsToProject(session: unknown, projectPath: string) {
  if (!isPlainObject(session)) return true;
  const directory =
    typeof session.directory === "string"
      ? session.directory
      : typeof session._projectDir === "string"
        ? session._projectDir
        : typeof session.projectID === "string"
          ? session.projectID
          : typeof session.metadata === "object" &&
              session.metadata &&
              typeof (session.metadata as Record<string, unknown>).directory === "string"
            ? ((session.metadata as Record<string, unknown>).directory as string)
            : null;
  if (!directory) return true;
  return resolve(directory) === resolve(projectPath);
}

async function syncProjectSessions(
  services: BackendServiceContext,
  project: ProjectRecord,
  harnessId: HarnessId,
): Promise<{ sessions: SessionRecord[]; nextCursor: string | null }> {
  const runtimeResults = await services.harnesses.listProjectSessions({
    project,
    scope: buildHarnessScope({ project, harnessId }),
    backendIds: [harnessId],
  });
  const runtimeSessions = runtimeResults[0]?.sessions?.filter((session) =>
    runtimeSessionBelongsToProject(session, project.path),
  );
  if (!runtimeSessions) {
    return await services.sessions.listSessions({
      projectId: project.id,
      harnessId,
    });
  }
  const sessions = await services.sessions.replaceScopeSessions(
    {
      projectId: project.id,
      harnessId,
    },
    runtimeSessions.map((session) =>
      toSessionRecordInputFromRuntime(session, {
        projectId: project.id,
        harnessId,
      }),
    ),
  );
  return { sessions, nextCursor: null };
}

async function runSessionJobsWithConcurrency<T>(
  jobs: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = Array.from<T>({ length: jobs.length });
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (nextIndex < jobs.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await jobs[currentIndex]!();
      }
    }),
  );
  return results;
}

function buildCapabilities(): OpenGuiCapabilities {
  const base = getBackendCapabilities();
  return {
    ...base,
    server: {
      ...base.server,
      projects: true,
      sessions: true,
    },
  };
}

async function handleProjectRequest(request: Request) {
  const services = await servicesReady;
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/api/projects") {
    try {
      if (request.method === "GET") {
        return Response.json({ ok: true, value: await services.projects.listProjects() });
      }
      if (request.method === "POST") {
        const input = await normalizeCreateProjectInput(
          parseCreateProjectInput(await readJsonBody(request)),
        );
        return Response.json({ ok: true, value: await services.projects.createProject(input) });
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
        const input = await normalizeUpdateProjectInput(
          parseUpdateProjectInput(await readJsonBody(request)),
        );
        const updated = await services.projects.updateProject(projectId, input);
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
        value: await services.harnesses.connectProject({
          project,
          scope: buildHarnessScope({ project, harnessId: backendIds?.[0] ?? "opencode" }),
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
      await services.harnesses.disconnectProject({
        project,
        scope: buildHarnessScope({ project, harnessId: backendIds?.[0] ?? "opencode" }),
        backendIds,
      });
      return Response.json({ ok: true, value: true });
    }

    if (child === "status") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
      return Response.json({
        ok: true,
        value: await services.harnesses.getProjectStatus({
          project,
          scope: buildHarnessScope({ project, harnessId: harnessId ?? "opencode" }),
          backendIds: harnessId ? [harnessId] : undefined,
        }),
      });
    }

    if (["providers", "models", "agents", "commands"].includes(child)) {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const harnessId = url.searchParams.get("harnessId") as HarnessId | null;
      if (!harnessId) return jsonError(new Error("harnessId is required"), 400);
      const resources = await services.harnesses.loadResources({
        project,
        scope: buildHarnessScope({ project, harnessId }),
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
  const normalized = await normalizeCreateProjectInput(
    parseCreateProjectInput({ path: input.directory, displayName: basename(input.directory) }),
  );
  const existing = await services.projects.findProjectByPath({
    path: normalized.path,
    canonicalPath: normalized.canonicalPath,
  });
  return existing ?? (await services.projects.createProject(normalized));
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
          const workspaceId = toOptionalString(projectInput.workspaceId, "workspaceId");
          if (!frontendProjectId || !directory) return null;

          try {
            const project = await resolveFrontendProjectForSessions(services, { directory });
            return { ok: true as const, frontendProjectId, directory, workspaceId, project };
          } catch (error) {
            return {
              ok: false as const,
              error: {
                frontendProjectId,
                directory,
                workspaceId,
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
      const sessionJobs = resolvedProjects
        .filter((result): result is Extract<NonNullable<typeof result>, { ok: true }> =>
          Boolean(result && result.ok),
        )
        .flatMap(({ frontendProjectId, workspaceId, project }) =>
          harnessIds.map((harnessId) => async () => {
            try {
              const page = sync
                ? await syncProjectSessions(services, project, harnessId)
                : await services.sessions.listSessions({ projectId: project.id, harnessId });
              return {
                ok: true as const,
                item: {
                  frontendProjectId,
                  directory: project.path,
                  workspaceId,
                  harnessId,
                  sessions: page.sessions,
                },
              };
            } catch (error) {
              return {
                ok: false as const,
                error: {
                  frontendProjectId,
                  directory: project.path,
                  workspaceId,
                  harnessId,
                  error: error instanceof Error ? error.message : String(error),
                },
              };
            }
          }),
        );
      const sessionResults = await runSessionJobsWithConcurrency(sessionJobs, 4);
      const items = sessionResults
        .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
        .map((result) => result.item);
      errors.push(
        ...sessionResults
          .filter((result): result is Extract<typeof result, { ok: false }> => !result.ok)
          .map((result) => result.error),
      );

      return Response.json({ ok: true, value: { items, errors } });
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
        value: await services.queues.listProjectQueues({ projectId, harnessId }),
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
        if (projectId && harnessId && sync !== "0" && sync !== "false") {
          return Response.json({
            ok: true,
            value: await syncProjectSessions(
              services,
              await getProjectOrThrow(services, projectId),
              harnessId,
            ),
          });
        }
        return Response.json({
          ok: true,
          value: await services.sessions.listSessions({
            projectId,
            harnessId,
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
        const runtimeSession = await services.harnesses.createSession({
          project,
          scope: buildHarnessScope({ project, harnessId }),
          title: toOptionalString(body.title, "title"),
        });
        const session = await services.sessions.ensureSession(
          toSessionRecordInputFromRuntime(runtimeSession, {
            projectId: project.id,
            harnessId,
          }),
        );
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
        const renamedRuntimeSession =
          typeof body.title === "string"
            ? await services.harnesses.updateSession({
                session: existing,
                scope: buildHarnessScope({
                  project,
                  harnessId: existing.harnessId,
                  sessionId: existing.id,
                }),
                title: body.title,
              })
            : null;
        const updated =
          renamedRuntimeSession && isPlainObject(renamedRuntimeSession)
            ? await services.sessions.ensureSession(
                toSessionRecordInputFromRuntime(renamedRuntimeSession, {
                  projectId: existing.projectId,
                  harnessId: existing.harnessId,
                }),
              )
            : await services.sessions.updateSession(sessionId, {
                title: toOptionalString(body.title, "title"),
                status: asSessionStatus(body.status),
                metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
              });
        if (!updated) return jsonError(new Error("Session not found"), 404);
        return Response.json({ ok: true, value: updated });
      }
      if (request.method === "DELETE") {
        const existing = await getSessionOrThrow(services, sessionId, sessionScope);
        const queuedPrompts = await services.queues.listSessionQueue(existing.id);
        const confirmedQueueDelete =
          url.searchParams.get("confirmQueue") === "1" ||
          url.searchParams.get("confirmQueue") === "true";
        if (queuedPrompts.length > 0 && !confirmedQueueDelete) {
          return jsonError(
            new Error("Session has queued prompts; confirmQueue=true is required"),
            409,
          );
        }
        const project = await getProjectOrThrow(services, existing.projectId);
        await services.harnesses.deleteSession({
          session: existing,
          scope: buildHarnessScope({
            project,
            harnessId: existing.harnessId,
            sessionId: existing.id,
          }),
        });
        await services.sessions.deleteSession(existing.id);
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
            value: await services.queues.listSessionQueue(sessionId),
          });
        }
        if (request.method === "POST") {
          const body = await readJsonBody(request);
          if (!isPlainObject(body) || typeof body.text !== "string") {
            throw new Error("text is required");
          }
          return Response.json({
            ok: true,
            value: await services.queues.enqueue(sessionId, {
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
        const entries = await services.queues.listSessionQueue(sessionId);
        const next = entries[0];
        if (!next) return Response.json({ ok: true, value: entries });
        await services.queues.remove(sessionId, next.id);
        await services.harnesses.promptSession({
          session: existing,
          scope: buildHarnessScope({
            project,
            harnessId: existing.harnessId,
            sessionId: existing.id,
          }),
          text: next.text,
          images: next.images,
          model: next.model,
          agent: next.agent,
          variant: next.variant,
        });
        return Response.json({
          ok: true,
          value: await services.queues.listSessionQueue(sessionId),
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
          value: await services.queues.reorder(sessionId, entryId, body.index),
        });
      }

      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        return Response.json({
          ok: true,
          value: await services.queues.update(sessionId, entryId, {
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
          value: await services.queues.remove(sessionId, entryId),
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
        value: await services.harnesses.listMessages({
          session: existing,
          scope: buildHarnessScope({
            project,
            harnessId: existing.harnessId,
            sessionId: existing.id,
          }),
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
      await services.harnesses.promptSession({
        session: existing,
        scope: buildHarnessScope({
          project,
          harnessId: existing.harnessId,
          sessionId: existing.id,
        }),
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
      await services.harnesses.sendCommand({
        session: existing,
        scope: buildHarnessScope({
          project,
          harnessId: existing.harnessId,
          sessionId: existing.id,
        }),
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
      await services.harnesses.abortSession({ session: existing });
      return Response.json({ ok: true, value: true });
    }

    if (child === "fork") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const forked = await services.harnesses.forkSession({
        session: existing,
        scope: buildHarnessScope({
          project,
          harnessId: existing.harnessId,
          sessionId: existing.id,
        }),
        messageId: isPlainObject(body) ? toOptionalString(body.messageId, "messageId") : undefined,
      });
      const session = await services.sessions.ensureSession(
        toSessionRecordInputFromRuntime(forked, {
          projectId: existing.projectId,
          harnessId: existing.harnessId,
        }),
      );
      return Response.json({ ok: true, value: session });
    }

    if (child === "compact") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      await services.harnesses.compactSession({
        session: existing,
        scope: buildHarnessScope({
          project,
          harnessId: existing.harnessId,
          sessionId: existing.id,
        }),
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
      const reverted = await services.harnesses.revertSession({
        session: existing,
        messageId: body.messageId,
        partId: toOptionalString(body.partId, "partId"),
      });
      if (reverted && isPlainObject(reverted)) {
        const session = await services.sessions.ensureSession(
          toSessionRecordInputFromRuntime(reverted, {
            projectId: existing.projectId,
            harnessId: existing.harnessId,
          }),
        );
        return Response.json({ ok: true, value: session });
      }
      return Response.json({ ok: true, value: true });
    }

    if (child === "unrevert") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const unreverted = await services.harnesses.unrevertSession({ session: existing });
      if (unreverted && isPlainObject(unreverted)) {
        const session = await services.sessions.ensureSession(
          toSessionRecordInputFromRuntime(unreverted, {
            projectId: existing.projectId,
            harnessId: existing.harnessId,
          }),
        );
        return Response.json({ ok: true, value: session });
      }
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
    await services.harnesses.respondPermission({
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
      await services.harnesses.replyQuestion({
        harnessId,
        requestId: questionId,
        answers: isPlainObject(body) ? toQuestionAnswers(body.answers) : [],
      });
    } else {
      await services.harnesses.rejectQuestion({ harnessId, requestId: questionId });
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
    value: services.harnesses.getManagedHarnessIds().map((id) => ({
      id,
      label: HARNESS_LABELS[id as keyof typeof HARNESS_LABELS],
    })),
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
app.get("/api/capabilities", () => Response.json({ ok: true, value: buildCapabilities() }));
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
