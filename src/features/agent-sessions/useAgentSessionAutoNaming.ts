import { useCallback } from "react";
import type { Action } from "@/hooks/agent-reducer";
import { nextNamingRequestId } from "@/hooks/agent-send-state";
import { shouldAutoNameSession } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import { generateSessionTitle } from "@/lib/session-namer";
import type { SessionTitleTrackingRefs } from "./useAgentSessionTitleOrchestration";

export function useAgentSessionAutoNaming(input: {
  dispatch: (action: Action) => void;
  tracking: SessionTitleTrackingRefs;
  applyGeneratedSessionTitle: (sessionId: string, requestId: number, title: string) => void;
}) {
  const { dispatch, tracking, applyGeneratedSessionTitle } = input;

  return useCallback(
    ({
      sessionId,
      sourceText,
      session,
      force = false,
    }: {
      sessionId: string;
      sourceText: string;
      session?: Session | null;
      force?: boolean;
    }) => {
      if (!force && !shouldAutoNameSession(session)) return;
      dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId, naming: true } });
      const requestId = nextNamingRequestId(tracking.namingRequestIds.current.get(sessionId));
      tracking.namingRequestIds.current.set(sessionId, requestId);
      void generateSessionTitle(sourceText).then((generatedTitle) => {
        applyGeneratedSessionTitle(sessionId, requestId, generatedTitle);
      });
    },
    [applyGeneratedSessionTitle, dispatch, tracking.namingRequestIds],
  );
}
