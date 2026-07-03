// @ts-nocheck
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Codex } from "@openai/codex-sdk";
import {
  buildCodexProviderFromModels,
  CODEX_VALID_VARIANTS,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  mapCodexAppServerModel,
  STATIC_CODEX_MODELS,
  STATIC_CODEX_PROVIDER,
} from "./codex-models.ts";
import {
  makeHarnessProjectKey as makeProjectKey,
  makeHarnessSessionIdCodec,
  normalizeHarnessDirectory as normalizeDir,
  nowHarnessConnection as nowConnection,
} from "./harness-adapter-kit.ts";
import {
  buildMessagesFromCodexAppServerThread,
  normalizeAppServerItem,
  normalizeCodexAppServerThread,
} from "./codex-bridge-mapping.ts";
import {
  makeHarnessBridgeEventEmitter,
  registerObjectTargetHarnessRpcHandlers,
} from "./harness-adapter-host.ts";

const CODEX_APP_SERVER_TIMEOUT_MS = 8_000;
const CODEX_PROVIDER_CACHE_TTL_MS = 60_000;
const CODEX_SESSION_PREFIX = "codex:";
const { toFrontendSessionId, toRawSessionId } = makeHarnessSessionIdCodec(CODEX_SESSION_PREFIX);

type CodexProject = { key: string; directory: string; workspaceId?: string };
type CodexMessageInfo = Record<string, unknown> & {
  id: string;
  sessionID: string;
  role?: string;
  time: { created: number; completed?: number };
  tokens?: Record<string, unknown>;
  model?: Record<string, unknown>;
};
type CodexMessagePart = Record<string, unknown> & {
  id: string;
  sessionID: string;
  messageID: string;
  type?: string;
  text?: string;
  time?: { start?: number; end?: number };
  state?: any;
};
type CodexMessageBundle = { info: CodexMessageInfo; parts: CodexMessagePart[] };
type CodexSession = {
  id: string;
  slug: string;
  _harnessId: string;
  _rawId: string;
  projectID: string;
  workspaceID?: string;
  directory: string;
  title: string;
  version: string;
  model?: { providerID: string; id: string; variant?: string };
  time: { created: number; updated: number };
};
type CodexSessionRecord = {
  id: string;
  directory: string;
  workspaceId?: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  modelId: string | null;
  variant: string | undefined;
  origin: string;
  hidden: boolean;
};
type CodexLiveSession = {
  sessionId: string;
  threadId: string;
  project: CodexProject;
  session: CodexSession;
  messages: CodexMessageBundle[];
  running: boolean;
  abortController: AbortController | null;
  currentAssistantMessageId: string | null;
  currentUserMessageId: string | null;
  currentModelId: string;
  currentVariant: string | undefined;
  createdAt: number;
  hidden: boolean;
};
type CodexAppServerItem = { id: string; type: string; text?: string; [key: string]: any };
type CodexModelSelection = {
  modelID?: string;
  providerID?: string;
  id?: string;
  variant?: string;
};
type CodexProviderData = { providers: Array<{ models?: Record<string, unknown> }> };

let codexProviderCache = {
  expiresAt: 0,
  promise: null,
  value: null,
};

function getCodexExecutable() {
  return process.env.CODEX_EXECUTABLE?.trim() || "codex";
}

function createCodexClient(options = {}) {
  return new Codex({
    ...options,
    codexPathOverride: getCodexExecutable(),
  });
}

type CodexAppServerRequest = (method: string, params?: Record<string, unknown>) => Promise<any>;

async function withCodexAppServer<T>(
  requestWork: (ctx: { request: CodexAppServerRequest }) => Promise<T>,
): Promise<T> {
  const env = pickCodexEnv(process.env);
  const executable = getCodexExecutable();
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    let settled = false;
    let nextId = 1;
    let stderr = "";
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();

    const cleanup = () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
      }
      pending.clear();
      rl.close();
      if (!child.killed) {
        try {
          child.kill();
        } catch {}
      }
    };

    const settleResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const request: CodexAppServerRequest = (method, params = {}) =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`Codex app-server request timed out: ${method}`));
        }, CODEX_APP_SERVER_TIMEOUT_MS);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message?.id !== "number") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error?.message || `Codex app-server error: ${message.id}`));
        return;
      }
      entry.resolve(message.result);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.once("error", (error) => {
      settleReject(error);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settleReject(
        new Error(
          `Codex app-server exited early (${signal ?? code ?? "unknown"}): ${stderr.trim() || "no stderr"}`,
        ),
      );
    });

    void (async () => {
      try {
        await request("initialize", {
          clientInfo: {
            name: "opengui_desktop",
            title: "OpenGUI",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        });
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        const result = await requestWork({ request });
        settleResolve(result);
      } catch (error) {
        settleReject(error);
      }
    })();
  });
}

async function listCodexAppServerSessions(
  target: { workspaceId?: string; directory?: string } = {},
) {
  const workspaceId = target.workspaceId ?? "local";
  if (target.workspaceId !== undefined && target.workspaceId !== "local") return [];
  return await withCodexAppServer(async ({ request }) => {
    const sessions = [];
    let cursor = undefined;
    do {
      const response = await request("thread/list", {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        ...(cursor ? { cursor } : {}),
      });
      for (const thread of Array.isArray(response?.data) ? response.data : []) {
        if (!thread?.id) continue;
        const session = normalizeCodexAppServerThread(thread, workspaceId);
        if (target.directory && normalizeDir(session.directory) !== normalizeDir(target.directory))
          continue;
        sessions.push(session);
      }
      cursor =
        typeof response?.nextCursor === "string" && response.nextCursor
          ? response.nextCursor
          : undefined;
    } while (cursor);
    return sessions;
  });
}

async function readCodexAppServerMessages(sessionId: string) {
  return await withCodexAppServer(async ({ request }) => {
    const response = await request("thread/read", {
      threadId: sessionId,
      includeTurns: true,
    });
    return buildMessagesFromCodexAppServerThread(response?.thread ?? { id: sessionId, turns: [] });
  });
}

async function fetchCodexProviderFromAppServer() {
  return await withCodexAppServer(async ({ request }) => {
    await request("account/read", {}).catch(() => null);
    const models = {};
    let cursor = undefined;
    do {
      const response = await request("model/list", cursor ? { cursor } : {});
      for (const rawModel of Array.isArray(response?.data) ? response.data : []) {
        const model = mapCodexAppServerModel(rawModel);
        if (!model) continue;
        models[model.id] = model;
      }
      cursor =
        typeof response?.nextCursor === "string" && response.nextCursor
          ? response.nextCursor
          : undefined;
    } while (cursor);
    return buildCodexProviderFromModels(
      Object.keys(models).length > 0 ? models : STATIC_CODEX_MODELS,
    );
  });
}

