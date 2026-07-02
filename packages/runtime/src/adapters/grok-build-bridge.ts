import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { GrokAcpClient } from "../../../../lib/grok-acp-client.ts";
import {
  makeHarnessProjectKey as makeProjectKey,
  makeHarnessSessionIdCodec,
  normalizeHarnessDirectory as normalizeDir,
  nowHarnessConnection as nowConnection,
} from "./harness-adapter-kit.ts";
import {
  makeHarnessBridgeEventEmitter,
  registerObjectTargetHarnessRpcHandlers,
  type ObjectTargetHarnessManager,
} from "./harness-adapter-host.ts";
import {
  buildGrokProvidersFromModelState,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  resolveSelectedModelId,
} from "./grok-build-models.ts";
import {
  defaultAssistantInfo,
  defaultUserInfo,
  getSessionPreview,
  makeReasoningPart,
  makeSessionTitle,
  makeTextPart,
  upsertMessage,
} from "./grok-build-bridge-mapping.ts";

const GROK_BUILD_SESSION_PREFIX = "grok-build:";
const { toFrontendSessionId, toRawSessionId } =
  makeHarnessSessionIdCodec(GROK_BUILD_SESSION_PREFIX);

type GrokProjectSlot = { key?: string; directory: string; workspaceId?: string };

type GrokSessionRecord = {
  id: string;
  directory: string;
  workspaceId?: string;
  title?: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  modelId?: string;
  activity?: string;
  origin?: string;
  hidden?: boolean;
};

type GrokMessageBundle = {
  info: Record<string, unknown> & { id: string; time?: { created?: number; completed?: number } };
  parts: Array<Record<string, unknown> & { id?: string; text?: string; time?: { start?: number } }>;
};

type GrokLiveSession = {
  grokSessionId: string;
  project: GrokProjectSlot;
  session: Record<string, unknown> & { id: string; title?: string; time?: { updated?: number } };
  messages: GrokMessageBundle[];
  running: boolean;
  aborted: boolean;
  abortRequested: boolean;
  turnIdleEmitted: boolean;
  pendingPrompt: Promise<unknown> | null;
  currentAssistantMessageId: string | null;
  currentUserMessageId: string | null;
  currentModelId: string;
  createdAt: number;
};

type GrokProjectTarget = { directory?: string; workspaceId?: string };

function findMessage(messages: GrokMessageBundle[], messageId: string) {
  return messages.find((entry) => entry.info.id === messageId) ?? null;
}

class GrokBuildBridgeManager {
  getAllWindows: () => Iterable<unknown>;
  emitBridgeEvent: (event: Record<string, unknown>) => void;
  projects: Map<string, GrokProjectSlot>;
  sessionIndex: Map<string, GrokSessionRecord>;
  liveSessions: Map<string, GrokLiveSession>;
  acp: GrokAcpClient;
  providerCache: ReturnType<typeof buildGrokProvidersFromModelState> | null;
  availableCommands: unknown[];
  acpReady: Promise<void> | null;

  constructor(
    getAllWindows: () => Iterable<{ webContents: { send: (ch: string, ...a: unknown[]) => void } }>,
  ) {
    this.getAllWindows = getAllWindows;
    this.emitBridgeEvent = makeHarnessBridgeEventEmitter("grok-build", getAllWindows);
    this.projects = new Map();
    this.sessionIndex = new Map();
    this.liveSessions = new Map();
    this.acp = new GrokAcpClient({
      onNotification: (notification) => this.handleAcpNotification(notification),
    });
    this.providerCache = null;
    this.availableCommands = [];
    this.acpReady = null;
  }

  emit(event: Record<string, unknown>) {
    this.emitBridgeEvent(event);
  }

  emitConnection(project: GrokProjectSlot, status: Record<string, unknown>) {
    this.emit({
      type: "connection:status",
      directory: project.directory,
      workspaceId: project.workspaceId,
      payload: status,
    });
  }

  emitBackend(project: GrokProjectSlot | null | undefined, payload: Record<string, unknown>) {
    this.emit({
      type: "grok-build:event",
      directory: project?.directory,
      workspaceId: project?.workspaceId,
      payload,
    });
  }

