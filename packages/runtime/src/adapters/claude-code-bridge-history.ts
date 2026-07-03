/**
 * Claude Code session history → harness message mapping (pure helpers).
 */
import { normalizeHarnessDirectory as normalizeDir } from "./harness-adapter-kit.ts";
import {
  makeReasoningPart,
  makeTextPart,
  mapClaudeModelId,
  normalizeToolInput,
} from "./claude-code-bridge-mapping.ts";
import type {
  ClaudeMessageBundle,
  ClaudeMessagePart,
  ClaudeProjectTarget,
} from "./claude-code-bridge-types.ts";

export type ClaudeHistoryEntry = Record<string, unknown> & {
  uuid?: string;
  type?: string;
  session_id?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    modelId?: string;
    content?: unknown;
  };
};

function parseTimestamp(raw: unknown) {
  if (typeof raw !== "string") return Date.now();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function defaultAssistantInfo(
  sessionId: string,
  messageId: string,
  directory: string,
  modelId = "default",
) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: modelId,
    providerID: "anthropic",
    mode: "claude-code",
    agent: "claude",
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

function defaultUserInfo(sessionId: string, messageId: string, modelId = "default", createdAt = Date.now()) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created: createdAt },
    agent: "claude",
    model: {
      providerID: "anthropic",
      modelID: modelId,
    },
  };
}

