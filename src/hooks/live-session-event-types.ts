import type { LiveSessionEvent, LiveSessionEventType } from "@opengui/runtime/client";

const LIVE_SESSION_EVENT_TYPES = new Set<LiveSessionEventType>([
  "run.started",
  "run.finished",
  "message.started",
  "message.finished",
  "part.started",
  "part.text.appended",
  "part.text.replaced",
  "part.state.changed",
  "tool.started",
  "tool.input.updated",
  "tool.output.appended",
  "tool.output.replaced",
  "tool.finished",
  "transcript.rebased",
  "session.error",
]);

export function isLiveSessionEventType(type: string): type is LiveSessionEventType {
  return LIVE_SESSION_EVENT_TYPES.has(type as LiveSessionEventType);
}

/** Backend SSE envelopes for canonical live session events (not legacy HarnessEvent). */
export function asCanonicalLiveSessionEvent(
  event: Record<string, unknown>,
): LiveSessionEvent | null {
  if (!isLiveSessionEventType(String(event.type))) return null;
  if (event.version !== 1) return null;
  const scope = event.scope;
  if (
    !scope ||
    typeof scope !== "object" ||
    typeof (scope as { directory?: unknown }).directory !== "string" ||
    typeof (scope as { harnessId?: unknown }).harnessId !== "string" ||
    typeof (scope as { sessionId?: unknown }).sessionId !== "string"
  ) {
    return null;
  }
  return event as unknown as LiveSessionEvent;
}
