/**
 * Pure Codex app-server item → OpenGUI transcript mapping (testable).
 */
import { randomUUID } from "node:crypto";
import { makeHarnessSessionIdCodec, normalizeHarnessDirectory } from "./harness-adapter-kit.ts";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "./codex-models.ts";

const { toFrontendSessionId, toRawSessionId } = makeHarnessSessionIdCodec("codex:");

export function codexTimestampToMs(value: number) {
  if (!Number.isFinite(value)) return Date.now();
  return value > 10_000_000_000 ? value : value * 1000;
}

export function firstLine(text: unknown) {
  const s = typeof text === "string" ? text : "";
  return s.trim().split(/\r?\n/, 1)[0] ?? "";
}

export function normalizeCodexAppServerThread(
  thread: {
    id?: string;
    createdAt?: number;
    updatedAt?: number;
    cwd?: string;
    name?: string;
    preview?: string;
  },
  workspaceId?: string,
) {
  const createdAt = codexTimestampToMs(thread?.createdAt ?? NaN);
  const updatedAt = codexTimestampToMs(thread?.updatedAt ?? thread?.createdAt ?? NaN);
  const directory = normalizeHarnessDirectory(thread?.cwd) || "";
  const title = firstLine(thread?.name || thread?.preview || "").slice(0, 80) || "Untitled";
  const rawId = toRawSessionId(thread.id);
  const id = toFrontendSessionId(rawId);
  return {
    id,
    slug: id,
    _harnessId: "codex" as const,
    _rawId: rawId,
    projectID: directory,
    workspaceID: workspaceId,
    directory,
    title,
    version: "codex",
    time: { created: createdAt, updated: updatedAt },
  };
}

export function appServerUserText(item: { content?: unknown[] }) {
  const content = Array.isArray(item?.content) ? item.content : [];
  return content
    .map((entry) => {
      const row = entry as { text?: string; text_elements?: Array<{ text?: string }> };
      if (typeof row?.text === "string") return row.text;
      if (Array.isArray(row?.text_elements)) {
        return row.text_elements.map((el) => el?.text || "").join("");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function appServerItemText(item: { text?: string; message?: string; content?: unknown[] }) {
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.message === "string") return item.message;
  if (Array.isArray(item?.content)) return appServerUserText(item);
  return "";
}

export function appServerReasoningText(item: { summary?: unknown; content?: unknown }) {
  const chunks: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string" && value.trim()) chunks.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value)
        collect(
          (entry as { text?: string; summary?: string; content?: unknown })?.text ??
            (entry as { summary?: string })?.summary ??
            (entry as { content?: unknown })?.content ??
            entry,
        );
    } else if (value && typeof value === "object") {
      const obj = value as { text?: string; summary?: string; content?: unknown };
      collect(obj.text ?? obj.summary ?? obj.content);
    }
  };
  collect(item?.summary);
  collect(item?.content);
  return chunks.join("\n\n").trim();
}

export function appServerStatusToCodexStatus(status: string | undefined) {
  if (status === "inProgress") return "in_progress";
  if (status === "declined") return "failed";
  return status || "completed";
}

export function normalizeAppServerItem(
  item: Record<string, unknown> | null | undefined,
  existing: Record<string, unknown> = {},
) {
  if (!item || typeof item !== "object") return null;
  const id = (item.id as string) || (existing.id as string) || randomUUID();
  if (item.type === "agentMessage" || item.type === "assistantMessage") {
    return {
      id,
      type: "agent_message",
      text:
        appServerItemText(item as Parameters<typeof appServerItemText>[0]) ||
        (existing.text as string) ||
        "",
    };
  }
  if (item.type === "reasoning") {
    return {
      id,
      type: "reasoning",
      text:
        appServerReasoningText(item as Parameters<typeof appServerReasoningText>[0]) ||
        (existing.text as string) ||
        "",
    };
  }
  if (item.type === "commandExecution") {
    return {
      id,
      type: "command_execution",
      command: (item.command as string) || (existing.command as string) || "",
      aggregated_output: item.aggregatedOutput ?? existing.aggregated_output ?? "",
      exit_code: item.exitCode ?? existing.exit_code ?? null,
      status: appServerStatusToCodexStatus((item.status ?? existing.status) as string | undefined),
    };
  }
  if (item.type === "fileChange") {
    return {
      id,
      type: "file_change",
      changes: item.changes ?? existing.changes ?? [],
      status: appServerStatusToCodexStatus((item.status ?? existing.status) as string | undefined),
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      id,
      type: "mcp_tool_call",
      server: item.server ?? existing.server ?? "mcp",
      tool: item.tool ?? existing.tool ?? "tool",
      arguments: item.arguments ?? existing.arguments ?? {},
      result: item.result ?? existing.result,
      error: item.error ?? existing.error,
      status: appServerStatusToCodexStatus((item.status ?? existing.status) as string | undefined),
    };
  }
  if (item.type === "webSearch") {
    return {
      id,
      type: "web_search",
      query:
        (item.query as string) ??
        (existing.query as string) ??
        (item.action as { query?: string })?.query ??
        "",
      status: appServerStatusToCodexStatus((item.status ?? existing.status) as string | undefined),
    };
  }
  if (item.type === "plan") {
    return {
      id,
      type: "reasoning",
      text: (item.text as string) || (existing.text as string) || "",
    };
  }
  return {
    id,
    type: (item.type as string) || "item",
    text:
      appServerItemText(item as Parameters<typeof appServerItemText>[0]) ||
      (existing.text as string) ||
      "",
  };
}

function defaultUserInfo(
  sessionId: string,
  messageId: string,
  modelId: string,
  createdAt = Date.now(),
) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "user" as const,
    time: { created: createdAt },
    agent: "codex",
    model: { providerID: DEFAULT_PROVIDER_ID, modelID: modelId },
  };
}

