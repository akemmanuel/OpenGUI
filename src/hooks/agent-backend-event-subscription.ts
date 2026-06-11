import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
} from "react";
import { handleHarnessEvent } from "@/hooks/agent-backend-events";
import {
  isCanonicalSessionNotification,
  isQueueEvent,
  toHarnessEvent,
  type BackendEventEnvelope,
} from "@/hooks/backend-event-normalization";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import type { Action } from "@/hooks/agent-reducer";
import { createHttpOpenGuiClient } from "@/protocol/http-client";
import type { OpenGuiClient } from "@/protocol/client";

type BackendEventTracking = {
  expectedProjectKeys: MutableRefObject<Set<string>>;
  forcedTitles: MutableRefObject<Map<string, string>>;
  pendingTitlePersistence: MutableRefObject<Map<string, string>>;
  sessionIdAliases: MutableRefObject<Map<string, string>>;
  namingRequestIds: MutableRefObject<Map<string, number>>;
};

export function useBackendEventSubscription(input: {
  allBackendsCount: number;
  cleanupSessionRefs: (sessionIds?: Iterable<string>) => void;
  dispatch: Dispatch<Action>;
  openGuiClient: OpenGuiClient;
  tracking: BackendEventTracking;
  workspaces: InternalAgentState["workspaces"];
}) {
  const { allBackendsCount, cleanupSessionRefs, dispatch, openGuiClient, tracking, workspaces } =
    input;
  const seenBackendEventIdsRef = useRef<string[]>([]);
  const seenBackendEventIdSetRef = useRef(new Set<string>());

  const handleBackendEvent = useCallback(
    (event: BackendEventEnvelope) => {
      // Remote workspaces deliver events through the canonical SSE stream. A reconnect or
      // overlapping subscription can surface the same canonical event more than once; streaming
      // text events are mutations, so applying a duplicate delta duplicates visible text.
      if (typeof event.id === "string") {
        const seenIds = seenBackendEventIdSetRef.current;
        if (seenIds.has(event.id)) return;
        seenIds.add(event.id);
        const order = seenBackendEventIdsRef.current;
        order.push(event.id);
        while (order.length > 1000) {
          const expired = order.shift();
          if (expired) seenIds.delete(expired);
        }
      }
      if (isQueueEvent(event)) {
        if (Array.isArray(event.entries)) {
          dispatch({
            type: "SET_SESSION_QUEUE",
            payload: { sessionID: event.sessionId, prompts: event.entries },
          });
        } else if (event.type === "queue.cleared") {
          dispatch({ type: "QUEUE_CLEAR", payload: { sessionID: event.sessionId } });
        }
        return;
      }
      if (isCanonicalSessionNotification(event)) {
        return;
      }
      handleHarnessEvent({
        event: toHarnessEvent(event),
        expectedProjectKeys: tracking.expectedProjectKeys.current,
        tracking: {
          forcedTitles: tracking.forcedTitles.current,
          pendingTitlePersistence: tracking.pendingTitlePersistence.current,
          sessionIdAliases: tracking.sessionIdAliases.current,
          namingRequestIds: tracking.namingRequestIds.current,
        },
        cleanupSessionRefs,
        renameSession: (renameInput) => openGuiClient.sessions.rename(renameInput),
        dispatch,
      });
    },
    [cleanupSessionRefs, dispatch, openGuiClient, tracking],
  );

  const remoteWorkspaceEventSources = useMemo(() => {
    const unique = new Map<string, { baseUrl: string; authToken?: string }>();
    for (const workspace of workspaces) {
      if (workspace.isLocal || !workspace.serverUrl.trim()) continue;
      const baseUrl = workspace.serverUrl.trim().replace(/\/+$/, "");
      const key = `${baseUrl}\u0000${workspace.authToken ?? ""}`;
      unique.set(key, { baseUrl, authToken: workspace.authToken });
    }
    return [...unique.values()];
  }, [workspaces]);

  useEffect(() => {
    if (allBackendsCount === 0) return;
    const unsubscribers = [openGuiClient.harnesses.subscribe(handleBackendEvent)];
    for (const remote of remoteWorkspaceEventSources) {
      unsubscribers.push(
        createHttpOpenGuiClient({
          baseUrl: remote.baseUrl,
          token: remote.authToken,
        }).harnesses.subscribe(handleBackendEvent),
      );
    }
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [allBackendsCount, handleBackendEvent, openGuiClient, remoteWorkspaceEventSources]);
}
