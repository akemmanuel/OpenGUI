import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import {
  AuthStorage,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  makeHarnessProjectKey as makeProjectKey,
  makeHarnessSessionIdCodec,
  normalizeHarnessDirectory as normalizeDir,
  nowHarnessConnection as nowConnection,
} from "./harness-adapter-kit.ts";
import {
  makeHarnessBridgeEventEmitter,
  registerHarnessRpcHandlers,
} from "./harness-adapter-host.ts";
import {
  pollUntilEffect,
  runEffect,
  sleepEffect,
  timeoutEffect,
  tryPromiseEffect,
} from "../../../../lib/effect-runtime.ts";
import { buildAllProvidersData, buildProvidersData } from "./pi-providers.ts";
import {
  invalidatePiSessionListCacheForDirectory,
  listFastPiSessionInfos as listPiSessionInfosFromDisk,
} from "./pi-session-listing.ts";
import {
  buildUserParts,
  cloneBundle,
  coerceTimestamp,
  createAssistantInfo,
  createBundle,
  createUserInfo,
  type PiMessageBundle,
  extractPiThinkingVariant,
  getSessionActivityType,
  inferPiSessionModelFromManager,
  makeSessionTitleFromText,
  makeTextPartId,
  normalizePiSession,
  normalizeToolInput,
  parseDataUrl,
  piImageBlockToFilePart,
  sessionStatus,
  stringifyUnknown,
  syncAssistantParts,
  toolResultContentToText,
} from "./pi-bridge-mapping.ts";
import {
  findCurrentAssistantBundleInCache,
  pairPendingAssistantsWithCanonical,
  resolvePiProjectForSession,
} from "./pi-bridge-live-resolution.ts";
import { createEmptyPiProjectShell, resolvePiProjectKeyFromTarget } from "./pi-project-slot.ts";
import {
  handlePiAssistantMessageStart,
  handlePiToolExecutionStart,
} from "./pi-bridge-session-events.ts";
import type {
  HarnessBridgeNativeEvent,
  PiBranchEntry,
  PiConnectionStatusPayload,
  PiLiveSessionLike,
  PiLiveState,
  PiModelRef,
  PiNativeSessionEvent,
  PiSessionManagerLike,
} from "./pi-bridge-types.ts";
import type { PiBridgeProject, PiLiveSessionContext } from "./pi-project-slot.ts";

const PI_DAEMON_STARTUP_TIMEOUT = 15_000;
const PI_DAEMON_SSE_RECONNECT_DELAY = 1_000;
const PI_DAEMON_HEALTH_TIMEOUT = 2_000;
// Bump when daemon import/runtime behavior changes. Existing healthy daemon gets reused
// across app restarts; failed lazy ESM imports inside pi-ai stay poisoned in-process.
const PI_DAEMON_VERSION = "2026-06-30-pi-tool-live-state-v1";
const __dirname = dirname(fileURLToPath(import.meta.url));

const { toFrontendSessionId, toRawSessionId } = makeHarnessSessionIdCodec("pi:");

function visibleUiBranchEntries(sessionManager: PiSessionManagerLike) {
  const branch = sessionManager.getBranch();
  let latestCompaction: PiBranchEntry | null = null;
  for (const entry of branch) {
    if (entry.type === "compaction") latestCompaction = entry;
  }
  if (!latestCompaction) return { entries: branch, seedEntries: [] as PiBranchEntry[] };
  const compactionIdx = branch.findIndex((entry) => entry.id === latestCompaction!.id);
  if (compactionIdx < 0) return { entries: branch, seedEntries: [] };
  const visible = [];
  let foundFirstKept = false;
  let visibleStartIdx = compactionIdx;
  for (let i = 0; i < compactionIdx; i++) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.id === latestCompaction.firstKeptEntryId) {
      foundFirstKept = true;
      visibleStartIdx = i;
    }
    if (foundFirstKept) visible.push(entry);
  }
  visible.push(latestCompaction);
  for (let i = compactionIdx + 1; i < branch.length; i++) {
    visible.push(branch[i]);
  }
  return { entries: visible, seedEntries: branch.slice(0, visibleStartIdx) };
}

function createSummaryUserBundle({
  sessionId,
  messageId,
  timestamp,
  text,
  model,
  directory,
}: {
  sessionId: string;
  messageId: string;
  timestamp: number;
  text: string;
  model?: PiModelRef;
  directory: string;
}) {
  return createBundle(
    createUserInfo({ sessionId, messageId, timestamp, model, directory }),
    text
      ? [
          {
            id: makeTextPartId(messageId, 0),
            sessionID: sessionId,
            messageID: messageId,
            type: "text",
            text,
          },
        ]
      : [],
  );
}

function createCompactionAssistantBundle({
  sessionId,
  messageId,
  timestamp,
  summary,
  model,
  directory,
  parentID,
  tailStartId,
}: {
  sessionId: string;
  messageId: string;
  timestamp: number;
  summary: string;
  model?: PiModelRef | null;
  directory: string;
  parentID: string;
  tailStartId: string;
}) {
  const info = {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: timestamp, completed: timestamp },
    parentID: parentID || "",
    modelID: model?.modelId ?? "",
    providerID: model?.provider ?? "pi",
    mode: "pi",
    agent: "pi",
    path: {
      cwd: directory,
      root: directory,
    },
    summary: true,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: "stop",
  };
  const parts = [];
  if (summary) {
    parts.push({
      id: makeTextPartId(messageId, 0),
      sessionID: sessionId,
      messageID: messageId,
      type: "text",
      text: summary,
    });
  }
  parts.push({
    id: `${messageId}:compaction`,
    sessionID: sessionId,
    messageID: messageId,
    type: "compaction",
    auto: false,
    tail_start_id: tailStartId,
  });
  return createBundle(info, parts);
}

function buildTranscriptFromSessionManager(
  sessionManager: PiSessionManagerLike,
  directory: string,
) {
  const sessionId = toFrontendSessionId(sessionManager.getSessionId());
  const { entries, seedEntries } = visibleUiBranchEntries(sessionManager);
  const bundles = [];
  const toolPartByCallId = new Map();
  let lastUserMessageId = "";
  let currentModel: PiModelRef | null = null;
  let currentThinkingLevel;
  let lastTimelineTimestamp = null;

  for (const entry of seedEntries) {
    if (!entry) continue;
    if (entry.type === "model_change") {
      currentModel = {
        provider: entry.provider,
        modelId: entry.modelId,
        ...(currentThinkingLevel ? { variant: currentThinkingLevel } : {}),
      };
      continue;
    }
    if (entry.type === "thinking_level_change") {
      currentThinkingLevel = extractPiThinkingVariant(entry) ?? currentThinkingLevel;
      if (currentModel) currentModel = { ...currentModel, variant: currentThinkingLevel };
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      currentModel = {
        provider: entry.message.provider,
        modelId: entry.message.model,
        ...(currentThinkingLevel ? { variant: currentThinkingLevel } : {}),
      };
    }
  }

  for (const entry of entries) {
    if (!entry) continue;
    if (entry.type === "model_change") {
      currentModel = {
        provider: entry.provider,
        modelId: entry.modelId,
        ...(currentThinkingLevel ? { variant: currentThinkingLevel } : {}),
      };
      continue;
    }
    if (entry.type === "thinking_level_change") {
      currentThinkingLevel = extractPiThinkingVariant(entry) ?? currentThinkingLevel;
      if (currentModel) currentModel = { ...currentModel, variant: currentThinkingLevel };
      continue;
    }
    if (entry.type === "label") {
      continue;
    }
    if (entry.type === "compaction") {
      const entryTimestamp = new Date(entry.timestamp).getTime();
      bundles.push(
        createCompactionAssistantBundle({
          sessionId,
          messageId: entry.id ?? `${sessionId}:compaction:${entryTimestamp}`,
          timestamp: entryTimestamp,
          summary: entry.summary ?? "",
          model: currentModel ?? undefined,
          directory,
          parentID: lastUserMessageId,
          tailStartId: entry.firstKeptEntryId ?? "",
        }),
      );
      lastTimelineTimestamp = entryTimestamp;
      continue;
    }
    if (entry.type === "branch_summary") {
      const entryTimestamp = new Date(entry.timestamp).getTime();
      bundles.push(
        createSummaryUserBundle({
          sessionId,
          messageId: entry.id,
          timestamp: entryTimestamp,
          text: `[Branch summary]\n${entry.summary}`,
          model: currentModel,
          directory,
        }),
      );
      lastTimelineTimestamp = entryTimestamp;
      continue;
    }
    if (entry.type === "custom_message") {
      const entryTimestamp = new Date(entry.timestamp).getTime();
      const bundle = createBundle(
        createUserInfo({
          sessionId,
          messageId: entry.id,
          timestamp: entryTimestamp,
          model: currentModel,
          directory,
        }),
        buildUserParts(entry.content, entry.id),
      );
      for (const part of bundle.parts) {
        part.sessionID = sessionId;
      }
      bundles.push(bundle);
      lastTimelineTimestamp = entryTimestamp;
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (message.role === "user") {
      const entryTimestamp =
        new Date(entry.timestamp).getTime() || coerceTimestamp(message.timestamp);
      const bundle = createBundle(
        createUserInfo({
          sessionId,
          messageId: entry.id,
          timestamp: entryTimestamp,
          model: currentModel,
          directory,
        }),
        buildUserParts(message.content, entry.id),
      );
      for (const part of bundle.parts) {
        part.sessionID = sessionId;
      }
      bundles.push(bundle);
      lastUserMessageId = entry.id;
      lastTimelineTimestamp = entryTimestamp;
      continue;
    }

    if (message.role === "assistant") {
      currentModel = {
        provider: message.provider,
        modelId: message.model,
        ...(currentThinkingLevel ? { variant: currentThinkingLevel } : {}),
      };
      const completedAt = new Date(entry.timestamp).getTime() || coerceTimestamp(message.timestamp);
      const startedAt =
        typeof lastTimelineTimestamp === "number" ? lastTimelineTimestamp : completedAt;
      const bundle = createBundle(
        createAssistantInfo({
          sessionId,
          messageId: entry.id,
          timestamp: completedAt,
          message: {
            ...message,
            ...(currentThinkingLevel ? { variant: currentThinkingLevel } : {}),
          },
          directory,
          parentID: lastUserMessageId,
          createdAt: startedAt,
          completedAt,
        }),
        [],
      );
      syncAssistantParts(bundle, message);
      for (const part of bundle.parts) {
        part.sessionID = sessionId;
        if (part.type === "tool") {
          toolPartByCallId.set(part.callID, part);
        }
      }
      bundles.push(bundle);
      lastTimelineTimestamp = completedAt;
      continue;
    }

    if (message.role === "toolResult") {
      const toolResultTimestamp = coerceTimestamp(message.timestamp);
      const toolPart = toolPartByCallId.get(message.toolCallId);
      if (!toolPart) {
        lastTimelineTimestamp = toolResultTimestamp;
        continue;
      }
      const attachments = [];
      let imageIndex = 0;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "image") {
          const filePart = piImageBlockToFilePart(block, toolPart.messageID, imageIndex);
          if (filePart) {
            filePart.sessionID = sessionId;
            attachments.push(filePart);
          }
          imageIndex += 1;
        }
      }
      const fallbackStart =
        typeof lastTimelineTimestamp === "number" ? lastTimelineTimestamp : toolResultTimestamp;
      toolPart.state = message.isError
        ? {
            status: "error",
            input: toolPart.state.input,
            error: toolResultContentToText(message.content) || "Tool failed",
            attachments: attachments.length > 0 ? attachments : undefined,
            time: {
              start: toolPart.state.time?.start ?? fallbackStart,
              end: toolResultTimestamp,
            },
          }
        : {
            status: "completed",
            input: toolPart.state.input,
            output: toolResultContentToText(message.content),
            title: toolPart.tool,
            metadata: message.details && typeof message.details === "object" ? message.details : {},
            time: {
              start: toolPart.state.time?.start ?? fallbackStart,
              end: toolResultTimestamp,
            },
            attachments: attachments.length > 0 ? attachments : undefined,
          };
      lastTimelineTimestamp = toolResultTimestamp;
    }
  }

  return {
    messages: bundles,
  };
}

