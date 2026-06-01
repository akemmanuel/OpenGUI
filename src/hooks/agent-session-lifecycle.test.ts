import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Session } from "@/hooks/agent-state-types";
import {
  createLifecycleSession,
  createSessionDeletionPlan,
  createSessionForkPlan,
  createSessionRenamePlan,
  deleteLifecycleSession,
  forkLifecycleSession,
  refreshLifecycleSession,
  resolveSessionCreationBackendId,
} from "./agent-session-lifecycle";

function makeSession(input: Partial<Session> & Pick<Session, "id">): Session {
  return {
    title: "Untitled",
    directory: "/repo",
    time: { created: 1, updated: 1 },
    ...input,
  } as Session;
}

describe("resolveSessionCreationBackendId", () => {
  test("prefers the draft backend over the active session and default backend", () => {
    const backendId = resolveSessionCreationBackendId({
      draftSessionBackendId: "codex",
      sessions: [makeSession({ id: "pi:session-1", _backendId: "pi" })],
      activeSessionId: "pi:session-1",
      preferredBackendId: "claude-code",
    });

    expect(backendId).toBe("codex");
  });

  test("falls back to the active session backend before the preferred backend", () => {
    const backendId = resolveSessionCreationBackendId({
      draftSessionBackendId: null,
      sessions: [makeSession({ id: "pi:session-1", _backendId: "pi" })],
      activeSessionId: "pi:session-1",
      preferredBackendId: "claude-code",
    });

    expect(backendId).toBe("pi");
  });
});

describe("createSessionDeletionPlan", () => {
  test("blocks deleting busy Pi sessions", () => {
    const plan = createSessionDeletionPlan({
      sessionId: "pi:session-1",
      sessions: [makeSession({ id: "pi:session-1", _backendId: "pi" })],
      activeSessionId: "pi:session-1",
      busySessionIds: new Set(["pi:session-1"]),
      worktreeParents: {},
    });

    expect(plan).toEqual({
      type: "blocked",
      errorMessage: "Stop Pi session before deleting it.",
    });
  });

  test("selects the neighboring session and queues worktree cleanup for the last session", () => {
    const plan = createSessionDeletionPlan({
      sessionId: "session-2",
      sessions: [
        makeSession({ id: "session-1", _backendId: "claude-code", _projectDir: "/repo" }),
        makeSession({
          id: "session-2",
          _backendId: "claude-code",
          _projectDir: "/repo/feature-a",
        }),
        makeSession({ id: "session-3", _backendId: "claude-code", _projectDir: "/other" }),
      ],
      activeSessionId: "session-2",
      busySessionIds: new Set(),
      worktreeParents: {
        "/repo/feature-a": {
          parentDir: "/repo",
          branch: "feature-a",
          createdAt: "2026-01-01",
          lastOpenedAt: "2026-01-01",
        },
      },
    });

    expect(plan).toMatchObject({
      type: "delete",
      backendId: "claude-code",
      deletedSession: expect.objectContaining({ id: "session-2" }),
      nextSessionId: "session-3",
      pendingWorktreeCleanup: {
        worktreeDir: "/repo/feature-a",
        parentDir: "/repo",
      },
    });
  });
});

describe("createSessionRenamePlan", () => {
  test("trims titles and prepares an optimistic session update", () => {
    const plan = createSessionRenamePlan({
      sessionId: "session-1",
      title: "  Renamed  ",
      sessions: [makeSession({ id: "session-1", title: "Untitled" })],
      currentRequestId: 2,
    });

    expect(plan.nextRequestId).toBe(3);
    expect(plan.trimmedTitle).toBe("Renamed");
    expect(plan.updatedSession).toMatchObject({ id: "session-1", title: "Renamed" });
  });
});

describe("createSessionForkPlan", () => {
  test("increments the fork number for the current base title", () => {
    const plan = createSessionForkPlan({
      activeSessionId: "session-1",
      sessions: [
        makeSession({ id: "session-1", title: "#2 Feature work" }),
        makeSession({ id: "session-2", title: "#1 Feature work" }),
        makeSession({ id: "session-3", title: "Different" }),
      ],
    });

    expect(plan).toEqual({ sourceSessionId: "session-1", forkTitle: "#3 Feature work" });
  });
});

