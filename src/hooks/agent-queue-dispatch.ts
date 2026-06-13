import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { SessionMetaMap } from "@/hooks/agent-state-persistence";
import type { Session } from "@/hooks/agent-state-types";

type QueueDispatchAction = {
  type: "CLEAR_AFTER_PART_TRIGGERED";
  payload: { sessionID: string };
};

export function processBusyToIdleTransitions({
  previousBusySessionIds,
  currentBusySessionIds,
  activeSessionId,
  sessions,
  sessionMeta,
  refreshSessionMessages,
}: {
  previousBusySessionIds: Iterable<string>;
  currentBusySessionIds: Set<string>;
  activeSessionId: string | null;
  sessions: Session[];
  sessionMeta: SessionMetaMap;
  refreshSessionMessages: (
    sessionId: string,
    projectTarget?: { directory?: string; workspaceId?: string },
  ) => Promise<unknown>;
}) {
  const newlyIdle: Record<string, true> = {};

  for (const sessionId of previousBusySessionIds) {
    if (currentBusySessionIds.has(sessionId)) continue;
    newlyIdle[sessionId] = true;
    if (sessionId === activeSessionId) {
      const projectTarget = getSessionProjectTarget(
        sessions.find((session) => session.id === sessionId),
        sessionMeta[sessionId],
      );
      void refreshSessionMessages(sessionId, projectTarget ?? undefined).catch(() => {
        /* best-effort final transcript reconcile */
      });
    }
  }

  return newlyIdle;
}

export function processAfterPartQueueTriggers({
  sessionIds,
  abortSession,
  dispatch,
}: {
  sessionIds: Iterable<string>;
  abortSession: (input: { sessionId: string }) => Promise<unknown>;
  dispatch: (action: QueueDispatchAction) => void;
}) {
  for (const sessionId of sessionIds) {
    dispatch({
      type: "CLEAR_AFTER_PART_TRIGGERED",
      payload: { sessionID: sessionId },
    });
    void abortSession({ sessionId });
  }
}
