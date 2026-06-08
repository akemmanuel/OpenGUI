import { type MutableRefObject, useCallback } from "react";
import { MESSAGE_PAGE_SIZE, tagPartWithDeltaPositions } from "@/hooks/agent-message-state";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { InternalAgentState, MessageEntry, Session } from "@/hooks/agent-state-types";
import { updateVariantSelections, variantKey } from "@/hooks/use-agent-variant-core";

export function deriveSelectionFromMessages(messages: MessageEntry[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const info = messages[i]?.info;
    if (!info || typeof info !== "object") continue;
    if (info.role !== "user") continue;
    const selectedAgent =
      "agent" in info && typeof info.agent === "string" ? info.agent : undefined;
    const variant =
      "variant" in info && typeof info.variant === "string" ? info.variant : undefined;
    if (
      "providerID" in info &&
      typeof info.providerID === "string" &&
      "modelID" in info &&
      typeof info.modelID === "string"
    ) {
      return {
        selectedModel: {
          providerID: info.providerID,
          modelID: info.modelID,
        },
        selectedAgent,
        variant,
      };
    }
    if (
      "model" in info &&
      info.model &&
      typeof info.model === "object" &&
      "providerID" in info.model &&
      typeof info.model.providerID === "string" &&
      "modelID" in info.model &&
      typeof info.model.modelID === "string"
    ) {
      return {
        selectedModel: {
          providerID: info.model.providerID,
          modelID: info.model.modelID,
        },
        selectedAgent,
        variant,
      };
    }
  }
  return { selectedModel: null, selectedAgent: null, variant: undefined };
}

export function createBufferedSessionMessages(
  bufferSnapshot: InternalAgentState["_sessionBuffers"][string] | undefined,
): MessageEntry[] | undefined {
  if (!bufferSnapshot) return undefined;
  return Object.values(bufferSnapshot.messages).map((entry) => ({
    info: entry.info,
    parts: Object.values(entry.parts).map((part) => tagPartWithDeltaPositions(part)),
  }));
}

export function createRefreshMessageLimit(currentMessagesLength: number): number {
  return Math.max(MESSAGE_PAGE_SIZE, currentMessagesLength + 8);
}

export const SESSION_RECONCILE_DELAYS = [
  150, 450, 900, 1500, 3000, 5000, 8000, 13000, 21000, 34000, 55000,
] as const;

type SessionActivationDispatch = (
  action:
    | { type: "SET_SELECTED_MODEL"; payload: { providerID: string; modelID: string } | null }
    | { type: "SET_SELECTED_AGENT"; payload: string | null }
    | { type: "SET_VARIANT_SELECTIONS"; payload: InternalAgentState["variantSelections"] }
    | { type: "SET_ACTIVE_SESSION"; payload: string | null }
    | {
        type: "SET_MESSAGES";
        payload: {
          messages: MessageEntry[];
          hasMore: boolean;
          nextCursor?: string | null;
          mode?: "replace" | "prepend" | "append";
        };
      }
    | { type: "SESSION_STATUS"; payload: { sessionID: string; status: { type: string } } },
) => void;

type ProjectTarget = { directory?: string; workspaceId?: string };

