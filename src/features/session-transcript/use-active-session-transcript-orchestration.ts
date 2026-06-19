import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { LiveSessionEvent, ProjectedTranscriptEvent } from "@opengui/runtime/client";
import { deriveSelectionFromMessages } from "@/hooks/agent-session-activation";
import { fetchSessionMessagePage } from "@/hooks/agent-message-loading";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { HarnessId } from "@/agents";
import type { InternalAgentState, MessageEntry } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";
import { updateVariantSelections, variantKey } from "@/hooks/use-agent-variant-core";
import { dispatchLiveSessionActivity } from "@/features/session-transcript/live-session-activity";
import { resolveActiveTranscriptScope } from "@/features/session-transcript/resolve-active-transcript-scope";
import { scopeFromLiveEvent, scopesEqual } from "@/features/session-transcript/transcript-input";
import type { ActiveTranscriptScope } from "@/features/session-transcript/transcript-input";
import { useActiveTranscriptStore } from "@/features/session-transcript/active-session-transcript-provider";

export type TranscriptOrchestrationDispatch = (
  action:
    | { type: "SET_SELECTED_MODEL"; payload: { providerID: string; modelID: string } | null }
    | { type: "SET_SELECTED_AGENT"; payload: string | null }
    | { type: "SET_VARIANT_SELECTIONS"; payload: InternalAgentState["variantSelections"] }
    | { type: "BIND_ASSISTANT_TURN_FROM_TRANSCRIPT"; payload: { entry: MessageEntry } }
    | { type: "SESSION_STATUS"; payload: { sessionID: string; status: { type: string } } }
    | { type: "SESSION_ERROR"; payload: { sessionID?: string; error: string } },
) => void;