export class PiBridgeManager {
  emitBridgeEvent: (event: HarnessBridgeNativeEvent) => void;
  agentDir: string;
  projects: Map<string, PiBridgeProject>;
  projectInitPromises: Map<string, Promise<PiBridgeProject>>;
  sessionIndex: Map<
    string,
    { projectKey: string; path?: string; directory: string; workspaceId?: string }
  >;
  sessionInfoCache: Map<string, { size: number; mtimeMs: number; info: unknown }>;
  directorySessionInfoCache: Map<string, { signature: string; infos: unknown[] }>;
  pendingOAuth: Map<string, unknown>;

  constructor(
    getAllWindows: () => Iterable<{ webContents: { send: (ch: string, ...a: unknown[]) => void } }>,
  ) {
    this.emitBridgeEvent = makeHarnessBridgeEventEmitter("pi", getAllWindows);
    this.agentDir = getAgentDir();
    this.projects = new Map();
    this.projectInitPromises = new Map();
    this.sessionIndex = new Map();
    this.sessionInfoCache = new Map();
    this.directorySessionInfoCache = new Map();
    this.pendingOAuth = new Map();
  }

  sendNativeEvent(event: HarnessBridgeNativeEvent) {
    this.emitBridgeEvent(event);
  }

  sendConnectionStatus(project: PiBridgeProject, status: PiConnectionStatusPayload) {
    this.sendNativeEvent({
      type: "connection:status",
      directory: project.directory,
      workspaceId: project.workspaceId,
      payload: status,
    });
  }

  sendBackendEvent(project: PiBridgeProject, payload: Record<string, unknown>) {
    this.sendNativeEvent({
      type: "pi:event",
      directory: project.directory,
      workspaceId: project.workspaceId,
      payload,
    });
  }

  ensureProjectRuntimeState(project: PiBridgeProject | undefined): PiBridgeProject | undefined {
    if (project && !project.abortedSessionIds) {
      project.abortedSessionIds = new Set();
    }
    return project;
  }

  getProject(target: { directory?: string; workspaceId?: string } = {}) {
    const directory = normalizeDir(target.directory);
    if (!directory) return null;
    return (
      this.ensureProjectRuntimeState(
        this.projects.get(makeProjectKey(target.workspaceId, directory)),
      ) || null
    );
  }

  getOrThrowProject(target: { directory?: string; workspaceId?: string } = {}) {
    const project = this.getProject(target);
    if (!project) {
      throw new Error("Pi project not connected");
    }
    return project;
  }

  getLiveSessionContext(project: PiBridgeProject, sessionId: string) {
    this.ensureProjectRuntimeState(project);
    return project.liveSessionContexts.get(sessionId) || null;
  }

  async disposeLiveSessionContext(
    project: PiBridgeProject,
    sessionId: string,
    { keepCache = true }: { keepCache?: boolean } = {},
  ) {
    const context = this.getLiveSessionContext(project, sessionId);
    if (!context) return;
    context.unsubscribe?.();
    await context.runtime.dispose().catch(() => {});
    project.liveSessionContexts.delete(sessionId);
    project.sessionContextInitPromises.delete(sessionId);
    project.busySessionIds.delete(sessionId);
    project.abortedSessionIds?.delete(sessionId);
    if (!keepCache) {
      project.liveStateBySessionId.delete(sessionId);
      project.sessionCaches.delete(sessionId);
      this.sessionIndex.delete(sessionId);
    }
    this.syncProjectRuntime(project);
  }

  async disposeIdleLiveSessionsExcept(project: PiBridgeProject, keepSessionIds: string[] = []) {
    const keep = new Set(keepSessionIds.filter(Boolean));
    for (const sessionId of project.liveSessionContexts.keys()) {
      if (keep.has(sessionId) || project.busySessionIds.has(sessionId)) continue;
      await this.disposeLiveSessionContext(project, sessionId, { keepCache: true });
    }
  }

  findLiveSessionContext(sessionId: string) {
    for (const project of this.projects.values()) {
      const context = this.getLiveSessionContext(project, sessionId);
      if (context) return { project, context };
    }
    return null;
  }

  syncProjectRuntime(project: PiBridgeProject) {
    const firstContext = project.liveSessionContexts.values().next().value || null;
    project.runtime = firstContext?.runtime || null;
  }

  setSessionActivity(
    project: PiBridgeProject,
    sessionId: string,
    nextType: string,
    {
      emitEvent = true,
      preserveAbort = false,
    }: { emitEvent?: boolean; preserveAbort?: boolean } = {},
  ) {
    const wasBusy = project.busySessionIds.has(sessionId);
    const isBusy = nextType === "busy";
    if (isBusy) {
      project.abortedSessionIds?.delete(sessionId);
      project.busySessionIds.add(sessionId);
    } else {
      project.busySessionIds.delete(sessionId);
      if (!preserveAbort) project.abortedSessionIds?.delete(sessionId);
    }
    if (!emitEvent || wasBusy === isBusy) return nextType;
    this.sendBackendEvent(project, {
      type: "session.status",
      sessionID: sessionId,
      status: sessionStatus(nextType),
    });
    return nextType;
  }

  markSessionAbortedIdle(project: PiBridgeProject, sessionId: string) {
    project.abortedSessionIds?.add(sessionId);
    return this.setSessionActivity(project, sessionId, "idle", { preserveAbort: true });
  }

  syncLiveSessionStatus(
    project: PiBridgeProject,
    session: PiLiveSessionLike,
    options: { emitEvent?: boolean; preserveAbort?: boolean } = {},
  ) {
    if (project.abortedSessionIds?.has(session.sessionId)) {
      return this.setSessionActivity(project, session.sessionId, "idle", {
        ...options,
        preserveAbort: true,
      });
    }
    return this.setSessionActivity(
      project,
      session.sessionId,
      getSessionActivityType(session),
      options,
    );
  }

  makeLiveState(): PiLiveState {
    return {
      nextSeq: 0,
      currentUserMessageId: null,
      currentAssistantMessageId: null,
      assistantStartedAt: null,
      reasoningTimesByContentIndex: new Map(),
      syntheticToReal: new Map(),
      pendingAssistantResolutions: [],
    };
  }

