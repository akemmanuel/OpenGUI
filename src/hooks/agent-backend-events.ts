import type { PermissionRequest, QuestionRequest } from "@/protocol/harness-types";

import { getHarnessIdFromSessionId, type HarnessId } from "@/agents";
import type { HarnessEvent } from "@/agents/backend";
import { makeProjectKey, parseProjectKey } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { ConnectionStatus } from "@/types/electron";
import type { ProjectedTranscriptEvent } from "@opengui/runtime/client";
import { normalizeProjectPath } from "@/lib/utils";
import { dispatchLiveSessionActivity } from "@/features/session-transcript/live-session-activity";
import { asCanonicalLiveSessionEvent } from "@/hooks/live-session-event-types";

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

function isProjectedTranscriptEvent(
  event: HarnessEvent,
): event is HarnessEvent & ProjectedTranscriptEvent {
  return (
    event.type === "transcript.snapshot" ||
    event.type === "transcript.message" ||
    event.type === "transcript.message.removed"
  );
}

function isExpectedProjectEvent({
  directory,
  workspaceId,
  expectedProjectKeys,
}: {
  directory: string;
  workspaceId?: string;
  expectedProjectKeys: Set<string>;
}): boolean {
  if (workspaceId && expectedProjectKeys.has(makeProjectKey(workspaceId, directory))) return true;
  if (workspaceId) return false;

  // Canonical backend envelopes do not always know the Frontend workspace id.
  // In that case, accept the event only if some expected project has the same
  // canonical directory; never let directory-less transcript events bypass the
  // project/worktree scope gate.
  const normalizedDirectory = normalizeProjectPath(directory);
  return [...expectedProjectKeys].some(
    (projectKey) =>
      normalizeProjectPath(parseProjectKey(projectKey).directory) === normalizedDirectory,
  );
}

export function handleHarnessEvent({
  event,
  expectedProjectKeys,
  tracking,
  cleanupSessionRefs,
  renameSession,
  dispatch,
  ingestProjectedTranscriptEvent,
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
  ingestProjectedTranscriptEvent?: (event: ProjectedTranscriptEvent) => boolean;
  warn?: (message: string, details?: unknown) => void;
}) {
  const liveEvent = asCanonicalLiveSessionEvent(event as Record<string, unknown>);
  if (liveEvent) {
    dispatchLiveSessionActivity({
      event: liveEvent,
      expectedProjectKeys,
      dispatch,
    });
    return;
  }

  if ("directory" in event) {
    if (
      !isExpectedProjectEvent({
        directory: event.directory,
        workspaceId: event.workspaceId,
        expectedProjectKeys,
      })
    ) {
      return;
    }
    if (event.type === "connection.status") {
      const projectKey = makeProjectKey(event.workspaceId, event.directory);
      dispatch({
        type: "SET_PROJECT_CONNECTION",
        payload: { projectKey, status: event.status },
      });
      return;
    }
  }

  if (isProjectedTranscriptEvent(event)) {
    if (
      !isExpectedProjectEvent({
        directory: event.scope.directory,
        expectedProjectKeys,
      })
    ) {
      return;
    }
    ingestProjectedTranscriptEvent?.(event);
    return;
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
    case "session.status":
      // Run lifecycle is driven by canonical run.started / run.finished when scoped live events arrive.
      if (event.status?.type === "retry") {
        dispatch({
          type: "SESSION_STATUS",
          payload: {
            sessionID: event.sessionID,
            status: event.status,
          },
        });
      }
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
    default:
      return;
  }
}
