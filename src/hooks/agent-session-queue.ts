import type { AgentBackendId } from "@/agents";
import type { AgentBackendTarget } from "@/agents/backend";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { InternalAgentState, QueuedPrompt, Session } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";

interface QueueLookup {
  backendId?: AgentBackendId;
  target?: AgentBackendTarget;
}

interface SessionQueueOptions {
  getState: () => Pick<InternalAgentState, "sessions" | "queuedPrompts" | "busySessionIds">;
  sessionsClient: OpenGuiClient["sessions"];
  dispatch: (action: unknown) => void;
  dispatchingSessionIds: Set<string>;
}

export interface SessionQueueOrchestrator {
  enqueuePrompt(
    this: void,
    input: {
      sessionId: string;
      text: string;
      images?: string[];
      model?: QueuedPrompt["model"];
      agent?: string;
      variant?: string;
      mode: QueuedPrompt["mode"];
      insertAt: "back" | "front";
    },
  ): Promise<QueuedPrompt[]>;
  dispatchNext(this: void, sessionId: string): Promise<void>;
  sendNow(this: void, sessionId: string, promptId: string): Promise<void>;
  abort(this: void, sessionId: string): Promise<void>;
}

function getSessionLookup(session: Session | undefined): QueueLookup {
  return {
    backendId: resolveSessionHarnessRoute(session).harnessId ?? undefined,
    target: getSessionProjectTarget(session) ?? undefined,
  };
}

export function createSessionQueueOrchestrator(
  options: SessionQueueOptions,
): SessionQueueOrchestrator {
  const { getState, sessionsClient, dispatch, dispatchingSessionIds } = options;

  const lookup = (sessionId: string) =>
    getSessionLookup(getState().sessions.find((session) => session.id === sessionId));

  const setSnapshot = (sessionId: string, prompts: QueuedPrompt[]) => {
    dispatch({ type: "SET_SESSION_QUEUE", payload: { sessionID: sessionId, prompts } });
  };

  const enqueuePrompt: SessionQueueOrchestrator["enqueuePrompt"] = async (input) => {
    let prompts = await sessionsClient.queue.enqueue({
      sessionId: input.sessionId,
      text: input.text,
      images: input.images,
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      mode: input.mode,
      ...lookup(input.sessionId),
    });

    if (input.insertAt === "front" && prompts.length > 1) {
      const createdEntryId = prompts.at(-1)?.id;
      if (createdEntryId) {
        prompts = await sessionsClient.queue.reorder({
          sessionId: input.sessionId,
          entryId: createdEntryId,
          index: 0,
          ...lookup(input.sessionId),
        });
      }
    }

    setSnapshot(input.sessionId, prompts);
    return prompts;
  };

  const dispatchNext = async (sessionId: string) => {
    if (dispatchingSessionIds.has(sessionId)) return;
    const queue = getState().queuedPrompts[sessionId];
    if (!queue || queue.length === 0) return;

    dispatchingSessionIds.add(sessionId);
    try {
      const prompts = await sessionsClient.queue.dispatchNext({ sessionId, ...lookup(sessionId) });
      setSnapshot(sessionId, prompts);
    } finally {
      dispatchingSessionIds.delete(sessionId);
    }
  };

  const abort = async (sessionId: string) => {
    await sessionsClient.abort({ sessionId, ...lookup(sessionId) });
  };

  const sendNow = async (sessionId: string, promptId: string) => {
    const queue = getState().queuedPrompts[sessionId] ?? [];
    if (queue.length === 0) return;
    const index = queue.findIndex((item) => item.id === promptId);
    if (index === -1) return;

    if (getState().busySessionIds.has(sessionId)) {
      if (index > 0) {
        const prompts = await sessionsClient.queue.reorder({
          sessionId,
          entryId: promptId,
          index: 0,
          ...lookup(sessionId),
        });
        setSnapshot(sessionId, prompts);
      }
      await abort(sessionId);
      return;
    }

    if (index > 0) {
      const prompts = await sessionsClient.queue.reorder({
        sessionId,
        entryId: promptId,
        index: 0,
        ...lookup(sessionId),
      });
      setSnapshot(sessionId, prompts);
    }
    const prompts = await sessionsClient.queue.dispatchNext({ sessionId, ...lookup(sessionId) });
    setSnapshot(sessionId, prompts);
  };

  return { enqueuePrompt, dispatchNext, sendNow, abort };
}
