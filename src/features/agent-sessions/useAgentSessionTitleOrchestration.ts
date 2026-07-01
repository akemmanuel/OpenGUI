import { useCallback, type MutableRefObject } from "react";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import type { Action } from "@/hooks/agent-reducer";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";

export type SessionTitleTrackingRefs = {
  forcedTitles: MutableRefObject<Map<string, string>>;
  pendingTitlePersistence: MutableRefObject<Map<string, string>>;
  sessionIdAliases: MutableRefObject<Map<string, string>>;
  namingRequestIds: MutableRefObject<Map<string, number>>;
};

export function useAgentSessionTitleOrchestration(input: {
  dispatch: (action: Action) => void;
  getState: () => InternalAgentState;
  openGuiClient: OpenGuiClient;
  tracking: SessionTitleTrackingRefs;
}) {
  const { dispatch, getState, openGuiClient, tracking } = input;

  const resolveCurrentSessionId = useCallback(
    (sessionId: string) => {
      let current = sessionId;
      const seen = new Set<string>();
      while (tracking.sessionIdAliases.current.has(current) && !seen.has(current)) {
        seen.add(current);
        current = tracking.sessionIdAliases.current.get(current) ?? current;
      }
      return current;
    },
    [tracking.sessionIdAliases],
  );

  const forceSessionTitle = useCallback(
    (sessionId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      const canonicalSessionId = resolveCurrentSessionId(sessionId);
      tracking.forcedTitles.current.set(canonicalSessionId, trimmed);
      const current = getState().sessions.find(
        (session) => session.id === canonicalSessionId || session.id === sessionId,
      );
      if (current && current.title !== trimmed) {
        dispatch({
          type: "SESSION_UPDATED",
          payload: { ...current, title: trimmed },
        });
      }
      openGuiClient.sessions
        .rename({
          sessionId: canonicalSessionId,
          title: trimmed,
          harnessId: resolveSessionHarnessRoute(current).harnessId ?? undefined,
          target: (() => {
            const target = getSessionProjectTarget(
              current,
              current ? getState().sessionMeta[current.id] : undefined,
            );
            const workspaceId = target?.workspaceId ?? getState().activeWorkspaceId;
            const workspace = workspaceId
              ? getState().workspaces.find((item) => item.id === workspaceId)
              : null;
            return workspace && !workspace.isLocal
              ? { ...target, workspaceId, baseUrl: workspace.serverUrl }
              : (target ?? undefined);
          })(),
        })
        .then(() => {
          tracking.pendingTitlePersistence.current.delete(sessionId);
        })
        .catch((error) => {
          tracking.pendingTitlePersistence.current.set(sessionId, trimmed);
          console.warn("[session-title] failed to persist", { sessionId, error });
        });
    },
    [dispatch, getState, openGuiClient, resolveCurrentSessionId, tracking],
  );

  const applyGeneratedSessionTitle = useCallback(
    (sessionId: string, requestId: number, generatedTitle: string) => {
      const currentId = resolveCurrentSessionId(sessionId);
      const activeRequestId =
        tracking.namingRequestIds.current.get(currentId) ??
        tracking.namingRequestIds.current.get(sessionId);
      if (activeRequestId !== requestId) return;
      forceSessionTitle(currentId, generatedTitle);
      dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId: currentId, naming: false } });
      if (currentId !== sessionId) {
        dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId, naming: false } });
      }
    },
    [dispatch, forceSessionTitle, resolveCurrentSessionId, tracking.namingRequestIds],
  );

  return { resolveCurrentSessionId, forceSessionTitle, applyGeneratedSessionTitle };
}