  async ensureAcp() {
    if (!this.acpReady) {
      this.acpReady = (async () => {
        await this.acp.ensureReady();
        await this.acp.authenticate();
        const meta = this.acp.initResult?._meta as
          | { modelState?: unknown; availableCommands?: unknown[] }
          | undefined;
        const modelState = meta?.modelState;
        this.providerCache = buildGrokProvidersFromModelState(
          modelState as Parameters<typeof buildGrokProvidersFromModelState>[0],
        );
        const commands = meta?.availableCommands;
        this.availableCommands = Array.isArray(commands) ? commands : [];
      })();
    }
    try {
      await this.acpReady;
    } catch (error) {
      this.acpReady = null;
      throw error;
    }
  }

  resetAcp() {
    this.acpReady = null;
    this.providerCache = null;
    this.availableCommands = [];
    void this.acp.close();
    this.acp = new GrokAcpClient({
      onNotification: (notification) => this.handleAcpNotification(notification),
    });
  }

  ensureKnownProject(directory: string | undefined, workspaceId: string | undefined) {
    const normalized = normalizeDir(directory);
    if (!normalized) throw new Error("Project directory is required");
    const key = makeProjectKey(workspaceId, normalized);
    let project = this.projects.get(key);
    if (!project) {
      project = { key, directory: normalized, workspaceId };
      this.projects.set(key, project);
    }
    return project;
  }

  getLiveSession(sessionId: string) {
    const rawId = toRawSessionId(sessionId);
    return this.liveSessions.get(rawId) ?? this.liveSessions.get(sessionId) ?? null;
  }

  emitSessionStatus(live: GrokLiveSession, statusType: string) {
    this.emitBackend(live.project, {
      type: "session.status",
      sessionID: live.session.id,
      status: { type: statusType },
    });
  }

  finalizeAssistantMessage(live: GrokLiveSession) {
    if (!live.currentAssistantMessageId) return;
    const bundle = findMessage(live.messages, live.currentAssistantMessageId);
    if (!bundle) return;
    const info = {
      ...bundle.info,
      time: {
        ...bundle.info.time,
        completed: Date.now(),
      },
    };
    bundle.info = info;
    this.emitBackend(live.project, { type: "message.updated", message: info });
  }

  finishPromptTurn(live: GrokLiveSession | null, { force = false } = {}) {
    if (!live) return;
    if (!force && !live.running && live.turnIdleEmitted) return;
    live.running = false;
    live.pendingPrompt = null;
    live.abortRequested = false;
    live.turnIdleEmitted = true;
    this.finalizeAssistantMessage(live);
    void this.syncSessionRecord(live);
    this.emitSessionStatus(live, "idle");
  }

  async ensureLiveSessionForPrompt(
    sessionId: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    const live = this.getLiveSession(sessionId);
    if (live) return live;
    const rawId = toRawSessionId(sessionId);
    const record = this.sessionIndex.get(rawId);
    if (!record) throw new Error("Grok Build session not found");
    const project = this.ensureKnownProject(
      directory || record.directory,
      workspaceId ?? record.workspaceId,
    );
    const session = this.buildSessionFromRecord(record);
    const createdAt = record.createdAt ?? Date.now();
    const resumed = {
      grokSessionId: rawId,
      project,
      session,
      messages: [],
      running: false,
      aborted: false,
      abortRequested: false,
      turnIdleEmitted: true,
      currentAssistantMessageId: null,
      currentUserMessageId: null,
      currentModelId: record.modelId ?? DEFAULT_MODEL_ID,
      createdAt,
      pendingPrompt: null,
    };
    this.liveSessions.set(rawId, resumed);
    return resumed;
  }

  buildSession({
    id,
    directory,
    workspaceId,
    title,
    createdAt,
    updatedAt,
    modelId,
  }: {
    id: string;
    directory: string;
    workspaceId?: string;
    title?: string;
    createdAt?: number;
    updatedAt?: number;
    modelId?: string;
  }) {
    const rawId = toRawSessionId(id);
    const frontendId = toFrontendSessionId(rawId);
    return {
      id: frontendId,
      slug: frontendId,
      _harnessId: "grok-build",
      _rawId: rawId,
      projectID: directory,
      workspaceID: workspaceId,
      directory,
      title: title || "Untitled",
      version: "grok-build",
      model: modelId
        ? {
            providerID: DEFAULT_PROVIDER_ID,
            id: modelId,
          }
        : undefined,
      time: {
        created: createdAt ?? Date.now(),
        updated: updatedAt ?? createdAt ?? Date.now(),
      },
    };
  }

