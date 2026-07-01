import type { LiveSessionEvent } from "@opengui/runtime/client";
import { isExpectedProjectedTranscriptScope } from "@/hooks/projected-transcript-events";

export type LiveSessionActivityDispatch = (
  action:
    | {
        type: "SESSION_STATUS";
        payload: { sessionID: string; status: { type: string } };
      }
    | {
        type: "SESSION_ERROR";
        payload: { sessionID?: string; error: string };
      },
) => void;

/** Busy/idle/error only — no transcript buffers (active transcript store owns message content). */
export function dispatchLiveSessionActivity(input: {
  event: LiveSessionEvent;
  expectedProjectKeys: Set<string>;
  dispatch: LiveSessionActivityDispatch;
}): boolean {
  const { event, expectedProjectKeys, dispatch } = input;
  if (!isExpectedProjectedTranscriptScope(event.scope, expectedProjectKeys)) return false;

  const sessionID = event.scope.sessionId;

  switch (event.type) {
    case "run.started":
      dispatch({
        type: "SESSION_STATUS",
        payload: { sessionID, status: { type: "busy" } },
      });
      return true;
    case "run.finished":
      dispatch({
        type: "SESSION_STATUS",
        payload: {
          sessionID,
          status: { type: event.reason === "error" ? "error" : "idle" },
        },
      });
      return true;
    case "session.error":
      dispatch({
        type: "SESSION_ERROR",
        payload: { sessionID, error: event.message },
      });
      return true;
    default:
      return true;
  }
}
