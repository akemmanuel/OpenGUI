/**
 * Pi native session event handlers (extracted from PiBridgeManager.handleSessionEvent).
 * Keeps the bridge class as wiring; tool/assistant logic stays testable in isolation.
 */

import {
  coerceTimestamp,
  createAssistantInfo,
  createBundle,
  makeStreamingMessageId,
  makeToolPartId,
  normalizeToolInput,
  stringifyUnknown,
  syncAssistantParts,
} from "./pi-bridge-mapping.ts";
import { findCurrentAssistantBundleInCache } from "./pi-bridge-live-resolution.ts";

export type PiSessionEventBridgeContext = {
  upsertBundle(project: unknown, sessionId: string, bundle: unknown): void;
  sendBackendEvent(project: unknown, payload: unknown): void;
  findBundle(project: unknown, sessionId: string, messageId: string): unknown;
  findCurrentAssistantBundle(
    project: unknown,
    sessionId: string,
    state: unknown,
  ): { messageId: string; bundle: { parts: unknown[]; info: unknown } } | null;
  flushPendingAssistantResolution(project: unknown, session: unknown): void;
  findLatestRealMessageId(sessionManager: unknown, role: string): string | null;
  markReasoningStart(state: unknown, contentIndex: number, eventAt: number): void;
  markReasoningEnd(state: unknown, contentIndex: number, eventAt: number): void;
  closeOpenReasoning(state: unknown, eventAt: number): void;
};

export function handlePiAssistantMessageStart(
  ctx: PiSessionEventBridgeContext,
  project: unknown,
  session: { sessionId: string; sessionManager: unknown },
  event: { message: { role: string; timestamp?: unknown } },
  state: {
    nextSeq: number;
    currentAssistantMessageId?: string | null;
    assistantStartedAt?: number | null;
    reasoningTimesByContentIndex: Map<number, { start: number; end?: number }>;
    pendingAssistantResolutions?: { syntheticId: string; startedAt?: number }[];
  },
  directory: string,
): void {
  if (event.message.role !== "assistant") return;
  ctx.flushPendingAssistantResolution(project, session);
  const sessionId = session.sessionId;
  const messageId = makeStreamingMessageId(sessionId, state.nextSeq++);
  const startedAt = Date.now();
  const parentID = ctx.findLatestRealMessageId(session.sessionManager, "user") || "";
  state.currentAssistantMessageId = messageId;
  state.assistantStartedAt = startedAt;
  state.reasoningTimesByContentIndex = new Map();
  state.pendingAssistantResolutions = [
    ...(state.pendingAssistantResolutions || []),
    { syntheticId: messageId, startedAt },
  ];
  const bundle = createBundle(
    createAssistantInfo({
      sessionId,
      messageId,
      timestamp: coerceTimestamp(event.message.timestamp),
      message: event.message,
      directory,
      parentID,
      createdAt: startedAt,
    }),
    [],
  );
  syncAssistantParts(bundle, event.message, state.reasoningTimesByContentIndex);
  ctx.upsertBundle(project, sessionId, bundle);
  ctx.sendBackendEvent(project, { type: "message.updated", message: bundle.info });
  for (const part of bundle.parts) {
    ctx.sendBackendEvent(project, { type: "message.part.updated", part });
  }
}

export function handlePiToolExecutionStart(
  ctx: PiSessionEventBridgeContext,
  project: unknown,
  sessionId: string,
  state: unknown,
  event: { toolCallId: string; toolName: string; args?: Record<string, unknown> },
): void {
  const assistantContext = ctx.findCurrentAssistantBundle(project, sessionId, state);
  if (!assistantContext) return;
  const { messageId, bundle } = assistantContext;
  const normalizedInput = normalizeToolInput(event.args || {});
  const parts = bundle.parts as Array<{
    type: string;
    callID?: string;
    id?: string;
    state?: unknown;
  }>;
  let part = parts.find((item) => item.type === "tool" && item.callID === event.toolCallId);
  if (!part) {
    part = {
      id: makeToolPartId(messageId, event.toolCallId, parts.length),
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
    } as (typeof parts)[number];
    parts.push(part);
  }
  part.state = {
    status: "running",
    input: normalizedInput,
    title: event.toolName,
    time: { start: Date.now() },
  };
  ctx.upsertBundle(project, sessionId, bundle);
  ctx.sendBackendEvent(project, { type: "message.part.updated", part });
}

/** Resolve assistant bundle for tool routing (re-export for tests). */
export function resolvePiToolAssistantBundle(
  project: { sessionCaches: Map<string, { messages: unknown[] }> },
  sessionId: string,
  state: Parameters<typeof findCurrentAssistantBundleInCache>[2],
) {
  return findCurrentAssistantBundleInCache(project, sessionId, state);
}
