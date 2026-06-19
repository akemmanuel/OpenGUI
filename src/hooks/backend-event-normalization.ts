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
  if (
    event.type !== "session.created" &&
    event.type !== "session.updated" &&
    event.type !== "session.deleted"
  ) {
    return false;
  }

  const session = event.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return false;
  const record = session as Record<string, unknown>;

  // Backend SessionDispatchIndex events carry SessionRecord shape. They are a
  // queue/control cache notification, not a Harness session-list event. Let the
  // raw Harness lifecycle event update the sidebar; accepting this record here
  // replaces rich Frontend Session fields (_projectDir/_workspaceId/time) with a
  // backend record and makes active sessions/worktrees disappear from the UI.
  return (
    typeof record.rawId === "string" &&
    typeof record.directory === "string" &&
    typeof record.harnessId === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
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
  directory?: string;
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
    ...(message.directory ? { directory: message.directory } : {}),
    ...(useEnvelopeSessionId ? { sessionId: message.sessionId } : {}),
    ...(message.harnessId ? { harnessId: message.harnessId } : {}),
  };
}