async function getCodexProviderData() {
  const now = Date.now();
  if (codexProviderCache.value && codexProviderCache.expiresAt > now) {
    return codexProviderCache.value;
  }
  if (codexProviderCache.promise) {
    return codexProviderCache.promise;
  }
  codexProviderCache.promise = (async () => {
    try {
      const provider = await fetchCodexProviderFromAppServer();
      codexProviderCache.value = provider;
      codexProviderCache.expiresAt = Date.now() + CODEX_PROVIDER_CACHE_TTL_MS;
      return provider;
    } catch (error) {
      console.warn("Failed to discover Codex models via app-server:", error);
      codexProviderCache.value = STATIC_CODEX_PROVIDER;
      codexProviderCache.expiresAt = Date.now() + CODEX_PROVIDER_CACHE_TTL_MS;
      return STATIC_CODEX_PROVIDER;
    } finally {
      codexProviderCache.promise = null;
    }
  })();
  return codexProviderCache.promise;
}

function getCodexModel(providerData: CodexProviderData | null, modelId: string | null | undefined) {
  if (!providerData || !modelId) return null;
  for (const provider of Array.isArray(providerData.providers) ? providerData.providers : []) {
    const model = provider?.models?.[modelId];
    if (model) return model;
  }
  return null;
}

async function resolveSupportedCodexVariant(
  model: CodexModelSelection | undefined,
  variant: string | undefined,
) {
  const normalized = resolveVariant(variant);
  if (!normalized) return undefined;
  const modelId = resolveSelectedModelId(model);
  const providerData = await getCodexProviderData();
  const codexModel = getCodexModel(providerData, modelId);
  const variants = Object.keys(codexModel?.variants ?? {}).filter(
    (key) => !codexModel?.variants?.[key]?.disabled,
  );
  if (variants.length === 0) return undefined;
  return variants.includes(normalized) ? normalized : undefined;
}

const MAX_CODEX_SESSION_INDEX_ENTRIES = 1000;

function sessionStatus(type: string) {
  return { type };
}

function firstLine(text: unknown) {
  return (
    String(text ?? "")
      .trim()
      .split(/\r?\n/, 1)[0] ?? ""
  );
}

function makeSessionTitle(text: string, title: string | undefined) {
  const explicit = typeof title === "string" ? title.trim() : "";
  if (explicit) return explicit;
  const line = firstLine(text);
  return line.slice(0, 80) || "Untitled";
}

function resolveSelectedModelId(selectedModel: CodexModelSelection | undefined) {
  if (selectedModel?.modelID && typeof selectedModel.modelID === "string") {
    return selectedModel.modelID;
  }
  return DEFAULT_MODEL_ID;
}

function resolveVariant(variant: string | undefined) {
  if (typeof variant !== "string") return undefined;
  return CODEX_VALID_VARIANTS.includes(variant) ? variant : undefined;
}

function defaultUserInfo(
  sessionId: string,
  messageId: string,
  modelId: string,
  variant: string | undefined,
  createdAt = Date.now(),
) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created: createdAt },
    agent: "codex",
    model: {
      providerID: DEFAULT_PROVIDER_ID,
      modelID: modelId,
      ...(variant ? { variant } : {}),
    },
  };
}

function defaultAssistantInfo(
  sessionId: string,
  messageId: string,
  directory: string,
  modelId: string,
  variant: string | undefined,
  createdAt = Date.now(),
) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: createdAt },
    parentID: "",
    modelID: modelId,
    providerID: DEFAULT_PROVIDER_ID,
    mode: "codex",
    agent: "codex",
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
    ...(variant ? { variant } : {}),
  };
}

function makeTextPart(
  sessionId: string,
  messageId: string,
  partId: string,
  text: string,
  synthetic = false,
) {
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
  };
}

function makeReasoningPart(
  sessionId: string,
  messageId: string,
  partId: string,
  text: string,
  start = Date.now(),
) {
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: "reasoning",
    text,
    time: { start },
  };
}

function parseDataUrl(dataUrl: unknown) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1] || "application/octet-stream",
    data: match[2],
  };
}

function mimeToExtension(mimeType: string) {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}

function createUserImageParts(sessionId: string, messageId: string, images: unknown) {
  return (Array.isArray(images) ? images : [])
    .map((image, index) => {
      const parsed = parseDataUrl(image);
      if (!parsed) return null;
      return {
        id: randomUUID(),
        sessionID: sessionId,
        messageID: messageId,
        type: "file",
        mime: parsed.mimeType,
        filename: `image-${index + 1}${mimeToExtension(parsed.mimeType)}`,
        url: image,
      };
    })
    .filter(Boolean);
}

function stringifyUnknown(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function appendOrReplaceCumulativeDelta(current: unknown, delta: string) {
  const currentText = typeof current === "string" ? current : "";
  if (currentText && delta.length > currentText.length && delta.startsWith(currentText)) {
    return delta;
  }
  return `${currentText}${delta}`;
}

function mcpContentToText(result: Record<string, unknown> | null | undefined) {
  if (!result || !Array.isArray(result.content))
    return stringifyUnknown(result?.structured_content);
  const parts = [];
  for (const block of result.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      parts.push("[image]");
      continue;
    }
    parts.push(stringifyUnknown(block));
  }
  const joined = parts.join("\n\n").trim();
  return joined || stringifyUnknown(result?.structured_content);
}

function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function makeStoragePaths(userData: string = join(homedir(), ".config", "OpenGUI")) {
  const root = join(userData, "codex");
  return {
    root,
  };
}

function buildCodexPath(source: Record<string, unknown> | null | undefined) {
  const pathValue = typeof source?.PATH === "string" ? source.PATH : "";
  const home = source?.HOME || homedir();
  const candidates = [
    join(home, ".local", "share", "pnpm"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  const parts = pathValue.split(":").filter(Boolean);
  for (const candidate of candidates) {
    if (!parts.includes(candidate)) parts.push(candidate);
  }
  return parts.join(":");
}

function pickCodexEnv(source: Record<string, unknown> | null | undefined) {
  const env = {};
  const allow = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSL_CERT_FILE",
  ]);
  const codexAllow = new Set([
    "CODEX_API_KEY",
    "CODEX_BASE_URL",
    "CODEX_HOME",
    "CODEX_CONFIG_DIR",
    "CODEX_EXECUTABLE",
    "CODEX_MANAGED_BY_NPM",
  ]);
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value !== "string") continue;
    if (
      allow.has(key) ||
      codexAllow.has(key) ||
      key.startsWith("OPENAI_") ||
      key === "HTTP_PROXY" ||
      key === "HTTPS_PROXY" ||
      key === "NO_PROXY"
    ) {
      env[key] = value;
    }
  }
  env.PATH = buildCodexPath(source);
  return env;
}

