import type { HarnessId } from "@/agents";
import type { HarnessTarget } from "@/agents/backend";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import { decidePromptIntentDispatch } from "@/features/local-intent/decide-prompt-intent";
import type { QueueMode } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { SessionMeta } from "@/hooks/agent-state-persistence";

export type LocalIntentDispatch = (action: unknown) => void;

export interface ExecuteLocalIntentSendPromptInput {
  text: string;
  mode?: QueueMode;
  activeSessionId: string | null;
  activeTargetDirectory: string | null;
  busySessionIds: ReadonlySet<string>;
  sessions: Session[];
  sessionMeta: Record<string, SessionMeta>;
  dispatch: LocalIntentDispatch;
  resolveSessionId: (sourceText: string) => Promise<string | null>;
  ensureModelSelectedForNewChat: () => boolean;
  preparePromptText: (sessionId: string, text: string) => string;
  enqueuePrompt: (input: {
    sessionId: string;
    text: string;
    mode: QueueMode;
    insertAt: "front" | "back";
  }) => Promise<boolean>;
  dispatchPromptNow: (sessionId: string, text: string, mode: QueueMode) => Promise<void>;
  abortSession: (input: {
    sessionId: string;
    harnessId?: HarnessId;
    target?: HarnessTarget;
  }) => Promise<void>;
}

/**
 * Local intent orchestration for one Agent send from PromptBox text:
 * resolve Session entry, decide prompt-now vs Queued prompt, optional interrupt abort.
 */
export async function executeLocalIntentSendPrompt(
  input: ExecuteLocalIntentSendPromptInput,
): Promise<void> {
  if (!input.activeSessionId && input.activeTargetDirectory) {
    if (!input.ensureModelSelectedForNewChat()) return;
  }

  const sessionId = await input.resolveSessionId(input.text);
  if (!sessionId) return;

  const intent = decidePromptIntentDispatch({
    sessionId,
    requestedMode: input.mode,
    busySessionIds: input.busySessionIds,
  });
  if (!intent) return;

  if (intent.type === "queue-after-part" || intent.type === "queue-prompt") {
    const queued = await input.enqueuePrompt({
      sessionId: intent.sessionId,
      text: input.text,
      mode: intent.mode,
      insertAt: intent.insertAt,
    });
    if (!queued) return;

    if (intent.type === "queue-after-part") {
      input.dispatch({
        type: "SET_AFTER_PART_PENDING",
        payload: { sessionID: intent.sessionId, pending: true },
      });
      return;
    }

    if (intent.type === "queue-prompt" && intent.mode === "interrupt") {
      const session = input.sessions.find((item) => item.id === intent.sessionId);
      await input.abortSession({
        sessionId: intent.sessionId,
        harnessId: resolveSessionHarnessRoute(session).harnessId ?? undefined,
        target: getSessionProjectTarget(session, input.sessionMeta[intent.sessionId]) ?? undefined,
      });
    }
    return;
  }

  await input.dispatchPromptNow(
    intent.sessionId,
    input.preparePromptText(intent.sessionId, input.text),
    intent.mode,
  );
}

export function createAbortSessionViaClient(sessionsClient: OpenGuiClient["sessions"]) {
  return (input: { sessionId: string; harnessId?: HarnessId; target?: HarnessTarget }) =>
    sessionsClient.abort({
      sessionId: input.sessionId,
      harnessId: input.harnessId,
      target: input.target,
    });
}
