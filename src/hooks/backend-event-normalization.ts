import type { AgentBackendEvent } from "@/agents/backend";
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

export function toAgentBackendEvent(event: BackendEventEnvelope): AgentBackendEvent {
  return event as AgentBackendEvent;
}