function getMessageText(bundle: CodexMessageBundle | null | undefined) {
  if (!bundle || !Array.isArray(bundle.parts)) return "";
  return bundle.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function getSessionPreview(messages: CodexMessageBundle[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = getMessageText(messages[i]);
    if (text) return firstLine(text).slice(0, 160);
  }
  return "";
}

function upsertMessage(messages: CodexMessageBundle[], info: CodexMessageInfo) {
  let bundle = messages.find((entry) => entry.info.id === info.id);
  if (!bundle) {
    bundle = { info, parts: [] };
    messages.push(bundle);
    return bundle;
  }
  bundle.info = info;
  return bundle;
}

function findMessage(messages: CodexMessageBundle[], messageId: string) {
  return messages.find((entry) => entry.info.id === messageId) ?? null;
}

function upsertPart(messages: CodexMessageBundle[], part: CodexMessagePart) {
  const bundle = findMessage(messages, part.messageID);
  if (!bundle) return null;
  const index = bundle.parts.findIndex((entry) => entry.id === part.id);
  if (index === -1) {
    bundle.parts.push(part);
    return part;
  }
  bundle.parts[index] = part;
  return part;
}

function findPart(messages: CodexMessageBundle[], messageId: string, partId: string) {
  const bundle = findMessage(messages, messageId);
  if (!bundle) return null;
  return bundle.parts.find((part) => part.id === partId) ?? null;
}

function renameSessionInMessages(messages: CodexMessageBundle[], oldId: string, newId: string) {
  for (const bundle of messages) {
    bundle.info = { ...bundle.info, sessionID: newId };
    bundle.parts = bundle.parts.map((part) => ({ ...part, sessionID: newId }));
  }
}

function summarizeFileChanges(changes: unknown) {
  return (Array.isArray(changes) ? changes : []).map((change) => {
    const c = change as { path?: string; kind?: string };
    return {
      filePath: c.path,
      relativePath: c.path,
      type: c.kind,
      additions: c.kind === "add" ? 1 : c.kind === "update" ? 1 : 0,
      deletions: c.kind === "delete" ? 1 : c.kind === "update" ? 1 : 0,
    };
  });
}

function buildToolPartFromItem(
  sessionId: string,
  messageId: string,
  item: CodexAppServerItem,
  existingPart: CodexMessagePart | null | undefined,
  phase: string,
) {
  const now = Date.now();
  const base = {
    id: existingPart?.id ?? `${messageId}:tool:${item.id}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "tool",
    callID: item.id,
  };

  if (item.type === "command_execution") {
    const isDone = item.status === "completed" || item.status === "failed";
    return {
      ...base,
      tool: "shell",
      state: isDone
        ? {
            status: item.status === "failed" ? "error" : "completed",
            input: { command: item.command },
            ...(item.status === "failed"
              ? { error: item.aggregated_output || `Command failed: ${item.command}` }
              : { output: item.aggregated_output || "" }),
            metadata: {
              exitCode: item.exit_code,
              output: item.aggregated_output || "",
            },
            time: {
              start: existingPart?.state?.time?.start ?? now,
              end: now,
            },
          }
        : {
            status: "running",
            input: { command: item.command },
            title: item.command,
            metadata: {
              output: item.aggregated_output || "",
              exitCode: item.exit_code,
            },
            time: {
              start: existingPart?.state?.time?.start ?? now,
            },
          },
    };
  }

  if (item.type === "file_change") {
    const failed = item.status === "failed";
    return {
      ...base,
      tool: "apply_patch",
      state: failed
        ? {
            status: "error",
            input: {},
            error: "Failed to apply file changes",
            metadata: { files: summarizeFileChanges(item.changes) },
            time: {
              start: existingPart?.state?.time?.start ?? now,
              end: now,
            },
          }
        : {
            status: "completed",
            input: {},
            output: "",
            title: "apply_patch",
            metadata: { files: summarizeFileChanges(item.changes) },
            time: {
              start: existingPart?.state?.time?.start ?? now,
              end: now,
            },
          },
    };
  }

  if (item.type === "mcp_tool_call") {
    const isDone = item.status === "completed" || item.status === "failed";
    const toolName = `${item.server}:${item.tool}`;
    return {
      ...base,
      tool: toolName,
      state: isDone
        ? item.status === "failed"
          ? {
              status: "error",
              input: item.arguments ?? {},
              error: item.error?.message || "MCP tool call failed",
              metadata: {
                server: item.server,
                tool: item.tool,
              },
              time: {
                start: existingPart?.state?.time?.start ?? now,
                end: now,
              },
            }
          : {
              status: "completed",
              input: item.arguments ?? {},
              output: mcpContentToText(item.result),
              title: toolName,
              metadata: {
                server: item.server,
                tool: item.tool,
                result: item.result?.structured_content,
              },
              time: {
                start: existingPart?.state?.time?.start ?? now,
                end: now,
              },
            }
        : {
            status: "running",
            input: item.arguments ?? {},
            title: toolName,
            metadata: {
              server: item.server,
              tool: item.tool,
            },
            time: {
              start: existingPart?.state?.time?.start ?? now,
            },
          },
    };
  }

  if (item.type === "web_search") {
    return {
      ...base,
      tool: "web_search",
      state:
        phase === "completed"
          ? {
              status: "completed",
              input: { query: item.query },
              output: "",
              title: "web_search",
              metadata: {},
              time: {
                start: existingPart?.state?.time?.start ?? now,
                end: now,
              },
            }
          : {
              status: "running",
              input: { query: item.query },
              title: "web_search",
              metadata: {},
              time: {
                start: existingPart?.state?.time?.start ?? now,
              },
            },
    };
  }

  if (item.type === "todo_list") {
    const todos = (Array.isArray(item.items) ? item.items : []).map((todo) => ({
      content: todo.text,
      status: todo.completed ? "completed" : "pending",
      priority: "medium",
    }));
    return {
      ...base,
      tool: "todowrite",
      state:
        phase === "completed"
          ? {
              status: "completed",
              input: { todos },
              output: "",
              title: "todowrite",
              metadata: {},
              time: {
                start: existingPart?.state?.time?.start ?? now,
                end: now,
              },
            }
          : {
              status: "running",
              input: { todos },
              title: "todowrite",
              metadata: {},
              time: {
                start: existingPart?.state?.time?.start ?? now,
              },
            },
    };
  }

  return {
    ...base,
    tool: item.type,
    state: {
      status: "completed",
      input: { item: stringifyUnknown(item) },
      output: "",
      title: item.type,
      metadata: {},
      time: {
        start: existingPart?.state?.time?.start ?? now,
        end: now,
      },
    },
  };
}

class CodexBridgeManager {
  emitBridgeEvent: (event: Record<string, unknown>) => void;
  projects: Map<string, CodexProject>;
  sessionIndex: Map<string, CodexSessionRecord>;
  transcriptCache: Map<string, { messages: CodexMessageBundle[] }>;
  liveSessions: Map<string, CodexLiveSession>;
  aliases: Map<string, string>;
  paths: ReturnType<typeof makeStoragePaths>;
  storageReady: Promise<void>;
  codex: ReturnType<typeof createCodexClient>;

  constructor(getAllWindows: () => Iterable<unknown>, options: { userData?: string } = {}) {
    this.emitBridgeEvent = makeHarnessBridgeEventEmitter("codex", getAllWindows);
    this.projects = new Map();
    this.sessionIndex = new Map();
    this.transcriptCache = new Map();
    this.liveSessions = new Map();
    this.aliases = new Map();
    this.paths = makeStoragePaths(options.userData);
    this.storageReady = this.loadStorage();
    this.codex = createCodexClient({
      env: pickCodexEnv(process.env),
    });
  }

  emit(event: Record<string, unknown>) {
    this.emitBridgeEvent(event);
  }

  emitConnection(project: CodexProject, status: Record<string, unknown>) {
    this.emit({
      type: "connection:status",
      directory: project.directory,
      workspaceId: project.workspaceId,
      payload: status,
    });
  }

  emitBackend(project: CodexProject | null | undefined, payload: Record<string, unknown>) {
    this.emit({
      type: "codex:event",
      directory: project?.directory,
      workspaceId: project?.workspaceId,
      payload,
    });
  }

  async loadStorage() {
    // Sessions and transcripts are Harness-owned. Codex-backed Sessions are
    // discovered from the Codex app-server and tracked here only in memory for
    // live orchestration.
  }

  pruneSessionIndex(maxEntries = MAX_CODEX_SESSION_INDEX_ENTRIES) {
    const entries = [...this.sessionIndex.entries()].sort(
      ([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
    for (const [sessionId] of entries.slice(maxEntries)) {
      this.clearSessionMemory(sessionId);
      this.sessionIndex.delete(sessionId);
    }
  }

  async persistIndex() {
    await this.storageReady;
    this.pruneSessionIndex();
  }

  clearSessionMemory(sessionId) {
    sessionId = toRawSessionId(sessionId);
    const realId = this.resolveSessionId(sessionId);
    this.liveSessions.delete(sessionId);
    this.liveSessions.delete(realId);
    this.transcriptCache.delete(sessionId);
    this.transcriptCache.delete(realId);
    for (const [alias, target] of this.aliases.entries()) {
      if (alias === sessionId || alias === realId || target === sessionId || target === realId) {
        this.aliases.delete(alias);
      }
    }
  }

  clearProjectMemory(directory, workspaceId) {
    for (const [sessionId, live] of this.liveSessions.entries()) {
      if (live.project.directory === directory && live.project.workspaceId === workspaceId) {
        this.clearSessionMemory(sessionId);
      }
    }
    for (const [sessionId, record] of this.sessionIndex.entries()) {
      if (record.directory === directory && record.workspaceId === workspaceId) {
        this.transcriptCache.delete(sessionId);
        for (const [alias, target] of this.aliases.entries()) {
          if (alias === sessionId || target === sessionId) {
            this.aliases.delete(alias);
          }
        }
      }
    }
  }

  async loadTranscript(sessionId) {
    sessionId = toRawSessionId(sessionId);
    const realId = this.resolveSessionId(sessionId);
    if (this.transcriptCache.has(realId)) {
      return this.transcriptCache.get(realId);
    }
    const empty = { messages: [] };
    this.transcriptCache.set(realId, empty);
    return empty;
  }

  async persistTranscript(sessionId, messages) {
    await this.storageReady;
    sessionId = toRawSessionId(sessionId);
    const realId = this.resolveSessionId(sessionId);
    const payload = { messages };
    this.transcriptCache.set(realId, payload);
  }

  resolveSessionId(sessionId) {
    let current = toRawSessionId(sessionId);
    while (this.aliases.has(current)) {
      current = this.aliases.get(current);
    }
    return current;
  }

  getLiveSession(sessionId) {
    sessionId = toRawSessionId(sessionId);
    const direct = this.liveSessions.get(sessionId);
    if (direct) return direct;
    const resolved = this.resolveSessionId(sessionId);
    return this.liveSessions.get(resolved) ?? null;
  }

  buildSession({ id, directory, workspaceId, title, createdAt, updatedAt, modelId, variant }) {
    const rawId = toRawSessionId(id);
    const frontendId = toFrontendSessionId(rawId);
    return {
      id: frontendId,
      slug: frontendId,
      _harnessId: "codex",
      _rawId: rawId,
      projectID: directory,
      workspaceID: workspaceId,
      directory,
      title: title || "Untitled",
      version: "codex",
      ...(modelId
        ? {
            model: {
              providerID: DEFAULT_PROVIDER_ID,
              id: modelId,
              ...(variant ? { variant } : {}),
            },
          }
        : {}),
      time: {
        created: createdAt,
        updated: updatedAt,
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
      variant: record.variant,
    });
  }

  deriveSessionModelFromMessages(messages) {
    let modelId = null;
    let variant = null;
    for (const entry of messages) {
      const info = entry?.info;
      if (!info || typeof info !== "object") continue;
      if (info.role === "assistant") {
        if (typeof info.modelID === "string" && info.modelID) modelId = info.modelID;
        if (typeof info.variant === "string" && info.variant) variant = info.variant;
        continue;
      }
      if (info.role === "user" && info.model) {
        if (typeof info.model.modelID === "string" && info.model.modelID)
          modelId = info.model.modelID;
        if (typeof info.model.variant === "string" && info.model.variant)
          variant = info.model.variant;
      }
    }
    return { modelId, variant };
  }

  ensureKnownProject(directory, workspaceId) {
    const normalized = normalizeDir(directory);
    if (!normalized) {
      throw new Error("Codex requires a project directory");
    }
    const key = makeProjectKey(workspaceId, normalized);
    let project = this.projects.get(key);
    if (!project) {
      project = { key, directory: normalized, workspaceId };
      this.projects.set(key, project);
    }
    return project;
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
    const workspaceId = target?.workspaceId;
    const project = this.projects.get(key) ?? { directory, workspaceId };
    this.clearProjectMemory(directory, workspaceId);
    this.projects.delete(key);
    this.emitConnection(project, nowConnection({ state: "idle" }));
  }

  disconnect() {
    for (const project of this.projects.values()) {
      this.emitConnection(project, nowConnection({ state: "idle" }));
    }
    this.projects.clear();
    this.liveSessions.clear();
    this.transcriptCache.clear();
    this.aliases.clear();
  }

  async listSessions(target = {}) {
    await this.storageReady;
    const directory = normalizeDir(target.directory);
    const workspaceId = target.workspaceId;
    const byId = new Map();
    try {
      for (const session of await listCodexAppServerSessions({ directory, workspaceId })) {
        const rawId = session._rawId ?? toRawSessionId(session.id);
        byId.set(session.id, session);
        if (!this.sessionIndex.has(rawId)) {
          this.sessionIndex.set(rawId, {
            id: rawId,
            directory: session.directory,
            workspaceId: session.workspaceID,
            title: session.title,
            preview: session.title,
            createdAt: session.time?.created ?? Date.now(),
            updatedAt: session.time?.updated ?? Date.now(),
            origin: "codex",
          });
        }
      }
    } catch (error) {
      console.warn("Failed to discover Codex sessions via app-server:", error);
    }
    for (const live of this.liveSessions.values()) {
      if (live.hidden) continue;
      if (directory && live.project.directory !== directory) continue;
      if (workspaceId !== undefined && live.project.workspaceId !== workspaceId) continue;
      byId.set(live.session.id, live.session);
    }
    this.pruneSessionIndex();
    for (const record of this.sessionIndex.values()) {
      if (record.hidden) continue;
      if (directory && record.directory !== directory) continue;
      if (workspaceId !== undefined && record.workspaceId !== workspaceId) continue;
      if (!record.modelId) {
        const inferred = this.deriveSessionModelFromMessages(
          (await this.loadTranscript(record.id)).messages,
        );
        if (inferred.modelId) {
          record.modelId = inferred.modelId;
          record.variant = inferred.variant ?? record.variant;
        }
      }
      byId.set(record.id, this.buildSessionFromRecord(record));
    }
    return [...byId.values()].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  }

  async createSession(input = {}) {
    const project = this.ensureKnownProject(input.directory, input.workspaceId);
    const now = Date.now();
    const tempId = `temp:${randomUUID()}`;
    const session = this.buildSession({
      id: tempId,
      directory: project.directory,
      workspaceId: project.workspaceId,
      title: makeSessionTitle("", input.title),
      createdAt: now,
      updatedAt: now,
    });
    const live = {
      sessionId: tempId,
      threadId: null,
      project,
      session,
      messages: [],
      running: false,
      abortController: null,
      currentAssistantMessageId: null,
      currentUserMessageId: null,
      currentModelId: DEFAULT_MODEL_ID,
      currentVariant: undefined,
      createdAt: now,
      hidden: false,
    };
    this.liveSessions.set(tempId, live);
    this.emitBackend(project, {
      type: "session.created",
      directory: project.directory,
      workspaceId: project.workspaceId,
      session,
    });
    return session;
  }

  async startSession(input = {}) {
    const session = await this.createSession(input);
    try {
      await this.prompt(
        session.id,
        input.text ?? "",
        input.images,
        input.model,
        input.agent,
        input.variant,
        input.directory,
        input.workspaceId,
      );
      return session;
    } catch (error) {
      await this.deleteSession(session.id, {
        directory: input.directory,
        workspaceId: input.workspaceId,
      });
      throw error;
    }
  }

  async deleteSession(sessionId, _target = {}) {
    sessionId = toRawSessionId(sessionId);
    await this.storageReady;
    const live = this.getLiveSession(sessionId);
    if (live?.running) {
      throw new Error("Stop Codex session before deleting it.");
    }
    if (live && !live.threadId) {
      live.hidden = true;
      this.clearSessionMemory(live.session.id);
      this.emitBackend(live.project, {
        type: "session.deleted",
        directory: live.project.directory,
        workspaceId: live.project.workspaceId,
        sessionId: live.session.id,
      });
      return true;
    }
    const realId = this.resolveSessionId(sessionId);
    const record = this.sessionIndex.get(realId);
    if (!record) return true;
    record.hidden = true;
    this.sessionIndex.set(realId, record);
    if (live) {
      live.hidden = true;
    }
    this.clearSessionMemory(sessionId);
    await this.persistIndex();
    const project = this.ensureKnownProject(record.directory, record.workspaceId);
    this.emitBackend(project, {
      type: "session.deleted",
      directory: project.directory,
      workspaceId: project.workspaceId,
      sessionId: realId,
    });
    return true;
  }

  async updateSession(sessionId, title, _target = {}) {
    sessionId = toRawSessionId(sessionId);
    const trimmed = String(title ?? "").trim();
    if (!trimmed) throw new Error("Session title cannot be empty");
    const live = this.getLiveSession(sessionId);
    if (live) {
      live.session = {
        ...live.session,
        title: trimmed,
        time: { ...live.session.time, updated: Date.now() },
      };
      if (live.threadId) {
        const record = this.sessionIndex.get(live.threadId) ?? {
          id: live.threadId,
          directory: live.project.directory,
          workspaceId: live.project.workspaceId,
          createdAt: live.createdAt,
          updatedAt: Date.now(),
          preview: "",
          origin: "opengui",
        };
        record.title = trimmed;
        record.updatedAt = Date.now();
        this.sessionIndex.set(live.threadId, record);
        await this.persistIndex();
      }
      this.emitBackend(live.project, {
        type: "session.updated",
        directory: live.project.directory,
        workspaceId: live.project.workspaceId,
        session: live.session,
      });
      return live.session;
    }
    const realId = this.resolveSessionId(sessionId);
    const record = this.sessionIndex.get(realId);
    if (!record) throw new Error("Codex session not found");
    record.title = trimmed;
    record.updatedAt = Date.now();
    this.sessionIndex.set(realId, record);
    await this.persistIndex();
    const session = this.buildSessionFromRecord(record);
    const project = this.ensureKnownProject(record.directory, record.workspaceId);
    this.emitBackend(project, {
      type: "session.updated",
      directory: project.directory,
      workspaceId: project.workspaceId,
      session,
    });
    return session;
  }

  async getSessionStatuses(target = {}) {
    const statuses = {};
    for (const session of await this.listSessions(target)) {
      const live = this.getLiveSession(session.id);
      statuses[session.id] = sessionStatus(live?.running ? "busy" : "idle");
    }
    return statuses;
  }

  async getProviders() {
    return await getCodexProviderData();
  }

  async getAgents() {
    return [];
  }

  async getCommands() {
    return [];
  }

  async getMessages(sessionId) {
    sessionId = toRawSessionId(sessionId);
    const live = this.getLiveSession(sessionId);
    if (live) {
      return {
        messages: cloneJSON(live.messages),
        nextCursor: null,
      };
    }
    const transcript = await this.loadTranscript(sessionId);
    if (transcript.messages.length > 0) {
      return {
        messages: cloneJSON(transcript.messages),
        nextCursor: null,
      };
    }
    try {
      const messages = await readCodexAppServerMessages(this.resolveSessionId(sessionId));
      if (messages.length > 0) {
        await this.persistTranscript(sessionId, messages);
        return { messages: cloneJSON(messages), nextCursor: null };
      }
    } catch (error) {
      console.warn("Failed to read Codex session via app-server:", error);
    }
    return {
      messages: cloneJSON(transcript.messages),
      nextCursor: null,
    };
  }

  async ensureLiveSessionForPrompt(sessionId, directory, workspaceId) {
    sessionId = toRawSessionId(sessionId);
    const live = this.getLiveSession(sessionId);
    if (live) return live;
    const realId = this.resolveSessionId(sessionId);
    const record = this.sessionIndex.get(realId);
    if (!record) throw new Error("Codex session not found");
    const project = this.ensureKnownProject(
      directory || record.directory,
      workspaceId ?? record.workspaceId,
    );
    const session = this.buildSessionFromRecord(record);
    const cached = await this.loadTranscript(realId);
    const createdAt = record.createdAt ?? Date.now();
    const state = {
      sessionId: realId,
      threadId: realId,
      project,
      session,
      messages: cloneJSON(cached.messages),
      running: false,
      abortController: null,
      currentAssistantMessageId: null,
      currentUserMessageId: null,
      currentModelId: DEFAULT_MODEL_ID,
      currentVariant: undefined,
      createdAt,
      hidden: false,
    };
    this.liveSessions.set(realId, state);
    return state;
  }

  appendSyntheticUserMessage(state, text, images, model, variant) {
    const messageId = randomUUID();
    const modelId = resolveSelectedModelId(model);
    state.currentModelId = modelId;
    state.currentVariant = resolveVariant(variant);
    state.session = {
      ...state.session,
      model: {
        providerID: DEFAULT_PROVIDER_ID,
        id: modelId,
        ...(state.currentVariant ? { variant: state.currentVariant } : {}),
      },
    };
    const info = defaultUserInfo(state.session.id, messageId, modelId, state.currentVariant);
    const parts = [
      makeTextPart(state.session.id, messageId, randomUUID(), String(text ?? ""), true),
      ...createUserImageParts(state.session.id, messageId, images),
    ];
    const bundle = { info, parts };
    state.messages.push(bundle);
    state.currentUserMessageId = messageId;
    this.emitBackend(state.project, { type: "message.updated", message: info });
    for (const part of parts) {
      this.emitBackend(state.project, { type: "message.part.updated", part });
    }
  }

  ensureAssistantMessage(state) {
    if (state.currentAssistantMessageId) {
      const existing = findMessage(state.messages, state.currentAssistantMessageId);
      if (existing) return existing;
    }
    const messageId = randomUUID();
    const info = defaultAssistantInfo(
      state.session.id,
      messageId,
      state.project.directory,
      state.currentModelId,
      state.currentVariant,
    );
    info.parentID = state.currentUserMessageId ?? "";
    const bundle = upsertMessage(state.messages, info);
    state.currentAssistantMessageId = messageId;
    this.emitBackend(state.project, { type: "message.updated", message: info });
    return bundle;
  }

  emitSessionUpdated(state) {
    this.emitBackend(state.project, {
      type: "session.updated",
      directory: state.project.directory,
      workspaceId: state.project.workspaceId,
      session: state.session,
    });
  }

  async syncRealSessionRecord(state, emitEvent = true) {
    if (!state.threadId) return;
    const now = Date.now();
    const preview = getSessionPreview(state.messages);
    const existing = this.sessionIndex.get(state.threadId);
    const title =
      state.session.title && state.session.title !== "Untitled"
        ? state.session.title
        : makeSessionTitle(preview, existing?.title);
    const record = {
      id: state.threadId,
      directory: state.project.directory,
      workspaceId: state.project.workspaceId,
      title,
      preview,
      createdAt: existing?.createdAt ?? state.createdAt,
      updatedAt: now,
      modelId: state.currentModelId ?? existing?.modelId,
      variant: state.currentVariant ?? existing?.variant,
      origin: "opengui",
      hidden: existing?.hidden ?? false,
    };
    this.sessionIndex.set(state.threadId, record);
    state.session = this.buildSessionFromRecord(record);
    state.sessionId = state.threadId;
    await this.persistIndex();
    await this.persistTranscript(state.threadId, state.messages);
    if (emitEvent) {
      this.emitSessionUpdated(state);
    }
  }

  async handleThreadStarted(state, threadId) {
    threadId = toRawSessionId(threadId);
    if (!threadId || state.threadId === threadId) return;
    const oldId = state.session.id;
    const oldRawId = toRawSessionId(oldId);
    state.threadId = threadId;
    state.sessionId = threadId;
    state.session = this.buildSession({
      id: threadId,
      directory: state.project.directory,
      workspaceId: state.project.workspaceId,
      title: state.session.title,
      createdAt: state.createdAt,
      updatedAt: Date.now(),
    });
    renameSessionInMessages(state.messages, oldId, threadId);
    this.aliases.set(oldRawId, threadId);
    this.liveSessions.delete(oldRawId);
    this.liveSessions.delete(oldId);
    this.liveSessions.set(threadId, state);
    await this.syncRealSessionRecord(state, false);
    this.emitBackend(state.project, {
      type: "session.replaced",
      oldId,
      newId: threadId,
      directory: state.project.directory,
      workspaceId: state.project.workspaceId,
      session: state.session,
    });
  }

  handleAgentTextPart(state, item, phase) {
    this.ensureAssistantMessage(state);
    const messageId = state.currentAssistantMessageId;
    const partId = `${messageId}:text:${item.id}`;
    const existing = findPart(state.messages, messageId, partId);
    const next = makeTextPart(state.session.id, messageId, partId, item.text || "");
    upsertPart(state.messages, next);
    if (
      existing &&
      typeof existing.text === "string" &&
      typeof next.text === "string" &&
      next.text.startsWith(existing.text) &&
      next.text !== existing.text
    ) {
      this.emitBackend(state.project, {
        type: "message.part.delta",
        sessionID: state.session.id,
        messageID: messageId,
        partID: partId,
        field: "text",
        delta: next.text.slice(existing.text.length),
      });
      if (phase === "completed") {
        this.emitBackend(state.project, { type: "message.part.updated", part: next });
      }
      return;
    }
    this.emitBackend(state.project, { type: "message.part.updated", part: next });
  }

  handleReasoningPart(state, item, phase) {
    this.ensureAssistantMessage(state);
    const messageId = state.currentAssistantMessageId;
    const partId = `${messageId}:reasoning:${item.id}`;
    const existing = findPart(state.messages, messageId, partId);
    const next = {
      ...(existing ?? makeReasoningPart(state.session.id, messageId, partId, item.text || "")),
      sessionID: state.session.id,
      messageID: messageId,
      text: item.text || "",
      time: {
        start: existing?.time?.start ?? Date.now(),
        ...(phase === "completed" ? { end: Date.now() } : {}),
      },
    };
    upsertPart(state.messages, next);
    if (
      existing &&
      typeof existing.text === "string" &&
      next.text.startsWith(existing.text) &&
      next.text !== existing.text
    ) {
      this.emitBackend(state.project, {
        type: "message.part.delta",
        sessionID: state.session.id,
        messageID: messageId,
        partID: partId,
        field: "text",
        delta: next.text.slice(existing.text.length),
      });
    }
    this.emitBackend(state.project, { type: "message.part.updated", part: next });
  }

  handleToolLikeItem(state, item, phase) {
    this.ensureAssistantMessage(state);
    const messageId = state.currentAssistantMessageId;
    const partId = `${messageId}:tool:${item.id}`;
    const existing = findPart(state.messages, messageId, partId);
    const next = buildToolPartFromItem(state.session.id, messageId, item, existing, phase);
    upsertPart(state.messages, next);
    this.emitBackend(state.project, { type: "message.part.updated", part: next });
  }

  finalizeAssistantMessage(state, usage) {
    if (!state.currentAssistantMessageId) return;
    const bundle = findMessage(state.messages, state.currentAssistantMessageId);
    if (!bundle) return;
    const info = {
      ...bundle.info,
      time: {
        ...bundle.info.time,
        completed: Date.now(),
      },
      tokens: {
        ...bundle.info.tokens,
        input: usage?.input_tokens ?? bundle.info.tokens.input,
        output: usage?.output_tokens ?? bundle.info.tokens.output,
      },
    };
    bundle.info = info;
    this.emitBackend(state.project, { type: "message.updated", message: info });
  }

  buildThreadOptions(project, model, variant) {
    return {
      model: resolveSelectedModelId(model),
      sandboxMode: "workspace-write",
      workingDirectory: project.directory,
      skipGitRepoCheck: false,
      modelReasoningEffort: resolveVariant(variant),
      approvalPolicy: "never",
    };
  }

  async stageImages(images) {
    const list = Array.isArray(images) ? images : [];
    if (list.length === 0) return { inputImages: [], cleanup: async () => {} };
    const dir = await mkdtemp(join(tmpdir(), "opengui-codex-"));
    const paths = [];
    try {
      for (let i = 0; i < list.length; i += 1) {
        const parsed = parseDataUrl(list[i]);
        if (!parsed) continue;
        const filePath = join(dir, `image-${i + 1}${mimeToExtension(parsed.mimeType)}`);
        await writeFile(filePath, Buffer.from(parsed.data, "base64"));
        paths.push(filePath);
      }
      return {
        inputImages: paths.map((path) => ({ type: "localImage", path })),
        cleanup: async () => {
          await rm(dir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  appServerThreadConfig(project, model, variant) {
    return {
      model: resolveSelectedModelId(model),
      cwd: project.directory,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      effort: resolveVariant(variant),
      serviceName: "opengui",
    };
  }

  appServerTurnConfig(project, model, variant) {
    return {
      cwd: project.directory,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [project.directory],
        networkAccess: false,
      },
      model: resolveSelectedModelId(model),
      effort: resolveVariant(variant),
    };
  }

  upsertAppServerItem(state, cache, item, phase) {
    const existing = cache.get(item?.id) ?? {};
    const normalized = normalizeAppServerItem(item, existing);
    if (!normalized) return;
    cache.set(normalized.id, normalized);
    if (normalized.type === "agent_message") {
      if (normalized.text) this.handleAgentTextPart(state, normalized, phase);
      return;
    }
    if (normalized.type === "reasoning") {
      if (normalized.text) this.handleReasoningPart(state, normalized, phase);
      return;
    }
    if (
      normalized.type === "command_execution" ||
      normalized.type === "file_change" ||
      normalized.type === "mcp_tool_call" ||
      normalized.type === "web_search" ||
      normalized.type === "todo_list"
    ) {
      this.handleToolLikeItem(state, normalized, phase);
    }
  }

  appendAppServerDelta(state, cache, itemId, field, delta, fallbackType) {
    if (!itemId || typeof delta !== "string") return;
    const existing = cache.get(itemId) ?? { id: itemId, type: fallbackType };
    if (fallbackType === "command_execution") {
      existing.aggregated_output = `${existing.aggregated_output ?? ""}${delta}`;
      existing.status = existing.status ?? "in_progress";
    } else {
      existing[field] = appendOrReplaceCumulativeDelta(existing[field], delta);
    }
    cache.set(itemId, existing);
    if (fallbackType === "agent_message") {
      this.handleAgentTextPart(state, existing, "running");
    } else if (fallbackType === "reasoning") {
      this.handleReasoningPart(state, existing, "running");
    } else if (fallbackType === "command_execution") {
      this.handleToolLikeItem(state, existing, "running");
    }
  }

  async runAppServerTurn(state, text, inputImages, model, variant, controller) {
    const env = pickCodexEnv(process.env);
    const executable = getCodexExecutable();
    const itemCache = new Map();
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, ["app-server"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let nextId = 1;
      let stderr = "";
      let finished = false;
      const pending = new Map<
        number,
        {
          resolve: (value: any) => void;
          reject: (error: unknown) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      const cleanup = () => {
        for (const entry of pending.values()) clearTimeout(entry.timer);
        pending.clear();
        rl.close();
        controller.signal.removeEventListener("abort", onAbort);
        if (!child.killed) {
          try {
            child.kill();
          } catch {}
        }
      };
      const settle = (fn: (value: any) => void, value: any) => {
        if (finished) return;
        finished = true;
        cleanup();
        fn(value);
      };
      const request: CodexAppServerRequest = (
        method,
        params = {},
        timeout = CODEX_APP_SERVER_TIMEOUT_MS,
      ) =>
        new Promise((resolveRequest, rejectRequest) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectRequest(new Error(`Codex app-server request timed out: ${method}`));
          }, timeout);
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
      const onAbort = () => settle(reject, new Error("Codex turn aborted"));
      controller.signal.addEventListener("abort", onAbort);

      const handleNotification = async (method: string, params: Record<string, any> = {}) => {
        if (method === "thread/started") {
          await this.handleThreadStarted(state, params.thread?.id);
          return;
        }
        if (method === "turn/started") {
          this.emitBackend(state.project, {
            type: "session.status",
            sessionID: state.session.id,
            status: sessionStatus("busy"),
          });
          return;
        }
        if (method === "item/started") {
          this.upsertAppServerItem(state, itemCache, params.item, "running");
          return;
        }
        if (method === "item/completed") {
          this.upsertAppServerItem(state, itemCache, params.item, "completed");
          return;
        }
        if (method === "item/agentMessage/delta") {
          this.appendAppServerDelta(
            state,
            itemCache,
            params.itemId,
            "text",
            params.delta,
            "agent_message",
          );
          return;
        }
        if (method === "item/plan/delta") {
          this.appendAppServerDelta(
            state,
            itemCache,
            params.itemId,
            "text",
            params.delta,
            "reasoning",
          );
          return;
        }
        if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
          this.appendAppServerDelta(
            state,
            itemCache,
            params.itemId,
            "text",
            params.delta,
            "reasoning",
          );
          return;
        }
        if (
          method === "item/commandExecution/outputDelta" ||
          method === "item/fileChange/outputDelta"
        ) {
          this.appendAppServerDelta(
            state,
            itemCache,
            params.itemId,
            "aggregated_output",
            params.delta,
            "command_execution",
          );
          return;
        }
        if (method === "turn/completed") {
          this.finalizeAssistantMessage(state, params.turn?.usage);
          if (params.turn?.status === "failed") {
            settle(reject, new Error(params.turn?.error?.message || "Codex turn failed"));
            return;
          }
          settle(resolve, params.turn);
        }
        if (method === "error") {
          settle(
            reject,
            new Error(params.error?.message || params.message || "Codex stream failed"),
          );
        }
      };

      rl.on("line", (line) => {
        if (!line.trim() || finished) return;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof message?.id === "number" && !message.method) {
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.error)
            entry.reject(
              new Error(message.error?.message || `Codex app-server error: ${message.id}`),
            );
          else entry.resolve(message.result);
          return;
        }
        if (typeof message?.id === "number" && message.method) {
          child.stdin.write(
            `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported request" } })}\n`,
          );
          return;
        }
        if (typeof message?.method === "string") {
          void handleNotification(message.method, message.params ?? {}).catch((error) =>
            settle(reject, error),
          );
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", (error) => settle(reject, error));
      child.once("exit", (code, signal) => {
        if (!finished)
          settle(
            reject,
            new Error(
              `Codex app-server exited early (${signal ?? code ?? "unknown"}): ${stderr.trim() || "no stderr"}`,
            ),
          );
      });

      void (async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "opengui_desktop", title: "OpenGUI", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          });
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          if (state.threadId) {
            await request("thread/resume", { threadId: state.threadId });
          } else {
            const response = await request(
              "thread/start",
              this.appServerThreadConfig(state.project, model, variant),
            );
            await this.handleThreadStarted(state, response?.thread?.id);
          }
          await request("turn/start", {
            threadId: state.threadId,
            input: [{ type: "text", text: String(text ?? "") }, ...inputImages],
            ...this.appServerTurnConfig(state.project, model, variant),
          });
        } catch (error) {
          settle(reject, error);
        }
      })();
    });
  }

  async runTurn(state, text, images, model, variant) {
    const controller = new AbortController();
    state.abortController = controller;
    state.running = true;
    state.currentAssistantMessageId = null;
    state.currentModelId = resolveSelectedModelId(model);
    state.currentVariant = resolveVariant(variant);
    let cleanup = async () => {};
    let emittedIdle = false;
    try {
      const staged = await this.stageImages(images);
      cleanup = staged.cleanup;
      await this.runAppServerTurn(state, text, staged.inputImages, model, variant, controller);
      await this.syncRealSessionRecord(state);
      this.emitBackend(state.project, {
        type: "session.status",
        sessionID: state.session.id,
        status: sessionStatus("idle"),
      });
      emittedIdle = true;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.emitBackend(state.project, {
          type: "session.error",
          error: error instanceof Error ? error.message : String(error),
          sessionID: state.session.id,
        });
        await this.syncRealSessionRecord(state);
      }
    } finally {
      state.running = false;
      state.abortController = null;
      state.currentAssistantMessageId = null;
      if (!emittedIdle) {
        this.emitBackend(state.project, {
          type: "session.status",
          sessionID: state.session.id,
          status: sessionStatus("idle"),
        });
      }
      await cleanup();
      if (state.threadId) {
        await this.persistTranscript(state.threadId, state.messages);
      }
    }
  }

  async prompt(sessionId, text, images, model, _agent, variant, directory, workspaceId) {
    sessionId = toRawSessionId(sessionId);
    const state = await this.ensureLiveSessionForPrompt(sessionId, directory, workspaceId);
    if (state.running) {
      throw new Error("Codex session already running");
    }
    const resolvedVariant = await resolveSupportedCodexVariant(model, variant);
    this.appendSyntheticUserMessage(state, text, images, model, resolvedVariant);
    if (state.threadId) {
      await this.persistTranscript(state.threadId, state.messages);
    }
    void this.runTurn(state, text, images, model, resolvedVariant).catch((error) => {
      state.running = false;
      state.abortController = null;
      this.emitBackend(state.project, {
        type: "session.error",
        error: error instanceof Error ? error.message : String(error),
        sessionID: state.session.id,
      });
      this.emitBackend(state.project, {
        type: "session.status",
        sessionID: state.session.id,
        status: sessionStatus("idle"),
      });
    });
  }

  async abort(sessionId) {
    sessionId = toRawSessionId(sessionId);
    const state = this.getLiveSession(sessionId);
    state?.abortController?.abort();
    return true;
  }

  async sendCommand(sessionId, command, args, model, agent, variant, directory, workspaceId) {
    sessionId = toRawSessionId(sessionId);
    const text = `/${command}${args ? ` ${args}` : ""}`;
    await this.prompt(sessionId, text, [], model, agent, variant, directory, workspaceId);
  }

  async summarizeSession(sessionId, model, directory, workspaceId) {
    sessionId = toRawSessionId(sessionId);
    await this.prompt(
      sessionId,
      "/compact",
      [],
      model,
      undefined,
      undefined,
      directory,
      workspaceId,
    );
  }
}

export function setupCodexBridge(ipcMain, getAllWindows, options = {}) {
  let manager = new CodexBridgeManager(getAllWindows, options);

  registerObjectTargetHarnessRpcHandlers("codex", ipcMain, () => manager);

  return {
    async restart() {
      manager.disconnect();
      manager = new CodexBridgeManager(getAllWindows, options);
      return true;
    },
  };
}