  registerLiveSessionContext(
    project: PiBridgeProject,
    runtime: PiLiveSessionContext["runtime"],
  ): PiLiveSessionContext {
    const session = runtime.session;
    const sessionId = session.sessionId;
    const existing = project.liveSessionContexts.get(sessionId);
    if (existing) {
      return existing;
    }
    const context = {
      runtime,
      session,
      unsubscribe: null,
    };
    project.liveSessionContexts.set(sessionId, context);
    project.sessionCaches.set(
      sessionId,
      buildTranscriptFromSessionManager(session.sessionManager, project.directory),
    );
    if (!project.liveStateBySessionId.has(sessionId)) {
      project.liveStateBySessionId.set(sessionId, this.makeLiveState());
    }
    if (session.sessionFile) {
      this.sessionIndex.set(sessionId, {
        projectKey: project.key,
        path: session.sessionFile,
        directory: project.directory,
        workspaceId: project.workspaceId,
      });
    }
    context.unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(project, session, event).catch((error) => {
        this.sendBackendEvent(project, {
          type: "session.error",
          error: error instanceof Error ? error.message : String(error),
          sessionID: session.sessionId,
        });
      });
    });
    this.syncLiveSessionStatus(project, session);
    this.syncProjectRuntime(project);
    return context;
  }

  async createRuntime(sessionManager: PiSessionManagerLike & { getCwd(): string }) {
    const createRuntime = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
      agentDir,
    }: {
      cwd: string;
      sessionManager: PiSessionManagerLike;
      sessionStartEvent: unknown;
      agentDir: string;
    }) => {
      const services = await createAgentSessionServices({ cwd, agentDir });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    return createAgentSessionRuntime(createRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir: this.agentDir,
      sessionManager,
    });
  }

  async ensureProject(target: { directory?: string; workspaceId?: string } = {}) {
    const { key, directory, workspaceId } = resolvePiProjectKeyFromTarget(target);
    const existingProject = this.ensureProjectRuntimeState(this.projects.get(key));
    if (existingProject?.runtime || existingProject?.liveSessionContexts?.size > 0) {
      this.syncProjectRuntime(existingProject);
      this.sendConnectionStatus(existingProject, nowConnection({ state: "connected" }));
      return existingProject;
    }

    const pendingInit = this.projectInitPromises.get(key);
    if (pendingInit) return await pendingInit;

    const project = existingProject ?? createEmptyPiProjectShell(key, directory, workspaceId);
    const initPromise = (async () => {
      try {
        project.runtime = await this.createRuntime(SessionManager.continueRecent(directory));
        this.registerLiveSessionContext(project, project.runtime);
        this.projects.set(key, project);
        this.sendConnectionStatus(project, nowConnection({ state: "connected" }));
        return project;
      } catch (error) {
        project.runtime = null;
        if (!existingProject) {
          this.projects.delete(key);
        }
        throw error;
      } finally {
        this.projectInitPromises.delete(key);
      }
    })();
    this.projectInitPromises.set(key, initPromise);
    return await initPromise;
  }

  async createSessionContext(project: PiBridgeProject, sessionManager: PiSessionManagerLike) {
    const runtime = await this.createRuntime(sessionManager);
    return this.registerLiveSessionContext(project, runtime);
  }

  async ensureSessionContext(
    sessionId: string,
    target: { directory?: string; workspaceId?: string } = {},
  ) {
    const project = await this.resolveProjectForSession(sessionId, target || {});
    const liveContext = this.getLiveSessionContext(project, sessionId);
    if (liveContext) {
      return {
        project,
        runtime: liveContext.runtime,
        session: liveContext.runtime.session,
        context: liveContext,
      };
    }
    await this.disposeIdleLiveSessionsExcept(project, [sessionId]);
    const pending = project.sessionContextInitPromises.get(sessionId);
    if (pending) return await pending;
    const initPromise = (async () => {
      let info = this.sessionIndex.get(sessionId);
      if (!info || info.projectKey !== project.key) {
        await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
        info = this.sessionIndex.get(sessionId);
      }
      if (!info?.path || info.projectKey !== project.key) {
        throw new Error("Pi session not found");
      }
      const context = await this.createSessionContext(
        project,
        SessionManager.open(info.path, undefined, project.directory),
      );
      return { project, runtime: context.runtime, session: context.runtime.session, context };
    })();
    project.sessionContextInitPromises.set(sessionId, initPromise);
    try {
      return await initPromise;
    } finally {
      project.sessionContextInitPromises.delete(sessionId);
    }
  }

  async attachSession(project: PiBridgeProject, session: PiLiveSessionLike) {
    if (project.sessionUnsubscribe) {
      project.sessionUnsubscribe();
      project.sessionUnsubscribe = null;
    }
    project.currentSessionId = session.sessionId;
    project.currentSessionFile = session.sessionFile;
    const cache = buildTranscriptFromSessionManager(session.sessionManager, project.directory);
    project.sessionCaches.set(session.sessionId, cache);
    if (!project.liveStateBySessionId.has(session.sessionId)) {
      project.liveStateBySessionId.set(session.sessionId, this.makeLiveState());
    }
    if (session.sessionFile) {
      this.sessionIndex.set(session.sessionId, {
        projectKey: project.key,
        path: session.sessionFile,
        directory: project.directory,
        workspaceId: project.workspaceId,
      });
    }
    project.sessionUnsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(project, session, event).catch((error) => {
        this.sendBackendEvent(project, {
          type: "session.error",
          error: error instanceof Error ? error.message : String(error),
          sessionID: session.sessionId,
        });
      });
    });
  }

  getLiveState(project: PiBridgeProject, sessionId: string): PiLiveState {
    if (!project.liveStateBySessionId.has(sessionId)) {
      project.liveStateBySessionId.set(sessionId, this.makeLiveState());
    }
    return project.liveStateBySessionId.get(sessionId);
  }

  getSessionCache(project: PiBridgeProject, sessionId: string) {
    if (!project.sessionCaches.has(sessionId)) {
      project.sessionCaches.set(sessionId, { messages: [] });
    }
    return project.sessionCaches.get(sessionId);
  }

  upsertBundle(project: PiBridgeProject, sessionId: string, bundle: PiMessageBundle) {
    const cache = this.getSessionCache(project, sessionId);
    const index = cache.messages.findIndex((item) => item.info.id === bundle.info.id);
    if (index >= 0) {
      cache.messages[index] = cloneBundle(bundle);
    } else {
      cache.messages.push(cloneBundle(bundle));
    }
  }

  findBundle(project: PiBridgeProject, sessionId: string, messageId: string) {
    const cache = this.getSessionCache(project, sessionId);
    return cache.messages.find((item) => item.info.id === messageId) || null;
  }

  closeOpenReasoning(
    state: PiLiveState,
    endedAt = Date.now(),
    exceptContentIndex: number | null = null,
  ) {
    for (const [contentIndex, time] of state.reasoningTimesByContentIndex) {
      if (contentIndex === exceptContentIndex) continue;
      if (!time || typeof time.start !== "number" || typeof time.end === "number") {
        continue;
      }
      time.end = endedAt;
    }
  }

  markReasoningStart(state: PiLiveState, contentIndex: number, startedAt = Date.now()) {
    this.closeOpenReasoning(state, startedAt, contentIndex);
    const existing = state.reasoningTimesByContentIndex.get(contentIndex);
    state.reasoningTimesByContentIndex.set(contentIndex, {
      start:
        typeof existing?.start === "number"
          ? existing.start
          : typeof state.assistantStartedAt === "number"
            ? state.assistantStartedAt
            : startedAt,
      end: undefined,
    });
  }

  markReasoningEnd(state: PiLiveState, contentIndex: number, endedAt = Date.now()) {
    const existing = state.reasoningTimesByContentIndex.get(contentIndex);
    state.reasoningTimesByContentIndex.set(contentIndex, {
      start:
        typeof existing?.start === "number"
          ? existing.start
          : typeof state.assistantStartedAt === "number"
            ? state.assistantStartedAt
            : endedAt,
      end: endedAt,
    });
    this.closeOpenReasoning(state, endedAt, contentIndex);
  }

  findLatestRealMessageId(sessionManager: PiSessionManagerLike, role: string) {
    const branch = sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === role) return entry.id;
    }
    return null;
  }

  findRealEntryId(
    sessionManager: PiSessionManagerLike,
    role: string,
    timestamp: number,
    contentText: string,
  ) {
    const branch = sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "message") continue;
      if (entry.message.role !== role) continue;
      const entryTime = coerceTimestamp(
        entry.message.timestamp ?? new Date(entry.timestamp).getTime(),
      );
      if (Math.abs(entryTime - timestamp) > 4000) continue;
      if (role === "user") {
        const text =
          typeof entry.message.content === "string"
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text || "")
                  .join("\n")
              : "";
        if (contentText && text !== contentText) continue;
      }
      return entry.id;
    }
    return null;
  }

  emitCanonicalTranscript(project: PiBridgeProject, session: PiLiveSessionLike) {
    const state = this.getLiveState(project, session.sessionId);
    const previous = project.sessionCaches.get(session.sessionId)?.messages ?? [];
    const previousById = new Map(previous.map((bundle) => [bundle.info.id, bundle]));
    const cache = buildTranscriptFromSessionManager(session.sessionManager, project.directory);
    project.sessionCaches.set(session.sessionId, cache);

    const pendingStreaming = (state.pendingAssistantResolutions || []).filter((pending) =>
      previousById.has(pending.syntheticId),
    );
    const replacementIds = new Set();
    const replacedSyntheticIds = new Set();
    const newCanonicalAssistants = cache.messages.filter(
      (bundle) => bundle.info.role === "assistant" && !previousById.has(bundle.info.id),
    );
    for (const { pending, bundle } of pairPendingAssistantsWithCanonical(
      pendingStreaming,
      newCanonicalAssistants,
    )) {
      replacementIds.add(bundle.info.id);
      replacedSyntheticIds.add(pending.syntheticId);
      state.syntheticToReal.set(pending.syntheticId, bundle.info.id);
      this.sendBackendEvent(project, {
        type: "message.replaced",
        sessionID: bundle.info.sessionID,
        oldId: pending.syntheticId,
        message: bundle.info,
        parts: bundle.parts,
      });
    }
    state.pendingAssistantResolutions = (state.pendingAssistantResolutions || []).filter(
      (pending) => !replacedSyntheticIds.has(pending.syntheticId),
    );

    for (const bundle of cache.messages) {
      if (replacementIds.has(bundle.info.id)) continue;
      const oldBundle = previousById.get(bundle.info.id);
      if (JSON.stringify(oldBundle?.info) !== JSON.stringify(bundle.info)) {
        this.sendBackendEvent(project, { type: "message.updated", message: bundle.info });
      }
      const oldPartsById = new Map((oldBundle?.parts ?? []).map((part) => [part.id, part]));
      for (const part of bundle.parts) {
        if (JSON.stringify(oldPartsById.get(part.id)) !== JSON.stringify(part)) {
          this.sendBackendEvent(project, { type: "message.part.updated", part });
        }
      }
    }
  }

  emitRealMessage(
    project: PiBridgeProject,
    session: PiLiveSessionLike,
    role: string,
    timestamp: number,
    contentText: string,
  ) {
    setTimeout(() => {
      try {
        const realId = this.findRealEntryId(session.sessionManager, role, timestamp, contentText);
        if (!realId) return;
        const cache = buildTranscriptFromSessionManager(session.sessionManager, project.directory);
        project.sessionCaches.set(session.sessionId, cache);
        const realBundle = cache.messages.find((item) => item.info.id === realId);
        if (!realBundle) return;
        this.sendBackendEvent(project, { type: "message.updated", message: realBundle.info });
        for (const part of realBundle.parts) {
          this.sendBackendEvent(project, { type: "message.part.updated", part });
        }
      } catch {
        /* ignore */
      }
    }, 0);
  }

  flushPendingAssistantResolution(project: PiBridgeProject, session: PiLiveSessionLike) {
    this.emitCanonicalTranscript(project, session);
  }

  findCurrentAssistantBundle(project: PiBridgeProject, sessionId: string, state: PiLiveState) {
    return findCurrentAssistantBundleInCache(project, sessionId, state);
  }

  async handleSessionEvent(
    project: PiBridgeProject,
    session: PiLiveSessionLike,
    event: PiNativeSessionEvent,
  ) {
    const sessionId = session.sessionId;
    const state = this.getLiveState(project, sessionId);
    if (event.type === "turn_end") {
      this.flushPendingAssistantResolution(project, session);
      this.emitCanonicalTranscript(project, session);
      state.currentAssistantMessageId = null;
      state.assistantStartedAt = null;
      state.reasoningTimesByContentIndex = new Map();
      return;
    }
    if (event.type === "agent_start") {
      this.syncLiveSessionStatus(project, session);
      return;
    }

    if (event.type === "compaction_start") {
      this.syncLiveSessionStatus(project, session);
      return;
    }

    if (event.type === "compaction_end") {
      this.syncLiveSessionStatus(project, session);
      if (event.result) {
        project.sessionCaches.set(
          sessionId,
          buildTranscriptFromSessionManager(session.sessionManager, project.directory),
        );
      }
      return;
    }

    if (event.type === "agent_end") {
      this.flushPendingAssistantResolution(project, session);
      this.emitCanonicalTranscript(project, session);
      // Pi keeps session.isStreaming=true until awaited agent_end listeners finish.
      // Since this bridge is itself such a listener, deriving status from
      // session.isStreaming here leaves the frontend stuck busy forever.
      this.setSessionActivity(project, sessionId, "idle");
      await this.disposeLiveSessionContext(project, sessionId, { keepCache: true });
      const normalized = await this.getSessionById(sessionId);
      if (normalized) {
        this.sendBackendEvent(project, {
          type: "session.updated",
          directory: project.directory,
          workspaceId: project.workspaceId,
          session: normalized,
        });
      }
      return;
    }

    if (event.type === "message_start") {
      handlePiAssistantMessageStart(this, project, session, event, state, project.directory);
      return;
    }

    if (event.type === "message_update" && event.message.role === "assistant") {
      const messageId = state.currentAssistantMessageId;
      if (!messageId) return;
      const eventAt = Date.now();
      if (event.assistantMessageEvent.type === "thinking_start") {
        this.markReasoningStart(state, event.assistantMessageEvent.contentIndex, eventAt);
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        if (!state.reasoningTimesByContentIndex.has(event.assistantMessageEvent.contentIndex)) {
          this.markReasoningStart(state, event.assistantMessageEvent.contentIndex, eventAt);
        }
      } else if (event.assistantMessageEvent.type === "thinking_end") {
        this.markReasoningEnd(state, event.assistantMessageEvent.contentIndex, eventAt);
      } else if (
        event.assistantMessageEvent.type === "text_start" ||
        event.assistantMessageEvent.type === "toolcall_start"
      ) {
        this.closeOpenReasoning(state, eventAt);
      }
      const bundle = this.findBundle(project, sessionId, messageId);
      if (!bundle) return;
      bundle.info = createAssistantInfo({
        sessionId,
        messageId,
        timestamp: coerceTimestamp(event.message.timestamp),
        message: event.message,
        directory: project.directory,
        parentID: bundle.info.parentID,
        createdAt: bundle.info.time.created,
      });
      syncAssistantParts(bundle, event.message, state.reasoningTimesByContentIndex);
      this.upsertBundle(project, sessionId, bundle);
      this.sendBackendEvent(project, { type: "message.updated", message: bundle.info });
      for (const part of bundle.parts) {
        this.sendBackendEvent(project, { type: "message.part.updated", part });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      handlePiToolExecutionStart(this, project, sessionId, state, event);
      return;
    }

    if (event.type === "tool_execution_update") {
      const assistantContext = this.findCurrentAssistantBundle(project, sessionId, state);
      if (!assistantContext) return;
      const { bundle } = assistantContext;
      const part = bundle.parts.find(
        (item) => item.type === "tool" && item.callID === event.toolCallId,
      );
      if (!part) return;
      const partialOutput = event.partialResult?.content
        ? toolResultContentToText(event.partialResult.content)
        : "output" in part.state && typeof part.state.output === "string"
          ? part.state.output
          : undefined;
      part.state = {
        status: "running",
        input: normalizeToolInput(event.args || {}),
        title: event.toolName,
        ...(typeof partialOutput === "string" ? { output: partialOutput } : {}),
        metadata:
          event.partialResult?.details && typeof event.partialResult.details === "object"
            ? event.partialResult.details
            : {},
        time: {
          start: part.state.time?.start ?? Date.now(),
        },
      };
      this.upsertBundle(project, sessionId, bundle);
      this.sendBackendEvent(project, { type: "message.part.updated", part });
      return;
    }

    if (event.type === "tool_execution_end") {
      const assistantContext = this.findCurrentAssistantBundle(project, sessionId, state);
      if (!assistantContext) return;
      const { bundle } = assistantContext;
      const part = bundle.parts.find(
        (item) => item.type === "tool" && item.callID === event.toolCallId,
      );
      if (!part) return;
      const attachments = [];
      let imageIndex = 0;
      for (const block of Array.isArray(event.result?.content) ? event.result.content : []) {
        if (block?.type === "image") {
          const filePart = piImageBlockToFilePart(block, part.messageID, imageIndex);
          if (filePart) {
            filePart.sessionID = sessionId;
            attachments.push(filePart);
          }
          imageIndex += 1;
        }
      }
      part.state = event.isError
        ? {
            status: "error",
            input: part.state.input || {},
            error: event.result?.content
              ? toolResultContentToText(event.result.content)
              : stringifyUnknown(event.result?.details) || "Tool failed",
            attachments: attachments.length > 0 ? attachments : undefined,
            time: {
              start: part.state.time?.start ?? Date.now(),
              end: Date.now(),
            },
          }
        : {
            status: "completed",
            input: part.state.input || {},
            output: event.result?.content
              ? toolResultContentToText(event.result.content)
              : stringifyUnknown(event.result?.details),
            title: event.toolName,
            metadata:
              event.result?.details && typeof event.result.details === "object"
                ? event.result.details
                : {},
            attachments: attachments.length > 0 ? attachments : undefined,
            time: {
              start: part.state.time?.start ?? Date.now(),
              end: Date.now(),
            },
          };
      this.upsertBundle(project, sessionId, bundle);
      this.sendBackendEvent(project, { type: "message.part.updated", part });
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "user") {
        this.emitRealMessage(
          project,
          session,
          "user",
          coerceTimestamp(event.message.timestamp),
          typeof event.message.content === "string"
            ? event.message.content
            : Array.isArray(event.message.content)
              ? event.message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text || "")
                  .join("\n")
              : "",
        );
        return;
      }
      if (event.message.role === "assistant") {
        if (event.message.stopReason === "error" && event.message.errorMessage) {
          this.sendBackendEvent(project, {
            type: "session.error",
            error: event.message.errorMessage,
            sessionID: sessionId,
          });
        }
        state.assistantStartedAt = null;
        state.reasoningTimesByContentIndex = new Map();
        return;
      }
    }
  }

  getListProject(target: PiProjectTarget = {}) {
    const { key, directory, workspaceId } = resolvePiProjectKeyFromTarget(target);
    const existing = this.ensureProjectRuntimeState(this.projects.get(key));
    if (existing) return existing;
    return createEmptyPiProjectShell(key, directory, workspaceId);
  }

  async resolveProjectForSession(sessionId: string, target: PiProjectTarget = {}) {
    return resolvePiProjectForSession(
      {
        projects: this.projects,
        sessionIndex: this.sessionIndex,
        findLiveProjectKey: (id) => this.findLiveSessionContext(id)?.project.key,
        ensureProject: (t) => this.ensureProject(t),
      },
      sessionId,
      target,
    );
  }

  mergeLivePiSessionsForProject(project: PiBridgeProject, diskSessions: unknown[]) {
    const diskIds = new Set(diskSessions.map((session) => toRawSessionId(session.id)));
    const liveExtras = [];
    for (const [sessionId, context] of project.liveSessionContexts) {
      if (diskIds.has(sessionId)) continue;
      const session = context.runtime.session;
      liveExtras.push(
        normalizePiSession(
          {
            id: sessionId,
            cwd: project.directory,
            name: session.sessionName,
            created: new Date(),
            modified: new Date(),
            firstMessage: session.sessionName || "",
          },
          project,
        ),
      );
    }
    return [...liveExtras, ...diskSessions].sort(
      (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
    );
  }

  async listSessions(target: PiProjectTarget) {
    if (target?.directory) {
      const project = this.getListProject(target);
      const infos = await listPiSessionInfosFromDisk(
        project.directory,
        this.agentDir,
        this.sessionInfoCache,
        this.directorySessionInfoCache,
      );
      for (const info of infos) {
        this.sessionIndex.set(info.id, {
          projectKey: project.key,
          path: info.path,
          directory: project.directory,
          workspaceId: project.workspaceId,
        });
      }
      const fromDisk = infos.map((info) => normalizePiSession(info, project));
      return this.mergeLivePiSessionsForProject(project, fromDisk);
    }
    const sessions = [];
    for (const project of this.projects.values()) {
      const infos = await listPiSessionInfosFromDisk(
        project.directory,
        this.agentDir,
        this.sessionInfoCache,
        this.directorySessionInfoCache,
      );
      for (const info of infos) {
        this.sessionIndex.set(info.id, {
          projectKey: project.key,
          path: info.path,
          directory: project.directory,
          workspaceId: project.workspaceId,
        });
        sessions.push(normalizePiSession(info, project));
      }
    }
    return sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  }

  async getSessionById(sessionId: string, target: PiProjectTarget) {
    const rawSessionId = toRawSessionId(sessionId);
    const project = await this.resolveProjectForSession(rawSessionId, target || {});
    await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
    const indexed = this.sessionIndex.get(rawSessionId);
    if (indexed?.path && indexed.projectKey === project.key) {
      const manager = SessionManager.open(indexed.path, undefined, project.directory);
      const firstUserEntry = manager
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "user");
      return normalizePiSession(
        {
          id: rawSessionId,
          cwd: project.directory,
          name: manager.getSessionName(),
          created: new Date(manager.getHeader().timestamp),
          modified: new Date(),
          firstMessage:
            firstUserEntry?.type === "message"
              ? typeof firstUserEntry.message.content === "string"
                ? firstUserEntry.message.content
                : Array.isArray(firstUserEntry.message.content)
                  ? firstUserEntry.message.content
                      .filter((part: { type?: string }) => part.type === "text")
                      .map((part: { text?: string }) => part.text || "")
                      .join("\n")
                  : ""
              : "",
          model: inferPiSessionModelFromManager(manager),
        },
        {
          directory: project.directory,
          workspaceId: project.workspaceId,
        },
      );
    }
    const sessions = await this.listSessions({
      directory: project.directory,
      workspaceId: project.workspaceId,
    });
    return sessions.find((session) => toRawSessionId(session.id) === rawSessionId) || null;
  }

  resolveRealMessageId(project: PiBridgeProject, sessionId: string, messageId: string) {
    const state = this.getLiveState(project, sessionId);
    return state.syntheticToReal?.get(messageId) || messageId;
  }

  async addProject(config: PiProjectTarget) {
    await this.ensureProject(config);
  }

  async removeProject(target: PiProjectTarget) {
    const directory = normalizeDir(target?.directory);
    const key = directory ? makeProjectKey(target?.workspaceId, directory) : null;
    const pendingInit = key ? this.projectInitPromises.get(key) : null;
    if (pendingInit) {
      try {
        await pendingInit;
      } catch {
        return;
      }
    }
    const project = this.getProject(target);
    if (!project) return;
    await Promise.allSettled(project.sessionContextInitPromises.values());
    for (const context of project.liveSessionContexts.values()) {
      context.unsubscribe?.();
    }
    await Promise.allSettled(
      [...project.liveSessionContexts.values()].map((context) => context.runtime.dispose()),
    );
    project.liveSessionContexts.clear();
    project.sessionCaches.clear();
    project.liveStateBySessionId.clear();
    project.abortedSessionIds?.clear();
    project.sessionContextInitPromises.clear();
    project.runtime = null;
    project.sessionUnsubscribe = null;
    for (const [sessionId, info] of this.sessionIndex.entries()) {
      if (info.projectKey === project.key) {
        this.sessionIndex.delete(sessionId);
      }
    }
    this.projects.delete(project.key);
    this.sendConnectionStatus(project, nowConnection({ state: "idle" }));
  }

  async disconnect() {
    await Promise.allSettled(this.projectInitPromises.values());
    const projects = Array.from(this.projects.values());
    for (const project of projects) {
      await this.removeProject(project);
    }
  }

  async createSession(input: Record<string, unknown> = {}) {
    const project = await this.ensureProject(input);
    const context = await this.createSessionContext(
      project,
      SessionManager.create(project.directory),
    );
    if (input.title) {
      context.runtime.session.setSessionName(input.title);
    }
    const session = normalizePiSession(
      {
        id: context.runtime.session.sessionId,
        cwd: project.directory,
        name: context.runtime.session.sessionName,
        created: new Date(),
        modified: new Date(),
        firstMessage: input.title || "",
      },
      project,
    );
    invalidatePiSessionListCacheForDirectory(
      project.directory,
      this.agentDir,
      this.sessionInfoCache,
      this.directorySessionInfoCache,
    );
    this.sendBackendEvent(project, {
      type: "session.created",
      directory: project.directory,
      workspaceId: project.workspaceId,
      session,
    });
    return session;
  }

  async startSession(input: Record<string, unknown>) {
    const project = await this.ensureProject(input);
    const context = await this.createSessionContext(
      project,
      SessionManager.create(project.directory),
    );
    if (input.title) {
      context.runtime.session.setSessionName(input.title);
    }
    if (input.model) {
      await this.applySelectedModel(context.runtime.session, input.model);
    }
    this.applySelectedVariant(context.runtime.session, input.variant);
    const sessionRef = context.runtime.session;
    const session = normalizePiSession(
      {
        id: sessionRef.sessionId,
        cwd: project.directory,
        name: sessionRef.sessionName || makeSessionTitleFromText(input.text, input.title),
        created: new Date(),
        modified: new Date(),
        firstMessage: input.text,
      },
      project,
    );
    this.sendBackendEvent(project, {
      type: "session.created",
      directory: project.directory,
      workspaceId: project.workspaceId,
      session,
    });
    this.setSessionActivity(project, sessionRef.sessionId, "busy");
    void this.dispatchSessionPrompt(project, sessionRef, input.text, input.images).catch(() => {});
    return session;
  }

  normalizeImages(images: unknown) {
    return (Array.isArray(images) ? images : [])
      .map((image) => parseDataUrl(image))
      .filter(Boolean)
      .map((image) => ({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      }));
  }

  handlePromptFailure(project: PiBridgeProject, sessionId: string, error: unknown) {
    this.sendBackendEvent(project, {
      type: "session.error",
      error: error instanceof Error ? error.message : String(error),
      sessionID: sessionId,
    });
    if (project.busySessionIds.has(sessionId)) {
      const liveContext = this.getLiveSessionContext(project, sessionId);
      if (liveContext) {
        this.syncLiveSessionStatus(project, liveContext.runtime.session);
      } else {
        project.busySessionIds.delete(sessionId);
        this.sendBackendEvent(project, {
          type: "session.status",
          sessionID: sessionId,
          status: sessionStatus("idle"),
        });
      }
    }
  }

  dispatchSessionPrompt(
    project: PiBridgeProject,
    session: PiLiveSessionLike,
    text: string,
    images: unknown,
  ) {
    const normalizedImages = this.normalizeImages(images);
    let accepted = false;
    let settled = false;
    let resolveAccepted;
    let rejectAccepted;
    const acceptedPromise = new Promise((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolveAccepted();
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectAccepted(error);
    };
    const promptPromise = session.prompt(text, {
      images: normalizedImages,
      preflightResult: (success: boolean) => {
        if (success) {
          accepted = true;
          settleResolve();
        }
      },
    });
    void promptPromise.catch((error) => {
      this.handlePromptFailure(project, session.sessionId, error);
      if (!accepted) {
        settleReject(error);
      }
    });
    return acceptedPromise;
  }

  async applySelectedModel(session: PiLiveSessionLike, selectedModel: Record<string, unknown>) {
    if (!selectedModel?.providerID || !selectedModel?.modelID) return;
    session.modelRegistry.refresh?.();
    const availableModels = session.modelRegistry.getAvailable();
    const model = availableModels.find(
      (item) => item.provider === selectedModel.providerID && item.id === selectedModel.modelID,
    );
    if (!model) {
      throw new Error(`Pi model not found: ${selectedModel.providerID}/${selectedModel.modelID}`);
    }
    await session.setModel(model);
  }

  applySelectedVariant(session: PiLiveSessionLike, variant: unknown) {
    if (typeof variant !== "string" || !variant.trim()) return;
    if (typeof session.setThinkingLevel !== "function") return;
    const model = session.model;
    if (model) {
      const supported = getSupportedThinkingLevels(model);
      if (!supported.includes(variant)) return;
    }
    session.setThinkingLevel(variant);
  }

  async deleteSession(sessionId: string, target: PiProjectTarget) {
    const rawSessionId = toRawSessionId(sessionId);
    const project = await this.resolveProjectForSession(rawSessionId, target || {});
    let info = this.sessionIndex.get(rawSessionId);
    if (!info || info.projectKey !== project.key) {
      await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
      info = this.sessionIndex.get(rawSessionId);
    }
    if (!info?.path || info.projectKey !== project.key) {
      throw new Error("Pi session not found");
    }
    const liveContext = this.getLiveSessionContext(project, rawSessionId);
    if (liveContext && project.busySessionIds.has(rawSessionId)) {
      throw new Error("Stop Pi session before deleting it.");
    }
    if (liveContext) {
      await this.disposeLiveSessionContext(project, rawSessionId, { keepCache: false });
    }
    await unlink(info.path);
    this.sessionIndex.delete(rawSessionId);
    project.sessionCaches.delete(rawSessionId);
    project.liveStateBySessionId.delete(rawSessionId);
    this.sendBackendEvent(project, {
      type: "session.deleted",
      directory: project.directory,
      workspaceId: project.workspaceId,
      sessionId: rawSessionId,
    });
    return true;
  }

  async updateSession(sessionId: string, title: string, target: PiProjectTarget) {
    const rawSessionId = toRawSessionId(sessionId);
    const live = this.findLiveSessionContext(rawSessionId);
    if (live) {
      const { project, context } = live;
      context.runtime.session.setSessionName(title);
      const manager = context.runtime.session.sessionManager;
      const header = manager.getHeader();
      const sessionFile = context.runtime.session.sessionFile;
      if (sessionFile) {
        this.sessionIndex.set(rawSessionId, {
          projectKey: project.key,
          path: sessionFile,
          directory: project.directory,
          workspaceId: project.workspaceId,
        });
      }
      const session = normalizePiSession(
        {
          id: rawSessionId,
          cwd: project.directory,
          name: title,
          created: header?.timestamp ? new Date(header.timestamp) : new Date(),
          modified: new Date(),
          firstMessage: title,
        },
        project,
      );
      this.sendBackendEvent(project, {
        type: "session.updated",
        directory: project.directory,
        workspaceId: project.workspaceId,
        session,
      });
      return session;
    }

    const project = await this.resolveProjectForSession(rawSessionId, target || {});
    let info = this.sessionIndex.get(rawSessionId);
    if (!info || info.projectKey !== project.key) {
      await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
      info = this.sessionIndex.get(rawSessionId);
    }
    if (!info?.path || info.projectKey !== project.key) {
      throw new Error("Pi session not found");
    }
    if (!existsSync(info.path)) {
      throw new Error("Pi session file not persisted yet; cannot rename non-live session");
    }
    const manager = SessionManager.open(info.path, undefined, project.directory);
    manager.appendSessionInfo(title);
    const session = normalizePiSession(
      {
        id: rawSessionId,
        cwd: project.directory,
        name: title,
        created: new Date(manager.getHeader().timestamp),
        modified: new Date(),
        firstMessage: title,
      },
      project,
    );
    this.sendBackendEvent(project, {
      type: "session.updated",
      directory: project.directory,
      workspaceId: project.workspaceId,
      session,
    });
    return session;
  }

  async getSessionStatuses(target: PiProjectTarget) {
    if (target?.directory) {
      const project = await this.ensureProject(target);
      const sessions = await this.listSessions(target);
      const statuses = {};
      for (const session of sessions) {
        const rawSessionId = toRawSessionId(session.id);
        const liveContext = this.getLiveSessionContext(project, rawSessionId);
        const abortRequested = project.abortedSessionIds?.has(rawSessionId);
        if (liveContext && !abortRequested) {
          this.syncLiveSessionStatus(project, liveContext.runtime.session, { emitEvent: false });
        }
        statuses[session.id] = sessionStatus(
          abortRequested
            ? "idle"
            : liveContext
              ? getSessionActivityType(liveContext.runtime.session)
              : project.busySessionIds.has(rawSessionId)
                ? "busy"
                : "idle",
        );
      }
      return statuses;
    }
    const statuses = {};
    for (const project of this.projects.values()) {
      const sessions = await this.listSessions({
        directory: project.directory,
        workspaceId: project.workspaceId,
      });
      for (const session of sessions) {
        const rawSessionId = toRawSessionId(session.id);
        const liveContext = this.getLiveSessionContext(project, rawSessionId);
        const abortRequested = project.abortedSessionIds?.has(rawSessionId);
        if (liveContext && !abortRequested) {
          this.syncLiveSessionStatus(project, liveContext.runtime.session, { emitEvent: false });
        }
        statuses[session.id] = sessionStatus(
          abortRequested
            ? "idle"
            : liveContext
              ? getSessionActivityType(liveContext.runtime.session)
              : project.busySessionIds.has(rawSessionId)
                ? "busy"
                : "idle",
        );
      }
    }
    return statuses;
  }

  async forkSession(sessionId: string, messageID: string, target: PiProjectTarget) {
    const rawSessionId = toRawSessionId(sessionId);
    const project = await this.resolveProjectForSession(rawSessionId, target || {});
    let info = this.sessionIndex.get(rawSessionId);
    if (!info || info.projectKey !== project.key) {
      await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
      info = this.sessionIndex.get(rawSessionId);
    }
    if (!info?.path || info.projectKey !== project.key) {
      throw new Error("Pi session not found");
    }
    const realMessageId = messageID
      ? this.resolveRealMessageId(project, rawSessionId, messageID)
      : undefined;
    const sourceManager = SessionManager.open(info.path, undefined, project.directory);
    let targetLeafId = realMessageId ?? sourceManager.getLeafId();
    if (realMessageId) {
      const selectedEntry = sourceManager.getEntry(realMessageId);
      if (!selectedEntry) {
        throw new Error("Invalid entry ID for forking");
      }
      if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
        throw new Error("Invalid entry ID for forking");
      }
      targetLeafId = selectedEntry.parentId;
    }
    const forkedPath = sourceManager.createBranchedSession(targetLeafId);
    if (!forkedPath) {
      throw new Error("Failed to create forked session");
    }
    const forkContext = await this.createSessionContext(
      project,
      SessionManager.open(forkedPath, undefined, project.directory),
    );
    const session = normalizePiSession(
      {
        id: forkContext.runtime.session.sessionId,
        cwd: project.directory,
        name: forkContext.runtime.session.sessionName,
        created: new Date(),
        modified: new Date(),
        firstMessage: "",
      },
      project,
    );
    this.sendBackendEvent(project, {
      type: "session.created",
      directory: project.directory,
      workspaceId: project.workspaceId,
      session,
    });
    return session;
  }

  getAuthStorage() {
    return AuthStorage.create(join(this.agentDir, "auth.json"));
  }

  async reloadProviderState() {
    for (const project of this.projects.values()) {
      const runtime =
        project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
      if (!runtime?.services?.modelRegistry) continue;
      runtime.services.modelRegistry.authStorage?.reload?.();
      runtime.services.modelRegistry.refresh?.();
    }
    return true;
  }

  getOAuthFlowKey(target: PiProjectTarget, providerID: string) {
    return `${makeProjectKey(target?.workspaceId, target?.directory)}:${providerID}`;
  }

  async getProviders(target: PiProjectTarget) {
    if (target?.directory) {
      const project = await this.ensureProject(target);
      const runtime =
        project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
      if (!runtime) {
        throw new Error("Pi project runtime not ready");
      }
      runtime.services.modelRegistry.refresh?.();
      const availableModels = runtime.services.modelRegistry.getAvailable();
      return buildProvidersData(availableModels);
    }
    const models = [];
    for (const project of this.projects.values()) {
      const runtime =
        project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
      if (!runtime) continue;
      runtime.services.modelRegistry.refresh?.();
      const availableModels = runtime.services.modelRegistry.getAvailable();
      models.push(...availableModels);
    }
    return buildProvidersData(models);
  }

  async listAllProviders(target: PiProjectTarget) {
    const project = await this.ensureProject(target);
    const runtime =
      project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
    if (!runtime?.services?.modelRegistry) {
      throw new Error("Pi project runtime not ready");
    }
    return buildAllProvidersData(runtime.services.modelRegistry);
  }

  async getProviderAuthMethods(_target: PiProjectTarget) {
    const methods = {};
    for (const provider of this.getAuthStorage().getOAuthProviders()) {
      methods[provider.id] = [
        {
          type: "oauth",
          label: provider.name,
        },
      ];
    }
    return methods;
  }

  async connectProvider(target: PiProjectTarget, providerID: string, auth: unknown) {
    const authStorage = this.getAuthStorage();
    if (auth?.type === "api") {
      authStorage.set(providerID, { type: "api_key", key: auth.key });
      await this.reloadProviderState();
      return true;
    }
    throw new Error(`Unsupported Pi provider auth type: ${auth?.type || "unknown"}`);
  }

  async disconnectProvider(_target: PiProjectTarget, providerID: string) {
    const authStorage = this.getAuthStorage();
    authStorage.remove(providerID);
    await this.reloadProviderState();
    return true;
  }

  async oauthAuthorize(target: PiProjectTarget, providerID: string) {
    const provider = getOAuthProvider(providerID);
    if (!provider) {
      throw new Error(`Pi OAuth provider not found: ${providerID}`);
    }
    const flowKey = this.getOAuthFlowKey(target, providerID);
    const existing = this.pendingOAuth.get(flowKey);
    if (existing?.authorization) {
      return existing.authorization;
    }

    let resolveManualCode;
    let rejectManualCode;
    const manualCodePromise = new Promise((resolve, reject) => {
      resolveManualCode = resolve;
      rejectManualCode = reject;
    });

    const flow = {
      done: false,
      error: null,
      authorization: null,
      resolveManualCode,
      rejectManualCode,
      promise: null,
    };
    this.pendingOAuth.set(flowKey, flow);

    flow.promise = this.getAuthStorage()
      .login(providerID, {
        onAuth: (info) => {
          flow.authorization = {
            url: typeof info === "string" ? info : info.url,
            method: provider.usesCallbackServer ? "code" : "auto",
            instructions:
              (typeof info === "string" ? "" : info.instructions) ||
              (provider.usesCallbackServer
                ? "Complete login in your browser, then paste the final redirect URL or authorization code here."
                : "Complete login in your browser to continue."),
          };
        },
        onPrompt: async () => {
          if (!flow.authorization) return "";
          return String(await manualCodePromise);
        },
        onManualCodeInput: provider.usesCallbackServer
          ? async () => String(await manualCodePromise)
          : undefined,
      })
      .then(async () => {
        flow.done = true;
        await this.reloadProviderState();
        return true;
      })
      .catch((error) => {
        flow.error = error instanceof Error ? error : new Error(String(error));
        throw flow.error;
      });

    const startedAt = Date.now();
    while (!flow.authorization && !flow.error && Date.now() - startedAt < 15_000) {
      await runEffect(sleepEffect(50));
    }
    if (flow.error) throw flow.error;
    if (!flow.authorization) {
      throw new Error(`Pi OAuth authorization did not start for ${providerID}`);
    }
    return flow.authorization;
  }

  async oauthCallback(target: PiProjectTarget, providerID: string, _method: string, code: string) {
    const flowKey = this.getOAuthFlowKey(target, providerID);
    const flow = this.pendingOAuth.get(flowKey);
    if (!flow) {
      throw new Error(`No Pi OAuth flow pending for ${providerID}`);
    }
    if (code && flow.resolveManualCode) {
      flow.resolveManualCode(code);
      flow.resolveManualCode = null;
      flow.rejectManualCode = null;
    }
    if (flow.done) {
      this.pendingOAuth.delete(flowKey);
      return true;
    }
    if (flow.error) {
      this.pendingOAuth.delete(flowKey);
      throw flow.error;
    }
    if (code) {
      await flow.promise;
      this.pendingOAuth.delete(flowKey);
      return true;
    }
    return false;
  }

  async disposeProviderInstance() {
    await this.reloadProviderState();
    return true;
  }

  async getAgents() {
    return [];
  }

  async getCommands(target: PiProjectTarget) {
    const project = target?.directory
      ? await this.ensureProject(target)
      : this.projects.values().next().value;
    if (!project) return [];
    const runtime =
      project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
    if (!runtime) return [];
    const session = runtime.session;
    const extensionCommands = session.extensionRunner
      .getRegisteredCommands()
      .map((command: { invocationName: string; description?: string }) => ({
        name: command.invocationName,
        description: command.description,
        source: "command",
        template: `/${command.invocationName}`,
        hints: [],
      }));
    const promptCommands = session.promptTemplates.map(
      (template: { name: string; description?: string }) => ({
        name: template.name,
        description: template.description,
        source: "command",
        template: `/${template.name}`,
        hints: [],
      }),
    );
    const skillCommands = session.resourceLoader
      .getSkills()
      .skills.map((skill: { name: string; description?: string }) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
        template: `/skill:${skill.name}`,
        hints: [],
      }));
    return [...extensionCommands, ...promptCommands, ...skillCommands];
  }

  async getMessages(sessionId: string, _options: unknown, target: PiProjectTarget) {
    const rawSessionId = toRawSessionId(sessionId);
    const project = await this.resolveProjectForSession(rawSessionId, target || {});
    const liveContext = this.getLiveSessionContext(project, rawSessionId);
    if (liveContext) {
      const cache = this.getSessionCache(project, rawSessionId);
      return {
        messages: cache.messages.map((bundle) => cloneBundle(bundle)),
        nextCursor: null,
      };
    }
    await this.disposeIdleLiveSessionsExcept(project, [rawSessionId]);
    let info = this.sessionIndex.get(rawSessionId);
    if (!info || info.projectKey !== project.key) {
      await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
      info = this.sessionIndex.get(rawSessionId);
    }
    if (!info?.path || info.projectKey !== project.key) {
      throw new Error("Pi session not found");
    }
    const manager = SessionManager.open(info.path, undefined, project.directory);
    const cache = buildTranscriptFromSessionManager(manager, project.directory);
    return {
      messages: cache.messages.map((bundle) => cloneBundle(bundle)),
      nextCursor: null,
    };
  }

  async prompt(
    sessionId: string,
    text: string,
    images: unknown,
    model: unknown,
    _agent: unknown,
    variant: unknown,
    directory: string,
    workspaceId: string | undefined,
  ) {
    const rawSessionId = toRawSessionId(sessionId);
    const { project, session } = await this.ensureSessionContext(rawSessionId, {
      directory,
      workspaceId,
    });
    if (model) {
      await this.applySelectedModel(session, model);
    }
    this.applySelectedVariant(session, variant);
    await this.dispatchSessionPrompt(project, session, text, images);
    return true;
  }

  async abort(sessionId: string, directory: string, workspaceId: string | undefined) {
    const rawSessionId = toRawSessionId(sessionId);
    const project = await this.resolveProjectForSession(rawSessionId, { directory, workspaceId });
    const liveContext = this.getLiveSessionContext(project, rawSessionId);
    if (!liveContext) {
      if (project.busySessionIds.has(rawSessionId)) {
        this.setSessionActivity(project, rawSessionId, "idle");
      }
      return true;
    }
    this.markSessionAbortedIdle(project, rawSessionId);
    try {
      void Promise.resolve(liveContext.runtime.session.abort()).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (/not active|not running|already idle|session is idle/i.test(errorMessage)) {
          this.markSessionAbortedIdle(project, rawSessionId);
          return;
        }
        this.sendBackendEvent(project, {
          type: "session.error",
          error: errorMessage,
          sessionID: rawSessionId,
        });
        if (project.busySessionIds.has(rawSessionId)) {
          this.setSessionActivity(project, rawSessionId, "idle");
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/not active|not running|already idle|session is idle/i.test(errorMessage)) {
        this.markSessionAbortedIdle(project, rawSessionId);
        return true;
      }
      this.sendBackendEvent(project, {
        type: "session.error",
        error: errorMessage,
        sessionID: rawSessionId,
      });
      if (project.busySessionIds.has(rawSessionId)) {
        this.setSessionActivity(project, rawSessionId, "idle");
      }
    }
    return true;
  }

  async summarizeSession(
    sessionId: string,
    model: unknown,
    directory: string,
    workspaceId: string | undefined,
  ) {
    const rawSessionId = toRawSessionId(sessionId);
    const { session } = await this.ensureSessionContext(rawSessionId, { directory, workspaceId });
    if (model) {
      await this.applySelectedModel(session, model);
    }
    await session.compact();
  }

  async sendCommand(
    sessionId: string,
    command: string,
    args: string,
    model: unknown,
    _agent: unknown,
    _variant: unknown,
    directory: string,
    workspaceId: string | undefined,
  ) {
    const text = `/${command}${args ? ` ${args}` : ""}`;
    return await this.prompt(
      sessionId,
      text,
      [],
      model,
      undefined,
      undefined,
      directory,
      workspaceId,
    );
  }
}

