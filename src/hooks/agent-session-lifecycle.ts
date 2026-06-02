import type { AgentBackendId } from "@/agents";
import type { WorktreeParentMap } from "@/hooks/agent-state-persistence";
import { resolvePendingPromptCreationHarnessRoute } from "@/hooks/agent-harness-routing";
import { getSessionBackendId, getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { MessageEntry, Session } from "@/hooks/agent-state-types";
import { getDirectoryPlacementInfo } from "@/lib/worktree-placement";
import { getErrorMessage, normalizeProjectPath } from "@/lib/utils";

const FORK_TITLE_RE = /^#(\d+)\s+(.+)$/;

type LifecycleAction =
  | {
      type: "SET_ERROR";
      payload: string | null;
    }
  | { type: "SESSION_CREATED"; payload: Session }
  | { type: "SESSION_UPDATED"; payload: Session }
  | { type: "SESSION_DELETED"; payload: string }
  | {
      type: "SET_SESSION_META";
      payload: {
        sessionId: string;
        meta: {
          originMode: "chat";
          assignedProjectDir: null;
        };
      };
    }
  | {
      type: "SET_MESSAGES";
      payload: {
        messages: MessageEntry[];
        hasMore: boolean;
        nextCursor: string | null;
      };
    }
  | {
      type: "SET_PENDING_WORKTREE_CLEANUP";
      payload: {
        worktreeDir: string;
        parentDir: string;
      } | null;
    };

interface SessionsClient {
  create(input: {
    backendId: AgentBackendId;
    title?: string;
    target: { directory?: string; workspaceId?: string; baseUrl?: string };
  }): Promise<Session>;
  delete(input: {
    sessionId: string;
    backendId: AgentBackendId;
    target?: { directory?: string; workspaceId?: string };
    confirmQueue?: boolean;
  }): Promise<unknown>;
  rename(input: {
    sessionId: string;
    title: string;
    backendId?: AgentBackendId;
    target?: { directory?: string; workspaceId?: string };
  }): Promise<unknown>;
  abort(input: {
    sessionId: string;
    backendId?: AgentBackendId;
    target?: { directory?: string; workspaceId?: string };
  }): Promise<unknown>;
}

interface SessionRuntime {
  forkSession(sessionId: string, messageID?: string): Promise<Session>;
  revertSession(sessionId: string, messageID: string): Promise<Session>;
  unrevertSession(sessionId: string): Promise<Session>;
}

interface SessionMutationResult {
  messages: MessageEntry[];
  hasMore: boolean;
  nextCursor: string | null;
}

function getForkBaseTitle(title: string | null | undefined): string {
  const trimmed = title?.trim() || "Untitled";
  return trimmed.match(FORK_TITLE_RE)?.[2]?.trim() || trimmed;
}

export function resolveSessionCreationBackendId({
  activeTargetBackendId,
  preferredBackendId,
}: {
  activeTargetBackendId: AgentBackendId | null;
  sessions?: Session[];
  activeSessionId?: string | null;
  preferredBackendId: AgentBackendId;
}) {
  return resolvePendingPromptCreationHarnessRoute({
    activeTargetBackendId,
    preferredBackendId,
  }).backendId;
}

export function createSessionDeletionPlan({
  sessionId,
  sessions,
  activeSessionId,
  busySessionIds,
  worktreeParents,
}: {
  sessionId: string;
  sessions: Session[];
  activeSessionId: string | null;
  busySessionIds: Set<string>;
  worktreeParents: WorktreeParentMap;
}) {
  const deletedSession = sessions.find((session) => session.id === sessionId);
  const backendId = getSessionBackendId(deletedSession);
  if (!backendId) {
    return { type: "skip" } as const;
  }
  if ((backendId === "pi" || backendId === "codex") && busySessionIds.has(sessionId)) {
    return {
      type: "blocked",
      errorMessage:
        backendId === "pi"
          ? "Stop Pi session before deleting it."
          : "Stop Codex session before deleting it.",
    } as const;
  }

  const needsSwitch = activeSessionId === sessionId;
  const nextSessionId = needsSwitch
    ? (() => {
        const idx = sessions.findIndex((session) => session.id === sessionId);
        const next = sessions[idx + 1] ?? sessions[idx - 1] ?? null;
        return next?.id ?? null;
      })()
    : null;

  const deletedDirectory = normalizeProjectPath(
    (deletedSession?._projectDir ?? deletedSession?.directory) || "",
  );
  const worktreePlacement = getDirectoryPlacementInfo(deletedDirectory, worktreeParents);
  const remainingSessions = deletedDirectory
    ? sessions.filter(
        (session) =>
          session.id !== sessionId &&
          normalizeProjectPath((session._projectDir ?? session.directory) || "") ===
            deletedDirectory,
      )
    : [];

  return {
    type: "delete",
    backendId,
    deletedSession,
    nextSessionId,
    pendingWorktreeCleanup:
      deletedDirectory && worktreePlacement?.isKnownWorktree && remainingSessions.length === 0
        ? {
            worktreeDir: deletedDirectory,
            parentDir: worktreePlacement.rootDirectory,
          }
        : null,
  } as const;
}

export function createSessionRenamePlan({
  sessionId,
  title,
  sessions,
  currentRequestId,
}: {
  sessionId: string;
  title: string;
  sessions: Session[];
  currentRequestId?: number;
}) {
  const trimmedTitle = title.trim();
  const currentSession = sessions.find((session) => session.id === sessionId) ?? null;

  return {
    nextRequestId: (currentRequestId ?? 0) + 1,
    trimmedTitle,
    currentSession,
    updatedSession:
      trimmedTitle && currentSession && currentSession.title !== trimmedTitle
        ? { ...currentSession, title: trimmedTitle }
        : null,
  };
}

export function createSessionForkPlan({
  activeSessionId,
  sessions,
}: {
  activeSessionId: string | null;
  sessions: Session[];
}) {
  if (!activeSessionId) return null;
  const sourceSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const baseTitle = getForkBaseTitle(sourceSession?.title);
  let maxFork = 0;
  for (const session of sessions) {
    const match = session.title?.trim().match(FORK_TITLE_RE);
    if (!match || match[2]?.trim() !== baseTitle) continue;
    maxFork = Math.max(maxFork, Number.parseInt(match[1] ?? "0", 10) || 0);
  }

  return {
    sourceSessionId: activeSessionId,
    forkTitle: `#${maxFork + 1} ${baseTitle}`,
  };
}

export async function createLifecycleSession({
  title,
  directory,
  state,
  preferredBackendId,
  ensureDirectoryConnection,
  sessionsClient,
  isChatDirectory,
  selectSession,
  dispatch,
}: {
  title?: string;
  directory?: string;
  state: {
    activeTargetBackendId: AgentBackendId | null;
    sessions: Session[];
    activeSessionId: string | null;
    activeWorkspaceId: string;
    activeWorkspaceServerUrl?: string;
  };
  preferredBackendId: AgentBackendId;
  ensureDirectoryConnection: (
    directory: string,
    options?: { backendIds?: AgentBackendId[] },
  ) => Promise<void>;
  sessionsClient: SessionsClient;
  isChatDirectory: (directory?: string | null) => boolean;
  selectSession: (sessionId: string, options?: { session?: Session }) => Promise<void>;
  dispatch: (action: LifecycleAction) => void;
}): Promise<Session | null> {
  const backendId = resolveSessionCreationBackendId({
    activeTargetBackendId: state.activeTargetBackendId,
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    preferredBackendId,
  });

  try {
    if (directory) {
      await ensureDirectoryConnection(directory, { backendIds: [backendId] });
    }
    const session = await sessionsClient.create({
      backendId,
      title,
      target: {
        directory,
        workspaceId: state.activeWorkspaceId,
        baseUrl: state.activeWorkspaceServerUrl,
      },
    });
    dispatch({ type: "SESSION_CREATED", payload: session });
    if (isChatDirectory(directory)) {
      dispatch({
        type: "SET_SESSION_META",
        payload: {
          sessionId: session.id,
          meta: { originMode: "chat", assignedProjectDir: null },
        },
      });
    }
    await selectSession(session.id, { session });
    return session;
  } catch (error) {
    dispatch({
      type: "SET_ERROR",
      payload: getErrorMessage(error) || "Failed to create session",
    });
    return null;
  }
}

export async function deleteLifecycleSession({
  sessionId,
  state,
  confirmQueue = false,
  cleanupSessionRefs,
  selectSession,
  sessionsClient,
  dispatch,
}: {
  sessionId: string;
  state: {
    sessions: Session[];
    activeSessionId: string | null;
    busySessionIds: Set<string>;
    worktreeParents: WorktreeParentMap;
  };
  confirmQueue?: boolean;
  cleanupSessionRefs: (sessionIds?: Iterable<string>) => void;
  selectSession: (sessionId: string, options?: { session?: Session }) => Promise<void>;
  sessionsClient: SessionsClient;
  dispatch: (action: LifecycleAction) => void;
}) {
  const plan = createSessionDeletionPlan({
    sessionId,
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    busySessionIds: state.busySessionIds,
    worktreeParents: state.worktreeParents,
  });

  if (plan.type === "skip") return;
  if (plan.type === "blocked") {
    dispatch({ type: "SET_ERROR", payload: plan.errorMessage });
    return;
  }

  cleanupSessionRefs([sessionId]);
  dispatch({ type: "SESSION_DELETED", payload: sessionId });
  if (plan.nextSessionId) {
    void selectSession(plan.nextSessionId);
  }

  void sessionsClient
    .delete({
      sessionId,
      backendId: plan.backendId,
      target: getSessionProjectTarget(plan.deletedSession) ?? undefined,
      confirmQueue,
    })
    .catch(() => {
      /* best-effort deletion */
    });

  if (plan.pendingWorktreeCleanup) {
    dispatch({
      type: "SET_PENDING_WORKTREE_CLEANUP",
      payload: plan.pendingWorktreeCleanup,
    });
  }
}

export async function refreshLifecycleSession({
  sessionId,
  mutateSession,
  fetchMessagePage,
  dispatch,
  errorMessage,
}: {
  sessionId: string;
  mutateSession: () => Promise<Session>;
  fetchMessagePage: (sessionId: string) => Promise<SessionMutationResult>;
  dispatch: (action: LifecycleAction) => void;
  errorMessage: string;
}) {
  try {
    const session = await mutateSession();
    dispatch({ type: "SESSION_UPDATED", payload: session });
    const refreshed = await fetchMessagePage(sessionId);
    dispatch({
      type: "SET_MESSAGES",
      payload: {
        messages: refreshed.messages,
        hasMore: refreshed.hasMore,
        nextCursor: refreshed.nextCursor,
      },
    });
  } catch (error) {
    dispatch({
      type: "SET_ERROR",
      payload: error instanceof Error ? error.message : errorMessage,
    });
  }
}

export async function forkLifecycleSession({
  messageId,
  activeSessionId,
  sessions,
  runtime,
  selectSession,
  forceSessionTitle,
  dispatch,
}: {
  messageId: string;
  activeSessionId: string | null;
  sessions: Session[];
  runtime: Pick<SessionRuntime, "forkSession">;
  selectSession: (sessionId: string, options?: { session?: Session }) => Promise<void>;
  forceSessionTitle: (sessionId: string, title: string) => void;
  dispatch: (action: LifecycleAction) => void;
}) {
  const plan = createSessionForkPlan({ activeSessionId, sessions });
  if (!plan) return;

  try {
    const session = await runtime.forkSession(plan.sourceSessionId, messageId);
    const titledSession = { ...session, title: plan.forkTitle };
    dispatch({ type: "SESSION_CREATED", payload: titledSession });
    forceSessionTitle(session.id, plan.forkTitle);
    await selectSession(session.id, { session: titledSession });
  } catch (error) {
    dispatch({
      type: "SET_ERROR",
      payload: error instanceof Error ? error.message : "Failed to fork session",
    });
  }
}
