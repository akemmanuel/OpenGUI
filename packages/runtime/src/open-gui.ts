import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { HarnessEvent } from "../../../src/agents/backend.ts";
import type { HarnessId } from "../../../src/agents/index.ts";
import { parseFrontendSessionId } from "../../../src/lib/session-identity.ts";
import type {
  DirectoryRegisterResult,
  HarnessResourceBundle,
} from "../../../src/protocol/client.ts";
import type { HarnessInventory } from "../../../src/types/electron.d.ts";
import type { SelectedModel } from "../../../src/types/electron.d.ts";
import { getHarnessInventories } from "../../../server/harness-inventory.ts";
import { directoryRef } from "./directory-ref.ts";
import {
  createHarnessService,
  type HarnessService,
  type RuntimeListedSession,
} from "./harness-service.ts";
import { resolveSafeDirectory, normalizeAllowedRoots } from "./directory-safety.ts";
import {
  type ManagedHarnessId,
  getHarnessIdFromBridgeChannel,
  isManagedHarnessId,
  normalizeBridgeEvent,
  MANAGED_HARNESS_IDS,
} from "./harness-runtime.ts";
import { createRuntimeHost } from "./host.ts";
import { InProcessIpcMain, InProcessIpcSender } from "./in-process-ipc.ts";
import { createDirectoryHandle, type DirectoryHandle } from "./directory-handle.ts";
import {
  createSessionHandle,
  sessionIdFromCreateResult,
  type SessionHandle,
  type SessionSummary,
} from "./session-handle.ts";
import { diagnoseFromInventories, type OpenGUIDiagnoseResult } from "./diagnose.ts";
import { OpenGuiSdkError } from "./opengui-sdk-error.ts";

export { OpenGuiSdkError } from "./opengui-sdk-error.ts";
export type { OpenGUIDiagnoseResult, HarnessDiagnoseEntry } from "./diagnose.ts";

export interface CreateOpenGUIOptions {
  /** Persistent config directory (bridges, caches). Default: `~/.config/opengui-runtime` */
  dataDir?: string;
  /** Filesystem roots allowed for `directory` operations. Default: home directory. */
  allowedRoots: string[];
  /** When set, only these harness adapters register at startup (faster cold start). */
  harnesses?: HarnessId[];
}

export type HarnessEventHandler = (event: HarnessEvent) => void;

export interface HarnessSessionsApi {
  list(input?: { directory?: string }): Promise<SessionSummary[]>;
  create(input?: { title?: string; directory?: string }): Promise<SessionHandle>;
  open(id: string, input?: { directory?: string }): Promise<SessionHandle>;
}

export interface HarnessHandle {
  readonly harnessId: ManagedHarnessId;
  /** Set when obtained via `og.at(path).harness(id)`; methods default `directory` to this path. */
  readonly directoryPath?: string;
  on(event: "event", handler: HarnessEventHandler): () => void;
  sessions: HarnessSessionsApi;
  registerDirectory(input?: { directory?: string }): Promise<DirectoryRegisterResult>;
  releaseDirectory(input?: { directory?: string }): Promise<void>;
  prompt(input: {
    directory?: string;
    sessionId: string;
    text: string;
    model?: SelectedModel;
    agent?: string;
    variant?: string;
  }): Promise<void>;
  abort(input: { directory?: string; sessionId: string }): Promise<void>;
  loadResources(input?: { directory?: string }): Promise<HarnessResourceBundle>;
  /** Read transcript for a session (no agent send). */
  messages(input: {
    directory?: string;
    sessionId: string;
    limit?: number;
    before?: string | null;
  }): Promise<unknown>;
  /** Per-harness connection + session status snapshot for a directory (read-only). */
  directoryStatus(input?: {
    directory?: string;
  }): Promise<
    Record<
      string,
      { connected: boolean; statuses: Record<string, { type: string }>; error?: string }
    >
  >;
}

export interface OpenGUI {
  /**
   * Resolve and pin a directory for Harness Scope operations.
   * @see ADR 0007 — prefer over passing `directory` on every `harness()` call.
   */
  at(directoryInput: string): Promise<DirectoryHandle>;
  /** @deprecated Prefer `og.at(directory).harness(id)` (ADR 0007). */
  harness(harnessId: HarnessId): HarnessHandle;
  registerDirectory(input: {
    directory: string;
    harnessIds?: HarnessId[];
  }): Promise<DirectoryRegisterResult>;
  releaseDirectory(input: { directory: string; harnessIds?: HarnessId[] }): Promise<void>;
  getHarnessInventories(): HarnessInventory[];
  /** Small readiness snapshot from inventories (ADR 0007). */
  diagnose(): OpenGUIDiagnoseResult;
  close(): Promise<void>;
}

