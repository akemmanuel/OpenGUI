// @ts-nocheck
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
  fail,
  makeHarnessProjectKey,
  normalizeHarnessDirectory,
  nowHarnessConnection,
  ok,
} from "./harness-adapter-kit.ts";
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

const PI_DAEMON_STARTUP_TIMEOUT = 15_000;
const PI_DAEMON_SSE_RECONNECT_DELAY = 1_000;
const PI_DAEMON_HEALTH_TIMEOUT = 2_000;
// Bump when daemon import/runtime behavior changes. Existing healthy daemon gets reused
// across app restarts; failed lazy ESM imports inside pi-ai stay poisoned in-process.
const PI_DAEMON_VERSION = "2026-06-15-dev-source-daemon-v1";
const __dirname = dirname(fileURLToPath(import.meta.url));

function normalizeDir(directory) {
  return normalizeHarnessDirectory(directory);
}

function makeProjectKey(workspaceId, directory) {
  return makeHarnessProjectKey(workspaceId, directory);
}

function toFrontendSessionId(id) {
  const value = String(id || "");
  return value.startsWith("pi:") ? value : `pi:${value}`;
}

function toRawSessionId(id) {
  const value = String(id || "");
  return value.startsWith("pi:") ? value.slice(3) : value;
}

function nowConnection(status = {}) {
  return nowHarnessConnection(status);
}

function coerceTimestamp(timestamp) {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  return Date.now();
}

function stringifyUnknown(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function makeStreamingMessageId(sessionId, seq) {
  return `pi:stream:${sessionId}:assistant:${seq}`;
}

function makeTextPartId(messageId, index) {
  return `${messageId}:text:${index}`;
}

function makeReasoningPartId(messageId, index) {
  return `${messageId}:reasoning:${index}`;
}

function makeFilePartId(messageId, index) {
  return `${messageId}:file:${index}`;
}

function makeToolPartId(messageId, toolCallId, index) {
  return `${messageId}:tool:${toolCallId || index}`;
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1] || "application/octet-stream",
    data: match[2],
  };
}

function piImageBlockToFilePart(block, messageId, index) {
  if (!block || block.type !== "image") return null;
  return {
    id: makeFilePartId(messageId, index),
    sessionID: "",
    messageID: messageId,
    type: "file",
    mime: block.mimeType || "application/octet-stream",
    filename: `image-${index + 1}.${(block.mimeType || "application/octet-stream").split("/")[1] || "bin"}`,
    url: `data:${block.mimeType || "application/octet-stream"};base64,${block.data}`,
  };
}

function toolResultContentToText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text") {
      parts.push(block.text || "");
      continue;
    }
    if (block.type === "image") {
      parts.push(`[image ${block.mimeType || "application/octet-stream"}]`);
    }
  }
  return parts.join("\n").trim();
}

function makeSessionTitleFromText(text, title) {
  const explicit = typeof title === "string" ? title.trim() : "";
  if (explicit) return explicit;
  const firstLine =
    String(text ?? "")
      .trim()
      .split(/\r?\n/, 1)[0] ?? "";
  return firstLine.slice(0, 80) || "Untitled";
}

function normalizePiSession(info, target = {}) {
  const directory = normalizeDir(target.directory || info?.cwd || "");
  const rawId = String(info.id || "");
  const rawFirstMessage =
    typeof info?.firstMessage === "string"
      ? info.firstMessage
      : stringifyUnknown(info?.firstMessage);
  const title = info?.name || rawFirstMessage || "Untitled";
  return {
    id: toFrontendSessionId(rawId),
    slug: rawId,
    _harnessId: "pi",
    _rawId: rawId,
    projectID: directory,
    workspaceID: target.workspaceId,
    directory,
    title,
    version: "pi",
    ...(info.model ? { model: info.model } : {}),
    time: {
      created: info.created?.getTime?.() ?? Date.now(),
      updated: info.modified?.getTime?.() ?? info.created?.getTime?.() ?? Date.now(),
    },
  };
}

function extractPiThinkingVariant(entry) {
  const raw = entry?.level ?? entry?.thinkingLevel ?? entry?.effort ?? entry?.value ?? entry?.label;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function inferPiSessionModelFromManager(manager) {
  const context = manager.buildSessionContext?.();
  if (context?.model?.provider && context.model.modelId) {
    return {
      providerID: context.model.provider,
      id: context.model.modelId,
      ...(typeof context.thinkingLevel === "string" ? { variant: context.thinkingLevel } : {}),
    };
  }

  let currentModel = null;
  let currentVariant;
  for (const entry of manager.getBranch()) {
    if (entry.type === "model_change") {
      if (entry.provider && entry.modelId) {
        currentModel = { providerID: entry.provider, id: entry.modelId };
      }
      continue;
    }
    if (entry.type === "thinking_level_change") {
      currentVariant = extractPiThinkingVariant(entry) ?? currentVariant;
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.provider && entry.message.model) {
      currentModel = { providerID: entry.message.provider, id: entry.message.model };
    }
  }
  if (!currentModel) return null;
  return { ...currentModel, ...(currentVariant ? { variant: currentVariant } : {}) };
}

function sessionStatus(type) {
  return { type };
}

function getSessionActivityType(session) {
  if (session?.isCompacting) return "busy";
  if (session?.isStreaming) return "busy";
  return "idle";
}

function openGuiError(errorMessage) {
  return {
    name: "PiError",
    data: { message: errorMessage },
  };
}

function createUserInfo({ sessionId, messageId, timestamp, model, directory }) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created: timestamp },
    agent: "pi",
    model: {
      providerID: model?.provider ?? "pi",
      modelID: model?.modelId ?? "default",
      ...(model?.variant ? { variant: model.variant } : {}),
    },
    system: directory || undefined,
  };
}