type PiDaemonInfo = {
  pid?: number;
  port: number;
  token: string;
  baseUrl: string;
  startedAt?: number;
};

type PiDaemonRpcResult = { success: boolean; error?: string; data?: unknown };

type PiDaemonClientOptions = { userData?: string };

type PiProjectTarget = { directory?: string; workspaceId?: string };

function daemonInfoPath(userData: string | undefined) {
  return join(userData || process.cwd(), "pi-daemon.json");
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function readDaemonInfo(path: string): Promise<PiDaemonInfo | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeDaemonInfo(path: string, info: PiDaemonInfo) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(info, null, 2), "utf8");
}

async function fetchDaemonJson(
  baseUrl: string,
  token: string,
  path: string,
  options: RequestInit & { timeout?: number; headers?: Record<string, string> } = {},
): Promise<PiDaemonRpcResult> {
  const response = await runEffect(
    timeoutEffect(
      tryPromiseEffect((signal) =>
        fetch(`${baseUrl}${path}`, {
          ...options,
          signal,
          headers: {
            "content-type": "application/json",
            "x-opengui-pi-token": token,
            ...options.headers,
          },
        }),
      ),
      {
        timeoutMs: options.timeout ?? PI_DAEMON_HEALTH_TIMEOUT,
        timeoutMessage: `Timed out calling Pi daemon ${path}`,
      },
    ),
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body.trim().slice(0, 800);
    throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
  }
  return (await response.json()) as PiDaemonRpcResult;
}

