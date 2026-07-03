/**
 * Pure Claude Code harness mapping helpers (testable).
 */
import { makeHarnessSessionIdCodec, normalizeHarnessDirectory } from "./harness-adapter-kit.ts";
import type { ClaudeMessageBundle } from "./claude-code-bridge-types.ts";

const { toFrontendSessionId, toRawSessionId } = makeHarnessSessionIdCodec("claude-code:");

export function mapClaudeModelId(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) return "default";
  const value = raw.toLowerCase();
  if (value === "default" || value.includes("sonnet")) return "default";
  if (value.includes("opus")) return "opus";
  if (value.includes("haiku")) return "haiku";
  return raw;
}

export function makeSessionTitle(text: unknown, title: unknown) {
  const explicit = typeof title === "string" ? title.trim() : "";
  if (explicit) return explicit;
  const lineSource = typeof text === "string" ? text : "";
  const firstLine = lineSource.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.slice(0, 80) || "Untitled";
}

export function makeSessionFromInfo(
  info: {
    sessionId?: string;
    cwd?: string;
    customTitle?: string;
    summary?: string;
    firstPrompt?: string;
    model?: unknown;
    createdAt?: number;
    lastModified?: number;
  },
  target: { directory?: string; workspaceId?: string } = {},
  fallbackTitle?: string,
) {
  const directory = normalizeHarnessDirectory(info?.cwd || target.directory || "");
  const rawId = toRawSessionId(info?.sessionId);
  const id = toFrontendSessionId(rawId);
  return {
    id,
    slug: id,
    _harnessId: "claude-code" as const,
    _rawId: rawId,
    projectID: directory,
    workspaceID: target.workspaceId,
    directory,
    title: info?.customTitle || info?.summary || info?.firstPrompt || fallbackTitle || "Untitled",
    version: "claude-code",
    ...(info?.model ? { model: info.model } : {}),
    time: {
      created: info?.createdAt ?? info?.lastModified ?? Date.now(),
      updated: info?.lastModified ?? info?.createdAt ?? Date.now(),
    },
  };
}

export function makeTextPart(
  sessionId: string,
  messageId: string,
  index: number,
  text: string,
  synthetic = false,
) {
  return {
    id: `${messageId}:text:${index}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    synthetic,
    time: { start: Date.now() },
  };
}

/** One reasoning part per index (#130). */
export function makeReasoningPart(
  sessionId: string,
  messageId: string,
  index: number,
  text: string,
) {
  return {
    id: `${messageId}:reasoning:${index}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "reasoning",
    text,
    time: { start: Date.now() },
  };
}

export function normalizeToolInput(_toolName: string, input: Record<string, unknown> = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input ?? {};
  }
  const normalized = { ...input };
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

export function tagMessageEntrySession(entry: ClaudeMessageBundle): ClaudeMessageBundle {
  const sessionID = toFrontendSessionId(entry.info.sessionID ?? entry.info.id);
  return {
    ...entry,
    info: { ...entry.info, sessionID },
    parts: entry.parts.map((part) =>
      part && "sessionID" in part ? { ...part, sessionID } : part,
    ),
  };
}