function createAssistantInfo({
  sessionId,
  messageId,
  timestamp,
  message,
  directory,
  parentID,
  createdAt,
  completedAt,
}) {
  const isCompleted = typeof completedAt === "number";
  return {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: {
      created: typeof createdAt === "number" ? createdAt : timestamp,
      completed: isCompleted ? completedAt : undefined,
    },
    error:
      isCompleted && message?.stopReason === "error"
        ? openGuiError(message?.errorMessage || "Pi error")
        : undefined,
    parentID: parentID || "",
    modelID: message?.model || "",
    providerID: message?.provider || "pi",
    ...(message?.variant ? { variant: message.variant } : {}),
    mode: "pi",
    agent: "pi",
    path: {
      cwd: directory,
      root: directory,
    },
    cost: message?.usage?.cost?.total ?? 0,
    tokens: {
      total: message?.usage?.totalTokens,
      input: message?.usage?.input ?? 0,
      output: message?.usage?.output ?? 0,
      reasoning: 0,
      cache: {
        read: message?.usage?.cacheRead ?? 0,
        write: message?.usage?.cacheWrite ?? 0,
      },
    },
    finish: isCompleted ? message?.stopReason : undefined,
  };
}

function visibleUiBranchEntries(sessionManager) {
  const branch = sessionManager.getBranch();
  let latestCompaction = null;
  for (const entry of branch) {
    if (entry.type === "compaction") latestCompaction = entry;
  }
  if (!latestCompaction) return { entries: branch, seedEntries: [] };
  const compactionIdx = branch.findIndex((entry) => entry.id === latestCompaction.id);
  if (compactionIdx < 0) return { entries: branch, seedEntries: [] };
  const visible = [];
  let foundFirstKept = false;
  let visibleStartIdx = compactionIdx;
  for (let i = 0; i < compactionIdx; i++) {
    const entry = branch[i];
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

function createBundle(info, parts = []) {
  return {
    info,
    parts,
  };
}

function cloneBundle(bundle) {
  return {
    info: { ...bundle.info },
    parts: bundle.parts.map((part) => ({ ...part })),
  };
}

function buildUserParts(content, messageId) {
  if (typeof content === "string") {
    return content
      ? [
          {
            id: makeTextPartId(messageId, 0),
            sessionID: "",
            messageID: messageId,
            type: "text",
            text: content,
          },
        ]
      : [];
  }
  const parts = [];
  let textIndex = 0;
  let fileIndex = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (!block) continue;
    if (block.type === "text") {
      parts.push({
        id: makeTextPartId(messageId, textIndex),
        sessionID: "",
        messageID: messageId,
        type: "text",
        text: block.text || "",
      });
      textIndex += 1;
      continue;
    }
    if (block.type === "image") {
      const filePart = piImageBlockToFilePart(block, messageId, fileIndex);
      if (filePart) parts.push(filePart);
      fileIndex += 1;
    }
  }
  return parts;
}

function normalizeToolInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input ?? {};
  }
  const normalized = { ...input };
  if (typeof normalized.path === "string" && normalized.filePath === undefined) {
    normalized.filePath = normalized.path;
  }
  if (typeof normalized.file_path === "string" && normalized.filePath === undefined) {
    normalized.filePath = normalized.file_path;
  }
  if (typeof normalized.old_string === "string" && normalized.oldString === undefined) {
    normalized.oldString = normalized.old_string;
  }
  if (typeof normalized.new_string === "string" && normalized.newString === undefined) {
    normalized.newString = normalized.new_string;
  }
  if (typeof normalized.task_description === "string" && normalized.description === undefined) {
    normalized.description = normalized.task_description;
  }
  if (typeof normalized.subagent_type === "string" && normalized.subagentType === undefined) {
    normalized.subagentType = normalized.subagent_type;
  }
  return normalized;
}

