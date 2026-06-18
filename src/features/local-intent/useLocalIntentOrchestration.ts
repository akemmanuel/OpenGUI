import { useEffect, useMemo, useRef, useState } from "react";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import {
  processAfterPartQueueTriggers,
  processBusyToIdleTransitions,
} from "@/hooks/agent-queue-dispatch";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import { createLocalIntentOrchestrator } from "./create-local-intent-orchestrator";
import type { UseLocalIntentOrchestrationInput, UseLocalIntentOrchestrationResult } from "./types";

export function useLocalIntentOrchestration(
  options: UseLocalIntentOrchestrationInput,
): UseLocalIntentOrchestrationResult {
  const {
    state,
    refreshSessionMessages,
    getState,
    getResourceRuntime,
    getCurrentVariant,
    getWorkspaceBaseUrl,
    sessionsClient,
    createSession,
    scheduleSessionMessageReconcile,
    requestSessionAutoName,
    dispatch,
    getFallbackHarnessId,
  } = options;

  const sessionCreatingRef = useRef(false);
  const prevBusyRef = useRef<Set<string>>(new Set());
  const [justIdledMap, setJustIdledMap] = useState<Record<string, true>>({});

  const orchestrator = useMemo(
    () =>
      createLocalIntentOrchestrator({
        getState,
        getResourceRuntime,
        getCurrentVariant,
        getWorkspaceBaseUrl,
        sessionsClient,
        createSession,
        scheduleSessionMessageReconcile,
        requestSessionAutoName,
        dispatch,
        sessionCreatingRef,
        getFallbackHarnessId,
      }),
    [
      createSession,
      dispatch,
      getCurrentVariant,
      getFallbackHarnessId,
      getResourceRuntime,
      getState,
      getWorkspaceBaseUrl,
      requestSessionAutoName,
      scheduleSessionMessageReconcile,
      sessionsClient,
    ],
  );

  useEffect(() => {
    const next = processBusyToIdleTransitions({
      previousBusySessionIds: prevBusyRef.current,
      currentBusySessionIds: state.busySessionIds,
      activeSessionId: getState().activeSessionId,
      sessions: getState().sessions,
      sessionMeta: getState().sessionMeta,
      refreshSessionMessages,
    });
    setJustIdledMap((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length && nextKeys.every((key) => prev[key])) return prev;
      return next;
    });
    prevBusyRef.current = new Set(state.busySessionIds);
  }, [state.busySessionIds, getState, refreshSessionMessages]);

  useEffect(() => {
    if (state._afterPartTriggered.size === 0) return;
    processAfterPartQueueTriggers({
      sessionIds: state._afterPartTriggered,
      abortSession: (input) => {
        const session = getState().sessions.find((item) => item.id === input.sessionId);
        return sessionsClient.abort({
          ...input,
          harnessId: resolveSessionHarnessRoute(session).harnessId ?? undefined,
          target:
            getSessionProjectTarget(
              session,
              session ? getState().sessionMeta[session.id] : undefined,
            ) ?? undefined,
        });
      },
      dispatch: dispatch as never,
    });
  }, [state._afterPartTriggered, sessionsClient, getState, dispatch]);

  return { ...orchestrator, justIdledMap };
}