function makeToolPart(
  sessionId: string,
  messageId: string,
  index: number,
  toolName: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): ClaudeMessagePart {
  return {
    id: `${messageId}:tool:${index}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "tool",
    callID: `${messageId}:call:${index}`,
    tool: toolName,
    state: {
      status: "completed",
      input: normalizeToolInput(toolName, input),
      output: "",
      title: toolName,
      metadata,
      time: {
        start: Date.now(),
        end: Date.now(),
      },
    },
  };
}

function getMessageBlocks(message: ClaudeHistoryEntry) {
  const content = message?.message?.content;
  if (Array.isArray(content)) return content as unknown[];
  return [content ?? message?.message].filter(Boolean);
}

function getToolResultBlocks(message: ClaudeHistoryEntry) {
  const blocks = getMessageBlocks(message);
  if (blocks.length === 0) return [];
  const toolResults = blocks.filter(
    (block): block is Record<string, unknown> =>
      Boolean(block && typeof block === "object" && (block as { type?: string }).type === "tool_result"),
  );
  return toolResults.length === blocks.length ? toolResults : [];
}

function toolResultContentToText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object" && typeof (content as { text?: string }).text === "string") {
      return (content as { text: string }).text;
    }
    return "";
  }
  const segments: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      segments.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as { text?: string; content?: string };
    if (typeof row.text === "string") {
      segments.push(row.text);
      continue;
    }
    if (typeof row.content === "string") {
      segments.push(row.content);
    }
  }
  return segments.join("\n\n");
}

export function mergeToolResultIntoPart(part: ClaudeMessagePart, block: Record<string, unknown>) {
  const output = toolResultContentToText(block?.content);
  const metadata =
    part.state?.metadata && typeof part.state.metadata === "object" ? part.state.metadata : {};
  return {
    ...part,
    callID: (typeof block?.tool_use_id === "string" ? block.tool_use_id : undefined) || part.callID,
    state: {
      ...part.state,
      status: block?.is_error ? "error" : "completed",
      output: output || part.state?.output || "",
      error: block?.is_error ? output || "Tool failed" : undefined,
      metadata: {
        ...metadata,
        toolUseId: block?.tool_use_id || metadata.toolUseId,
      },
      time: {
        ...part.state?.time,
        end: Date.now(),
      },
    },
  };
}

function contentToTextSegments(content: unknown) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const result: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      result.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const row = block as { text?: string; content?: string | unknown[] };
    if (typeof row.text === "string") {
      result.push(row.text);
      continue;
    }
    if (typeof row.content === "string") {
      result.push(row.content);
      continue;
    }
    if (Array.isArray(row.content)) {
      for (const nested of row.content) {
        if (nested && typeof nested === "object" && typeof (nested as { text?: string }).text === "string") {
          result.push((nested as { text: string }).text);
        }
      }
    }
  }
  return result;
}

function mapUserHistoryMessage(message: ClaudeHistoryEntry, sessionId: string): ClaudeMessageBundle {
  const createdAt = parseTimestamp(message?.timestamp);
  const info = defaultUserInfo(sessionId, message.uuid ?? "", "sonnet", createdAt);
  const parts = contentToTextSegments(getMessageBlocks(message)).map((text, index) =>
    makeTextPart(sessionId, info.id, index, text),
  );
  return { info, parts };
}

function mapAssistantContent(sessionId: string, messageId: string, content: unknown): ClaudeMessagePart[] {
  if (!Array.isArray(content)) return [];
  const parts: ClaudeMessagePart[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!block || typeof block !== "object") continue;
    const row = block as {
      text?: string;
      thinking?: string;
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
      id?: string;
    };
    if (typeof row.text === "string") {
      parts.push(makeTextPart(sessionId, messageId, index, row.text));
      continue;
    }
    if (typeof row.thinking === "string") {
      parts.push(makeReasoningPart(sessionId, messageId, index, row.thinking));
      continue;
    }
    if (row.type === "tool_use") {
      const part = makeToolPart(
        sessionId,
        messageId,
        index,
        row.name || "tool",
        row.input || {},
        { id: row.id },
      );
      part.callID = row.id || part.callID;
      parts.push(part);
    }
  }
  return parts;
}

function mapAssistantHistoryMessage(
  message: ClaudeHistoryEntry,
  sessionId: string,
  directory: string,
): ClaudeMessageBundle {
  const createdAt = parseTimestamp(message?.timestamp);
  const modelID = mapClaudeModelId(message?.message?.model ?? message?.message?.modelId);
  const messageId = message?.message?.id || message.uuid || "";
  const info = {
    ...defaultAssistantInfo(sessionId, messageId, directory, modelID),
    time: {
      created: createdAt,
      completed: createdAt,
    },
  };
  const parts = mapAssistantContent(sessionId, info.id, message?.message?.content);
  return { info, parts };
}

function mergeHistoryMessages(messages: ClaudeMessageBundle[]) {
  const merged = new Map<string, ClaudeMessageBundle>();
  for (const entry of messages) {
    if (!entry) continue;
    const existing = merged.get(entry.info.id);
    if (!existing) {
      merged.set(entry.info.id, {
        info: entry.info,
        parts: [...entry.parts],
      });
      continue;
    }
    const partsById = new Map(existing.parts.map((part) => [part.id, part]));
    for (const part of entry.parts) {
      partsById.set(part.id, part);
    }
    merged.set(entry.info.id, {
      info: {
        ...existing.info,
        ...entry.info,
        time: {
          ...existing.info.time,
          ...entry.info.time,
          created: Math.min(
            existing.info.time?.created ?? entry.info.time?.created ?? Date.now(),
            entry.info.time?.created ?? existing.info.time?.created ?? Date.now(),
          ),
          completed: entry.info.time?.completed ?? existing.info.time?.completed,
        },
      },
      parts: [...partsById.values()],
    });
  }
  return [...merged.values()];
}

function mapHistoryMessage(
  entry: ClaudeHistoryEntry,
  target: ClaudeProjectTarget,
): ClaudeMessageBundle | null {
  const sessionId = entry?.session_id ?? entry?.sessionId;
  if (!entry || typeof entry !== "object" || !entry.uuid || !sessionId) {
    return null;
  }
  if (entry.type === "user") {
    if (getToolResultBlocks(entry).length > 0) return null;
    return mapUserHistoryMessage(entry, sessionId);
  }
  if (entry.type === "assistant") {
    return mapAssistantHistoryMessage(
      entry,
      sessionId,
      normalizeDir(target.directory || process.cwd()),
    );
  }
  return null;
}

export function mapHistoryEntries(
  history: ClaudeHistoryEntry[] | null | undefined,
  target: ClaudeProjectTarget,
): ClaudeMessageBundle[] {
  const mapped: ClaudeMessageBundle[] = [];
  const toolRefs = new Map<
    string,
    { entry: ClaudeMessageBundle; index: number }
  >();
  for (const entry of history ?? []) {
    const sessionId = entry?.session_id ?? entry?.sessionId;
    if (!entry || typeof entry !== "object" || !entry.uuid || !sessionId) {
      continue;
    }
    if (entry.type === "assistant") {
      const mappedEntry = mapHistoryMessage(entry, target);
      if (!mappedEntry) continue;
      mapped.push(mappedEntry);
      mappedEntry.parts.forEach((part, index) => {
        if (part?.type !== "tool") return;
        const callId = part.callID;
        if (typeof callId === "string") {
          toolRefs.set(callId, { entry: mappedEntry, index });
        }
        const metaId =
          part.state?.metadata && typeof part.state.metadata === "object"
            ? (part.state.metadata as { id?: string }).id
            : undefined;
        if (typeof metaId === "string") {
          toolRefs.set(metaId, { entry: mappedEntry, index });
        }
      });
      continue;
    }
    if (entry.type === "user") {
      const toolResults = getToolResultBlocks(entry);
      if (toolResults.length > 0) {
        for (const block of toolResults) {
          const toolUseId =
            typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
          if (!toolUseId) continue;
          const ref = toolRefs.get(toolUseId);
          if (!ref) continue;
          const current = ref.entry.parts[ref.index];
          if (!current || current.type !== "tool") continue;
          ref.entry.parts[ref.index] = mergeToolResultIntoPart(current, block);
        }
        continue;
      }
      const mappedEntry = mapHistoryMessage(entry, target);
      if (mappedEntry) mapped.push(mappedEntry);
    }
  }
  return mergeHistoryMessages(mapped);
}

export function makeSyntheticUserMessage(
  sessionId: string,
  messageId: string,
  text: string,
  modelId = "sonnet",
): ClaudeMessageBundle {
  const info = defaultUserInfo(sessionId, messageId, modelId, Date.now());
  const parts = String(text ?? "")
    .split(/\r?\n/)
    .flatMap((line, index, lines) => {
      if (line.length > 0) return [makeTextPart(sessionId, messageId, index, line)];
      return lines.length > 1 ? [makeTextPart(sessionId, messageId, index, " ", true)] : [];
    });
  return { info, parts };
}

export function mapAssistantContentForLive(
  sessionId: string,
  messageId: string,
  content: unknown,
): ClaudeMessagePart[] {
  return mapAssistantContent(sessionId, messageId, content);
}

export function getToolResultBlocksFromMessage(message: ClaudeHistoryEntry) {
  return getToolResultBlocks(message);
}

export function getMessageBlocksFromEntry(message: ClaudeHistoryEntry) {
  return getMessageBlocks(message);
}

export function contentToTextSegmentsFromBlocks(content: unknown) {
  return contentToTextSegments(content);
}

export function mapUserHistoryMessageFromEntry(message: ClaudeHistoryEntry, sessionId: string) {
  return mapUserHistoryMessage(message, sessionId);
}