  buildSessionFromRecord(record: GrokSessionRecord) {
    return this.buildSession({
      id: record.id,
      directory: record.directory,
      workspaceId: record.workspaceId,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      modelId: record.modelId,
    });
  }

  handleAcpNotification(notification: { method?: string; params?: Record<string, unknown> }) {
    const method = notification?.method;
    const params = notification?.params ?? {};

    if (method === "_x.ai/sessions/changed") {
      const upserted = Array.isArray(params.upserted) ? params.upserted : [];
      for (const entry of upserted) {
        const row = entry as Record<string, unknown>;
        this.indexDiscoveredSession(row);
        const activity = row.activity;
        const live = this.getLiveSession(String(row.sessionId ?? ""));
        if (!live) continue;
        if (activity === "idle" && live.running) {
          this.finishPromptTurn(live);
        }
      }
      return;
    }

    if (method === "_x.ai/models/update") {
      this.providerCache = buildGrokProvidersFromModelState(
        params as Parameters<typeof buildGrokProvidersFromModelState>[0],
      );
      return;
    }

    if (method === "session/update") {
      const sessionId = String(params.sessionId ?? "");
      const update = (params.update ?? {}) as Record<string, unknown>;
      const live = this.getLiveSession(sessionId);
      if (!live || live.aborted) return;
      this.handleSessionUpdate(live, update);
      return;
    }

    if (method === "_x.ai/session/prompt_complete") {
      const live = this.getLiveSession(String(params.sessionId ?? ""));
      if (!live) return;
      this.finishPromptTurn(live);
    }
  }

  indexDiscoveredSession(entry: Record<string, unknown>) {
    const rawId = String(entry?.sessionId ?? "").trim();
    const directory = normalizeDir(
      typeof entry.cwd === "string" ? entry.cwd : undefined,
    );
    if (!rawId || !directory) return;
    const existing = this.sessionIndex.get(rawId);
    const now = Date.now();
    this.sessionIndex.set(rawId, {
      id: rawId,
      directory,
      workspaceId: existing?.workspaceId,
      title: String(entry.title ?? existing?.title ?? "Untitled"),
      preview: existing?.preview || "",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      modelId: String(entry.modelId ?? existing?.modelId ?? DEFAULT_MODEL_ID),
      activity: typeof entry.activity === "string" ? entry.activity : existing?.activity,
      origin: existing?.origin ?? "grok",
      hidden: existing?.hidden ?? false,
    });
  }

  handleSessionUpdate(live: GrokLiveSession, update: Record<string, unknown>) {
    const sessionUpdate = update.sessionUpdate;
    if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") {
      const content = update.content as { text?: string } | undefined;
      const text = content?.text ?? "";
      if (!text) return;
      const bundle = this.ensureAssistantMessage(live);
      const partId = `${bundle.info.id}:${sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text"}`;
      const existingPart = bundle.parts.find((p) => p.id === partId);
      const nextText = `${existingPart?.text ?? ""}${text}`;
      const part =
        sessionUpdate === "agent_thought_chunk"
          ? makeReasoningPart(
              live.session.id,
              bundle.info.id,
              partId,
              nextText,
              existingPart?.time?.start,
            )
          : makeTextPart(live.session.id, bundle.info.id, partId, nextText);
      if (existingPart) {
        Object.assign(existingPart, part);
      } else {
        bundle.parts.push(part);
      }
      this.emitBackend(live.project, {
        type: "message.part.delta",
        sessionID: live.session.id,
        messageID: bundle.info.id,
        partID: partId,
        field: "text",
        delta: text,
      });
      if (!existingPart) {
        this.emitBackend(live.project, { type: "message.part.updated", part });
      }
      return;
    }