class PiDaemonClient {
  emitBridgeEvent: (event: HarnessBridgeNativeEvent) => void;
  userData: string;
  infoPath: string;
  info: PiDaemonInfo | null;
  startPromise: Promise<PiDaemonInfo> | null;
  eventAbort: AbortController | null;
  eventReconnectTimer: ReturnType<typeof setTimeout> | null;
  eventStarted: boolean;

  constructor(
    getAllWindows: () => Iterable<{ webContents: { send: (ch: string, ...a: unknown[]) => void } }>,
    options: PiDaemonClientOptions = {},
  ) {
    this.emitBridgeEvent = makeHarnessBridgeEventEmitter("pi", getAllWindows);
    this.userData = options.userData || process.cwd();
    this.infoPath = daemonInfoPath(this.userData);
    this.info = null;
    this.startPromise = null;
    this.eventAbort = null;
    this.eventReconnectTimer = null;
    this.eventStarted = false;
  }

  async addProject(config: PiProjectTarget) {
    return await this.call("addProject", [config]);
  }

  async removeProject(target: PiProjectTarget) {
    return await this.call("removeProject", [target]);
  }

  async disconnect() {
    // Client-side disconnect only. Background daemon and running Pi sessions stay alive.
    this.stopEvents();
    this.info = null;
    return true;
  }