describe("createLifecycleSession", () => {
  test("connects the directory, creates the session, and marks chat sessions", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const created = makeSession({ id: "session-1", title: "New", directory: "/chat" });
    const selected: Array<Record<string, unknown>> = [];
    const ensured: string[] = [];

    const result = await createLifecycleSession({
      title: "New",
      directory: "/chat",
      state: {
        draftSessionBackendId: null,
        sessions: [],
        activeSessionId: null,
        activeWorkspaceId: "workspace-1",
      },
      preferredBackendId: "claude-code",
      ensureDirectoryConnection: async (directory) => {
        ensured.push(directory);
      },
      sessionsClient: {
        create: async (input) => {
          actions.push({ type: "create-call", input });
          return created;
        },
        delete: async () => undefined,
        rename: async () => undefined,
        abort: async () => undefined,
      },
      isChatDirectory: (directory) => directory === "/chat",
      selectSession: async (sessionId, options) => {
        selected.push({ sessionId, session: options?.session });
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(result).toBe(created);
    expect(ensured).toEqual(["/chat"]);
    expect(actions).toContainEqual({
      type: "SESSION_CREATED",
      payload: created,
    });
    expect(actions).toContainEqual({
      type: "SET_SESSION_META",
      payload: {
        sessionId: "session-1",
        meta: { originMode: "chat", assignedProjectDir: null },
      },
    });
    expect(selected).toEqual([{ sessionId: "session-1", session: created }]);
  });
});

describe("deleteLifecycleSession", () => {
  test("dispatches a local delete and best-effort backend delete", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const cleaned: string[][] = [];
    const deleted: Array<Record<string, unknown>> = [];
    const selected: string[] = [];

    await deleteLifecycleSession({
      sessionId: "session-2",
      state: {
        sessions: [
          makeSession({ id: "session-1", _backendId: "claude-code" }),
          makeSession({ id: "session-2", _backendId: "claude-code" }),
        ],
        activeSessionId: "session-2",
        busySessionIds: new Set(),
        worktreeParents: {},
      },
      cleanupSessionRefs: (ids) => {
        cleaned.push(Array.from(ids ?? []));
      },
      selectSession: async (sessionId) => {
        selected.push(sessionId);
      },
      sessionsClient: {
        create: async () => makeSession({ id: "unused" }),
        delete: async (input) => {
          deleted.push(input);
        },
        rename: async () => undefined,
        abort: async () => undefined,
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(cleaned).toEqual([["session-2"]]);
    expect(actions).toContainEqual({ type: "SESSION_DELETED", payload: "session-2" });
    expect(selected).toEqual(["session-1"]);
    expect(deleted).toEqual([
      {
        sessionId: "session-2",
        backendId: "claude-code",
        target: { directory: "/repo", workspaceId: undefined },
        confirmQueue: false,
      },
    ]);
  });
});

describe("refreshLifecycleSession", () => {
  test("reconciles the session and refreshed messages after a runtime mutation", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const updated = makeSession({ id: "session-1", title: "Updated" });
    const messages = [{ info: { id: "message-1" }, parts: [] }] as never;

    await refreshLifecycleSession({
      sessionId: "session-1",
      mutateSession: async () => updated,
      fetchMessagePage: async () => ({ messages, hasMore: true, nextCursor: "cursor-1" }),
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
      errorMessage: "Failed to mutate session",
    });

    expect(actions).toEqual([
      { type: "SESSION_UPDATED", payload: updated },
      {
        type: "SET_MESSAGES",
        payload: { messages, hasMore: true, nextCursor: "cursor-1" },
      },
    ]);
  });
});

describe("forkLifecycleSession", () => {
  test("creates and selects a fork with the next fork title", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const forcedTitles: Array<Record<string, string>> = [];
    const selected: Array<Record<string, unknown>> = [];
    const forked = makeSession({ id: "session-99", title: "Untitled" });

    await forkLifecycleSession({
      messageId: "message-1",
      activeSessionId: "session-1",
      sessions: [
        makeSession({ id: "session-1", title: "Feature work" }),
        makeSession({ id: "session-2", title: "#1 Feature work" }),
      ],
      runtime: {
        forkSession: async () => forked,
      },
      selectSession: async (sessionId, options) => {
        selected.push({ sessionId, session: options?.session });
      },
      forceSessionTitle: (sessionId, title) => {
        forcedTitles.push({ sessionId, title });
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toContainEqual({
      type: "SESSION_CREATED",
      payload: { ...forked, title: "#2 Feature work" },
    });
    expect(forcedTitles).toEqual([{ sessionId: "session-99", title: "#2 Feature work" }]);
    expect(selected).toEqual([
      {
        sessionId: "session-99",
        session: { ...forked, title: "#2 Feature work" },
      },
    ]);
  });
});