export function useActiveSessionTranscriptOrchestration(input: {
  activeSessionId: string | null;
  stateRef: MutableRefObject<InternalAgentState>;
  dispatch: TranscriptOrchestrationDispatch;
  openGuiClient: OpenGuiClient;
  selectSessionRequestRef: MutableRefObject<number>;
  expectedProjectKeysRef: MutableRefObject<Set<string>>;
  consumePreservePromptBoxSelection?: (sessionId: string) => boolean;
}) {
  const store = useActiveTranscriptStore();
  const lastBoundAssistantKeyRef = useRef<string | null>(null);
  const {
    activeSessionId,
    stateRef,
    dispatch,
    openGuiClient,
    selectSessionRequestRef,
    expectedProjectKeysRef,
    consumePreservePromptBoxSelection,
  } = input;

  const fetchPageRef = useRef<
    (
      scope: ActiveTranscriptScope,
      options?: { before?: string; limit?: number },
      phase?: "initial" | "older" | "final",
    ) => Promise<void>
  >(async () => {});

  fetchPageRef.current = async (scope, options, phase = "initial") => {
    const session = stateRef.current.sessions.find((item) => item.id === scope.sessionId);
    const projectTarget = session
      ? (getSessionProjectTarget(session, stateRef.current.sessionMeta[session.id]) ?? undefined)
      : undefined;
    try {
      const page = await fetchSessionMessagePage({
        sessionsClient: openGuiClient.sessions,
        sessions: stateRef.current.sessions,
        sessionId: scope.sessionId,
        options,
        projectTarget,
        harnessId: scope.harnessId as HarnessId,
      });
      if (!scopesEqual(store.getSnapshot().scope, scope)) return;
      store.dispatch({
        type: "page.loaded",
        scope,
        messages: page.messages,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        phase,
      });
    } catch (error) {
      if (!scopesEqual(store.getSnapshot().scope, scope)) return;
      const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
      const errorText = raw.trim() || "sessionError.messagesLoadFailed";
      store.dispatch({
        type: "page.failed",
        scope,
        error: errorText,
      });
      dispatch({
        type: "SESSION_ERROR",
        payload: { sessionID: scope.sessionId, error: errorText },
      });
    }
  };

  useEffect(() => {
    store.setEffects({
      scheduleFinalReconcile: (scope) => {
        void fetchPageRef.current(
          scope,
          {
            limit: Math.max(30, store.getSnapshot().messages.length + 8),
          },
          "final",
        );
      },
    });
  }, [store]);

  useEffect(() => {
    const unsubscribe = store.subscribe((snapshot) => {
      const activeId = stateRef.current.activeSessionId;
      if (!activeId || !snapshot.scope || snapshot.scope.sessionId !== activeId) return;
      const lastAssistant = snapshot.messages.findLast((m) => m.info.role === "assistant");
      if (lastAssistant) {
        const completedAt = (lastAssistant.info.time as { completed?: number }).completed ?? "";
        const bindKey = [
          activeId,
          lastAssistant.info.id,
          lastAssistant.info.providerID ?? "",
          lastAssistant.info.modelID ?? "",
          completedAt,
        ].join("\u0000");
        if (lastBoundAssistantKeyRef.current === bindKey) return;
        lastBoundAssistantKeyRef.current = bindKey;
        dispatch({
          type: "BIND_ASSISTANT_TURN_FROM_TRANSCRIPT",
          payload: { entry: lastAssistant },
        });
        return;
      }
      lastBoundAssistantKeyRef.current = null;
    });
    return unsubscribe;
  }, [dispatch, stateRef, store]);

  useEffect(() => {
    const scope = resolveActiveTranscriptScope({
      sessionId: activeSessionId,
      sessions: stateRef.current.sessions,
      sessionMeta: stateRef.current.sessionMeta,
    });
    store.select(scope);
    if (!scope) return;

    const requestId = ++selectSessionRequestRef.current;
    void (async () => {
      await fetchPageRef.current(scope, undefined, "initial");
      if (requestId !== selectSessionRequestRef.current) return;
      const snapshot = store.getSnapshot();
      if (!scopesEqual(snapshot.scope, scope)) return;
      const derived = deriveSelectionFromMessages(snapshot.messages);
      const preservePromptBoxSelection =
        consumePreservePromptBoxSelection?.(scope.sessionId) ?? false;
      if (preservePromptBoxSelection && !derived.selectedModel) return;
      dispatch({ type: "SET_SELECTED_MODEL", payload: derived.selectedModel });
      if (derived.selectedAgent !== undefined) {
        dispatch({ type: "SET_SELECTED_AGENT", payload: derived.selectedAgent ?? null });
      }
      if (derived.variant !== undefined && derived.selectedModel) {
        const key = variantKey(derived.selectedModel.providerID, derived.selectedModel.modelID);
        const nextSelections = updateVariantSelections(
          stateRef.current.variantSelections,
          key,
          derived.variant,
        );
        if (nextSelections !== stateRef.current.variantSelections) {
          dispatch({ type: "SET_VARIANT_SELECTIONS", payload: nextSelections });
        }
      }
    })();
  }, [
    activeSessionId,
    consumePreservePromptBoxSelection,
    dispatch,
    selectSessionRequestRef,
    stateRef,
    store,
  ]);

  const ingestLiveEvent = useCallback(
    (event: LiveSessionEvent) => {
      dispatchLiveSessionActivity({
        event,
        expectedProjectKeys: expectedProjectKeysRef.current,
        dispatch,
      });
      const activeScope = resolveActiveTranscriptScope({
        sessionId: stateRef.current.activeSessionId,
        sessions: stateRef.current.sessions,
        sessionMeta: stateRef.current.sessionMeta,
      });
      if (!activeScope) return;
      if (!scopesEqual(scopeFromLiveEvent(event), activeScope)) return;
      store.ingestLive(event);
    },
    [dispatch, expectedProjectKeysRef, stateRef, store],
  );

  const ingestProjectedTranscriptEvent = useCallback(
    (event: ProjectedTranscriptEvent) => {
      const activeScope = resolveActiveTranscriptScope({
        sessionId: stateRef.current.activeSessionId,
        sessions: stateRef.current.sessions,
        sessionMeta: stateRef.current.sessionMeta,
      });
      if (!activeScope) return false;
      if (!scopesEqual(event.scope, activeScope)) return false;

      switch (event.type) {
        case "transcript.snapshot":
          store.dispatch({
            type: "page.loaded",
            scope: activeScope,
            messages: event.page.messages,
            hasMore: event.page.nextCursor !== null,
            nextCursor: event.page.nextCursor,
            phase: "initial",
          });
          return true;
        case "transcript.message":
          return true;
        case "transcript.message.removed":
          store.dispatch({
            type: "message.removed",
            scope: activeScope,
            messageId: event.messageID,
          });
          return true;
        default:
          return false;
      }
    },
    [stateRef, store],
  );

  const loadOlderMessages = useCallback(async (): Promise<boolean> => {
    const scope = store.getSnapshot().scope;
    if (!scope || !store.beginLoadOlder()) return false;
    const cursor = store.getSnapshot().olderCursor;
    if (!cursor) return false;
    await fetchPageRef.current(scope, { before: cursor }, "older");
    return store.getSnapshot().hasOlder;
  }, [store]);

  const reloadActiveTranscript = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const scope = resolveActiveTranscriptScope({
        sessionId,
        sessions: stateRef.current.sessions,
        sessionMeta: stateRef.current.sessionMeta,
      });
      if (!scope || stateRef.current.activeSessionId !== sessionId) return false;
      await fetchPageRef.current(
        scope,
        { limit: Math.max(30, store.getSnapshot().messages.length + 8) },
        "final",
      );
      return true;
    },
    [stateRef, store],
  );

  return {
    ingestLiveEvent,
    ingestProjectedTranscriptEvent,
    loadOlderMessages,
    reloadActiveTranscript,
    getTranscriptSnapshot: () => store.getSnapshot(),
  };
}