type SessionRuntimeStatus = "idle" | "running" | "error" | "unknown";

function sessionStatusKey(directory: string, harnessId: HarnessId, rawId: string) {
  return `${directory}::${harnessId}::${rawId}`;
}

function mapHarnessSessionStatus(type: string | undefined): SessionRuntimeStatus {
  if (type === "busy" || type === "running") return "running";
  if (type === "idle") return "idle";
  if (type === "error") return "error";
  return "unknown";
}

class HarnessHandleImpl implements HarnessHandle {
  readonly harnessId: ManagedHarnessId;
  readonly directoryPath: string | undefined;
  private readonly emitter = new EventEmitter();
  private readonly service: HarnessService;
  private readonly resolveDirectory: (path: string) => Promise<string>;
  private readonly sessionStatus = new Map<string, SessionRuntimeStatus>();
  private readonly registeredDirectories = new Set<string>();

  constructor(
    harnessId: ManagedHarnessId,
    service: HarnessService,
    resolveDirectory: (path: string) => Promise<string>,
    directoryPath?: string,
  ) {
    this.harnessId = harnessId;
    this.service = service;
    this.resolveDirectory = resolveDirectory;
    this.directoryPath = directoryPath;
  }

  private async resolveDirectoryInput(directoryInput?: string): Promise<string> {
    if (directoryInput !== undefined && directoryInput !== "") {
      return await this.resolveDirectory(directoryInput);
    }
    if (this.directoryPath) return this.directoryPath;
    throw new OpenGuiSdkError(
      "DIRECTORY_REQUIRED",
      "directory is required (use og.at(path).harness(id) or pass directory on this call)",
    );
  }

  ingestCanonicalEvent(event: HarnessEvent) {
    this.emitter.emit("event", event);
    if (event.type === "session.status") {
      const rawId = event.sessionID;
      if (!rawId) return;
      const directory = this.directoryFromEvent(event);
      if (!directory) return;
      this.sessionStatus.set(
        sessionStatusKey(directory, this.harnessId, rawId),
        mapHarnessSessionStatus(event.status?.type),
      );
      return;
    }
    if (event.type === "session.error") {
      const rawId = event.sessionID;
      if (!rawId) return;
      const directory = this.directoryFromEvent(event);
      if (!directory) return;
      this.sessionStatus.set(sessionStatusKey(directory, this.harnessId, rawId), "error");
    }
  }

  private directoryFromEvent(event: HarnessEvent): string | undefined {
    if ("directory" in event && typeof event.directory === "string") return event.directory;
    return undefined;
  }

  on(_event: "event", handler: HarnessEventHandler): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  private async ensureDirectory(directoryInput?: string): Promise<string> {
    const directory = await this.resolveDirectoryInput(directoryInput);
    if (!this.registeredDirectories.has(directory)) {
      await this.registerDirectory({ directory });
    }
    return directory;
  }

  async registerDirectory(input?: { directory?: string }): Promise<DirectoryRegisterResult> {
    const directory = await this.resolveDirectoryInput(input?.directory);
    const result = await this.service.registerDirectory({
      directory,
      harnessIds: [this.harnessId],
    });
    if (result.connectedHarnessIds.includes(this.harnessId)) {
      this.registeredDirectories.add(directory);
    }
    return result;
  }

  async releaseDirectory(input?: { directory?: string }): Promise<void> {
    const directory = await this.resolveDirectoryInput(input?.directory);
    await this.service.releaseDirectory({ directory, harnessIds: [this.harnessId] });
    this.registeredDirectories.delete(directory);
    for (const key of this.sessionStatus.keys()) {
      if (key.startsWith(`${directory}::${this.harnessId}::`)) this.sessionStatus.delete(key);
    }
  }

  sessions: HarnessSessionsApi = {
    list: async (input) => this.listSessions(input),
    create: async (input) => this.createSession(input),
    open: async (id, input) => this.openSession(id, input),
  };

  private getSessionStatus(directory: string, rawId: string): SessionRuntimeStatus | undefined {
    return this.sessionStatus.get(sessionStatusKey(directory, this.harnessId, rawId));
  }