function defaultAssistantInfo(
  sessionId: string,
  messageId: string,
  directory: string,
  modelId: string,
  createdAt = Date.now(),
) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "assistant" as const,
    time: { created: createdAt },
    parentID: "",
    modelID: modelId,
    providerID: DEFAULT_PROVIDER_ID,
    mode: "codex",
    agent: "codex",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function makeTextPart(sessionId: string, messageId: string, partId: string, text: string) {
  return { id: partId, sessionID: sessionId, messageID: messageId, type: "text", text };
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

/** Build message bundles from a Codex thread snapshot (#130: one reasoning part per item). */
export function buildMessagesFromCodexAppServerThread(thread: {
  id?: string;
  cwd?: string;
  model?: string;
  modelId?: string;
  createdAt?: number;
  turns?: Array<{
    id?: string;
    startedAt?: number;
    items?: Array<{
      type?: string;
      id?: string;
      content?: unknown[];
      text?: string;
      message?: string;
    }>;
  }>;
}) {
  const sessionId = toFrontendSessionId(thread.id);
  const directory = normalizeHarnessDirectory(thread.cwd) || "";
  const modelId = thread.model || thread.modelId || DEFAULT_MODEL_ID;
  const messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> =
    [];
  let seq = 0;
  for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
    const createdAt = codexTimestampToMs(turn.startedAt ?? thread.createdAt ?? NaN);
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const type = item?.type;
      if (type === "userMessage") {
        const text = appServerUserText(item);
        if (!text) continue;
        const messageId = item.id || `${turn.id}:user:${seq++}`;
        messages.push({
          info: defaultUserInfo(sessionId, messageId, modelId, createdAt),
          parts: [makeTextPart(sessionId, messageId, `${messageId}:text`, text)],
        });
        continue;
      }
      if (type === "agentMessage" || type === "assistantMessage" || type === "reasoning") {
        const text = appServerItemText(item);
        if (!text) continue;
        const messageId = item.id || `${turn.id}:assistant:${seq++}`;
        const info = defaultAssistantInfo(sessionId, messageId, directory, modelId, createdAt);
        messages.push({
          info,
          parts:
            type === "reasoning"
              ? [makeReasoningPart(sessionId, messageId, `${messageId}:reasoning`, text, createdAt)]
              : [makeTextPart(sessionId, messageId, `${messageId}:text`, text)],
        });
      }
    }
  }
  return messages;
}
