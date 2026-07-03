/**
 * Pure Pi harness event → OpenGUI transcript mapping (testable, no IPC/SDK).
 */
import { makeHarnessSessionIdCodec, normalizeHarnessDirectory } from "./harness-adapter-kit.ts";
import type { PiContentBlock } from "./pi-bridge-types.ts";

const { toFrontendSessionId } = makeHarnessSessionIdCodec("pi:");

export function coerceTimestamp(timestamp: unknown) {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  return Date.now();
}

export function stringifyUnknown(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[object]";
  }
}

export function makeStreamingMessageId(sessionId: string, seq: number) {
  return `pi:stream:${sessionId}:assistant:${seq}`;
}

export function makeTextPartId(messageId: string, index: number) {
  return `${messageId}:text:${index}`;
}

export function makeReasoningPartId(messageId: string, index: number) {
  return `${messageId}:reasoning:${index}`;
}

export function makeFilePartId(messageId: string, index: number) {
  return `${messageId}:file:${index}`;
}

export function makeToolPartId(messageId: string, toolCallId: string, index: number) {
  return `${messageId}:tool:${toolCallId || index}`;
}

export function isPiImageContentBlock(
  block: unknown,
): block is Extract<PiContentBlock, { type: "image" }> {
  return block != null && typeof block === "object" && (block as PiContentBlock).type === "image";
}

export function parseDataUrl(dataUrl: unknown) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1] || "application/octet-stream",
    data: match[2],
  };
}

