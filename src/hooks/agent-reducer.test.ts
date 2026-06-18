import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessId } from "@/agents";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import { mergeProjectBackendSessions, reducer } from "./agent-reducer";
import { createProjectConnectionStatus } from "./agent-project-connection";

function session(id: string, harnessId: HarnessId, directory = "/repo", updated = 1): Session {
  return {
    id,
    title: id,
    directory,
    _projectDir: directory,
    _workspaceId: "workspace-1",
    _harnessId: harnessId,
    time: { created: updated, updated },
  } as Session;
}

function baseState(overrides: Partial<InternalAgentState> = {}): InternalAgentState {
  return {
    workspaces: [],
    activeWorkspaceId: "workspace-1",
    projectWorkspaceMap: {},
    connections: {},
    sessions: [],
    activeSessionId: null,
    messages: [],
    messageHistoryHasMore: false,
    messageHistoryCursor: null,
    isLoadingMessages: false,
    isLoadingOlderMessages: false,
    isBusy: false,
    pendingPermissions: {},
    pendingQuestions: {},
    lastError: null,
    sessionErrors: {},
    bootState: "idle",
    bootError: null,
    bootLogs: null,
    workspaceResources: {},
    providers: [],
    providerDefaults: {},
    selectedModel: null,
    busySessionIds: new Set(),
    agents: [],
    selectedAgent: null,
    variantSelections: {},
    commands: [],
    queuedPrompts: {},
    defaultChatDirectory: null,
    activeTargetDirectory: null,
    activeTargetHarnessId: null,
    namingSessionIds: new Set(),
    unreadSessionIds: new Set(),
    sessionDrafts: {},
    sessionMeta: {},
    projectMeta: {},
    worktreeParents: {},
    pendingWorktreeCleanup: null,
    turnRuns: {},
    activeTurnRunBySession: {},
    childSessions: {},
    trackedChildSessionIds: new Set(),
    _pendingSnapshots: [],
    _sessionBuffers: {},
    afterPartPending: new Set(),
    _afterPartTriggered: new Set(),
    _deletedSessionIds: new Set(),
    ...overrides,
  } as InternalAgentState;
}

describe("SET_ACTIVE_TARGET", () => {
  test("resets prompt selection for a fresh chat when requested", () => {
    const next = reducer(
      baseState({
        selectedModel: { providerID: "openai", modelID: "gpt-5" },
        selectedAgent: "build",
      }),
      {
        type: "SET_ACTIVE_TARGET",
        payload: { directory: "/repo", harnessId: "opencode", resetSelection: true },
      },
    );

    expect(next.activeTargetDirectory).toBe("/repo");
    expect(next.selectedModel).toBeNull();
    expect(next.selectedAgent).toBeNull();
  });

  test("uses explicit prompt selection for a fresh target", () => {
    const selectedModel = { providerID: "anthropic", modelID: "claude-sonnet" };
    const next = reducer(
      baseState({
        selectedModel: { providerID: "openai", modelID: "gpt-5" },
        selectedAgent: "build",
      }),
      {
        type: "SET_ACTIVE_TARGET",
        payload: {
          directory: "/repo",
          harnessId: "opencode",
          resetSelection: true,
          selectedModel,
          selectedAgent: null,
        },
      },
    );

    expect(next.selectedModel).toBe(selectedModel);
    expect(next.selectedAgent).toBeNull();
  });

  test("preserves prompt selection when changing target without reset", () => {
    const selectedModel = { providerID: "openai", modelID: "gpt-5" };
    const next = reducer(baseState({ selectedModel, selectedAgent: "build" }), {
      type: "SET_ACTIVE_TARGET",
      payload: { directory: "/repo", harnessId: "opencode" },
    });

    expect(next.selectedModel).toBe(selectedModel);
    expect(next.selectedAgent).toBe("build");
  });
});

