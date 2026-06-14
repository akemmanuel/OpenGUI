import type { Message, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client";
import { getHarnessIdFromSessionId, type HarnessId } from "@/agents";
import type { HarnessEvent } from "@/agents/backend";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { ConnectionStatus } from "@/types/electron";

type BackendEventDispatch = (
  action:
    | { type: "SET_PROJECT_CONNECTION"; payload: { projectKey: string; status: ConnectionStatus } }
    | { type: "SESSION_CREATED"; payload: Session }
    | {
        type: "SESSION_REPLACED";
        payload: { oldId: string; newId: string; session: Session };
      }
    | { type: "SESSION_UPDATED"; payload: Session }
    | { type: "SESSION_DELETED"; payload: string }
    | {
        type: "MESSAGE_UPDATED";
        payload: Message;
      }
    | {
        type: "MESSAGE_REPLACED";
        payload: {
          sessionID: string;
          oldId: string;
          message: Message;
          parts: Part[];
        };
      }
    | {
        type: "PART_UPDATED";
        payload: { part: Part };
      }
    | {
        type: "PART_DELTA";
        payload: {
          sessionID: string;
          messageID: string;
          partID: string;
          field: string;
          delta: string;
        };
      }
    | {
        type: "PART_REMOVED";
        payload: { sessionID: string; messageID: string; partID: string };
      }
    | { type: "MESSAGE_REMOVED"; payload: { sessionID: string; messageID: string } }
    | {
        type: "SESSION_STATUS";
        payload: {
          sessionID: string;
          status: { type: string };
        };
      }
    | {
        type: "SET_PERMISSION";
        payload: PermissionRequest | { sessionID: string; clear: true };
      }
    | {
        type: "SET_QUESTION";
        payload: QuestionRequest | { sessionID: string; clear: true };
      }
    | { type: "SET_ERROR"; payload: string | null }
    | { type: "SESSION_ERROR"; payload: { sessionID?: string; error: string } },
) => void;

const seenDeltaEventIds = new Set<string>();

interface SessionTitleTrackingState {
  forcedTitles: Map<string, string>;
  pendingTitlePersistence: Map<string, string>;
  sessionIdAliases: Map<string, string>;
  namingRequestIds: Map<string, number>;
}

function enforceTrackedSessionTitle(
  session: Session,
  tracking: SessionTitleTrackingState,
): Session {
  const forcedTitle = tracking.forcedTitles.get(session.id);
  if (!forcedTitle || session.title === forcedTitle) return session;
  return { ...session, title: forcedTitle };
}

function migrateReplacedSessionTracking({
  oldId,
  newId,
  tracking,
}: {
  oldId: string;
  newId: string;
  tracking: SessionTitleTrackingState;
}) {
  const oldForcedTitle = tracking.forcedTitles.get(oldId);
  if (oldForcedTitle) {
    tracking.forcedTitles.delete(oldId);
    tracking.forcedTitles.set(newId, oldForcedTitle);
  }

  tracking.sessionIdAliases.set(oldId, newId);

  const oldRequestId = tracking.namingRequestIds.get(oldId);
  if (oldRequestId !== undefined) {
    tracking.namingRequestIds.set(newId, oldRequestId);
  }

  const oldPendingTitle = tracking.pendingTitlePersistence.get(oldId);
  if (oldPendingTitle) {
    tracking.pendingTitlePersistence.delete(oldId);
    tracking.pendingTitlePersistence.set(newId, oldPendingTitle);
  }

  return {
    titleToPersist: oldPendingTitle ?? oldForcedTitle,
  };
}

export function handleHarnessEvent({
  event,
  expectedProjectKeys,
  tracking,
  cleanupSessionRefs,
  renameSession,
  dispatch,
  warn = console.warn,
}: {
  event: HarnessEvent;
  expectedProjectKeys: Set<string>;
  tracking: SessionTitleTrackingState;
  cleanupSessionRefs: (sessionIds?: Iterable<string>) => void;
  renameSession: (input: {
    sessionId: string;
    title: string;
    harnessId?: HarnessId;
  }) => Promise<unknown>;
  dispatch: BackendEventDispatch;
  warn?: (message: string, details?: unknown) => void;
}) {
  if ("directory" in event) {
    const projectKey = makeProjectKey(event.workspaceId, event.directory);
    if (!expectedProjectKeys.has(projectKey)) {
      return;
    }
    if (event.type === "connection.status") {
      dispatch({
        type: "SET_PROJECT_CONNECTION",
        payload: { projectKey, status: event.status },
      });
      return;
    }
  }

  switch (event.type) {
    case "session.created":
      dispatch({
        type: "SESSION_CREATED",
        payload: enforceTrackedSessionTitle(event.session as Session, tracking),
      });
      return;
    case "session.replaced": {
      const { titleToPersist } = migrateReplacedSessionTracking({
        oldId: event.oldId,
        newId: event.newId,
        tracking,
      });
      if (titleToPersist) {
        const harnessId = getHarnessIdFromSessionId(event.newId) ?? undefined;
        void renameSession({
          sessionId: event.newId,
          title: titleToPersist,
          harnessId,
        })
          .then(() => {
            tracking.pendingTitlePersistence.delete(event.newId);
          })
          .catch((error) => {
            tracking.pendingTitlePersistence.set(event.newId, titleToPersist);
            warn("[session-title] failed to persist after session replacement", {
              sessionId: event.newId,
              error,
            });
          });
      }
      dispatch({
        type: "SESSION_REPLACED",
        payload: {
          oldId: event.oldId,
          newId: event.newId,
          session: enforceTrackedSessionTitle(event.session as Session, tracking),
        },
      });
      return;
    }
    case "session.updated":
      dispatch({
        type: "SESSION_UPDATED",
        payload: enforceTrackedSessionTitle(event.session as Session, tracking),
      });
      return;
    case "session.deleted":
      cleanupSessionRefs([event.sessionId]);
      dispatch({ type: "SESSION_DELETED", payload: event.sessionId });
      return;
    case "message.updated":
      dispatch({ type: "MESSAGE_UPDATED", payload: event.message });
      return;
    case "message.replaced":
      dispatch({
        type: "MESSAGE_REPLACED",
        payload: {
          sessionID: event.sessionID,
          oldId: event.oldId,
          message: event.message,
          parts: event.parts,
        },
      });
      return;
    case "message.part.updated":
      dispatch({ type: "PART_UPDATED", payload: { part: event.part } });
      return;
    case "message.part.delta": {
      const eventId = (event as { id?: string }).id;
      if (eventId) {
        if (seenDeltaEventIds.has(eventId)) return;
        seenDeltaEventIds.add(eventId);
        if (seenDeltaEventIds.size > 1000) seenDeltaEventIds.clear();
      }
      dispatch({
        type: "PART_DELTA",
        payload: {
          sessionID: event.sessionID,
          messageID: event.messageID,
          partID: event.partID,
          field: event.field,
          delta: event.delta,
        },
      });
      return;
    }
    case "message.part.removed":
      dispatch({
        type: "PART_REMOVED",
        payload: {
          sessionID: event.sessionID,
          messageID: event.messageID,
          partID: event.partID,
        },
      });
      return;
    case "message.removed":
      dispatch({
        type: "MESSAGE_REMOVED",
        payload: {
          sessionID: event.sessionID,
          messageID: event.messageID,
        },
      });
      return;
    case "session.status":
      dispatch({
        type: "SESSION_STATUS",
        payload: {
          sessionID: event.sessionID,
          status: event.status,
        },
      });
      return;
    case "permission.requested":
      dispatch({ type: "SET_PERMISSION", payload: event.request });
      return;
    case "permission.cleared":
      dispatch({
        type: "SET_PERMISSION",
        payload: { sessionID: event.sessionID, clear: true },
      });
      return;
    case "question.requested":
      dispatch({ type: "SET_QUESTION", payload: event.request });
      return;
    case "question.cleared":
      dispatch({
        type: "SET_QUESTION",
        payload: { sessionID: event.sessionID, clear: true },
      });
      return;
    case "session.error":
      dispatch({
        type: "SESSION_ERROR",
        payload: { sessionID: event.sessionID, error: event.error },
      });
      return;
  }
}
