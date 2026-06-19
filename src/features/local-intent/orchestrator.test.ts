import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { initI18n, i18n } from "@/i18n";
import { initialAgentState } from "@/hooks/agent-initial-state";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import type { SelectedModel } from "@/types/electron";
import { createLocalIntentOrchestrator } from "@/features/local-intent";

function makeState(overrides: Partial<InternalAgentState> = {}): InternalAgentState {
  return {
    ...initialAgentState,
    activeWorkspaceId: "workspace-1",
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
  test("creates a titled session on first send when no backend session exists yet", async () => {
    const state = makeState({
      activeTargetDirectory: "/repo",
      selectedModel: { providerID: "openai", modelID: "gpt-5" },
    });
    const actions: Array<Record<string, unknown>> = [];
    const reconciled: Array<Record<string, unknown>> = [];

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        prompt: async () => undefined,
        abort: async () => undefined,
      } as never,
      createSession: async (title, directory) => {
        const session = {
          id: "session-1",
          title,
          directory,
          _projectDir: directory,
          _workspaceId: "workspace-1",
          time: { created: 1, updated: 1 },
        } as Session;
        state.sessions = [session];
        return session;
      },
      scheduleSessionMessageReconcile: (sessionId, projectTarget) => {
        reconciled.push({ sessionId, projectTarget });
      },
      requestSessionAutoName: () => undefined,
      dispatch: (action) => {
        actions.push(action as unknown as Record<string, unknown>);
      },
      sessionCreatingRef: { current: false },
      getFallbackHarnessId: () => "claude-code" as const,
    });

    await orchestrator.sendPrompt("Ship it");

    expect(actions).toEqual(
      expect.arrayContaining([
        { type: "CLEAR_SESSION_DRAFT", payload: "draft:workspace-1:/repo" },
        { type: "CLEAR_ACTIVE_TARGET" },
        { type: "SET_BUSY", payload: true },
      ]),
    );
    expect(reconciled).toEqual([
      {
        sessionId: "session-1",
        projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
      },
    ]);
  });

  test("requires model before creating a fresh session", async () => {
    await initI18n();
    const state = makeState({ activeTargetDirectory: "/repo", selectedModel: null });
    const actions: Array<Record<string, unknown>> = [];
    let created = false;

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        prompt: async () => undefined,
        abort: async () => undefined,
      } as never,
      createSession: async () => {
        created = true;
        return null;
      },
      scheduleSessionMessageReconcile: () => undefined,
      requestSessionAutoName: () => undefined,
      dispatch: (action) => {
        actions.push(action as unknown as Record<string, unknown>);
      },
      sessionCreatingRef: { current: false },
      getFallbackHarnessId: () => "claude-code" as const,
    });

    await orchestrator.sendPrompt("Ship it");

    expect(created).toBe(false);
    expect(actions).toEqual([
      {
        type: "SET_ERROR",
        payload: i18n.t("prompt.chooseHarnessAndModelBeforeSend"),
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
      selectedModel: { providerID: "openai", modelID: "gpt-5" },
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
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input);
        },
        abort: async () => undefined,
      } as never,
      createSession: async () => null,
      scheduleSessionMessageReconcile: () => undefined,
      requestSessionAutoName: () => undefined,
      dispatch: (action) => {
        actions.push(action as unknown as Record<string, unknown>);
      },
      sessionCreatingRef: { current: false },
      getFallbackHarnessId: () => "claude-code" as const,
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

  test("prepends a directory-change notice when a session is moved back to its original project", async () => {
    const session = makeSession({
      id: "session-1",
      directory: "/project-b",
      _projectDir: "/project-b",
      _workspaceId: "workspace-1",
    });
    const state = makeState({
      activeSessionId: session.id,
      selectedModel: { providerID: "openai", modelID: "gpt-5" },
      sessions: [session],
      sessionMeta: {
        [session.id]: {
          nativeProjectDir: "/original",
          assignedProjectDir: null,
          assignedProjectSourceDir: "/project-b",
          pendingDirectoryChangeNotice: true,
        },
      },
    });
    const prompts: Array<Record<string, unknown>> = [];

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input);
        },
        abort: async () => undefined,
      } as never,
      createSession: async () => null,
      scheduleSessionMessageReconcile: () => undefined,
      requestSessionAutoName: () => undefined,
      dispatch: () => undefined,
      sessionCreatingRef: { current: false },
      getFallbackHarnessId: () => "claude-code" as const,
    });

    await orchestrator.sendPrompt("Where are you?");

    expect(prompts).toHaveLength(1);
    expect(String(prompts[0]?.text)).toContain("`/project-b`");
    expect(String(prompts[0]?.text)).toContain("`/original`");
    expect(prompts[0]).toMatchObject({
      target: { directory: "/original", workspaceId: "workspace-1" },
    });
  });

  test("queues busy-session prompts without creating an optimistic turn", async () => {
    const session = makeSession({
      id: "opencode:session-1",
      _harnessId: "opencode",
      _rawId: "session-1",
      _projectDir: "/repo",
      _workspaceId: "workspace-1",
    });
    const model: SelectedModel = { providerID: "openai", modelID: "gpt-5" };
    const state = makeState({
      activeSessionId: session.id,
      sessions: [session],
      busySessionIds: new Set([session.id]),
      selectedModel: model,
    });
    const actions: Array<Record<string, unknown>> = [];
    const prompts: Array<Record<string, unknown>> = [];
    const queued: Array<Record<string, unknown>> = [];

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input);
        },
        abort: async () => undefined,
        queue: {
          enqueue: async (input: Record<string, unknown>) => {
            queued.push(input);
            return [{ id: "queue-1", text: String(input.text), mode: "queue" }];
          },
        },
      } as never,
      createSession: async () => null,
      scheduleSessionMessageReconcile: () => undefined,
      requestSessionAutoName: () => undefined,
      dispatch: (action) => {
        actions.push(action as unknown as Record<string, unknown>);
      },
      sessionCreatingRef: { current: false },
      getFallbackHarnessId: () => "claude-code" as const,
    });

    await orchestrator.sendPrompt("Queue this");

    expect(prompts).toEqual([]);
    expect(queued).toEqual([
      expect.objectContaining({
        sessionId: "opencode:session-1",
        text: "Queue this",
        model,
        mode: "queue",
        insertAt: "back",
        harnessId: "opencode",
        target: { directory: "/repo", workspaceId: "workspace-1" },
      }),
    ]);
    expect(actions).toEqual([
      {
        type: "SET_SESSION_QUEUE",
        payload: {
          sessionID: "opencode:session-1",
          prompts: [{ id: "queue-1", text: "Queue this", mode: "queue" }],
        },
      },
    ]);
  });

  test("queues busy-session prompts even when local Session lacks project directory metadata", async () => {
    const session = makeSession({
      id: "pi:session-1",
      directory: undefined as never,
      _harnessId: "pi",
      _rawId: "session-1",
      _workspaceId: "workspace-1",
    });
    const model: SelectedModel = { providerID: "openai", modelID: "gpt-5" };
    const state = makeState({
      activeSessionId: session.id,
      sessions: [session],
      busySessionIds: new Set([session.id]),
      selectedModel: model,
    });
    const queued: Array<Record<string, unknown>> = [];

    const orchestrator = createLocalIntentOrchestrator({
      getState: () => state,
      getResourceRuntime: () => undefined,
      getCurrentVariant: () => undefined,
      sessionsClient: {
        prompt: async () => undefined,
        abort: async () => undefined,
        queue: {
          enqueue: async (input: Record<string, unknown>) => {
            queued.push(input);
            return [{ id: "queue-1", text: String(input.text), mode: "queue" }];
          },
        },
      } as never,
      createSession: async () => null,
      scheduleSessionMessageReconcile: () => undefined,
      requestSessionAutoName: () => undefined,
      dispatch: () => undefined,
      sessionCreatingRef: { current: false },
      getFallbackHarnessId: () => "claude-code" as const,
    });

    await orchestrator.sendPrompt("Queue without directory");

    expect(queued).toEqual([
      expect.objectContaining({
        sessionId: "pi:session-1",
        text: "Queue without directory",
        model,
        mode: "queue",
        insertAt: "back",
        harnessId: "pi",
        target: { workspaceId: "workspace-1" },
      }),
    ]);
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
      createSession: async () => null,
      scheduleSessionMessageReconcile: (sessionId, projectTarget) => {
        reconciled.push({ sessionId, projectTarget });
      },
      requestSessionAutoName: () => undefined,
      dispatch: () => undefined,
      sessionCreatingRef: { current: false },
      getFallbackHarnessId: () => "claude-code" as const,
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