function syncAssistantParts(bundle, message, reasoningTimesByContentIndex) {
  const existingToolPartsByCallId = new Map();
  for (const part of bundle.parts) {
    if (part.type === "tool") {
      existingToolPartsByCallId.set(part.callID, part);
    }
  }
  const nextParts = [];
  const content = Array.isArray(message?.content) ? message.content : [];
  let textIndex = 0;
  let reasoningIndex = 0;
  let toolIndex = 0;
  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const block = content[contentIndex];
    if (!block) continue;
    if (block.type === "text") {
      nextParts.push({
        id: makeTextPartId(bundle.info.id, textIndex),
        sessionID: bundle.info.sessionID,
        messageID: bundle.info.id,
        type: "text",
        text: block.text || "",
      });
      textIndex += 1;
      continue;
    }
    if (block.type === "thinking") {
      const reasoningTime = reasoningTimesByContentIndex?.get(contentIndex);
      nextParts.push({
        id: makeReasoningPartId(bundle.info.id, reasoningIndex),
        sessionID: bundle.info.sessionID,
        messageID: bundle.info.id,
        type: "reasoning",
        text: block.thinking || (block.redacted ? "[Reasoning redacted]" : ""),
        time: {
          start: reasoningTime?.start ?? bundle.info.time.created,
          end:
            typeof reasoningTime?.end === "number"
              ? reasoningTime.end
              : typeof bundle.info.time.completed === "number"
                ? bundle.info.time.completed
                : undefined,
        },
      });
      reasoningIndex += 1;
      continue;
    }
    if (block.type === "toolCall") {
      const existing = existingToolPartsByCallId.get(block.id);
      const normalizedInput = normalizeToolInput(block.arguments || {});
      nextParts.push({
        id: existing?.id ?? makeToolPartId(bundle.info.id, block.id, toolIndex),
        sessionID: bundle.info.sessionID,
        messageID: bundle.info.id,
        type: "tool",
        callID: block.id,
        tool: block.name,
        state: existing?.state ?? {
          status: "pending",
          input: normalizedInput,
          raw: stringifyUnknown(normalizedInput),
        },
      });
      toolIndex += 1;
    }
  }
  for (const existing of bundle.parts) {
    if (existing.type === "tool" && !nextParts.some((part) => part.id === existing.id)) {
      nextParts.push(existing);
    }
  }
  bundle.parts = nextParts;
}