export function piImageBlockToFilePart(
  block: { type?: string; mimeType?: string; data?: string },
  messageId: string,
  index: number,
) {
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

export function toolResultContentToText(content: unknown) {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
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

export function makeSessionTitleFromText(text: unknown, title: unknown) {
  const explicit = typeof title === "string" ? title.trim() : "";
  if (explicit) return explicit;
  const lineSource = typeof text === "string" ? text : "";
  const firstLine = lineSource.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.slice(0, 80) || "Untitled";
}

export function normalizePiSession(
  info: {
    id?: string;
    cwd?: string;
    name?: string;
    firstMessage?: unknown;
    model?: unknown;
    created?: { getTime?: () => number };
    modified?: { getTime?: () => number };
  },
  target: { directory?: string; workspaceId?: string } = {},
) {
  const directory = normalizeHarnessDirectory(target.directory || info?.cwd || "");
  const rawId = String(info.id || "");
  const rawFirstMessage =
    typeof info?.firstMessage === "string"
      ? info.firstMessage
      : stringifyUnknown(info?.firstMessage);
  const title = info?.name || rawFirstMessage || "Untitled";
  return {
    id: toFrontendSessionId(rawId),
    slug: rawId,
    _harnessId: "pi" as const,
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

export function extractPiThinkingVariant(entry: {
  level?: unknown;
  thinkingLevel?: unknown;
  effort?: unknown;
  value?: unknown;
  label?: unknown;
}) {
  const raw = entry?.level ?? entry?.thinkingLevel ?? entry?.effort ?? entry?.value ?? entry?.label;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function toOptionalModelRef(
  model: { provider?: string; modelId?: string; variant?: string } | null,
): { provider?: string; modelId?: string; variant?: string } | undefined {
  return model ?? undefined;
}

export function branchEntryMessageId(
  entry: { id?: string },
  sessionId: string,
  fallbackSuffix: string,
): string {
  if (typeof entry.id === "string" && entry.id.length > 0) return entry.id;
  return `${sessionId}:${fallbackSuffix}`;
}

export type PiMessageBranchEntry = {
  type: string;
  id?: string;
  timestamp?: string | number;
  summary?: string;
  content?: unknown;
  firstKeptEntryId?: string;
  provider?: string;
  modelId?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: unknown;
    stopReason?: string;
    errorMessage?: string;
    provider?: string;
    model?: string;
    variant?: string;
    toolCallId?: string;
    isError?: boolean;
    details?: unknown;
    usage?: Record<string, unknown>;
  };
};

export function requireMessageEntry(entry: PiMessageBranchEntry): entry is PiMessageBranchEntry & {
  message: NonNullable<PiMessageBranchEntry["message"]> & { role: string };
} {
  return (
    entry.type === "message" && entry.message != null && typeof entry.message.role === "string"
  );
}

type BranchEntry =
  | { type: "model_change"; provider?: string; modelId?: string }
  | { type: "thinking_level_change"; level?: string }
  | { type: "message"; message?: { role?: string; provider?: string; model?: string } };

export function inferPiSessionModelFromManager(manager: {
  buildSessionContext?: () => {
    model?: { provider?: string; modelId?: string };
    thinkingLevel?: string;
  };
  getBranch: () => BranchEntry[];
}) {
  const context = manager.buildSessionContext?.();
  if (context?.model?.provider && context.model.modelId) {
    return {
      providerID: context.model.provider,
      id: context.model.modelId,
      ...(typeof context.thinkingLevel === "string" ? { variant: context.thinkingLevel } : {}),
    };
  }

  let currentModel: { providerID: string; id: string } | null = null;
  let currentVariant: string | undefined;
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

export function sessionStatus(type: string) {
  return { type };
}

export function getSessionActivityType(session: { isCompacting?: boolean; isStreaming?: boolean }) {
  if (session?.isCompacting) return "busy";
  if (session?.isStreaming) return "busy";
  return "idle";
}

export function createUserInfo({
  sessionId,
  messageId,
  timestamp,
  model,
  directory,
}: {
  sessionId: string;
  messageId: string;
  timestamp: number;
  model?: { provider?: string; modelId?: string; variant?: string };
  directory?: string;
}) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "user" as const,
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

export function createAssistantInfo({
  sessionId,
  messageId,
  timestamp,
  message,
  directory,
  parentID,
  createdAt,
  completedAt,
}: {
  sessionId: string;
  messageId: string;
  timestamp: number;
  message?: {
    stopReason?: string;
    errorMessage?: string;
    model?: string;
    provider?: string;
    variant?: string;
    usage?: {
      cost?: { total?: number };
      totalTokens?: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  directory?: string;
  parentID?: string;
  createdAt?: number;
  completedAt?: number;
}) {
  const isCompleted = typeof completedAt === "number";
  return {
    id: messageId,
    sessionID: sessionId,
    role: "assistant" as const,
    time: {
      created: typeof createdAt === "number" ? createdAt : timestamp,
      completed: isCompleted ? completedAt : undefined,
    },
    error:
      isCompleted && message?.stopReason === "error"
        ? {
            name: "PiError",
            data: { message: message?.errorMessage || "Pi error" },
          }
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

export type PiMessageBundle = {
  info: {
    id: string;
    sessionID: string;
    role?: string;
    parentID?: string;
    time: { created: number; completed?: number };
  };
  parts: Array<Record<string, unknown>>;
};

export type PiAssistantContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
  id?: string;
  name?: string;
  arguments?: unknown;
};

export function toAssistantSyncMessage(message: {
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  provider?: string;
  variant?: string;
  usage?: Record<string, unknown>;
}): { content?: PiAssistantContentBlock[] } {
  const content = Array.isArray(message.content)
    ? (message.content as PiAssistantContentBlock[])
    : undefined;
  return { content };
}

export function createBundle(
  info: PiMessageBundle["info"] | Record<string, unknown>,
  parts: PiMessageBundle["parts"] | unknown[] = [],
): PiMessageBundle {
  return {
    info: info as PiMessageBundle["info"],
    parts: parts as PiMessageBundle["parts"],
  };
}

export function cloneBundle(bundle: PiMessageBundle): PiMessageBundle {
  return {
    info: { ...bundle.info },
    parts: bundle.parts.map((part) => ({ ...part })),
  };
}

export function buildUserParts(content: unknown, messageId: string) {
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
  const parts: Array<Record<string, unknown>> = [];
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

export function normalizeToolInput(input: Record<string, unknown> = {}) {
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

/** Sync assistant content blocks to parts; one reasoning part per thinking block (#130). */
export function syncAssistantParts(
  bundle: PiMessageBundle,
  message: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      redacted?: boolean;
      id?: string;
      name?: string;
      arguments?: unknown;
    }>;
  },
  reasoningTimesByContentIndex?: Map<number, { start?: number; end?: number }>,
) {
  const existingToolPartsByCallId = new Map<string, Record<string, unknown>>();
  for (const part of bundle.parts) {
    if (part.type === "tool") {
      existingToolPartsByCallId.set(String(part.callID), part);
    }
  }
  const nextParts: Array<Record<string, unknown>> = [];
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
      const existing = existingToolPartsByCallId.get(block.id!);
      const normalizedInput = normalizeToolInput(
        (block.arguments || {}) as Record<string, unknown>,
      );
      nextParts.push({
        id: existing?.id ?? makeToolPartId(bundle.info.id, block.id!, toolIndex),
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
