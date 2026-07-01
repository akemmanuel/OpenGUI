import type { HarnessId } from "../../../src/agents/index.ts";
import {
  composeFrontendSessionId,
  parseFrontendSessionId,
} from "../../../src/lib/session-identity.ts";
import type { LiveSessionEvent } from "./live-session-events/live-session-event.ts";

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

export type AgentStreamHandler = (event: AgentStreamEvent) => void;

export function liveSessionEventToAgentStreamEvents(event: LiveSessionEvent): AgentStreamEvent[] {
  const sessionId = normalizeStreamSessionId(event.scope.harnessId, event.scope.sessionId);
  switch (event.type) {
    case "run.started":
      return [{ type: "run.start", sessionId }];
    case "run.finished":
      return [{ type: "run.end", sessionId, reason: event.reason }];
    case "part.text.appended":
      return [
        {
          type: event.partKind === "thinking" ? "thinking.delta" : "text.delta",
          sessionId,
          messageId: event.messageId ?? "",
          partId: event.partId ?? "",
          delta: event.text,
        },
      ];
    case "tool.started":
      return [
        {
          type: "tool.start",
          sessionId,
          messageId: event.messageId ?? "",
          partId: event.partId ?? "",
          tool: event.tool,
        },
      ];
    case "tool.finished":
      return [
        {
          type: "tool.end",
          sessionId,
          messageId: event.messageId ?? "",
          partId: event.partId ?? "",
          status: event.status,
        },
      ];
    case "session.error":
      return [{ type: "error", sessionId, message: event.message }];
    default:
      return [];
  }
}

export function filterStreamEventsForSession(
  events: AgentStreamEvent[],
  handleSessionId: string,
  harnessId: HarnessId,
): AgentStreamEvent[] {
  return events.filter((item) =>
    streamEventMatchesSession(handleSessionId, item.sessionId, harnessId),
  );
}
