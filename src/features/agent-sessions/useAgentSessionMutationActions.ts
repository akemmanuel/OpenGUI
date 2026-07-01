import { useCallback } from "react";
import type { HarnessDescriptor } from "@/agents/backend";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import type { Action } from "@/hooks/agent-reducer";
import { forkLifecycleSession, refreshLifecycleSession } from "@/hooks/agent-session-lifecycle";
import {
  createSessionProjectDetachMeta,
  createSessionProjectMoveMeta,
  getSessionProjectTarget,
  makeProjectKey,
} from "@/hooks/agent-session-utils";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import { persistWorktreeParents, type SessionColor } from "@/hooks/agent-state-persistence";
import type { OpenGuiClient } from "@/protocol/client";
import { getErrorMessage, normalizeProjectPath } from "@/lib/utils";

export function useAgentSessionMutationActions(input: {
  state: InternalAgentState;
  dispatch: (action: Action) => void;
  getState: () => InternalAgentState;
  openGuiClient: OpenGuiClient;
  runtime: HarnessDescriptor["runtime"] | undefined;
  selectSession: (id: string | null) => Promise<void>;
  ensureDirectoryConnection: (directory: string) => Promise<void>;
  reloadActiveTranscript: (sessionId: string) => Promise<boolean>;
  forceSessionTitle: (sessionId: string, title: string) => void;
}) {
  const {
    state,
    dispatch,
    getState,
    openGuiClient,
    runtime,
    selectSession,
    ensureDirectoryConnection,
    reloadActiveTranscript,
    forceSessionTitle,
  } = input;

  const revertToMessage = useCallback(
    async (messageID: string) => {
      if (!runtime || !state.activeSessionId) return;
      if (state.busySessionIds.has(state.activeSessionId)) {
        const activeSession = state.sessions.find(
          (session) => session.id === state.activeSessionId,
        );
        await openGuiClient.sessions.abort({
          sessionId: state.activeSessionId,
          harnessId: resolveSessionHarnessRoute(activeSession).harnessId ?? undefined,
          target:
            getSessionProjectTarget(
              activeSession,
              activeSession ? state.sessionMeta[activeSession.id] : undefined,
            ) ?? undefined,
        });
      }
      const activeSession = getState().sessions.find(
        (session) => session.id === state.activeSessionId,
      );
      const projectTarget =
        getSessionProjectTarget(
          activeSession,
          activeSession ? getState().sessionMeta[activeSession.id] : undefined,
        ) ?? undefined;
      await refreshLifecycleSession({
        sessionId: state.activeSessionId,
        mutateSession: () =>
          runtime.revertSession(state.activeSessionId!, messageID, undefined, projectTarget),
        reloadTranscript: (id) => reloadActiveTranscript(id),
        dispatch,
        errorMessage: "Failed to revert session",
      });
    },
    [
      dispatch,
      getState,
      openGuiClient,
      reloadActiveTranscript,
      runtime,
      state.activeSessionId,
      state.busySessionIds,
      state.sessionMeta,
      state.sessions,
    ],
  );

  const unrevert = useCallback(async () => {
    if (!runtime || !state.activeSessionId) return;
    const activeSession = getState().sessions.find(
      (session) => session.id === state.activeSessionId,
    );
    const projectTarget =
      getSessionProjectTarget(
        activeSession,
        activeSession ? getState().sessionMeta[activeSession.id] : undefined,
      ) ?? undefined;
    await refreshLifecycleSession({
      sessionId: state.activeSessionId,
      mutateSession: () => runtime.unrevertSession(state.activeSessionId!, projectTarget),
      reloadTranscript: (id) => reloadActiveTranscript(id),
      dispatch,
      errorMessage: "Failed to unrevert session",
    });
  }, [dispatch, getState, reloadActiveTranscript, runtime, state.activeSessionId]);

  const forkFromMessage = useCallback(
    async (messageID: string) => {
      if (!runtime || !state.activeSessionId) return;
      const activeSession = getState().sessions.find(
        (session) => session.id === state.activeSessionId,
      );
      const projectTarget =
        getSessionProjectTarget(
          activeSession,
          activeSession ? getState().sessionMeta[activeSession.id] : undefined,
        ) ?? undefined;
      await forkLifecycleSession({
        messageId: messageID,
        activeSessionId: state.activeSessionId,
        sessions: getState().sessions,
        runtime,
        selectSession,
        forceSessionTitle,
        dispatch,
        target: projectTarget,
      });
    },
    [dispatch, forceSessionTitle, getState, runtime, selectSession, state.activeSessionId],
  );

  const setSessionColor = useCallback(
    (sessionId: string, color: SessionColor) => {
      dispatch({
        type: "SET_SESSION_META",
        payload: { sessionId, meta: { color } },
      });
    },
    [dispatch],
  );

  const setSessionTags = useCallback(
    (sessionId: string, tags: string[]) => {
      dispatch({
        type: "SET_SESSION_META",
        payload: { sessionId, meta: { tags } },
      });
    },
    [dispatch],
  );

  const setSessionPinned = useCallback(
    (sessionId: string, pinned: boolean) => {
      dispatch({
        type: "SET_SESSION_META",
        payload: {
          sessionId,
          meta: { pinnedAt: pinned ? new Date().toISOString() : undefined },
        },
      });
    },
    [dispatch],
  );

  const moveSessionToProject = useCallback(
    async (sessionId: string, directory: string) => {
      try {
        const targetDirectory = normalizeProjectPath(directory);
        if (!targetDirectory) return;
        const stateNow = getState();
        if (stateNow.busySessionIds.has(sessionId)) {
          throw new Error("Wait for the session to finish before moving it.");
        }
        const sourceSession = stateNow.sessions.find((session) => session.id === sessionId);
        if (!sourceSession) return;
        const sourceDirectory = normalizeProjectPath(
          (sourceSession._projectDir ?? sourceSession.directory) || "",
        );
        if (!sourceDirectory) return;
        const meta = createSessionProjectMoveMeta(
          sourceSession,
          stateNow.sessionMeta[sessionId],
          targetDirectory,
        );
        if (!meta) return;
        dispatch({ type: "SET_SESSION_META", payload: { sessionId, meta } });
        await ensureDirectoryConnection(targetDirectory);
        await selectSession(sessionId);
      } catch (error) {
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error) || "Failed to move session",
        });
      }
    },
    [dispatch, ensureDirectoryConnection, getState, selectSession],
  );

  const removeSessionFromProject = useCallback(
    async (sessionId: string) => {
      try {
        const stateNow = getState();
        if (stateNow.busySessionIds.has(sessionId)) {
          throw new Error("Wait for the session to finish before removing it from the project.");
        }
        const sourceSession = stateNow.sessions.find((session) => session.id === sessionId);
        if (!sourceSession) return;
        const sourceDirectory = normalizeProjectPath(
          (sourceSession._projectDir ?? sourceSession.directory) || "",
        );
        if (!sourceDirectory) return;
        const meta = createSessionProjectDetachMeta(
          sourceSession,
          stateNow.sessionMeta[sessionId],
          Date.now(),
          stateNow.defaultChatDirectory,
        );
        if (!meta) return;
        dispatch({ type: "SET_SESSION_META", payload: { sessionId, meta } });
        await selectSession(sessionId);
      } catch (error) {
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error) || "Failed to remove session from project",
        });
      }
    },
    [dispatch, getState, selectSession],
  );

  const setProjectPinned = useCallback(
    (directory: string, pinned: boolean) => {
      const workspaceId = getState().activeWorkspaceId;
      if (!workspaceId) return;
      dispatch({
        type: "SET_PROJECT_META",
        payload: {
          projectKey: makeProjectKey(workspaceId, directory),
          meta: { pinnedAt: pinned ? new Date().toISOString() : undefined },
        },
      });
    },
    [dispatch, getState],
  );

  const registerWorktree = useCallback(
    (worktreeDir: string, parentDir: string, branch: string) => {
      const normalizedWorktreeDir = normalizeProjectPath(worktreeDir);
      const normalizedParentDir = normalizeProjectPath(parentDir);
      if (!normalizedWorktreeDir || !normalizedParentDir) return;
      const stateNow = getState();
      const now = new Date().toISOString();
      persistWorktreeParents({
        ...stateNow.worktreeParents,
        [normalizedWorktreeDir]: {
          parentDir: normalizedParentDir,
          branch,
          createdAt: stateNow.worktreeParents[normalizedWorktreeDir]?.createdAt ?? now,
          lastOpenedAt: now,
        },
      });
      dispatch({
        type: "REGISTER_WORKTREE",
        payload: {
          worktreeDir: normalizedWorktreeDir,
          parentDir: normalizedParentDir,
          branch,
        },
      });
    },
    [dispatch, getState],
  );

  const unregisterWorktree = useCallback(
    (worktreeDir: string) => {
      const normalizedWorktreeDir = normalizeProjectPath(worktreeDir);
      if (!normalizedWorktreeDir) return;
      const next = { ...getState().worktreeParents };
      delete next[normalizedWorktreeDir];
      persistWorktreeParents(next);
      dispatch({ type: "UNREGISTER_WORKTREE", payload: normalizedWorktreeDir });
    },
    [dispatch, getState],
  );

  const clearWorktreeCleanup = useCallback(() => {
    dispatch({ type: "SET_PENDING_WORKTREE_CLEANUP", payload: null });
  }, [dispatch]);

  return {
    revertToMessage,
    unrevert,
    forkFromMessage,
    setSessionColor,
    setSessionTags,
    setSessionPinned,
    moveSessionToProject,
    removeSessionFromProject,
    setProjectPinned,
    registerWorktree,
    unregisterWorktree,
    clearWorktreeCleanup,
  };
}