describe("mergeProjectBackendSessions", () => {
  test("replaces only sessions from listed backends", () => {
    const current = [session("open-old", "opencode"), session("pi-old", "pi")];
    const incoming = [session("pi-new", "pi", "/repo", 2)];

    const merged = mergeProjectBackendSessions({
      current,
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming,
      harnessIds: ["pi"],
    });

    expect(merged.map((item) => item.id).sort()).toEqual(["open-old", "pi-new"]);
  });

  test("preserves sessions when backend listing failed", () => {
    const current = [session("open-old", "opencode"), session("pi-old", "pi")];

    const merged = mergeProjectBackendSessions({
      current,
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming: [],
      harnessIds: [],
    });

    expect(merged.map((item) => item.id).sort()).toEqual(["open-old", "pi-old"]);
  });

  test("incoming id wins even when previous copy belonged to another directory", () => {
    const current = [session("same", "opencode", "/old", 1)];
    const incoming = [session("same", "opencode", "/repo", 2)];

    const merged = mergeProjectBackendSessions({
      current,
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming,
      harnessIds: ["opencode"],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?._projectDir).toBe("/repo");
  });

  test("selecting a session with an active running turn keeps it busy", () => {
    const sessionId = "pi:session-1";
    const withTurn = reducer(baseState({ sessions: [session(sessionId, "pi")] }), {
      type: "TURN_RUN_STARTED",
      payload: {
        id: "turn-1",
        sessionID: sessionId,
        startedAt: 1,
        status: "running",
      },
    } as Parameters<typeof reducer>[1]);

    const selected = reducer(withTurn, {
      type: "SET_ACTIVE_SESSION",
      payload: sessionId,
    } as Parameters<typeof reducer>[1]);

    expect(selected.isBusy).toBe(true);
  });

  test("session error stops active turn and records message", () => {
    const sessionId = "pi:session-1";
    const running = reducer(
      baseState({ activeSessionId: sessionId, sessions: [session(sessionId, "pi")] }),
      {
        type: "TURN_RUN_STARTED",
        payload: {
          id: "turn-1",
          sessionID: sessionId,
          startedAt: 1,
          status: "running",
        },
      } as Parameters<typeof reducer>[1],
    );

    const next = reducer(running, {
      type: "SESSION_ERROR",
      payload: { sessionID: sessionId, error: "Claude auth expired" },
    } as Parameters<typeof reducer>[1]);

    expect(next.isBusy).toBe(false);
    expect(next.busySessionIds.has(sessionId)).toBe(false);
    expect(next.sessionErrors[sessionId]).toBe("Claude auth expired");
    expect(next.lastError).toBe("Claude auth expired");
    expect(next.turnRuns["turn-1"]?.status).toBe("error");
    expect(next.isLoadingMessages).toBe(false);
  });

  test("retry session status keeps session busy and records message", () => {
    const sessionId = "opencode:session-1";
    const next = reducer(baseState({ activeSessionId: sessionId }), {
      type: "SESSION_STATUS",
      payload: {
        sessionID: sessionId,
        status: {
          type: "retry",
          attempt: 4,
          message: "Claude authentication expired or invalid. Run 'claude login' in your terminal.",
          next: Date.now() + 9000,
        },
      },
    } as Parameters<typeof reducer>[1]);

    expect(next.isBusy).toBe(true);
    expect(next.busySessionIds.has(sessionId)).toBe(true);
    expect(next.sessionErrors[sessionId]).toContain("claude login");
  });

  test("idle session status clears retry message", () => {
    const sessionId = "opencode:session-1";
    const next = reducer(
      baseState({ activeSessionId: sessionId, sessionErrors: { [sessionId]: "retrying" } }),
      {
        type: "SESSION_STATUS",
        payload: { sessionID: sessionId, status: { type: "idle" } },
      } as Parameters<typeof reducer>[1],
    );

    expect(next.sessionErrors[sessionId]).toBeUndefined();
  });

  test("new turn clears previous session error", () => {
    const sessionId = "pi:session-1";
    const next = reducer(baseState({ sessionErrors: { [sessionId]: "old error" } }), {
      type: "TURN_RUN_STARTED",
      payload: {
        id: "turn-1",
        sessionID: sessionId,
        startedAt: 1,
        status: "running",
      },
    } as Parameters<typeof reducer>[1]);

    expect(next.sessionErrors[sessionId]).toBeUndefined();
  });

  test("promotes chat-infra to project when explicitly set to connected", () => {
    const next = reducer(
      baseState({
        connections: {
          "workspace-1\u0000/home/emmanuel": createProjectConnectionStatus(
            "connected",
            "http://localhost:4096",
            "chat-infra",
          ),
        },
      }),
      {
        type: "SET_PROJECT_CONNECTION",
        payload: {
          projectKey: "workspace-1\u0000/home/emmanuel",
          status: createProjectConnectionStatus("connected", "http://localhost:4096", "project"),
        },
      } as Parameters<typeof reducer>[1],
    );

    expect(next.connections["workspace-1\u0000/home/emmanuel"]?.kind).toBe("project");
  });

  test("preserves chat-infra connection kind across backend status updates", () => {
    const next = reducer(
      baseState({
        connections: {
          "workspace-1\u0000/home/emmanuel": createProjectConnectionStatus(
            "connected",
            "http://localhost:4096",
            "chat-infra",
          ),
        },
      }),
      {
        type: "SET_PROJECT_CONNECTION",
        payload: {
          projectKey: "workspace-1\u0000/home/emmanuel",
          status: {
            state: "reconnecting",
            serverUrl: "http://localhost:4096",
            serverVersion: null,
            error: null,
            lastEventAt: 2,
          },
        },
      } as Parameters<typeof reducer>[1],
    );

    expect(next.connections["workspace-1\u0000/home/emmanuel"]?.kind).toBe("chat-infra");
  });

  test("does not delete sessions when removing a non-workspace infrastructure connection", () => {
    const state = baseState({
      workspaces: [
        {
          id: "workspace-1",
          name: "Workspace",
          serverUrl: "http://localhost:4096",
          isLocal: false,
          projects: [],
        },
      ],
      sessions: [session("chat-1", "opencode", "/home/emmanuel")],
      connections: {
        "workspace-1\u0000/home/emmanuel": createProjectConnectionStatus(
          "connected",
          "http://localhost:4096",
          "chat-infra",
        ),
      },
    });

    const next = reducer(state, {
      type: "REMOVE_PROJECT",
      payload: {
        projectKey: "workspace-1\u0000/home/emmanuel",
        directory: "/home/emmanuel",
      },
    } as Parameters<typeof reducer>[1]);

    expect(next.sessions.map((item) => item.id)).toEqual(["chat-1"]);
  });

  test("keeps chat-origin sessions in the default chat directory when project indexes echo them", () => {
    const state = baseState({
      defaultChatDirectory: "/home/tobias/Dokumente",
      sessions: [session("opencode:chat-1", "opencode", "/home/tobias/Dokumente", 1)],
      sessionMeta: {
        "opencode:chat-1": {
          originMode: "chat",
          nativeProjectDir: "/home/tobias/Dokumente",
          assignedProjectDir: null,
        },
      },
    });

    const next = reducer(state, {
      type: "SESSION_UPDATED",
      payload: session("opencode:chat-1", "opencode", "/home/tobias/Dokumente/Jutta Kürzl", 2),
    } as Parameters<typeof reducer>[1]);

    expect(next.sessions[0]?._projectDir).toBe("/home/tobias/Dokumente");
    expect(next.sessions[0]?.directory).toBe("/home/tobias/Dokumente");
  });

  test("marks sessions listed from default chat targets as chat-origin", () => {
    const next = reducer(baseState({ defaultChatDirectory: "/home/chats" }), {
      type: "MERGE_PROJECT_SESSIONS",
      payload: {
        projectKey: "workspace-1\u0000/home/chats",
        directory: "/home/chats",
        sessions: [session("opencode:chat-1", "opencode", "/home/chats", 1)],
        harnessIds: ["opencode"],
        source: "default-chat",
      },
    } as Parameters<typeof reducer>[1]);

    expect(next.sessionMeta["opencode:chat-1"]).toMatchObject({
      originMode: "chat",
      nativeProjectDir: "/home/chats",
      assignedProjectDir: null,
    });
  });

  test("does not overwrite existing placement metadata when default chat target is listed", () => {
    const next = reducer(
      baseState({
        defaultChatDirectory: "/home/chats",
        sessionMeta: {
          "opencode:project-1": {
            originMode: "project",
            nativeProjectDir: "/home/chats",
          },
        },
      }),
      {
        type: "MERGE_PROJECT_SESSIONS",
        payload: {
          projectKey: "workspace-1\u0000/home/chats",
          directory: "/home/chats",
          sessions: [session("opencode:project-1", "opencode", "/home/chats", 1)],
          harnessIds: ["opencode"],
          source: "default-chat",
        },
      } as Parameters<typeof reducer>[1],
    );

    expect(next.sessionMeta["opencode:project-1"]?.originMode).toBe("project");
  });
});
