import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { AgentBackendId } from "@/agents";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import { mergeProjectBackendSessions, reducer } from "./agent-reducer";
import { createProjectConnectionStatus } from "./agent-project-connection";

function session(id: string, backendId: AgentBackendId, directory = "/repo", updated = 1): Session {
  return {
    id,
    title: id,
    directory,
    _projectDir: directory,
    _workspaceId: "workspace-1",
    _backendId: backendId,
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
    bootState: "idle",
    bootError: null,
    bootLogs: null,
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
    activeTargetBackendId: null,
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

describe("mergeProjectBackendSessions", () => {
  test("replaces only sessions from listed backends", () => {
    const current = [session("open-old", "opencode"), session("pi-old", "pi")];
    const incoming = [session("pi-new", "pi", "/repo", 2)];

    const merged = mergeProjectBackendSessions({
      current,
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming,
      backendIds: ["pi"],
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
      backendIds: [],
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
      backendIds: ["opencode"],
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
});
