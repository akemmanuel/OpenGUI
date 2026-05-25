import type { PromptDispatchDecision } from "@/hooks/agent-prompt-routing";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { QueuedPrompt } from "@/lib/session-drafts";
import type { SelectedModel } from "@/types/electron";

type QueueDispatchAction =
  | { type: "QUEUE_ADD"; payload: { sessionID: string; prompt: QueuedPrompt } }
  | {
      type: "QUEUE_REORDER";
      payload: { sessionID: string; fromIndex: number; toIndex: number };
    }
  | { type: "QUEUE_SHIFT"; payload: { sessionID: string } }
  | { type: "QUEUE_REMOVE"; payload: { sessionID: string; promptID: string } }
  | {
      type: "SET_AFTER_PART_PENDING";
      payload: { sessionID: string; pending: boolean };
    }
  | {
      type: "CLEAR_AFTER_PART_TRIGGERED";
      payload: { sessionID: string };
    };

type DispatchPromptDirect = (
  sessionId: string,
  text: string,
  images?: string[],
  model?: SelectedModel,
  agent?: string,
  variant?: string,
) => Promise<void>;

export async function applyQueueDispatchDecision({
  sessionId,
  decision,
  existingQueueLength,
  abortSession,
  dispatch,
}: {
  sessionId: string;
  decision: PromptDispatchDecision;
  existingQueueLength: number;
  abortSession: (input: { sessionId: string }) => Promise<unknown>;
  dispatch: (action: QueueDispatchAction) => void;
}) {
  if (decision.type !== "queue") return false;

  dispatch({
    type: "QUEUE_ADD",
    payload: { sessionID: sessionId, prompt: decision.prompt },
  });

  if (decision.insertAt === "front" && existingQueueLength > 0) {
    dispatch({
      type: "QUEUE_REORDER",
      payload: {
        sessionID: sessionId,
        fromIndex: existingQueueLength,
        toIndex: 0,
      },
    });
  }

  if (decision.shouldAbort) {
    await abortSession({ sessionId });
  } else if (decision.shouldSetAfterPartPending) {
    dispatch({
      type: "SET_AFTER_PART_PENDING",
      payload: { sessionID: sessionId, pending: true },
    });
  }

  return true;
}

export async function dispatchNextQueuedPrompt({
  sessionId,
  queue,
  dispatchingSessionIds,
  preparePromptText,
  dispatchPromptDirect,
  dispatch,
}: {
  sessionId: string;
  queue: QueuedPrompt[] | undefined;
  dispatchingSessionIds: Set<string>;
  preparePromptText: (sessionId: string, text: string) => string;
  dispatchPromptDirect: DispatchPromptDirect;
  dispatch: (action: QueueDispatchAction) => void;
}) {
  if (dispatchingSessionIds.has(sessionId)) return;
  if (!queue || queue.length === 0) return;

  dispatchingSessionIds.add(sessionId);
  try {
    const next = queue[0];
    if (!next) return;
    dispatch({ type: "QUEUE_SHIFT", payload: { sessionID: sessionId } });
    await dispatchPromptDirect(
      sessionId,
      preparePromptText(sessionId, next.text),
      next.images,
      next.model,
      next.agent,
      next.variant,
    );
  } finally {
    dispatchingSessionIds.delete(sessionId);
  }
}

export function processBusyToIdleTransitions({
  previousBusySessionIds,
  currentBusySessionIds,
  activeSessionId,
  sessions,
  dispatchNextQueued,
  refreshSessionMessages,
}: {
  previousBusySessionIds: Iterable<string>;
  currentBusySessionIds: Set<string>;
  activeSessionId: string | null;
  sessions: Session[];
  dispatchNextQueued: (sessionId: string) => Promise<void>;
  refreshSessionMessages: (
    sessionId: string,
    projectTarget?: { directory?: string; workspaceId?: string },
  ) => Promise<unknown>;
}) {
  const newlyIdle: Record<string, true> = {};

  for (const sessionId of previousBusySessionIds) {
    if (currentBusySessionIds.has(sessionId)) continue;
    newlyIdle[sessionId] = true;
    void dispatchNextQueued(sessionId);
    if (sessionId === activeSessionId) {
      const projectTarget = getSessionProjectTarget(
        sessions.find((session) => session.id === sessionId),
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

export async function sendQueuedPromptNow({
  sessionId,
  promptId,
  queue,
  isBusy,
  abortSession,
  dispatchPromptDirect,
  dispatch,
}: {
  sessionId: string;
  promptId: string;
  queue: QueuedPrompt[];
  isBusy: boolean;
  abortSession: (input: { sessionId: string }) => Promise<unknown>;
  dispatchPromptDirect: DispatchPromptDirect;
  dispatch: (action: QueueDispatchAction) => void;
}) {
  if (queue.length === 0) return;

  const index = queue.findIndex((item) => item.id === promptId);
  if (index === -1) return;
  const target = queue[index];
  if (!target) return;

  if (isBusy) {
    if (index > 0) {
      dispatch({
        type: "QUEUE_REORDER",
        payload: { sessionID: sessionId, fromIndex: index, toIndex: 0 },
      });
    }
    await abortSession({ sessionId });
    return;
  }

  dispatch({
    type: "QUEUE_REMOVE",
    payload: { sessionID: sessionId, promptID: promptId },
  });

  await dispatchPromptDirect(
    sessionId,
    target.text,
    target.images,
    target.model,
    target.agent,
    target.variant,
  );
}
