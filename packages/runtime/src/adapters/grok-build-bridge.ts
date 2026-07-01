// @ts-nocheck
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
} from "./harness-adapter-host.ts";
import {
  buildGrokProvidersFromModelState,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  resolveSelectedModelId,
} from "./grok-build-models.ts";

const GROK_BUILD_SESSION_PREFIX = "grok-build:";
const { toFrontendSessionId, toRawSessionId } =
  makeHarnessSessionIdCodec(GROK_BUILD_SESSION_PREFIX);

function firstLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function makeSessionTitle(text, fallback = "Untitled") {
  const line = firstLine(text);
  return line.slice(0, 80) || fallback;
}

function defaultUserInfo(sessionId, messageId, modelId, createdAt = Date.now()) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created: createdAt },
    agent: "grok-build",
    model: {
      providerID: DEFAULT_PROVIDER_ID,
      modelID: modelId,
    },
  };
}

function defaultAssistantInfo(sessionId, messageId, directory, modelId, createdAt = Date.now()) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: createdAt },
    parentID: "",
    modelID: modelId,
    providerID: DEFAULT_PROVIDER_ID,
    mode: "grok-build",
    agent: "grok-build",
    path: {
      cwd: directory,
      root: directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function makeTextPart(sessionId, messageId, partId, text, synthetic = false) {
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
  };
}

function makeReasoningPart(sessionId, messageId, partId, text, start = Date.now()) {
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: "reasoning",
    text,
    time: { start },
  };
}

function upsertMessage(messages, info) {
  const existing = messages.find((entry) => entry.info.id === info.id);
  if (existing) {
    existing.info = { ...existing.info, ...info };
    return existing;
  }
  const bundle = { info, parts: [] };
  messages.push(bundle);
  return bundle;
}

function findMessage(messages, messageId) {
  return messages.find((entry) => entry.info.id === messageId) ?? null;
}

function getSessionPreview(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.info.role !== "user") continue;
    for (const part of entry.parts) {
      if (part.type === "text" && part.text) return part.text;
    }
  }
  return "";
}

