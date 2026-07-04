import { useCallback } from "react";
import type { HarnessId } from "@/agents";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import type { Action } from "@/hooks/agent-reducer";
import {
  createLifecycleSession,
  createSessionRenamePlan,
  deleteLifecycleSession,
} from "@/hooks/agent-session-lifecycle";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";
import type { SessionTitleTrackingRefs } from "./useAgentSessionTitleOrchestration";

export function useAgentSessionLifecycleActions(input: {
  dispatch: (action: Action) => void;
  getState: () => InternalAgentState;
  openGuiClient: OpenGuiClient;
  preferredHarnessId: HarnessId;
  ensureDirectoryConnection: (
    directory: string,
    options?: {
      hidden?: boolean;
      transient?: boolean;
      harnessIds?: import("@/agents").HarnessId[];
    },
  ) => Promise<void>;
  selectSession: (id: string | null, options?: { session?: Session }) => Promise<void>;
  isChatDirectory: (directory?: string | null) => boolean;
  cleanupSessionRefs: (sessionIds?: Iterable<string>) => void;
  tracking: SessionTitleTrackingRefs;
}) {
  const {
    dispatch,
    getState,
    openGuiClient,
    preferredHarnessId,
    ensureDirectoryConnection,
    selectSession,
    isChatDirectory,
    cleanupSessionRefs,
    tracking,
  } = input;

  const createSession = useCallback(
    async (title?: string, directory?: string): Promise<Session | null> => {
      const state = getState();
      return await createLifecycleSession({
        title,
        directory,
        state: {
          activeTargetHarnessId: state.activeTargetHarnessId,
          sessions: state.sessions,
          activeSessionId: state.activeSessionId,
          activeTargetDirectory: state.activeTargetDirectory,
          activeWorkspaceId: state.activeWorkspaceId,
          activeWorkspaceServerUrl: state.workspaces.find(
            (workspace) => workspace.id === state.activeWorkspaceId,
          )?.serverUrl,
        },
        preferredHarnessId,
        ensureDirectoryConnection,
        sessionsClient: openGuiClient.sessions,
        isChatDirectory,
        selectSession,
        dispatch,
      });
    },
    [
      dispatch,
      ensureDirectoryConnection,
      getState,
      isChatDirectory,
      openGuiClient,
      preferredHarnessId,
      selectSession,
    ],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      const state = getState();
      const queuedCount = state.queuedPrompts[id]?.length ?? 0;
      const confirmQueue =
        queuedCount === 0 ||
        window.confirm(
          `Delete this shared Session and its ${queuedCount} queued prompt${queuedCount === 1 ? "" : "s"}?`,
        );
      if (!confirmQueue) return;
      await deleteLifecycleSession({
        sessionId: id,
        state: {
          sessions: state.sessions,
          activeSessionId: state.activeSessionId,
          busySessionIds: state.busySessionIds,
          worktreeParents: state.worktreeParents,
        },
        confirmQueue: queuedCount > 0,
        cleanupSessionRefs,
        selectSession,
        sessionsClient: openGuiClient.sessions,
        dispatch,
      });
    },
    [cleanupSessionRefs, dispatch, getState, openGuiClient, selectSession],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const state = getState();
      const plan = createSessionRenamePlan({
        sessionId: id,
        title,
        sessions: state.sessions,
        currentRequestId: tracking.namingRequestIds.current.get(id),
      });
      tracking.namingRequestIds.current.set(id, plan.nextRequestId);
      dispatch({ type: "SET_SESSION_NAMING", payload: { sessionId: id, naming: false } });
      if (!plan.trimmedTitle) return;
      tracking.forcedTitles.current.set(id, plan.trimmedTitle);
      if (plan.updatedSession) {
        dispatch({ type: "SESSION_UPDATED", payload: plan.updatedSession });
      }
      openGuiClient.sessions
        .rename({
          sessionId: id,
          title: plan.trimmedTitle,
          harnessId: resolveSessionHarnessRoute(plan.currentSession).harnessId ?? undefined,
          target:
            getSessionProjectTarget(
              plan.currentSession,
              plan.currentSession ? state.sessionMeta[plan.currentSession.id] : undefined,
            ) ?? undefined,
        })
        .catch(() => {
          /* best-effort rename – backend events will reconcile */
        });
    },
    [dispatch, getState, openGuiClient, tracking],
  );

  return { createSession, deleteSession, renameSession };
}