type FetchMessagePage = (
  sessionId: string,
  options?: { before?: string; limit?: number },
  projectTarget?: ProjectTarget,
) => Promise<{
  messages: MessageEntry[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

type RefreshSessionStatus = (sessionId: string, projectTarget?: ProjectTarget) => Promise<void>;

export function useAgentSessionActivation({
  fetchMessagePage,
  refreshSessionStatus,
  hydrateChildSessionsForMessages,
  dispatch,
  stateRef,
  selectSessionRequestRef,
  sessionReconcileRequestRef,
}: {
  fetchMessagePage: FetchMessagePage;
  refreshSessionStatus?: RefreshSessionStatus;
  hydrateChildSessionsForMessages: (
    messages: MessageEntry[],
    options?: {
      requestId?: number;
      sessionId?: string;
      directory?: string;
      workspaceId?: string;
    },
  ) => void;
  dispatch: SessionActivationDispatch;
  stateRef: MutableRefObject<InternalAgentState>;
  selectSessionRequestRef: MutableRefObject<number>;
  sessionReconcileRequestRef: MutableRefObject<Record<string, number>>;
}) {
  const selectSession = useCallback(
    async (
      id: string | null,
      options?: { session?: Session | null; force?: boolean; preserveSelectionOnFailure?: boolean },
    ) => {
      if (!options?.force && id === stateRef.current.activeSessionId) return;

      const applySelectionFromMessages = (messages: MessageEntry[]) => {
        const derived = deriveSelectionFromMessages(messages);
        dispatch({ type: "SET_SELECTED_MODEL", payload: derived.selectedModel });
        if (derived.selectedAgent !== undefined) {
          dispatch({ type: "SET_SELECTED_AGENT", payload: derived.selectedAgent ?? null });
        }
        if (derived.variant !== undefined) {
          const key = variantKey(derived.selectedModel.providerID, derived.selectedModel.modelID);
          const nextSelections = updateVariantSelections(
            stateRef.current.variantSelections,
            key,
            derived.variant,
          );
          if (nextSelections !== stateRef.current.variantSelections) {
            dispatch({
              type: "SET_VARIANT_SELECTIONS",
              payload: nextSelections,
            });
          }
        }
      };

      const bufferSnapshot = id ? stateRef.current._sessionBuffers[id] : undefined;
      const hadCompleteBuffer = !!bufferSnapshot?.complete;
      const bufferMessages = createBufferedSessionMessages(bufferSnapshot);

      const requestId = ++selectSessionRequestRef.current;
      dispatch({ type: "SET_ACTIVE_SESSION", payload: id });
      if (!id) return;
      const resolvedSession =
        options?.session && options.session.id === id
          ? options.session
          : stateRef.current.sessions.find((session) => session.id === id);
      const projectTarget = getSessionProjectTarget(resolvedSession);

      if (hadCompleteBuffer && bufferMessages) {
        applySelectionFromMessages(bufferMessages);
        hydrateChildSessionsForMessages(bufferMessages, {
          requestId,
          sessionId: id,
          directory: projectTarget?.directory,
          workspaceId: projectTarget?.workspaceId,
        });
        return;
      }

      let page: Awaited<ReturnType<typeof fetchMessagePage>>;
      try {
        page = await fetchMessagePage(id, undefined, projectTarget ?? undefined);
      } catch {
        if (requestId !== selectSessionRequestRef.current) return;
        if (options?.preserveSelectionOnFailure) {
          dispatch({
            type: "SET_MESSAGES",
            payload: { messages: [], hasMore: false, nextCursor: null },
          });
          return;
        }
        dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
        dispatch({
          type: "SET_MESSAGES",
          payload: { messages: [], hasMore: false, nextCursor: null },
        });
        return;
      }
      const { messages, hasMore, nextCursor } = page;
      if (requestId !== selectSessionRequestRef.current) return;
      dispatch({
        type: "SET_MESSAGES",
        payload: { messages, hasMore, nextCursor },
      });
      applySelectionFromMessages(messages);
      hydrateChildSessionsForMessages(messages, {
        requestId,
        sessionId: id,
        directory: projectTarget?.directory,
        workspaceId: projectTarget?.workspaceId,
      });
    },
    [
      dispatch,
      fetchMessagePage,
      hydrateChildSessionsForMessages,
      selectSessionRequestRef,
      stateRef,
    ],
  );

  const refreshActiveSessionMessages = useCallback(
    async (sessionId: string, projectTarget?: ProjectTarget) => {
      if (stateRef.current.activeSessionId !== sessionId) return false;
      const refreshed = await fetchMessagePage(
        sessionId,
        {
          limit: createRefreshMessageLimit(stateRef.current.messages.length),
        },
        projectTarget,
      );
      if (stateRef.current.activeSessionId !== sessionId) return false;
      dispatch({
        type: "SET_MESSAGES",
        payload: {
          messages: refreshed.messages,
          hasMore: refreshed.hasMore,
          nextCursor: refreshed.nextCursor,
        },
      });
      hydrateChildSessionsForMessages(refreshed.messages, {
        sessionId,
        directory: projectTarget?.directory,
        workspaceId: projectTarget?.workspaceId,
      });
      return true;
    },
    [dispatch, fetchMessagePage, hydrateChildSessionsForMessages, stateRef],
  );

  const scheduleSessionMessageReconcile = useCallback(
    (sessionId: string, projectTarget?: ProjectTarget) => {
      const requestId = (sessionReconcileRequestRef.current[sessionId] ?? 0) + 1;
      sessionReconcileRequestRef.current[sessionId] = requestId;

      void (async () => {
        for (const delayMs of SESSION_RECONCILE_DELAYS) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          if (sessionReconcileRequestRef.current[sessionId] !== requestId) return;
          if (stateRef.current.activeSessionId !== sessionId) return;
          try {
            await refreshActiveSessionMessages(sessionId, projectTarget);
            await refreshSessionStatus?.(sessionId, projectTarget);
          } catch {
            /* best-effort transcript reconcile */
          }
        }
      })();
    },
    [refreshActiveSessionMessages, refreshSessionStatus, sessionReconcileRequestRef, stateRef],
  );

  return {
    selectSession,
    refreshActiveSessionMessages,
    scheduleSessionMessageReconcile,
  };
}