function createSummaryUserBundle({ sessionId, messageId, timestamp, text, model, directory }) {
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

function buildTranscriptFromSessionManager(sessionManager, directory) {
  const sessionId = toFrontendSessionId(sessionManager.getSessionId());
  const { entries, seedEntries } = visibleUiBranchEntries(sessionManager);
  const bundles = [];
  const toolPartByCallId = new Map();
  let lastUserMessageId = "";
  let currentModel = null;
  let currentThinkingLevel;
  let lastTimelineTimestamp = null;

  for (const entry of seedEntries) {
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
          messageId: entry.id,
          timestamp: entryTimestamp,
          summary: entry.summary,
          model: currentModel,
          directory,
          parentID: lastUserMessageId,
          tailStartId: entry.firstKeptEntryId,
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
  constructor(getAllWindows) {
    this.getAllWindows = getAllWindows;
    this.agentDir = getAgentDir();
    this.projects = new Map();
    this.projectInitPromises = new Map();
    this.sessionIndex = new Map();
    this.sessionInfoCache = new Map();
    this.directorySessionInfoCache = new Map();
    this.pendingOAuth = new Map();
  }

  sendNativeEvent(event) {
    for (const window of this.getAllWindows()) {
      if (window?.isDestroyed?.()) continue;
      window.webContents.send("pi:bridge-event", event);
    }
  }

  sendConnectionStatus(project, status) {
    this.sendNativeEvent({
      type: "connection:status",
      directory: project.directory,
      workspaceId: project.workspaceId,
      payload: status,
    });
  }

  sendBackendEvent(project, payload) {
    this.sendNativeEvent({
      type: "pi:event",
      directory: project.directory,
      workspaceId: project.workspaceId,
      payload,
    });
  }

  getProject(target = {}) {
    const directory = normalizeDir(target.directory);
    if (!directory) return null;
    return this.projects.get(makeProjectKey(target.workspaceId, directory)) || null;
  }

  getOrThrowProject(target = {}) {
    const project = this.getProject(target);
    if (!project) {
      throw new Error("Pi project not connected");
    }
    return project;
  }

  getLiveSessionContext(project, sessionId) {
    return project.liveSessionContexts.get(sessionId) || null;
  }

  async disposeLiveSessionContext(project, sessionId, { keepCache = true } = {}) {
    const context = this.getLiveSessionContext(project, sessionId);
    if (!context) return;
    context.unsubscribe?.();
    await context.runtime.dispose().catch(() => {});
    project.liveSessionContexts.delete(sessionId);
    project.sessionContextInitPromises.delete(sessionId);
    project.busySessionIds.delete(sessionId);
    if (!keepCache) {
      project.syntheticStateBySessionId.delete(sessionId);
      project.sessionCaches.delete(sessionId);
      this.sessionIndex.delete(sessionId);
    }
    this.syncProjectRuntime(project);
  }

  async disposeIdleLiveSessionsExcept(project, keepSessionIds = []) {
    const keep = new Set(keepSessionIds.filter(Boolean));
    for (const sessionId of project.liveSessionContexts.keys()) {
      if (keep.has(sessionId) || project.busySessionIds.has(sessionId)) continue;
      await this.disposeLiveSessionContext(project, sessionId, { keepCache: true });
    }
  }

  findLiveSessionContext(sessionId) {
    for (const project of this.projects.values()) {
      const context = this.getLiveSessionContext(project, sessionId);
      if (context) return { project, context };
    }
    return null;
  }

  syncProjectRuntime(project) {
    const firstContext = project.liveSessionContexts.values().next().value || null;
    project.runtime = firstContext?.runtime || null;
  }

  setSessionActivity(project, sessionId, nextType, { emitEvent = true } = {}) {
    const wasBusy = project.busySessionIds.has(sessionId);
    const isBusy = nextType === "busy";
    if (isBusy) {
      project.busySessionIds.add(sessionId);
    } else {
      project.busySessionIds.delete(sessionId);
    }
    if (!emitEvent || wasBusy === isBusy) return nextType;
    this.sendBackendEvent(project, {
      type: "session.status",
      sessionID: sessionId,
      status: sessionStatus(nextType),
    });
    return nextType;
  }

  syncLiveSessionStatus(project, session, options = {}) {
    return this.setSessionActivity(
      project,
      session.sessionId,
      getSessionActivityType(session),
      options,
    );
  }

  makeSyntheticState() {
    return {
      nextSeq: 0,
      currentUserMessageId: null,
      currentAssistantMessageId: null,
      assistantStartedAt: null,
      reasoningTimesByContentIndex: new Map(),
      syntheticToReal: new Map(),
      pendingAssistantResolution: null,
      pendingAssistantResolutions: [],
    };
  }

  registerLiveSessionContext(project, runtime) {
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
    if (!project.syntheticStateBySessionId.has(sessionId)) {
      project.syntheticStateBySessionId.set(sessionId, this.makeSyntheticState());
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

  async createRuntime(sessionManager) {
    const createRuntime = async ({ cwd, sessionManager, sessionStartEvent, agentDir }) => {
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

  async ensureProject(target = {}) {
    const directory = normalizeDir(target.directory);
    if (!directory) {
      throw new Error("Directory required for Pi backend");
    }
    const workspaceId = target.workspaceId;
    const key = makeProjectKey(workspaceId, directory);
    const existingProject = this.projects.get(key);
    if (existingProject?.runtime || existingProject?.liveSessionContexts?.size > 0) {
      this.syncProjectRuntime(existingProject);
      this.sendConnectionStatus(existingProject, nowConnection({ state: "connected" }));
      return existingProject;
    }

    const pendingInit = this.projectInitPromises.get(key);
    if (pendingInit) return await pendingInit;

    const project = existingProject ?? {
      key,
      directory,
      workspaceId,
      busySessionIds: new Set(),
      sessionCaches: new Map(),
      syntheticStateBySessionId: new Map(),
      liveSessionContexts: new Map(),
      sessionContextInitPromises: new Map(),
      runtime: null,
      sessionUnsubscribe: null,
      currentSessionId: null,
      currentSessionFile: null,
    };
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

  async createSessionContext(project, sessionManager) {
    const runtime = await this.createRuntime(sessionManager);
    return this.registerLiveSessionContext(project, runtime);
  }

  async ensureSessionContext(sessionId, target = {}) {
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

  async attachSession(project, session) {
    if (project.sessionUnsubscribe) {
      project.sessionUnsubscribe();
      project.sessionUnsubscribe = null;
    }
    project.currentSessionId = session.sessionId;
    project.currentSessionFile = session.sessionFile;
    const cache = buildTranscriptFromSessionManager(session.sessionManager, project.directory);
    project.sessionCaches.set(session.sessionId, cache);
    if (!project.syntheticStateBySessionId.has(session.sessionId)) {
      project.syntheticStateBySessionId.set(session.sessionId, this.makeSyntheticState());
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

  getSyntheticState(project, sessionId) {
    if (!project.syntheticStateBySessionId.has(sessionId)) {
      project.syntheticStateBySessionId.set(sessionId, this.makeSyntheticState());
    }
    return project.syntheticStateBySessionId.get(sessionId);
  }

  getSessionCache(project, sessionId) {
    if (!project.sessionCaches.has(sessionId)) {
      project.sessionCaches.set(sessionId, { messages: [] });
    }
    return project.sessionCaches.get(sessionId);
  }

  upsertBundle(project, sessionId, bundle) {
    const cache = this.getSessionCache(project, sessionId);
    const index = cache.messages.findIndex((item) => item.info.id === bundle.info.id);
    if (index >= 0) {
      cache.messages[index] = cloneBundle(bundle);
    } else {
      cache.messages.push(cloneBundle(bundle));
    }
  }

  findBundle(project, sessionId, messageId) {
    const cache = this.getSessionCache(project, sessionId);
    return cache.messages.find((item) => item.info.id === messageId) || null;
  }

  closeOpenReasoning(state, endedAt = Date.now(), exceptContentIndex = null) {
    for (const [contentIndex, time] of state.reasoningTimesByContentIndex) {
      if (contentIndex === exceptContentIndex) continue;
      if (!time || typeof time.start !== "number" || typeof time.end === "number") {
        continue;
      }
      time.end = endedAt;
    }
  }

  markReasoningStart(state, contentIndex, startedAt = Date.now()) {
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

  markReasoningEnd(state, contentIndex, endedAt = Date.now()) {
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

  findLatestRealMessageId(sessionManager, role) {
    const branch = sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === role) return entry.id;
    }
    return null;
  }

  findRealEntryId(sessionManager, role, timestamp, contentText) {
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

  emitCanonicalTranscript(project, session) {
    const state = this.getSyntheticState(project, session.sessionId);
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
    for (let i = 0; i < pendingStreaming.length && i < newCanonicalAssistants.length; i += 1) {
      const pending = pendingStreaming[i];
      const bundle = newCanonicalAssistants[i];
      replacementIds.add(bundle.info.id);
      replacedSyntheticIds.add(pending.syntheticId);
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

  emitRealMessage(project, session, role, timestamp, contentText) {
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

  flushPendingAssistantResolution(project, session) {
    const state = project.syntheticStateBySessionId.get(session.sessionId);
    const pending = state?.pendingAssistantResolution;
    if (!pending) return;
    state.pendingAssistantResolution = null;
    this.emitRealMessage(project, session, "assistant", pending.timestamp, pending.contentText);
  }

  findCurrentAssistantBundle(project, sessionId, state) {
    const candidateIds = [];
    if (typeof state.currentAssistantMessageId === "string") {
      candidateIds.push(state.currentAssistantMessageId);
    }
    const pendingSyntheticId = state.pendingAssistantResolution?.syntheticId;
    if (typeof pendingSyntheticId === "string") {
      candidateIds.push(pendingSyntheticId);
    }
    for (let i = 0; i < candidateIds.length; i += 1) {
      const id = candidateIds[i];
      const mapped = state.syntheticToReal.get(id);
      if (mapped) candidateIds.push(mapped);
    }
    const seen = new Set();
    for (const id of candidateIds) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      const bundle = this.findBundle(project, sessionId, id);
      if (bundle) return { messageId: id, bundle };
    }
    return null;
  }

  async handleSessionEvent(project, session, event) {
    const sessionId = session.sessionId;
    const state = this.getSyntheticState(project, sessionId);
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
      if (event.message.role === "assistant") {
        this.flushPendingAssistantResolution(project, session);
        const messageId = makeStreamingMessageId(sessionId, state.nextSeq++);
        const startedAt = Date.now();
        const parentID = this.findLatestRealMessageId(session.sessionManager, "user") || "";
        state.currentAssistantMessageId = messageId;
        state.assistantStartedAt = startedAt;
        state.reasoningTimesByContentIndex = new Map();
        state.pendingAssistantResolutions = [
          ...(state.pendingAssistantResolutions || []),
          { syntheticId: messageId },
        ];
        const bundle = createBundle(
          createAssistantInfo({
            sessionId,
            messageId,
            timestamp: coerceTimestamp(event.message.timestamp),
            message: event.message,
            directory: project.directory,
            parentID,
            createdAt: startedAt,
          }),
          [],
        );
        syncAssistantParts(bundle, event.message, state.reasoningTimesByContentIndex);
        this.upsertBundle(project, sessionId, bundle);
        this.sendBackendEvent(project, { type: "message.updated", message: bundle.info });
        for (const part of bundle.parts) {
          this.sendBackendEvent(project, { type: "message.part.updated", part });
        }
      }
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
      const assistantContext = this.findCurrentAssistantBundle(project, sessionId, state);
      if (!assistantContext) return;
      const { messageId, bundle } = assistantContext;
      const normalizedInput = normalizeToolInput(event.args || {});
      let part = bundle.parts.find(
        (item) => item.type === "tool" && item.callID === event.toolCallId,
      );
      if (!part) {
        part = {
          id: makeToolPartId(messageId, event.toolCallId, bundle.parts.length),
          sessionID: sessionId,
          messageID: messageId,
          type: "tool",
          callID: event.toolCallId,
          tool: event.toolName,
          state: {
            status: "pending",
            input: normalizedInput,
            raw: stringifyUnknown(normalizedInput),
          },
        };
        bundle.parts.push(part);
      }
      part.state = {
        status: "running",
        input: normalizedInput,
        title: event.toolName,
        time: { start: Date.now() },
      };
      this.upsertBundle(project, sessionId, bundle);
      this.sendBackendEvent(project, { type: "message.part.updated", part });
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

  getListProject(target = {}) {
    const directory = normalizeDir(target.directory);
    if (!directory) throw new Error("Directory required for Pi backend");
    const workspaceId = target.workspaceId;
    const key = makeProjectKey(workspaceId, directory);
    const existing = this.projects.get(key);
    if (existing) return existing;
    return {
      key,
      directory,
      workspaceId,
      busySessionIds: new Set(),
      sessionCaches: new Map(),
      syntheticStateBySessionId: new Map(),
      liveSessionContexts: new Map(),
      sessionContextInitPromises: new Map(),
      runtime: null,
      sessionUnsubscribe: null,
      currentSessionId: null,
      currentSessionFile: null,
    };
  }

  async resolveProjectForSession(sessionId, target = {}) {
    const directory = normalizeDir(target?.directory);
    if (directory) {
      return await this.ensureProject({ directory, workspaceId: target?.workspaceId });
    }
    const live = this.findLiveSessionContext(sessionId);
    if (live) return live.project;
    if (this.projects.size === 1) return this.projects.values().next().value;
    throw new Error("Pi operation requires a Project directory");
  }

  mergeLivePiSessionsForProject(project, diskSessions) {
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

  async listSessions(target) {
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

  async getSessionById(sessionId, target) {
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
                      .filter((part) => part.type === "text")
                      .map((part) => part.text || "")
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

  resolveRealMessageId(project, sessionId, messageId) {
    const state = this.getSyntheticState(project, sessionId);
    return state.syntheticToReal.get(messageId) || messageId;
  }

  async addProject(config) {
    await this.ensureProject(config);
  }

  async removeProject(target) {
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
    project.syntheticStateBySessionId.clear();
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

  async createSession(input = {}) {
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

  async startSession(input) {
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

  normalizeImages(images) {
    return (Array.isArray(images) ? images : [])
      .map((image) => parseDataUrl(image))
      .filter(Boolean)
      .map((image) => ({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      }));
  }

  handlePromptFailure(project, sessionId, error) {
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

  dispatchSessionPrompt(project, session, text, images) {
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
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      rejectAccepted(error);
    };
    const promptPromise = session.prompt(text, {
      images: normalizedImages,
      preflightResult: (success) => {
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

  async applySelectedModel(session, selectedModel) {
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

  applySelectedVariant(session, variant) {
    if (typeof variant !== "string" || !variant.trim()) return;
    if (typeof session.setThinkingLevel !== "function") return;
    const model = session.model;
    if (model) {
      const supported = getSupportedThinkingLevels(model);
      if (!supported.includes(variant)) return;
    }
    session.setThinkingLevel(variant);
  }

  async deleteSession(sessionId, target) {
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
    project.syntheticStateBySessionId.delete(rawSessionId);
    this.sendBackendEvent(project, {
      type: "session.deleted",
      directory: project.directory,
      workspaceId: project.workspaceId,
      sessionId: rawSessionId,
    });
    return true;
  }

  async updateSession(sessionId, title, target) {
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

  async getSessionStatuses(target) {
    if (target?.directory) {
      const project = await this.ensureProject(target);
      const sessions = await this.listSessions(target);
      const statuses = {};
      for (const session of sessions) {
        const rawSessionId = toRawSessionId(session.id);
        const liveContext = this.getLiveSessionContext(project, rawSessionId);
        if (liveContext) {
          this.syncLiveSessionStatus(project, liveContext.runtime.session, { emitEvent: false });
        }
        statuses[session.id] = sessionStatus(
          liveContext
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
        if (liveContext) {
          this.syncLiveSessionStatus(project, liveContext.runtime.session, { emitEvent: false });
        }
        statuses[session.id] = sessionStatus(
          liveContext
            ? getSessionActivityType(liveContext.runtime.session)
            : project.busySessionIds.has(rawSessionId)
              ? "busy"
              : "idle",
        );
      }
    }
    return statuses;
  }

  async forkSession(sessionId, messageID, target) {
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

  getOAuthFlowKey(target, providerID) {
    return `${makeProjectKey(target?.workspaceId, target?.directory)}:${providerID}`;
  }

  async getProviders(target) {
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

  async listAllProviders(target) {
    const project = await this.ensureProject(target);
    const runtime =
      project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
    if (!runtime?.services?.modelRegistry) {
      throw new Error("Pi project runtime not ready");
    }
    return buildAllProvidersData(runtime.services.modelRegistry);
  }

  async getProviderAuthMethods(_target) {
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

  async connectProvider(target, providerID, auth) {
    const authStorage = this.getAuthStorage();
    if (auth?.type === "api") {
      authStorage.set(providerID, { type: "api_key", key: auth.key });
      await this.reloadProviderState();
      return true;
    }
    throw new Error(`Unsupported Pi provider auth type: ${auth?.type || "unknown"}`);
  }

  async disconnectProvider(_target, providerID) {
    const authStorage = this.getAuthStorage();
    authStorage.remove(providerID);
    await this.reloadProviderState();
    return true;
  }

  async oauthAuthorize(target, providerID) {
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

  async oauthCallback(target, providerID, _method, code) {
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

  async getCommands(target) {
    const project = target?.directory
      ? await this.ensureProject(target)
      : this.projects.values().next().value;
    if (!project) return [];
    const runtime =
      project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
    if (!runtime) return [];
    const session = runtime.session;
    const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "command",
      template: `/${command.invocationName}`,
      hints: [],
    }));
    const promptCommands = session.promptTemplates.map((template) => ({
      name: template.name,
      description: template.description,
      source: "command",
      template: `/${template.name}`,
      hints: [],
    }));
    const skillCommands = session.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      template: `/skill:${skill.name}`,
      hints: [],
    }));
    return [...extensionCommands, ...promptCommands, ...skillCommands];
  }

  async getMessages(sessionId, _options, target) {
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

  async prompt(sessionId, text, images, model, _agent, variant, directory, workspaceId) {
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

  async abort(sessionId, directory, workspaceId) {
    const rawSessionId = toRawSessionId(sessionId);
    const project = await this.resolveProjectForSession(rawSessionId, { directory, workspaceId });
    const liveContext = this.getLiveSessionContext(project, rawSessionId);
    if (!liveContext) {
      throw new Error("Pi session not active");
    }
    await liveContext.runtime.session.abort();
  }

  async summarizeSession(sessionId, model, directory, workspaceId) {
    const rawSessionId = toRawSessionId(sessionId);
    const { session } = await this.ensureSessionContext(rawSessionId, { directory, workspaceId });
    if (model) {
      await this.applySelectedModel(session, model);
    }
    await session.compact();
  }

  async sendCommand(sessionId, command, args, model, _agent, _variant, directory, workspaceId) {
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

function daemonInfoPath(userData) {
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

async function readDaemonInfo(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeDaemonInfo(path, info) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(info, null, 2), "utf8");
}

async function fetchDaemonJson(baseUrl, token, path, options = {}) {
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
  return await response.json();
}

class PiDaemonClient {
  constructor(getAllWindows, options = {}) {
    this.getAllWindows = getAllWindows;
    this.userData = options.userData || process.cwd();
    this.infoPath = daemonInfoPath(this.userData);
    this.info = null;
    this.startPromise = null;
    this.eventAbort = null;
    this.eventReconnectTimer = null;
    this.eventStarted = false;
  }

  async addProject(config) {
    return await this.call("addProject", [config]);
  }

  async removeProject(target) {
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

  async listSessions(target) {
    return await this.call("listSessions", [target]);
  }

  async createSession(input) {
    return await this.call("createSession", [input]);
  }

  async deleteSession(sessionId, target) {
    return await this.call("deleteSession", [sessionId, target]);
  }

  async updateSession(sessionId, title, target) {
    return await this.call("updateSession", [sessionId, title, target]);
  }

  async getSessionStatuses(target) {
    return await this.call("getSessionStatuses", [target]);
  }

  async forkSession(sessionId, messageID, target) {
    return await this.call("forkSession", [sessionId, messageID, target]);
  }

  async getProviders(target) {
    return await this.call("getProviders", [target]);
  }

  async listAllProviders(target) {
    return await this.call("listAllProviders", [target]);
  }

  async getProviderAuthMethods(target) {
    return await this.call("getProviderAuthMethods", [target]);
  }

  async connectProvider(target, providerID, auth) {
    return await this.call("connectProvider", [target, providerID, auth]);
  }

  async disconnectProvider(target, providerID) {
    return await this.call("disconnectProvider", [target, providerID]);
  }

  async oauthAuthorize(target, providerID, method) {
    return await this.call("oauthAuthorize", [target, providerID, method]);
  }

  async oauthCallback(target, providerID, method, code) {
    return await this.call("oauthCallback", [target, providerID, method, code]);
  }

  async disposeProviderInstance(target) {
    return await this.call("disposeProviderInstance", [target]);
  }

  async getAgents() {
    return await this.call("getAgents", []);
  }

  async getCommands(target) {
    return await this.call("getCommands", [target]);
  }

  async getMessages(sessionId, options, target) {
    return await this.call("getMessages", [sessionId, options, target]);
  }

  async startSession(input) {
    return await this.call("startSession", [input]);
  }

  async prompt(sessionId, text, images, model, agent, variant, directory, workspaceId) {
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

  async abort(sessionId, directory, workspaceId) {
    return await this.call("abort", [sessionId, directory, workspaceId]);
  }

  async sendCommand(sessionId, command, args, model, agent, variant, directory, workspaceId) {
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

  async summarizeSession(sessionId, model, directory, workspaceId) {
    return await this.call("summarizeSession", [sessionId, model, directory, workspaceId]);
  }

  async call(method, args) {
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

  async getHealth(info) {
    if (!info?.baseUrl || !info?.token) return null;
    try {
      return await fetchDaemonJson(info.baseUrl, info.token, "/health");
    } catch {
      return null;
    }
  }

  async isHealthy(info) {
    const health = await this.getHealth(info);
    return Boolean(health?.success && health?.data?.daemonVersion === PI_DAEMON_VERSION);
  }

  async stopDaemon(info) {
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

  async waitForDaemonStopped(info) {
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

  async startDaemon(preferredInfo = null) {
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
    const appendLog = (chunk) => {
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

  forwardEvent(event) {
    for (const window of this.getAllWindows()) {
      if (window?.isDestroyed?.()) continue;
      window.webContents.send("pi:bridge-event", event);
    }
  }
}

export function setupPiBridge(ipcMain, getAllWindows, options = {}) {
  const manager = new PiDaemonClient(getAllWindows, options);

  ipcMain.handle("pi:project:add", async (_event, config) => {
    try {
      await manager.addProject(config);
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:project:remove", async (_event, directory, workspaceId) => {
    try {
      await manager.removeProject({ directory, workspaceId });
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:disconnect", async () => {
    try {
      await manager.disconnect();
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:session:list", async (_event, directory, workspaceId) => {
    try {
      return ok(await manager.listSessions({ directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:session:create", async (_event, title, directory, workspaceId) => {
    try {
      return ok(await manager.createSession({ title, directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:session:delete", async (_event, sessionId, directory, workspaceId) => {
    try {
      return ok(await manager.deleteSession(sessionId, { directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:session:update", async (_event, sessionId, title, directory, workspaceId) => {
    try {
      return ok(await manager.updateSession(sessionId, title, { directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:session:statuses", async (_event, directory, workspaceId) => {
    try {
      return ok(await manager.getSessionStatuses({ directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(
    "pi:session:fork",
    async (_event, sessionId, messageID, directory, workspaceId) => {
      try {
        return ok(await manager.forkSession(sessionId, messageID, { directory, workspaceId }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  ipcMain.handle("pi:providers", async (_event, directory, workspaceId) => {
    try {
      return ok(await manager.getProviders({ directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:provider:list", async (_event, directory, workspaceId) => {
    try {
      return ok(await manager.listAllProviders({ directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:provider:auth-methods", async (_event, directory, workspaceId) => {
    try {
      return ok(await manager.getProviderAuthMethods({ directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(
    "pi:provider:connect",
    async (_event, directory, workspaceId, providerID, auth) => {
      try {
        return ok(await manager.connectProvider({ directory, workspaceId }, providerID, auth));
      } catch (error) {
        return fail(error);
      }
    },
  );

  ipcMain.handle("pi:provider:disconnect", async (_event, directory, workspaceId, providerID) => {
    try {
      return ok(await manager.disconnectProvider({ directory, workspaceId }, providerID));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(
    "pi:provider:oauth:authorize",
    async (_event, directory, workspaceId, providerID, method) => {
      try {
        return ok(await manager.oauthAuthorize({ directory, workspaceId }, providerID, method));
      } catch (error) {
        return fail(error);
      }
    },
  );

  ipcMain.handle(
    "pi:provider:oauth:callback",
    async (_event, directory, workspaceId, providerID, method, code) => {
      try {
        return ok(
          await manager.oauthCallback({ directory, workspaceId }, providerID, method, code),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  ipcMain.handle("pi:instance:dispose", async (_event, directory, workspaceId) => {
    try {
      return ok(await manager.disposeProviderInstance({ directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:agents", async () => {
    try {
      return ok(await manager.getAgents());
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:commands", async (_event, directory, workspaceId) => {
    try {
      return ok(await manager.getCommands({ directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:messages", async (_event, sessionId, options, directory, workspaceId) => {
    try {
      return ok(await manager.getMessages(sessionId, options, { directory, workspaceId }));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("pi:session:start", async (_event, input) => {
    try {
      return ok(await manager.startSession(input));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(
    "pi:prompt",
    async (_event, sessionId, text, images, model, agent, variant, directory, workspaceId) => {
      try {
        await manager.prompt(
          sessionId,
          text,
          images,
          model,
          agent,
          variant,
          directory,
          workspaceId,
        );
        return ok(true);
      } catch (error) {
        return fail(error);
      }
    },
  );

  ipcMain.handle("pi:abort", async (_event, sessionId, directory, workspaceId) => {
    try {
      await manager.abort(sessionId, directory, workspaceId);
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(
    "pi:command:send",
    async (_event, sessionId, command, args, model, agent, variant, directory, workspaceId) => {
      try {
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
        return ok(true);
      } catch (error) {
        return fail(error);
      }
    },
  );

  ipcMain.handle(
    "pi:session:summarize",
    async (_event, sessionId, model, directory, workspaceId) => {
      try {
        await manager.summarizeSession(sessionId, model, directory, workspaceId);
        return ok(true);
      } catch (error) {
        return fail(error);
      }
    },
  );

  return {
    restart: () => manager.restart(),
  };
}