  async restart() {
    const existing = this.info ?? (await readDaemonInfo(this.infoPath));
    this.stopEvents();
    this.startPromise = null;
    await this.stopDaemon(existing);
    await this.waitForDaemonStopped(existing);
    this.info = null;
    this.info = await this.startDaemon(existing);
    this.startEvents();
    return true;
  }

  async listSessions(target: PiProjectTarget) {
    return await this.call("listSessions", [target]);
  }

  async createSession(input: Record<string, unknown>) {
    return await this.call("createSession", [input]);
  }

  async deleteSession(sessionId: string, target: PiProjectTarget) {
    return await this.call("deleteSession", [sessionId, target]);
  }

  async updateSession(sessionId: string, title: string, target: PiProjectTarget) {
    return await this.call("updateSession", [sessionId, title, target]);
  }

  async getSessionStatuses(target: PiProjectTarget) {
    return await this.call("getSessionStatuses", [target]);
  }

  async forkSession(sessionId: string, messageID: string, target: PiProjectTarget) {
    return await this.call("forkSession", [sessionId, messageID, target]);
  }

  async getProviders(target: PiProjectTarget) {
    return await this.call("getProviders", [target]);
  }

  async listAllProviders(target: PiProjectTarget) {
    return await this.call("listAllProviders", [target]);
  }

