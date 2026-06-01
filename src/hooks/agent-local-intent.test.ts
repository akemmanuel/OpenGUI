import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import type { SelectedModel } from "@/types/electron";
import { createLocalIntentOrchestrator } from "./agent-local-intent";

function makeState(overrides: Partial<InternalAgentState> = {}): InternalAgentState {
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
    draftSessionDirectory: null,
    draftSessionBackendId: null,
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
  };
}

function makeSession(input: Partial<Session> & Pick<Session, "id">): Session {
  return {
    title: "Untitled",
    directory: "/repo",
    time: { created: 1, updated: 1 },
    ...input,
  } as Session;
}

describe("createLocalIntentOrchestrator", () => {
  test("starts a draft session send when no backend session exists yet", async () => {
    const state = makeState({
      draftSessionDirectory: "/repo",
      selectedModel: { providerID: "openai", modelID: "gpt-5" },
    });
    const actions: Array<Record<string, unknown>> = [];
    const ensured: Array<Record<string, unknown>> = [];
    const selectCalls: Array<Record<string, unknown>> = [];
    const named: Array<Record<string, unknown>> = [];
    const reconciled: Array<Record<string, unknown>> = [];

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getCreationBackendId: () => "opencode",
      getCreationRuntime: () =>
        ({
          startSession: async (input: Record<string, unknown>) => ({
            id: "session-1",
            directory: input.directory,
          }),
        }) as never,
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        abort: async () => undefined,
      } as never,
      ensureDirectoryConnection: async (directory, options) => {
        ensured.push({ directory, options });
      },
      createSession: async () => null,
      selectSession: async (sessionId, options) => {
        selectCalls.push({ sessionId, options });
      },
      scheduleSessionMessageReconcile: (sessionId, projectTarget) => {
        reconciled.push({ sessionId, projectTarget });
      },
      requestSessionAutoName: (input) => {
        named.push(input as Record<string, unknown>);
      },
      isChatDirectory: () => false,
      dispatch: (action) => {
        actions.push(action as unknown as Record<string, unknown>);
      },
      dispatchingSessionIds: new Set(),
      draftCreatingRef: { current: false },
    });

    await orchestrator.sendPrompt("Ship it");

    expect(ensured).toEqual([{ directory: "/repo", options: { backendIds: ["opencode"] } }]);
    expect(actions).toEqual(
      expect.arrayContaining([
        { type: "SET_BUSY", payload: true },
        {
          type: "SESSION_CREATED",
          payload: expect.objectContaining({ id: "session-1", title: "Untitled" }),
        },
        { type: "CLEAR_DRAFT_SESSION" },
      ]),
    );
    expect(named).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        sourceText: "Ship it",
        force: true,
      }),
    ]);
    expect(selectCalls).toEqual([
      {
        sessionId: "session-1",
        options: {
          session: expect.objectContaining({ id: "session-1", title: "Untitled" }),
        },
      },
    ]);
    expect(reconciled).toEqual([
      {
        sessionId: "session-1",
        projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
      },
    ]);
  });

  test("prepends the directory-change notice before prompting the backend", async () => {
    const session = makeSession({
      id: "session-1",
      directory: "/original",
      _projectDir: "/original",
      _workspaceId: "workspace-1",
    });
    const state = makeState({
      activeSessionId: session.id,
      sessions: [session],
      sessionMeta: {
        [session.id]: {
          assignedProjectDir: "/target",
          assignedProjectSourceDir: "/original",
          pendingDirectoryChangeNotice: true,
        },
      },
    });
    const prompts: Array<Record<string, unknown>> = [];
    const actions: Array<Record<string, unknown>> = [];

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getCreationBackendId: () => "opencode",
      getCreationRuntime: () => undefined,
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input);
        },
        abort: async () => undefined,
      } as never,
      ensureDirectoryConnection: async () => undefined,
      createSession: async () => null,
      selectSession: async () => undefined,
      scheduleSessionMessageReconcile: () => undefined,
      requestSessionAutoName: () => undefined,
      isChatDirectory: () => false,
      dispatch: (action) => {
        actions.push(action as unknown as Record<string, unknown>);
      },
      dispatchingSessionIds: new Set(),
      draftCreatingRef: { current: false },
    });

    await orchestrator.sendPrompt("Continue");

    expect(prompts).toHaveLength(1);
    expect(String(prompts[0]?.text)).toContain("<SYSTEM-APPEND>");
    expect(String(prompts[0]?.text)).toContain("/target");
    expect(actions).toEqual(
      expect.arrayContaining([
        {
          type: "SET_SESSION_META",
          payload: {
            sessionId: "session-1",
            meta: expect.objectContaining({
              pendingDirectoryChangeNotice: false,
              hideSystemAppendBlocks: true,
            }),
          },
        },
      ]),
    );
  });

  test("queues prompts instead of sending them while the session is busy", async () => {
    const session = makeSession({ id: "session-1" });
    const model: SelectedModel = { providerID: "openai", modelID: "gpt-5" };
    const state = makeState({
      activeSessionId: session.id,
      sessions: [session],
      busySessionIds: new Set([session.id]),
      selectedModel: model,
    });
    const actions: Array<Record<string, unknown>> = [];
    const prompts: Array<Record<string, unknown>> = [];
    const queueSnapshots: Array<unknown> = [];

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getCreationBackendId: () => "opencode",
      getCreationRuntime: () => undefined,
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input);
        },
        abort: async () => undefined,
        queue: {
          enqueue: async (input: Record<string, unknown>) => {
            const snapshot = [
              {
                id: "queue-1",
                sessionId: String(input.sessionId),
                canonicalSessionId: "session-canonical-1",
                text: String(input.text),
                createdAt: 1,
                model,
                mode: "queue",
                order: 0,
              },
            ];
            queueSnapshots.push(snapshot);
            return snapshot as never;
          },
        },
      } as never,
      ensureDirectoryConnection: async () => undefined,
      createSession: async () => null,
      selectSession: async () => undefined,
      scheduleSessionMessageReconcile: () => undefined,
      requestSessionAutoName: () => undefined,
      isChatDirectory: () => false,
      dispatch: (action) => {
        actions.push(action as unknown as Record<string, unknown>);
      },
      dispatchingSessionIds: new Set(),
      draftCreatingRef: { current: false },
    });

    await orchestrator.sendPrompt("Queue this");

    expect(prompts).toEqual([]);
    expect(queueSnapshots).toHaveLength(1);
    expect(actions).toEqual(
      expect.arrayContaining([
        {
          type: "SET_SESSION_QUEUE",
          payload: {
            sessionID: "session-1",
            prompts: expect.arrayContaining([
              expect.objectContaining({ text: "Queue this", model }),
            ]),
          },
        },
      ]),
    );
  });

  test("sends commands through the active backend runtime and reconciles afterward", async () => {
    const session = makeSession({
      id: "session-1",
      _projectDir: "/repo",
      _workspaceId: "workspace-1",
    });
    const state = makeState({
      activeSessionId: session.id,
      sessions: [session],
      selectedModel: { providerID: "openai", modelID: "gpt-5" },
      selectedAgent: "reviewer",
    });
    const commands: Array<Record<string, unknown>> = [];
    const reconciled: Array<Record<string, unknown>> = [];

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getCreationBackendId: () => "opencode",
      getCreationRuntime: () => undefined,
      getResourceRuntime: () =>
        ({
          sendCommand: async (input: Record<string, unknown>) => {
            commands.push(input);
          },
        }) as never,
      getCurrentVariant: () => "high",
      sessionsClient: {
        abort: async () => undefined,
      } as never,
      ensureDirectoryConnection: async () => undefined,
      createSession: async () => null,
      selectSession: async () => undefined,
      scheduleSessionMessageReconcile: (sessionId, projectTarget) => {
        reconciled.push({ sessionId, projectTarget });
      },
      requestSessionAutoName: () => undefined,
      isChatDirectory: () => false,
      dispatch: () => undefined,
      dispatchingSessionIds: new Set(),
      draftCreatingRef: { current: false },
    });

    await orchestrator.sendCommand("review", "--all");

    expect(commands).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        command: "review",
        args: "--all",
        directory: "/repo",
        workspaceId: "workspace-1",
        agent: "reviewer",
        variant: "high",
      }),
    ]);
    expect(reconciled).toEqual([
      {
        sessionId: "session-1",
        projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
      },
    ]);
  });
});
