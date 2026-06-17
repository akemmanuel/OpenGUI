import type { HarnessEvent } from "../../../src/agents/backend.ts";
import type { HarnessId } from "../../../src/agents/index.ts";
import {
  composeFrontendSessionId,
  parseFrontendSessionId,
} from "../../../src/lib/session-identity.ts";

/** Small streaming union for SDK embedders (ADR 0007); not full HarnessEvent. */
export type AgentStreamEvent =
  | { type: "run.start"; sessionId: string }
  | { type: "run.end"; sessionId: string; reason?: "idle" | "error" }
  | { type: "text.delta"; sessionId: string; messageId: string; partId: string; delta: string }
  | { type: "thinking.delta"; sessionId: string; messageId: string; partId: string; delta: string }
  | { type: "tool.start"; sessionId: string; messageId: string; partId: string; tool: string }
  | {
      type: "tool.end";
      sessionId: string;
      messageId: string;
      partId: string;
      status: string;
    }
  | { type: "error"; sessionId: string; message: string };

export interface MapHarnessEventContext {
  harnessId: HarnessId;
}

/** Normalize harness wire session id to the SDK session id form (`harness:raw`). */
export function normalizeStreamSessionId(harnessId: HarnessId, wireSessionId: string): string {
  const parsed = parseFrontendSessionId(wireSessionId);
  if (parsed) return composeFrontendSessionId(parsed.harnessId, parsed.rawId);
  return composeFrontendSessionId(harnessId, wireSessionId);
}

/** True when `eventSessionId` refers to the same session as `handleSessionId`. */
export function streamEventMatchesSession(
  handleSessionId: string,
  eventSessionId: string,
  harnessId: HarnessId,
): boolean {
  const handleParsed = parseFrontendSessionId(handleSessionId);
  const eventParsed = parseFrontendSessionId(eventSessionId);
  const handleRaw = handleParsed?.rawId ?? handleSessionId;
  const eventRaw = eventParsed?.rawId ?? eventSessionId;
  if (handleRaw === eventRaw) {
    if (handleParsed && eventParsed) {
      return handleParsed.harnessId === eventParsed.harnessId;
    }
    return true;
  }
  const normalizedEvent = normalizeStreamSessionId(harnessId, eventSessionId);
  return normalizedEvent === handleSessionId || eventSessionId === handleSessionId;
}

function mapSessionStatus(
  harnessId: HarnessId,
  sessionID: string,
  statusType: string | undefined,
): AgentStreamEvent[] {
  const sessionId = normalizeStreamSessionId(harnessId, sessionID);
  if (statusType === "busy" || statusType === "running") {
    return [{ type: "run.start", sessionId }];
  }
  if (statusType === "idle") {
    return [{ type: "run.end", sessionId, reason: "idle" }];
  }
  if (statusType === "error") {
    return [{ type: "run.end", sessionId, reason: "error" }];
  }
  return [];
}

function mapPartDelta(
  harnessId: HarnessId,
  event: Extract<HarnessEvent, { type: "message.part.delta" }>,
): AgentStreamEvent[] {
  const sessionId = normalizeStreamSessionId(harnessId, event.sessionID);
  const base = {
    sessionId,
    messageId: event.messageID,
    partId: event.partID,
    delta: event.delta,
  };
  const field = event.field?.toLowerCase() ?? "text";
  if (field.includes("reason") || field === "thinking") {
    return [{ type: "thinking.delta", ...base }];
  }
  return [{ type: "text.delta", ...base }];
}

function mapPartUpdated(
  harnessId: HarnessId,
  part: {
    sessionID: string;
    messageID: string;
    id: string;
    type: string;
    tool?: string;
    state?: { status?: string };
  },
): AgentStreamEvent[] {
  const sessionId = normalizeStreamSessionId(harnessId, part.sessionID);
  if (part.type === "tool") {
    const status = part.state?.status ?? "";
    const tool = typeof part.tool === "string" ? part.tool : "tool";
    if (status === "running" || status === "pending") {
      return [
        {
          type: "tool.start",
          sessionId,
          messageId: part.messageID,
          partId: part.id,
          tool,
        },
      ];
    }
    if (status === "completed" || status === "error" || status === "failed") {
      return [
        {
          type: "tool.end",
          sessionId,
          messageId: part.messageID,
          partId: part.id,
          status,
        },
      ];
    }
  }
  return [];
}

/**
 * Map one canonical HarnessEvent to zero or more AgentStreamEvents.
 * Harnesses that only emit full `message.part.updated` (e.g. Pi) may produce fewer deltas;
 * Codex/Claude may emit `message.part.delta` for text/reasoning.
 */
export function harnessEventToAgentStreamEvents(
  event: HarnessEvent,
  context: MapHarnessEventContext,
): AgentStreamEvent[] {
  const { harnessId } = context;
  switch (event.type) {
    case "session.status":
      if (!event.sessionID) return [];
      return mapSessionStatus(harnessId, event.sessionID, event.status?.type);
    case "session.error": {
      const wire = event.sessionID;
      if (!wire) return [];
      return [
        {
          type: "error",
          sessionId: normalizeStreamSessionId(harnessId, wire),
          message: event.error,
        },
        {
          type: "run.end",
          sessionId: normalizeStreamSessionId(harnessId, wire),
          reason: "error",
        },
      ];
    }
    case "message.part.delta":
      return mapPartDelta(harnessId, event);
    case "message.part.updated":
      return mapPartUpdated(harnessId, event.part);
    default:
      return [];
  }
}

export type AgentStreamHandler = (event: AgentStreamEvent) => void;

export function filterStreamEventsForSession(
  events: AgentStreamEvent[],
  handleSessionId: string,
  harnessId: HarnessId,
): AgentStreamEvent[] {
  return events.filter((item) =>
    streamEventMatchesSession(handleSessionId, item.sessionId, harnessId),
  );
}