  async getProviderAuthMethods(target: PiProjectTarget) {
    return await this.call("getProviderAuthMethods", [target]);
  }

  async connectProvider(target: PiProjectTarget, providerID: string, auth: unknown) {
    return await this.call("connectProvider", [target, providerID, auth]);
  }

  async disconnectProvider(target: PiProjectTarget, providerID: string) {
    return await this.call("disconnectProvider", [target, providerID]);
  }

  async oauthAuthorize(target: PiProjectTarget, providerID: string, method: string) {
    return await this.call("oauthAuthorize", [target, providerID, method]);
  }

  async oauthCallback(target: PiProjectTarget, providerID: string, method: string, code: string) {
    return await this.call("oauthCallback", [target, providerID, method, code]);
  }

  async disposeProviderInstance(target: PiProjectTarget) {
    return await this.call("disposeProviderInstance", [target]);
  }

  async getAgents() {
    return await this.call("getAgents", []);
  }

  async getCommands(target: PiProjectTarget) {
    return await this.call("getCommands", [target]);
  }

  async getMessages(sessionId: string, options: unknown, target: PiProjectTarget) {
    return await this.call("getMessages", [sessionId, options, target]);
  }

  async startSession(input: Record<string, unknown>) {
    return await this.call("startSession", [input]);
  }

  async prompt(
    sessionId: string,
    text: string,
    images: unknown,
    model: unknown,
    agent: unknown,
    variant: unknown,
    directory: string,
    workspaceId: string | undefined,
  ) {
    return await this.call("prompt", [
      sessionId,
      text,
      images,
      model,
      agent,
      variant,
      directory,
      workspaceId,
    ]);
  }

  async abort(sessionId: string, directory: string, workspaceId: string | undefined) {
    return await this.call("abort", [sessionId, directory, workspaceId]);
  }

