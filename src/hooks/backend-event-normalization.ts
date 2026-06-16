import type { HarnessEvent } from "@/agents/backend";
import type { QueuedPrompt } from "@/lib/session-drafts";

export type BackendEventEnvelope = { type: string } & Record<string, unknown>;

export interface QueueEvent extends BackendEventEnvelope {
  sessionId: string;
  entries?: QueuedPrompt[];
}

export function isQueueEvent(event: BackendEventEnvelope): event is QueueEvent {
  return event.type.startsWith("queue.") && typeof event.sessionId === "string";
}

export function isCanonicalSessionNotification(event: BackendEventEnvelope): boolean {
  return (
    (event.type === "session.created" ||
      event.type === "session.updated" ||
      event.type === "session.deleted") &&
    typeof event.projectId === "string" &&
    typeof event.harnessId === "string" &&
    !("directory" in event)
  );
}

export function toHarnessEvent(event: BackendEventEnvelope): HarnessEvent {
  return event as HarnessEvent;
}

/** Canonical SSE envelope refs use backend session index ids; queue payloads use frontend session ids. */
export function mergeCanonicalEventForListener(message: {
  id: string;
  type: string;
  projectId?: string;
  sessionId?: string;
  harnessId?: string;
  payload: unknown;
}): Record<string, unknown> | null {
  if (!message.payload || typeof message.payload !== "object") return null;
  const useEnvelopeSessionId = Boolean(message.sessionId) && !message.type.startsWith("queue.");
  return {
    id: message.id,
    type: message.type,
    ...(message.payload as object),
    ...(message.projectId ? { projectId: message.projectId } : {}),
    ...(useEnvelopeSessionId ? { sessionId: message.sessionId } : {}),
    ...(message.harnessId ? { harnessId: message.harnessId } : {}),
  };
}
