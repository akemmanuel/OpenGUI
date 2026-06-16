import type { QuestionAnswer } from "@/protocol/harness-types";
import { useCallback, type MutableRefObject } from "react";
import type { HarnessDescriptor } from "@/agents/backend";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import type { Action } from "@/hooks/agent-reducer";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import { getErrorMessage } from "@/lib/utils";
import type { OpenGuiClient } from "@/protocol/client";
import type { SelectedModel } from "@/types/electron";

type Dispatch = (action: Action) => void;
type QueuePrompts = InternalAgentState["queuedPrompts"][string];

export function useSessionInteractionOrchestration({
  state,
  stateRef,
  runtime,
  openGuiClient,
  ensureSession,
  resolveCurrentSessionId,
  dispatch,
}: {
  state: InternalAgentState;
  stateRef: MutableRefObject<InternalAgentState>;
  runtime: HarnessDescriptor["runtime"] | undefined;
  openGuiClient: OpenGuiClient;
  ensureSession: () => Promise<string | null>;
  resolveCurrentSessionId: (sessionId: string) => string;
  dispatch: Dispatch;
}) {
  const {
    activeSessionId,
    activeWorkspaceId,
    pendingPermissions,
    pendingQuestions,
    queuedPrompts,
    sessionMeta,
    sessions,
    workspaces,
  } = state;

  const getQueuedPrompts = useCallback(
    (sessionId: string) => queuedPrompts[sessionId] ?? [],
    [queuedPrompts],
  );

  const applyQueueSnapshot = useCallback(
    (sessionId: string, prompts: QueuePrompts) => {
      dispatch({ type: "SET_SESSION_QUEUE", payload: { sessionID: sessionId, prompts } });
    },
    [dispatch],
  );

  const getQueueTarget = useCallback(
    (sessionId: string) => {
      const session = stateRef.current.sessions.find((item) => item.id === sessionId);
      const harnessId = resolveSessionHarnessRoute(session).harnessId ?? undefined;
      const target =
        getSessionProjectTarget(
          session,
          session ? stateRef.current.sessionMeta[session.id] : undefined,
        ) ?? undefined;
      if (harnessId && target?.directory) {
        return { harnessId, target: { ...target, directory: target.directory } };
      }
      dispatch({
        type: "SET_ERROR",
        payload: "Queued prompt target requires Harness, Project directory, and Session ID",
      });
      throw new Error("Queued prompt target requires Harness, Project directory, and Session ID");
    },
    [dispatch, stateRef],
  );

  const mutateQueue = useCallback(
    (
      sessionId: string,
      label: string,
      run: (scope: ReturnType<typeof getQueueTarget>) => Promise<QueuePrompts>,
    ) => {
      let scope: ReturnType<typeof getQueueTarget>;
      try {
        scope = getQueueTarget(sessionId);
      } catch {
        return;
      }
      void run(scope)
        .then((prompts) => applyQueueSnapshot(sessionId, prompts))
        .catch((error) => {
          dispatch({
            type: "SET_ERROR",
            payload: getErrorMessage(error) || `Failed to ${label} queued prompt`,
          });
        });
    },
    [applyQueueSnapshot, dispatch, getQueueTarget],
  );

  const removeFromQueue = useCallback(
    (sessionId: string, promptId: string) =>
      mutateQueue(sessionId, "remove", (scope) =>
        openGuiClient.sessions.queue.remove({ sessionId, entryId: promptId, ...scope }),
      ),
    [mutateQueue, openGuiClient],
  );

  const reorderQueue = useCallback(
    (sessionId: string, fromIndex: number, toIndex: number) => {
      const entryId = stateRef.current.queuedPrompts[sessionId]?.[fromIndex]?.id;
      if (!entryId) return;
      mutateQueue(sessionId, "reorder", (scope) =>
        openGuiClient.sessions.queue.reorder({ sessionId, entryId, index: toIndex, ...scope }),
      );
    },
    [mutateQueue, openGuiClient, stateRef],
  );

  const updateQueuedPrompt = useCallback(
    (sessionId: string, promptId: string, text: string) =>
      mutateQueue(sessionId, "update", (scope) =>
        openGuiClient.sessions.queue.update({ sessionId, entryId: promptId, text, ...scope }),
      ),
    [mutateQueue, openGuiClient],
  );

  const summarizeSession = useCallback(
    async (modelOverride?: SelectedModel) => {
      if (!runtime) return;
      const sessionId = await ensureSession();
      if (!sessionId) return;

      const model = modelOverride ?? stateRef.current.selectedModel;
      if (!model) {
        dispatch({ type: "SET_ERROR", payload: "Compaction requires a model to be selected" });
        return;
      }

      dispatch({ type: "SET_BUSY", payload: true });
      try {
        const projectTarget = getSessionProjectTarget(
          stateRef.current.sessions.find((session) => session.id === sessionId),
          stateRef.current.sessionMeta[sessionId],
        );
        await runtime.compactSession(sessionId, model, projectTarget ?? undefined);
        await new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (!stateRef.current.busySessionIds.has(sessionId)) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }, 200);
          setTimeout(() => {
            clearInterval(checkInterval);
            resolve(true);
          }, 6000);
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const messages = (
          await openGuiClient.sessions.getMessages({ sessionId, options: { limit: 100 } })
        ).messages;
        dispatch({ type: "SET_MESSAGES", payload: { messages, hasMore: false, nextCursor: null } });
      } catch (err) {
        dispatch({ type: "SET_ERROR", payload: getErrorMessage(err) });
      }
    },
    [dispatch, ensureSession, openGuiClient, runtime, stateRef],
  );

  const abortSession = useCallback(async () => {
    if (!activeSessionId) return;
    const sessionId = resolveCurrentSessionId(activeSessionId);
    const activeSession = sessions.find(
      (session) => session.id === sessionId || session.id === activeSessionId,
    );
    const target =
      getSessionProjectTarget(
        activeSession,
        activeSession ? sessionMeta[activeSession.id] : undefined,
      ) ?? undefined;
    const workspaceId = target?.workspaceId ?? activeWorkspaceId;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    await openGuiClient.sessions.abort({
      sessionId,
      harnessId: resolveSessionHarnessRoute(activeSession).harnessId ?? undefined,
      target:
        workspace && !workspace.isLocal
          ? { ...target, workspaceId, baseUrl: workspace.serverUrl }
          : target,
    });
    dispatch({
      type: "SESSION_STATUS",
      payload: { sessionID: activeSessionId, status: { type: "idle" } },
    });
  }, [
    activeSessionId,
    activeWorkspaceId,
    dispatch,
    openGuiClient,
    resolveCurrentSessionId,
    sessionMeta,
    sessions,
    workspaces,
  ]);

  const respondPermission = useCallback(
    async (response: "once" | "always" | "reject") => {
      const sessionId = activeSessionId;
      if (!sessionId) return;
      const pending = pendingPermissions[sessionId];
      if (!pending) return;
      const session = sessions.find((item) => item.id === sessionId);
      const clearPermission = () =>
        dispatch({ type: "SET_PERMISSION", payload: { sessionID: sessionId, clear: true } });

      try {
        await openGuiClient.sessions.respondPermission({
          sessionId,
          permissionId: pending.id,
          response,
          harnessId: resolveSessionHarnessRoute(session).harnessId ?? undefined,
          target:
            getSessionProjectTarget(session, session ? sessionMeta[session.id] : undefined) ??
            undefined,
        });
        clearPermission();
      } catch (error) {
        const message = getErrorMessage(error);
        if (/permission request not found|permission not found|not found/i.test(message)) {
          clearPermission();
        }
        dispatch({
          type: "SET_ERROR",
          payload: message || "Failed to respond to permission request",
        });
      }
    },
    [activeSessionId, dispatch, openGuiClient, pendingPermissions, sessionMeta, sessions],
  );

  const submitQuestionResponse = useCallback(
    async (answers?: QuestionAnswer[]) => {
      if (!activeSessionId) return;
      const pending = pendingQuestions[activeSessionId];
      if (!pending) return;
      const session = sessions.find((item) => item.id === activeSessionId);
      const input = {
        sessionId: activeSessionId,
        requestId: pending.id,
        harnessId: resolveSessionHarnessRoute(session).harnessId ?? undefined,
        target: getSessionProjectTarget(session) ?? undefined,
      };
      try {
        if (answers) await openGuiClient.sessions.replyQuestion({ ...input, answers });
        else await openGuiClient.sessions.rejectQuestion(input);
        dispatch({
          type: "SET_QUESTION",
          payload: { sessionID: activeSessionId, clear: true },
        });
      } catch (error) {
        dispatch({
          type: "SET_ERROR",
          payload:
            error instanceof Error
              ? error.message
              : answers
                ? "Failed to submit question reply"
                : "Failed to dismiss question",
        });
      }
    },
    [activeSessionId, dispatch, openGuiClient, pendingQuestions, sessions],
  );

  const replyQuestion = useCallback(
    (answers: QuestionAnswer[]) => submitQuestionResponse(answers),
    [submitQuestionResponse],
  );
  const rejectQuestion = useCallback(() => submitQuestionResponse(), [submitQuestionResponse]);

  return {
    summarizeSession,
    abortSession,
    respondPermission,
    replyQuestion,
    rejectQuestion,
    getQueuedPrompts,
    removeFromQueue,
    reorderQueue,
    updateQueuedPrompt,
  };
}