    if (sessionUpdate === "available_commands_update") {
      const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      if (commands.length) this.availableCommands = commands;
    }
  }

  appendSyntheticUserMessage(live: GrokLiveSession, text: string, modelId: string) {
    const messageId = randomUUID();
    live.currentModelId = modelId;
    const info = defaultUserInfo(live.session.id, messageId, modelId);
    const part = makeTextPart(live.session.id, messageId, randomUUID(), String(text ?? ""), true);
    const bundle = { info, parts: [part] };
    live.messages.push(bundle);
    live.currentUserMessageId = messageId;
    this.emitBackend(live.project, { type: "message.updated", message: info });
    this.emitBackend(live.project, { type: "message.part.updated", part });
  }

  ensureAssistantMessage(live: GrokLiveSession) {
    if (live.currentAssistantMessageId) {
      const existing = findMessage(live.messages, live.currentAssistantMessageId);
      if (existing) return existing;
    }
    const messageId = randomUUID();
    const info = defaultAssistantInfo(
      live.session.id,
      messageId,
      live.project.directory,
      live.currentModelId,
    );
    info.parentID = live.currentUserMessageId ?? "";
    const bundle = upsertMessage(live.messages, info) as GrokMessageBundle;
    live.currentAssistantMessageId = messageId;
    this.emitBackend(live.project, { type: "message.updated", message: info });
    return bundle;
  }

  async syncSessionRecord(live: GrokLiveSession, emitEvent = true) {
    const now = Date.now();
    const rawId = toRawSessionId(live.session.id);
    const preview = getSessionPreview(
      live.messages as Parameters<typeof getSessionPreview>[0],
    );
    const existing = this.sessionIndex.get(rawId);
    const title =
      live.session.title && live.session.title !== "Untitled"
        ? live.session.title
        : makeSessionTitle(preview, existing?.title);
    const record = {
      id: rawId,
      directory: live.project.directory,
      workspaceId: live.project.workspaceId,
      title,
      preview,
      createdAt: existing?.createdAt ?? live.createdAt,
      updatedAt: now,
      modelId: live.currentModelId ?? existing?.modelId ?? DEFAULT_MODEL_ID,
      origin: existing?.origin ?? "opengui",
      hidden: existing?.hidden ?? false,
    };
    this.sessionIndex.set(rawId, record);
    live.session = this.buildSessionFromRecord(record);
    if (emitEvent) {
      this.emitBackend(live.project, {
        type: "session.updated",
        directory: live.project.directory,
        workspaceId: live.project.workspaceId,
        session: live.session,
      });
    }
  }

  async addProject(config: GrokProjectTarget) {
    const project = this.ensureKnownProject(config?.directory, config?.workspaceId);
    try {
      const info = await stat(project.directory);
      if (!info.isDirectory()) {
        throw new Error(`${project.directory} is not a directory`);
      }
    } catch (error) {
      this.emitConnection(
        project,
        nowConnection({
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
    this.emitConnection(project, nowConnection({ state: "connected" }));
  }

  async removeProject(target: GrokProjectTarget) {
    const directory = normalizeDir(target?.directory);
    if (!directory) return;
    const key = makeProjectKey(target?.workspaceId, directory);
    const project = this.projects.get(key) ?? { directory, workspaceId: target?.workspaceId };
    for (const [sessionId, live] of this.liveSessions.entries()) {
      if (
        live.project.directory === directory &&
        live.project.workspaceId === target?.workspaceId
      ) {
        this.liveSessions.delete(sessionId);
      }
    }
    this.projects.delete(key);
    this.emitConnection(project, nowConnection({ state: "idle" }));
  }

  disconnect() {
    for (const project of this.projects.values()) {
      this.emitConnection(project, nowConnection({ state: "idle" }));
    }
    this.projects.clear();
    this.liveSessions.clear();
    this.sessionIndex.clear();
    this.resetAcp();
  }

  async listSessions(target: GrokProjectTarget = {}) {
    const directory = normalizeDir(target.directory);
    const workspaceId = target.workspaceId;
    const byId = new Map();
    for (const live of this.liveSessions.values()) {
      if (directory && live.project.directory !== directory) continue;
      if (workspaceId !== undefined && live.project.workspaceId !== workspaceId) continue;
      byId.set(live.session.id, live.session);
    }
    for (const record of this.sessionIndex.values()) {
      if (record.hidden) continue;
      if (directory && record.directory !== directory) continue;
      if (workspaceId !== undefined && record.workspaceId !== workspaceId) continue;
      byId.set(toFrontendSessionId(record.id), this.buildSessionFromRecord(record));
    }
    return [...byId.values()].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  }

  async createSession(input: Record<string, unknown> = {}) {
    const project = this.ensureKnownProject(
      typeof input.directory === "string" ? input.directory : undefined,
      typeof input.workspaceId === "string" ? input.workspaceId : undefined,
    );
    await this.ensureAcp();
    const now = Date.now();
    const created = (await this.acp.request("session/new", {
      cwd: project.directory,
      mcpServers: [],
    })) as { sessionId?: string };
    const sessionId = String(created.sessionId ?? "");
    const rawId = toRawSessionId(sessionId);
    const session = this.buildSession({
      id: rawId,
      directory: project.directory,
      workspaceId: project.workspaceId,
      title: makeSessionTitle("", typeof input.title === "string" ? input.title : undefined),
      createdAt: now,
      updatedAt: now,
      modelId: DEFAULT_MODEL_ID,
    });
    const live = {
      grokSessionId: rawId,
      project,
      session,
      messages: [],
      running: false,
      aborted: false,
      abortRequested: false,
      turnIdleEmitted: true,
      pendingPrompt: null,
      currentAssistantMessageId: null,
      currentUserMessageId: null,
      currentModelId: DEFAULT_MODEL_ID,
      createdAt: now,
    };
    this.liveSessions.set(rawId, live);
    this.sessionIndex.set(rawId, {
      id: rawId,
      directory: project.directory,
      workspaceId: project.workspaceId,
      title: session.title,
      preview: "",
      createdAt: now,
      updatedAt: now,
      modelId: DEFAULT_MODEL_ID,
      origin: "opengui",
      hidden: false,
    });
    this.emitBackend(project, {
      type: "session.created",
      directory: project.directory,
      workspaceId: project.workspaceId,
      session,
    });
    return session;
  }

  async getMessages(sessionId: string, target: GrokProjectTarget = {}) {
    const live = this.getLiveSession(sessionId);
    if (live) return live.messages;
    const rawId = toRawSessionId(sessionId);
    const record = this.sessionIndex.get(rawId);
    if (!record) return [];
    if (target.directory && record.directory !== normalizeDir(target.directory)) return [];
    return [];
  }

  async getProviders() {
    await this.ensureAcp();
    return (
      this.providerCache ??
      buildGrokProvidersFromModelState(
        (this.acp.initResult?._meta as { modelState?: unknown } | undefined)?.modelState as
          Parameters<typeof buildGrokProvidersFromModelState>[0],
      )
    );
  }

  async getCommands() {
    await this.ensureAcp();
    const cmds = (this.availableCommands ?? []).filter(
      (c): c is { name: string; description?: string } =>
        Boolean(c && typeof c === "object" && typeof (c as { name?: string }).name === "string"),
    );
    return cmds.map((command) => ({
      name: command.name,
      description: command.description ?? command.name,
      source: "command",
      template: `/${command.name}`,
      hints: [],
    }));
  }

  async getAgents() {
    return [];
  }

  async getSessionStatuses(target: GrokProjectTarget = {}) {
    const directory = normalizeDir(target.directory);
    const workspaceId = target.workspaceId;
    const statuses: Record<string, { type: string }> = {};
    for (const live of this.liveSessions.values()) {
      if (directory && live.project.directory !== directory) continue;
      if (workspaceId !== undefined && live.project.workspaceId !== workspaceId) continue;
      statuses[live.session.id] = { type: live.running ? "busy" : "idle" };
    }
    for (const record of this.sessionIndex.values()) {
      if (record.hidden) continue;
      if (directory && record.directory !== directory) continue;
      if (workspaceId !== undefined && record.workspaceId !== workspaceId) continue;
      const frontendId = toFrontendSessionId(record.id);
      if (statuses[frontendId]) continue;
      statuses[frontendId] = {
        type: record.activity === "working" ? "busy" : "idle",
      };
    }
    return statuses;
  }

  async prompt(
    sessionId: string,
    text: string,
    _images: unknown,
    model: unknown,
    _agent: unknown,
    _variant: unknown,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    const live = await this.ensureLiveSessionForPrompt(sessionId, directory, workspaceId);
    if (live.running) {
      throw new Error("Grok Build session already running");
    }
    const project = this.ensureKnownProject(
      directory || live.project.directory,
      workspaceId ?? live.project.workspaceId,
    );
    live.project = project;
    await this.ensureAcp();
    const modelId = resolveSelectedModelId(
      model as Parameters<typeof resolveSelectedModelId>[0],
    );
    live.currentModelId = modelId;
    live.running = true;
    live.turnIdleEmitted = false;
    live.aborted = false;
    live.abortRequested = false;
    live.currentAssistantMessageId = null;
    this.appendSyntheticUserMessage(live, text, modelId);
    this.emitSessionStatus(live, "busy");
    void this.runPromptTurn(live, String(text ?? ""), modelId).catch((error) => {
      if (live.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.finishPromptTurn(live, { force: true });
      this.emitBackend(live.project, {
        type: "session.error",
        sessionID: live.session.id,
        error: message,
      });
    });
  }

  async runPromptTurn(live: GrokLiveSession, text: string, modelId: string) {
    try {
      await this.acp.request("session/set_model", {
        sessionId: live.grokSessionId,
        modelId,
      });
    } catch (error) {
      console.warn("Grok Build model switch failed:", error);
    }
    if (live.aborted) return;
    try {
      live.pendingPrompt = this.acp.request(
        "session/prompt",
        {
          sessionId: live.grokSessionId,
          prompt: [{ type: "text", text }],
        },
        { timeoutMs: 0 },
      );
      await live.pendingPrompt;
    } finally {
      live.pendingPrompt = null;
      if (!live.aborted && live.running) {
        this.finishPromptTurn(live);
      }
    }
  }

  async startSession(input: Record<string, unknown> = {}) {
    const session = await this.createSession(input);
    if (typeof input.text === "string" && input.text) {
      await this.prompt(
        session.id,
        input.text,
        input.images,
        input.model,
        input.agent,
        input.variant,
        typeof input.directory === "string" ? input.directory : undefined,
        typeof input.workspaceId === "string" ? input.workspaceId : undefined,
      );
    }
    return session;
  }

  async deleteSession(sessionId: string, target: GrokProjectTarget = {}) {
    const rawId = toRawSessionId(sessionId);
    const live = this.getLiveSession(rawId);
    const record = this.sessionIndex.get(rawId);
    const directory = normalizeDir(
      target.directory || live?.project.directory || record?.directory,
    );
    const workspaceId = target.workspaceId ?? live?.project.workspaceId ?? record?.workspaceId;
    this.liveSessions.delete(rawId);
    this.sessionIndex.delete(rawId);
    if (directory) {
      this.emitBackend(
        { directory, workspaceId },
        {
          type: "session.deleted",
          directory,
          workspaceId,
          sessionId: toFrontendSessionId(rawId),
        },
      );
    }
    return true;
  }

  async updateSession(sessionId: string, title: string, _target: GrokProjectTarget = {}) {
    const live = this.getLiveSession(sessionId);
    const rawId = toRawSessionId(sessionId);
    const record = this.sessionIndex.get(rawId);
    if (!live && !record) throw new Error("Grok Build session not found");
    const nextTitle = String(title ?? "").trim();
    if (record) {
      record.title = nextTitle || record.title;
      record.updatedAt = Date.now();
      this.sessionIndex.set(rawId, record);
    }
    if (live) {
      live.session = {
        ...live.session,
        title: nextTitle || live.session.title,
        time: { ...live.session.time, updated: Date.now() },
      };
      this.emitBackend(live.project, {
        type: "session.updated",
        directory: live.project.directory,
        workspaceId: live.project.workspaceId,
        session: live.session,
      });
      return live.session;
    }
    if (!record) throw new Error("Grok Build session not found");
    return this.buildSessionFromRecord(record);
  }

  async abort(sessionId: string) {
    const live = this.getLiveSession(sessionId);
    if (!live) return true;
    live.abortRequested = true;
    live.aborted = true;
    this.finishPromptTurn(live, { force: true });
    return true;
  }

  async sendCommand(
    sessionId: string,
    command: string,
    args: string,
    model: unknown,
    agent: unknown,
    variant: unknown,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    const text = `/${command}${args ? ` ${args}` : ""}`;
    await this.prompt(sessionId, text, [], model, agent, variant, directory, workspaceId);
  }

  async summarizeSession(
    sessionId: string,
    model: unknown,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    await this.sendCommand(
      sessionId,
      "compact",
      "",
      model,
      undefined,
      undefined,
      directory,
      workspaceId,
    );
  }
}

export function setupGrokBuildBridge(
  ipcMain: Parameters<typeof registerObjectTargetHarnessRpcHandlers>[1],
  getAllWindows: () => Iterable<{ webContents: { send: (ch: string, ...a: unknown[]) => void } }>,
) {
  let manager = new GrokBuildBridgeManager(getAllWindows);

  registerObjectTargetHarnessRpcHandlers("grok-build", ipcMain, () =>
    manager as unknown as ObjectTargetHarnessManager,
  );

  return {
    async restart() {
      manager.disconnect();
      manager = new GrokBuildBridgeManager(getAllWindows);
      return true;
    },
  };
}