  private markSessionRunning(directory: string, rawId: string): void {
    this.sessionStatus.set(sessionStatusKey(directory, this.harnessId, rawId), "running");
  }

  private markSessionIdle(directory: string, rawId: string): void {
    this.sessionStatus.set(sessionStatusKey(directory, this.harnessId, rawId), "idle");
  }

  private makeSessionHandle(directory: string, sessionId: string): SessionHandle {
    return createSessionHandle({
      harnessId: this.harnessId,
      directory,
      sessionId,
      service: this.service,
      resolveSessionIds: (id) => this.resolveSessionIds(id),
      getSessionStatus: (dir, rawId) => this.getSessionStatus(dir, rawId),
      markSessionRunning: (dir, rawId) => this.markSessionRunning(dir, rawId),
      markSessionIdle: (dir, rawId) => this.markSessionIdle(dir, rawId),
      subscribeHarnessEvents: (handler) => this.on("event", handler),
    });
  }

  private async listSessions(input?: { directory?: string }): Promise<SessionSummary[]> {
    const directory = await this.ensureDirectory(input?.directory);
    let rows;
    try {
      rows = await this.service.listDirectorySessions({
        directory,
        harnessIds: [this.harnessId],
      });
    } catch (error) {
      throw this.toOpenGuiBridgeError(error);
    }
    const entry = rows.find((row) => row.harnessId === this.harnessId);
    const sessions = entry?.sessions ?? [];
    for (const session of sessions) {
      const rawId =
        typeof session.id === "string"
          ? (parseFrontendSessionId(session.id)?.rawId ?? session.id)
          : "";
      if (!rawId) continue;
      const statusRaw = session.status;
      const status: SessionRuntimeStatus =
        typeof statusRaw === "string"
          ? (statusRaw as SessionRuntimeStatus)
          : typeof statusRaw === "object" && statusRaw?.type
            ? (statusRaw.type as SessionRuntimeStatus)
            : "unknown";
      this.sessionStatus.set(sessionStatusKey(directory, this.harnessId, rawId), status);
    }
    return sessions.map((session: RuntimeListedSession) => {
      const status =
        typeof session.status === "string"
          ? session.status
          : typeof session.status === "object" && session.status?.type
            ? session.status.type
            : undefined;
      return {
        id: session.id,
        title: session.title,
        status,
        directory: session.directory,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    });
  }

  private async createSession(input?: {
    title?: string;
    directory?: string;
  }): Promise<SessionHandle> {
    const directory = await this.ensureDirectory(input?.directory);
    let data: unknown;
    try {
      data = await this.service.createSession({
        scope: { directory, harnessId: this.harnessId },
        title: input?.title,
      });
    } catch (error) {
      throw this.toOpenGuiBridgeError(error);
    }
    const sessionId = sessionIdFromCreateResult(this.harnessId, data);
    return this.makeSessionHandle(directory, sessionId);
  }

  private async openSession(id: string, input?: { directory?: string }): Promise<SessionHandle> {
    const directory = await this.ensureDirectory(input?.directory);
    this.resolveSessionIds(id);
    return this.makeSessionHandle(directory, id);
  }

  private toOpenGuiBridgeError(error: unknown): OpenGuiSdkError {
    if (error instanceof OpenGuiSdkError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new OpenGuiSdkError("BRIDGE_ERROR", message);
  }

  async prompt(input: {
    directory?: string;
    sessionId: string;
    text: string;
    model?: SelectedModel;
    agent?: string;
    variant?: string;
  }): Promise<void> {
    const directory = await this.ensureDirectory(input.directory);
    const { rawId } = this.resolveSessionIds(input.sessionId);
    const status = this.sessionStatus.get(sessionStatusKey(directory, this.harnessId, rawId));
    if (status === "running") {
      throw new OpenGuiSdkError(
        "SESSION_BUSY",
        "Session is running; SDK does not queue prompts. Wait for idle or call abort().",
      );
    }
    const now = new Date().toISOString();
    const session = {
      id: input.sessionId,
      rawId,
      directory,
      harnessId: this.harnessId,
      title: "",
      status: status ?? "unknown",
      createdAt: now,
      updatedAt: now,
    };
    await this.service.promptSession({
      session,
      scope: {
        directory,
        harnessId: this.harnessId,
        sessionId: rawId,
      },
      text: input.text,
      model: input.model,
      agent: input.agent,
      variant: input.variant,
    });
    this.sessionStatus.set(sessionStatusKey(directory, this.harnessId, rawId), "running");
  }

  async abort(input: { directory?: string; sessionId: string }): Promise<void> {
    const directory = await this.ensureDirectory(input.directory);
    const { rawId } = this.resolveSessionIds(input.sessionId);
    const now = new Date().toISOString();
    await this.service.abortSession({
      session: {
        id: input.sessionId,
        rawId,
        directory,
        harnessId: this.harnessId,
        title: "",
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
      scope: {
        directory,
        harnessId: this.harnessId,
        sessionId: rawId,
      },
    });
    this.sessionStatus.set(sessionStatusKey(directory, this.harnessId, rawId), "idle");
  }

  async loadResources(input?: { directory?: string }): Promise<HarnessResourceBundle> {
    const directory = await this.ensureDirectory(input?.directory);
    return await this.service.loadResources({
      scopeRef: directoryRef(directory),
      scope: {
        directory,
        harnessId: this.harnessId,
      },
    });
  }

  async messages(input: {
    directory?: string;
    sessionId: string;
    limit?: number;
    before?: string | null;
  }): Promise<unknown> {
    const directory = await this.ensureDirectory(input.directory);
    const { rawId } = this.resolveSessionIds(input.sessionId);
    const now = new Date().toISOString();
    return await this.service.listMessages({
      session: {
        id: input.sessionId,
        rawId,
        directory,
        harnessId: this.harnessId,
        title: "",
        status: "unknown",
        createdAt: now,
        updatedAt: now,
      },
      scope: {
        directory,
        harnessId: this.harnessId,
        sessionId: rawId,
      },
      options: {
        limit: input.limit,
        before: input.before,
      },
    });
  }

  async directoryStatus(input?: {
    directory?: string;
  }): Promise<
    Record<
      string,
      { connected: boolean; statuses: Record<string, { type: string }>; error?: string }
    >
  > {
    const directory = await this.resolveDirectoryInput(input?.directory);
    return await this.service.getDirectoryStatus({
      directory,
      harnessIds: [this.harnessId],
    });
  }

  private resolveSessionIds(sessionId: string): { rawId: string } {
    const parsed = parseFrontendSessionId(sessionId);
    if (parsed) {
      if (parsed.harnessId !== this.harnessId) {
        throw new OpenGuiSdkError(
          "HARNESS_MISMATCH",
          `Session id is for harness "${parsed.harnessId}", not "${this.harnessId}"`,
        );
      }
      return { rawId: parsed.rawId };
    }
    return { rawId: sessionId };
  }
}

class OpenGUIImpl implements OpenGUI {
  private readonly service: HarnessService;
  private readonly resolveDirectory: (path: string) => Promise<string>;
  private readonly loadedHarnessIds: ReadonlySet<ManagedHarnessId>;
  private readonly handles = new Map<ManagedHarnessId, HarnessHandleImpl>();
  /** All handles per harness (primary + `og.at().harness()` bindings) for event fan-in. */
  private readonly handlesByHarness = new Map<ManagedHarnessId, Set<HarnessHandleImpl>>();
  private readonly sender: InProcessIpcSender;
  private closed = false;

  constructor(input: {
    service: HarnessService;
    allowedRoots: string[];
    sender: InProcessIpcSender;
    loadedHarnessIds: readonly ManagedHarnessId[];
  }) {
    this.service = input.service;
    this.resolveDirectory = (path) => resolveSafeDirectory(path, input.allowedRoots);
    this.sender = input.sender;
    this.loadedHarnessIds = new Set(input.loadedHarnessIds);
  }

  private trackHarnessHandle(handle: HarnessHandleImpl) {
    let set = this.handlesByHarness.get(handle.harnessId);
    if (!set) {
      set = new Set();
      this.handlesByHarness.set(handle.harnessId, set);
    }
    set.add(handle);
  }

  routeBridgeEvent(harnessId: ManagedHarnessId, event: HarnessEvent) {
    const targets = this.handlesByHarness.get(harnessId);
    if (!targets?.size) {
      const primary = this.handles.get(harnessId);
      primary?.ingestCanonicalEvent(event);
      return;
    }
    for (const handle of targets) {
      handle.ingestCanonicalEvent(event);
    }
  }

  async at(directoryInput: string): Promise<DirectoryHandle> {
    const path = await this.resolveDirectory(directoryInput);
    return createDirectoryHandle({ path, runtime: this });
  }

  createBoundHarness(harnessId: HarnessId, directoryPath: string): HarnessHandle {
    if (!isManagedHarnessId(harnessId) || !this.loadedHarnessIds.has(harnessId)) {
      throw new OpenGuiSdkError(
        "UNKNOWN_HARNESS",
        `Unknown or unloaded harness "${String(harnessId)}". Loaded: ${[...this.loadedHarnessIds].join(", ")}`,
      );
    }
    const handle = new HarnessHandleImpl(
      harnessId,
      this.service,
      this.resolveDirectory,
      directoryPath,
    );
    this.trackHarnessHandle(handle);
    return handle;
  }

  harness(harnessId: HarnessId): HarnessHandle {
    if (!isManagedHarnessId(harnessId) || !this.loadedHarnessIds.has(harnessId)) {
      throw new OpenGuiSdkError(
        "UNKNOWN_HARNESS",
        `Unknown or unloaded harness "${String(harnessId)}". Loaded: ${[...this.loadedHarnessIds].join(", ")}`,
      );
    }
    let handle = this.handles.get(harnessId);
    if (!handle) {
      handle = new HarnessHandleImpl(harnessId, this.service, this.resolveDirectory);
      this.handles.set(harnessId, handle);
      this.trackHarnessHandle(handle);
    }
    return handle;
  }

  async registerDirectory(input: {
    directory: string;
    harnessIds?: HarnessId[];
  }): Promise<DirectoryRegisterResult> {
    const directory = await this.resolveDirectory(input.directory);
    const harnessIds = input.harnessIds?.length
      ? input.harnessIds.filter(isManagedHarnessId)
      : [...MANAGED_HARNESS_IDS];
    return await this.service.registerDirectory({ directory, harnessIds });
  }

  async releaseDirectory(input: { directory: string; harnessIds?: HarnessId[] }): Promise<void> {
    const directory = await this.resolveDirectory(input.directory);
    const harnessIds = input.harnessIds?.length
      ? input.harnessIds.filter(isManagedHarnessId)
      : [...MANAGED_HARNESS_IDS];
    await this.service.releaseDirectory({ directory, harnessIds });
    for (const handle of this.handles.values()) {
      await handle.releaseDirectory({ directory }).catch(() => undefined);
    }
  }

  getHarnessInventories(): HarnessInventory[] {
    return getHarnessInventories();
  }

  diagnose(): OpenGUIDiagnoseResult {
    return diagnoseFromInventories(this.getHarnessInventories());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.service.shutdownHarnessClients();
    this.sender.destroy?.();
  }
}

/** Create an in-process OpenGUI Runtime instance (SDK v1). */
export async function createOpenGUI(options: CreateOpenGUIOptions): Promise<OpenGUI> {
  const trimmedRoots = options.allowedRoots.map((entry) => entry.trim()).filter(Boolean);
  if (!trimmedRoots.length) {
    throw new OpenGuiSdkError("INVALID_OPTIONS", "allowedRoots must include at least one path");
  }
  const allowedRoots = normalizeAllowedRoots(trimmedRoots);

  const dataDir = resolve(options.dataDir ?? join(homedir(), ".config", "opengui-runtime"));
  await mkdir(dataDir, { recursive: true });

  let runtime: OpenGUIImpl | undefined;

  const broadcast = (channel: string, data: unknown) => {
    const harnessId = getHarnessIdFromBridgeChannel(channel);
    if (!harnessId || !runtime) return;
    let normalized: HarnessEvent | null;
    try {
      normalized = normalizeBridgeEvent({ harnessId, event: data });
    } catch {
      return;
    }
    if (!normalized) return;
    runtime.routeBridgeEvent(harnessId, normalized);
  };

  const ipcMain = new InProcessIpcMain();
  const sender = new InProcessIpcSender(broadcast);
  const host = createRuntimeHost({
    ipcMain,
    sender,
    dataDir,
    broadcast,
    harnessIds: options.harnesses,
  });
  const service = createHarnessService({
    invoke: <T>(channel: string, args: unknown[] = []) =>
      ipcMain.invoke(channel, { sender }, args) as Promise<T>,
    controls: host.controls,
    managedHarnessIds: host.managedHarnessIds,
  });

  runtime = new OpenGUIImpl({
    service,
    allowedRoots,
    sender,
    loadedHarnessIds: host.managedHarnessIds,
  });

  for (const harnessId of host.managedHarnessIds) {
    runtime.harness(harnessId);
  }

  return runtime;
}