  async sendCommand(
    sessionId: string,
    command: string,
    args: string,
    model: unknown,
    agent: unknown,
    variant: unknown,
    directory: string,
    workspaceId: string | undefined,
  ) {
    return await this.call("sendCommand", [
      sessionId,
      command,
      args,
      model,
      agent,
      variant,
      directory,
      workspaceId,
    ]);
  }

  async summarizeSession(
    sessionId: string,
    model: unknown,
    directory: string,
    workspaceId: string | undefined,
  ) {
    return await this.call("summarizeSession", [sessionId, model, directory, workspaceId]);
  }

  async call(method: string, args: unknown[]) {
    const info = await this.ensureDaemon();
    const result = await fetchDaemonJson(info.baseUrl, info.token, "/rpc", {
      method: "POST",
      body: JSON.stringify({ method, args }),
      timeout: 30_000,
    });
    if (!result.success) throw new Error(result.error || `Pi daemon call failed: ${method}`);
    return result.data;
  }

  async ensureDaemon() {
    if (this.info && (await this.isHealthy(this.info))) return this.info;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startDaemon();
    try {
      this.info = await this.startPromise;
      if (!this.eventStarted) this.startEvents();
      return this.info;
    } finally {
      this.startPromise = null;
    }
  }

  async getHealth(info: PiDaemonInfo | null) {
    if (!info?.baseUrl || !info?.token) return null;
    try {
      return await fetchDaemonJson(info.baseUrl, info.token, "/health");
    } catch {
      return null;
    }
  }

  async isHealthy(info: PiDaemonInfo) {
    const health = await this.getHealth(info);
    return Boolean(health?.success && health?.data?.daemonVersion === PI_DAEMON_VERSION);
  }

  async stopDaemon(info: PiDaemonInfo | null) {
    if (!info?.baseUrl || !info?.token) return;
    try {
      await fetchDaemonJson(info.baseUrl, info.token, "/shutdown", {
        method: "POST",
        timeout: 1_000,
      });
    } catch {
      // Best effort. A stale daemon may already be gone.
    }
  }

  async waitForDaemonStopped(info: PiDaemonInfo | null) {
    if (!info?.baseUrl || !info?.token) return;
    await runEffect(
      pollUntilEffect({
        attempt: async () => !(await this.getHealth(info)),
        intervalMs: 100,
        timeoutMs: 3_000,
        timeoutMessage: "Pi daemon did not stop in time",
      }),
    ).catch(() => undefined);
  }

  async startDaemon(preferredInfo: PiDaemonInfo | null = null) {
    if (!preferredInfo) {
      const existing = await readDaemonInfo(this.infoPath);
      const existingHealth = await this.getHealth(existing);
      if (existingHealth?.success && existingHealth?.data?.daemonVersion === PI_DAEMON_VERSION)
        return existing;
      if (existingHealth?.success) await this.stopDaemon(existing);
    }

    const port = Number(preferredInfo?.port || (await findFreePort()));
    if (!port) throw new Error("Could not allocate Pi daemon port");
    const token = preferredInfo?.token || randomUUID();
    const baseUrl = `http://127.0.0.1:${port}`;
    const daemonPathCandidates = [
      join(process.cwd(), "packages/runtime/src/adapters/pi-daemon-server.ts"),
      join(__dirname, "pi-daemon-server.ts"),
      join(__dirname, "pi-daemon-server.js"),
      join(process.cwd(), "dist-electron", "pi-daemon-server.js"),
    ];
    const daemonPath = daemonPathCandidates.find((candidate) => existsSync(candidate));
    if (!daemonPath) {
      throw new Error(`Pi daemon script not found. Tried: ${daemonPathCandidates.join(", ")}`);
    }

    let logs = "";
    const appendLog = (chunk: Buffer | string) => {
      if (logs.length < 8192) logs += chunk.toString().slice(0, 8192 - logs.length);
    };
    const daemonArgs = daemonPath.endsWith(".ts")
      ? ["--experimental-strip-types", daemonPath, "--port", String(port), "--token", token]
      : [daemonPath, "--port", String(port), "--token", token];
    const child = spawn(process.execPath, daemonArgs, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OPENGUI_PI_DAEMON_PORT: String(port),
        OPENGUI_PI_DAEMON_TOKEN: token,
        OPENGUI_PI_DAEMON_VERSION: PI_DAEMON_VERSION,
      },
    });
    child.stdout?.on("data", appendLog);
    child.stderr?.on("data", appendLog);
    child.unref();

    const startedAt = Date.now();
    const info = { pid: child.pid, port, token, baseUrl, startedAt };
    await runEffect(
      pollUntilEffect({
        attempt: async () => await this.isHealthy(info),
        intervalMs: 200,
        timeoutMs: PI_DAEMON_STARTUP_TIMEOUT,
        timeoutMessage: () => `Pi daemon did not become healthy. ${logs.trim()}`.trim(),
      }),
    );
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    child.stdout?.destroy();
    child.stderr?.destroy();
    await writeDaemonInfo(this.infoPath, info);
    return info;
  }

  startEvents() {
    this.eventStarted = true;
    void this.connectEvents();
  }

  stopEvents() {
    this.eventStarted = false;
    if (this.eventReconnectTimer) clearTimeout(this.eventReconnectTimer);
    this.eventReconnectTimer = null;
    this.eventAbort?.abort();
    this.eventAbort = null;
  }

  scheduleEventReconnect() {
    if (!this.eventStarted || this.eventReconnectTimer) return;
    this.eventReconnectTimer = setTimeout(() => {
      this.eventReconnectTimer = null;
      void this.connectEvents();
    }, PI_DAEMON_SSE_RECONNECT_DELAY);
  }

  async connectEvents() {
    if (!this.eventStarted) return;
    let info;
    try {
      info = await this.ensureDaemon();
    } catch {
      this.scheduleEventReconnect();
      return;
    }
    this.eventAbort?.abort();
    const controller = new AbortController();
    this.eventAbort = controller;
    try {
      const response = await fetch(`${info.baseUrl}/events`, {
        signal: controller.signal,
        headers: { "x-opengui-pi-token": info.token },
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (this.eventStarted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line || line.startsWith(":")) continue;
          const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
          if (!payload) continue;
          this.forwardEvent(JSON.parse(payload));
        }
      }
    } catch {
      // Reconnect below unless this was an intentional disconnect.
    } finally {
      if (this.eventAbort === controller) this.eventAbort = null;
      this.scheduleEventReconnect();
    }
  }

  forwardEvent(event: HarnessBridgeNativeEvent) {
    this.emitBridgeEvent(event);
  }
}

export function setupPiBridge(
  ipcMain: Parameters<typeof registerHarnessRpcHandlers>[1],
  getAllWindows: () => Iterable<{ webContents: { send: (ch: string, ...a: unknown[]) => void } }>,
  options: PiDaemonClientOptions = {},
) {
  const manager = new PiDaemonClient(getAllWindows, options);

  registerHarnessRpcHandlers("pi", ipcMain, {
    "project:add": async (config) => {
      await manager.addProject(config);
      return true;
    },
    "project:remove": async (directory, workspaceId) => {
      await manager.removeProject({ directory, workspaceId });
      return true;
    },
    disconnect: async () => {
      await manager.disconnect();
      return true;
    },
    "session:list": (directory, workspaceId) => manager.listSessions({ directory, workspaceId }),
    "session:create": (title, directory, workspaceId) =>
      manager.createSession({ title, directory, workspaceId }),
    "session:delete": (sessionId, directory, workspaceId) =>
      manager.deleteSession(sessionId, { directory, workspaceId }),
    "session:update": (sessionId, title, directory, workspaceId) =>
      manager.updateSession(sessionId, title, { directory, workspaceId }),
    "session:statuses": (directory, workspaceId) =>
      manager.getSessionStatuses({ directory, workspaceId }),
    "session:fork": (sessionId, messageID, directory, workspaceId) =>
      manager.forkSession(sessionId, messageID, { directory, workspaceId }),
    providers: (directory, workspaceId) => manager.getProviders({ directory, workspaceId }),
    "provider:list": (directory, workspaceId) =>
      manager.listAllProviders({ directory, workspaceId }),
    "provider:auth-methods": (directory, workspaceId) =>
      manager.getProviderAuthMethods({ directory, workspaceId }),
    "provider:connect": (directory, workspaceId, providerID, auth) =>
      manager.connectProvider({ directory, workspaceId }, providerID, auth),
    "provider:disconnect": (directory, workspaceId, providerID) =>
      manager.disconnectProvider({ directory, workspaceId }, providerID),
    "provider:oauth:authorize": (directory, workspaceId, providerID, method) =>
      manager.oauthAuthorize({ directory, workspaceId }, providerID, method),
    "provider:oauth:callback": (directory, workspaceId, providerID, method, code) =>
      manager.oauthCallback({ directory, workspaceId }, providerID, method, code),
    "instance:dispose": (directory, workspaceId) =>
      manager.disposeProviderInstance({ directory, workspaceId }),
    agents: () => manager.getAgents(),
    commands: (directory, workspaceId) => manager.getCommands({ directory, workspaceId }),
    messages: (sessionId, options, directory, workspaceId) =>
      manager.getMessages(sessionId, options, { directory, workspaceId }),
    "session:start": (input) => manager.startSession(input),
    prompt: async (sessionId, text, images, model, agent, variant, directory, workspaceId) => {
      await manager.prompt(sessionId, text, images, model, agent, variant, directory, workspaceId);
      return true;
    },
    abort: async (sessionId, directory, workspaceId) => {
      await manager.abort(sessionId, directory, workspaceId);
      return true;
    },
    "command:send": async (
      sessionId,
      command,
      args,
      model,
      agent,
      variant,
      directory,
      workspaceId,
    ) => {
      await manager.sendCommand(
        sessionId,
        command,
        args,
        model,
        agent,
        variant,
        directory,
        workspaceId,
      );
      return true;
    },
    "session:summarize": async (sessionId, model, directory, workspaceId) => {
      await manager.summarizeSession(sessionId, model, directory, workspaceId);
      return true;
    },
  });

  return {
    restart: () => manager.restart(),
  };
}