class GrokBuildBridgeManager {
  constructor(getAllWindows) {
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

  emit(event) {
    this.emitBridgeEvent(event);
  }

  emitConnection(project, status) {
    this.emit({
      type: "connection:status",
      directory: project.directory,
      workspaceId: project.workspaceId,
      payload: status,
    });
  }

  emitBackend(project, payload) {
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
        const modelState = this.acp.initResult?._meta?.modelState;
        this.providerCache = buildGrokProvidersFromModelState(modelState);
        const commands = this.acp.initResult?._meta?.availableCommands;
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

  ensureKnownProject(directory, workspaceId) {
    const normalized = normalizeDir(directory);
    if (!normalized) throw new Error("Project directory is required");
    const key = makeProjectKey(workspaceId, normalized);
    let project = this.projects.get(key);
    if (!project) {
      project = { directory: normalized, workspaceId };
      this.projects.set(key, project);
    }
    return project;
  }

  getLiveSession(sessionId) {
    const rawId = toRawSessionId(sessionId);
    return this.liveSessions.get(rawId) ?? this.liveSessions.get(sessionId) ?? null;
  }

  emitSessionStatus(live, statusType) {
    this.emitBackend(live.project, {
      type: "session.status",
      sessionID: live.session.id,
      status: { type: statusType },
    });
  }

  finalizeAssistantMessage(live) {
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

  finishPromptTurn(live, { force = false } = {}) {
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

  async ensureLiveSessionForPrompt(sessionId, directory, workspaceId) {
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

  buildSession({ id, directory, workspaceId, title, createdAt, updatedAt, modelId }) {
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

  buildSessionFromRecord(record) {
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

  handleAcpNotification(notification) {
    const method = notification?.method;
    const params = notification?.params ?? {};

    if (method === "_x.ai/sessions/changed") {
      const upserted = Array.isArray(params.upserted) ? params.upserted : [];
      for (const entry of upserted) {
        this.indexDiscoveredSession(entry);
        const activity = entry?.activity;
        const live = this.getLiveSession(entry?.sessionId);
        if (!live) continue;
        if (activity === "idle" && live.running) {
          this.finishPromptTurn(live);
        }
      }
      return;
    }

    if (method === "_x.ai/models/update") {
      this.providerCache = buildGrokProvidersFromModelState(params);
      return;
    }

    if (method === "session/update") {
      const sessionId = params.sessionId;
      const update = params.update ?? {};
      const live = this.getLiveSession(sessionId);
      if (!live || live.aborted) return;
      this.handleSessionUpdate(live, update);
      return;
    }

    if (method === "_x.ai/session/prompt_complete") {
      const live = this.getLiveSession(params.sessionId);
      if (!live) return;
      this.finishPromptTurn(live);
    }
  }

  indexDiscoveredSession(entry) {
    const rawId = String(entry?.sessionId ?? "").trim();
    const directory = normalizeDir(entry?.cwd);
    if (!rawId || !directory) return;
    const existing = this.sessionIndex.get(rawId);
    const now = Date.now();
    this.sessionIndex.set(rawId, {
      id: rawId,
      directory,
      workspaceId: existing?.workspaceId,
      title: entry?.title || existing?.title || "Untitled",
      preview: existing?.preview || "",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      modelId: entry?.modelId || existing?.modelId || DEFAULT_MODEL_ID,
      activity: entry?.activity || existing?.activity,
      origin: existing?.origin ?? "grok",
      hidden: existing?.hidden ?? false,
    });
  }

  handleSessionUpdate(live, update) {
    const sessionUpdate = update?.sessionUpdate;
    if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") {
      const text = update?.content?.text ?? "";
      if (!text) return;
      const bundle = this.ensureAssistantMessage(live);
      const partId = `${bundle.info.id}:${sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text"}`;
      const existingPart = bundle.parts.find((part) => part.id === partId);
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

  appendSyntheticUserMessage(live, text, modelId) {
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

  ensureAssistantMessage(live) {
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
    const bundle = upsertMessage(live.messages, info);
    live.currentAssistantMessageId = messageId;
    this.emitBackend(live.project, { type: "message.updated", message: info });
    return bundle;
  }

  async syncSessionRecord(live, emitEvent = true) {
    const now = Date.now();
    const rawId = toRawSessionId(live.session.id);
    const preview = getSessionPreview(live.messages);
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

  async addProject(config) {
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

  async removeProject(target) {
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

  async listSessions(target = {}) {
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

  async createSession(input = {}) {
    const project = this.ensureKnownProject(input.directory, input.workspaceId);
    await this.ensureAcp();
    const now = Date.now();
    const { sessionId } = await this.acp.request("session/new", {
      cwd: project.directory,
      mcpServers: [],
    });
    const rawId = toRawSessionId(sessionId);
    const session = this.buildSession({
      id: rawId,
      directory: project.directory,
      workspaceId: project.workspaceId,
      title: makeSessionTitle("", input.title),
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

  async getMessages(sessionId, target = {}) {
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
      this.providerCache ?? buildGrokProvidersFromModelState(this.acp.initResult?._meta?.modelState)
    );
  }

  async getCommands() {
    await this.ensureAcp();
    return (this.availableCommands ?? []).map((command) => ({
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

  async getSessionStatuses(target = {}) {
    const directory = normalizeDir(target.directory);
    const workspaceId = target.workspaceId;
    const statuses = {};
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

  async prompt(sessionId, text, _images, model, _agent, _variant, directory, workspaceId) {
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
    const modelId = resolveSelectedModelId(model);
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

  async runPromptTurn(live, text, modelId) {
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

  async startSession(input = {}) {
    const session = await this.createSession(input);
    if (input.text) {
      await this.prompt(
        session.id,
        input.text,
        input.images,
        input.model,
        input.agent,
        input.variant,
        input.directory,
        input.workspaceId,
      );
    }
    return session;
  }

  async deleteSession(sessionId, target = {}) {
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

  async updateSession(sessionId, title, _target = {}) {
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
    return this.buildSessionFromRecord(record);
  }

  async abort(sessionId) {
    const live = this.getLiveSession(sessionId);
    if (!live) return true;
    live.abortRequested = true;
    live.aborted = true;
    this.finishPromptTurn(live, { force: true });
    return true;
  }

  async sendCommand(sessionId, command, args, model, agent, variant, directory, workspaceId) {
    const text = `/${command}${args ? ` ${args}` : ""}`;
    await this.prompt(sessionId, text, [], model, agent, variant, directory, workspaceId);
  }

  async summarizeSession(sessionId, model, directory, workspaceId) {
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

export function setupGrokBuildBridge(ipcMain, getAllWindows) {
  let manager = new GrokBuildBridgeManager(getAllWindows);

  registerObjectTargetHarnessRpcHandlers("grok-build", ipcMain, () => manager);

  return {
    async restart() {
      manager.disconnect();
      manager = new GrokBuildBridgeManager(getAllWindows);
      return true;
    },
  };
}
