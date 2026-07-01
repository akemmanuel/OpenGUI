import type { QueuedPrompt } from "@/hooks/agent-state-types";

/** Frontend mirror of backend-owned Queued prompts plus after-part steering flags. */
export interface QueuePresentationSlice {
  queuedPrompts: Record<string, QueuedPrompt[]>;
  afterPartPending: Set<string>;
  _afterPartTriggered: Set<string>;
}

export type QueuePresentationAction =
  | { type: "SET_SESSION_QUEUE"; payload: { sessionID: string; prompts: QueuedPrompt[] } }
  | { type: "QUEUE_CLEAR"; payload: { sessionID: string } }
  | {
      type: "SET_AFTER_PART_PENDING";
      payload: { sessionID: string; pending: boolean };
    }
  | {
      type: "CLEAR_AFTER_PART_TRIGGERED";
      payload: { sessionID: string };
    };

export function renameSessionIdInQueueSlice(
  slice: QueuePresentationSlice,
  oldId: string,
  newId: string,
): QueuePresentationSlice {
  const rename = (id: string) => (id === oldId ? newId : id);

  const nextQueued: Record<string, QueuedPrompt[]> = {};
  for (const [sid, q] of Object.entries(slice.queuedPrompts)) {
    nextQueued[rename(sid)] = q;
  }

  return {
    queuedPrompts: nextQueued,
    afterPartPending: new Set([...slice.afterPartPending].map(rename)),
    _afterPartTriggered: new Set([...slice._afterPartTriggered].map(rename)),
  };
}

export function removeSessionFromQueueSlice(
  slice: QueuePresentationSlice,
  sessionId: string,
): QueuePresentationSlice {
  const { [sessionId]: _deletedQueue, ...remainingQueues } = slice.queuedPrompts;
  return {
    ...slice,
    queuedPrompts: remainingQueues,
  };
}

export function reduceQueuePresentation(
  slice: QueuePresentationSlice,
  action: QueuePresentationAction,
): QueuePresentationSlice {
  switch (action.type) {
    case "SET_SESSION_QUEUE": {
      const { sessionID, prompts } = action.payload;
      if (prompts.length === 0) {
        const { [sessionID]: _, ...rest } = slice.queuedPrompts;
        return { ...slice, queuedPrompts: rest };
      }
      return {
        ...slice,
        queuedPrompts: {
          ...slice.queuedPrompts,
          [sessionID]: prompts,
        },
      };
    }

    case "QUEUE_CLEAR": {
      const { sessionID } = action.payload;
      const { [sessionID]: _, ...rest } = slice.queuedPrompts;
      return { ...slice, queuedPrompts: rest };
    }

    case "SET_AFTER_PART_PENDING": {
      const { sessionID, pending } = action.payload;
      const next = new Set(slice.afterPartPending);
      if (pending) {
        next.add(sessionID);
      } else {
        next.delete(sessionID);
      }
      return { ...slice, afterPartPending: next };
    }

    case "CLEAR_AFTER_PART_TRIGGERED": {
      const { sessionID } = action.payload;
      const next = new Set(slice._afterPartTriggered);
      next.delete(sessionID);
      return { ...slice, _afterPartTriggered: next };
    }

    default:
      return slice;
  }
}

export function isQueuePresentationAction(action: {
  type: string;
}): action is QueuePresentationAction {
  switch (action.type) {
    case "SET_SESSION_QUEUE":
    case "QUEUE_CLEAR":
    case "SET_AFTER_PART_PENDING":
    case "CLEAR_AFTER_PART_TRIGGERED":
      return true;
    default:
      return false;
  }
}

export function pickQueuePresentationSlice(state: {
  queuedPrompts: QueuePresentationSlice["queuedPrompts"];
  afterPartPending: QueuePresentationSlice["afterPartPending"];
  _afterPartTriggered: QueuePresentationSlice["_afterPartTriggered"];
}): QueuePresentationSlice {
  return {
    queuedPrompts: state.queuedPrompts,
    afterPartPending: state.afterPartPending,
    _afterPartTriggered: state._afterPartTriggered,
  };
}

export function mergeQueuePresentationSlice<T extends QueuePresentationSlice>(
  state: T,
  slice: QueuePresentationSlice,
): T {
  return {
    ...state,
    queuedPrompts: slice.queuedPrompts,
    afterPartPending: slice.afterPartPending,
    _afterPartTriggered: slice._afterPartTriggered,
  };
}
