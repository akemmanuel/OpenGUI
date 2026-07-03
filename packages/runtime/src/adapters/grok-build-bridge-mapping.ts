/**
 * Pure Grok Build harness mapping helpers (testable).
 */
import { makeHarnessSessionIdCodec } from "./harness-adapter-kit.ts";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "./grok-build-models.ts";

const { toFrontendSessionId } = makeHarnessSessionIdCodec("grok-build:");

/** Narrow unknown ACP / IPC values to optional strings (no Object stringification). */
export function asHarnessString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asHarnessStringOr(value: unknown, fallback: string): string {
  return asHarnessString(value) ?? fallback;
}

export function firstLine(text: unknown) {
  const s = typeof text === "string" ? text : "";
  return (
    s
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function makeSessionTitle(text: unknown, fallback = "Untitled") {
  const line = firstLine(text);
  return line.slice(0, 80) || fallback;
}

export function makeTextPart(
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

export function makeReasoningPart(
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

export function defaultUserInfo(
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
    agent: "grok-build",
    model: { providerID: DEFAULT_PROVIDER_ID, modelID: modelId },
  };
}

export function defaultAssistantInfo(
  sessionId: string,
  messageId: string,
  directory: string,
  modelId: string = DEFAULT_MODEL_ID,
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
    mode: "grok-build",
    agent: "grok-build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

export function upsertMessage(
  messages: Array<{ info: { id: string }; parts: unknown[] }>,
  info: { id: string } & Record<string, unknown>,
) {
  const existing = messages.find((entry) => entry.info.id === info.id);
  if (existing) {
    existing.info = { ...existing.info, ...info };
    return existing;
  }
  const bundle = { info, parts: [] as unknown[] };
  messages.push(bundle);
  return bundle;
}

export function getSessionPreview(
  messages: Array<{ info: { role?: string }; parts: Array<{ type?: string; text?: string }> }>,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry) continue;
    if (entry.info.role !== "user") continue;
    for (const part of entry.parts) {
      if (part.type === "text" && part.text) return part.text;
    }
  }
  return "";
}

export { toFrontendSessionId };
