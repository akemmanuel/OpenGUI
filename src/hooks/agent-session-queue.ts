import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { InternalAgentState, QueuedPrompt, Session } from "@/hooks/agent-state-types";
import type { OpenGuiClient, QueueScopeInput } from "@/protocol/client";

interface SessionQueueOptions {
  getState: () => Pick<InternalAgentState, "sessions">;
  sessionsClient: OpenGuiClient["sessions"];
  dispatch: (action: unknown) => void;
}

export interface SessionQueueOrchestrator {
  enqueuePrompt(
    this: void,
    input: {
      sessionId: string;
      text: string;
      model?: QueuedPrompt["model"];
      agent?: string;
      variant?: string;
      mode: QueuedPrompt["mode"];
      insertAt: "back" | "front";
    },
  ): Promise<QueuedPrompt[]>;
  sendNow(this: void, sessionId: string, promptId: string): Promise<void>;
}

function getSessionLookup(session: Session | undefined): QueueScopeInput {
  const harnessId = resolveSessionHarnessRoute(session).harnessId ?? undefined;
  const target = getSessionProjectTarget(session) ?? undefined;
  if (!harnessId || !target?.directory) {
    throw new Error("Queued prompt target requires Harness, Project directory, and Session ID");
  }
  return { harnessId, target: { ...target, directory: target.directory } };
}

export function createSessionQueueOrchestrator(
  options: SessionQueueOptions,
): SessionQueueOrchestrator {
  const { getState, sessionsClient, dispatch } = options;

  const lookup = (sessionId: string) =>
    getSessionLookup(getState().sessions.find((session) => session.id === sessionId));

  const setSnapshot = (sessionId: string, prompts: QueuedPrompt[]) => {
    dispatch({ type: "SET_SESSION_QUEUE", payload: { sessionID: sessionId, prompts } });
  };

  const enqueuePrompt: SessionQueueOrchestrator["enqueuePrompt"] = async (input) => {
    const prompts = await sessionsClient.queue.enqueue({
      sessionId: input.sessionId,
      text: input.text,
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      mode: input.mode,
      insertAt: input.insertAt,
      ...lookup(input.sessionId),
    });

    setSnapshot(input.sessionId, prompts);
    return prompts;
  };

  const sendNow = async (sessionId: string, promptId: string) => {
    const prompts = await sessionsClient.queue.sendNow({
      sessionId,
      entryId: promptId,
      ...lookup(sessionId),
    });
    setSnapshot(sessionId, prompts);
  };

  return { enqueuePrompt, sendNow };
}
