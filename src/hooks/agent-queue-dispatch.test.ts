import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Session } from "@/hooks/agent-state-types";
import type { QueuedPrompt } from "@/lib/session-drafts";
import {
  applyQueueDispatchDecision,
  dispatchNextQueuedPrompt,
  processAfterPartQueueTriggers,
  processBusyToIdleTransitions,
  sendQueuedPromptNow,
} from "./agent-queue-dispatch";

function makeQueuedPrompt(
  input: Partial<QueuedPrompt> & Pick<QueuedPrompt, "id" | "text">,
): QueuedPrompt {
  return {
    createdAt: 1,
    mode: "queue",
    ...input,
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

describe("applyQueueDispatchDecision", () => {
  test("adds, reorders, and aborts interrupt prompts", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const aborts: Array<Record<string, unknown>> = [];

    await applyQueueDispatchDecision({
      sessionId: "session-1",
      decision: {
        type: "queue",
        prompt: makeQueuedPrompt({ id: "prompt-1", text: "interrupt" }),
        insertAt: "front",
        shouldAbort: true,
        shouldSetAfterPartPending: false,
      },
      existingQueueLength: 2,
      abortSession: async (input) => {
        aborts.push(input);
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([
      {
        type: "QUEUE_ADD",
        payload: {
          sessionID: "session-1",
          prompt: expect.objectContaining({ id: "prompt-1", text: "interrupt" }),
        },
      },
      {
        type: "QUEUE_REORDER",
        payload: { sessionID: "session-1", fromIndex: 2, toIndex: 0 },
      },
    ]);
    expect(aborts).toEqual([{ sessionId: "session-1" }]);
  });

  test("marks after-part prompts without aborting", async () => {
    const actions: Array<Record<string, unknown>> = [];

    await applyQueueDispatchDecision({
      sessionId: "session-1",
      decision: {
        type: "queue",
        prompt: makeQueuedPrompt({ id: "prompt-1", text: "after part" }),
        insertAt: "front",
        shouldAbort: false,
        shouldSetAfterPartPending: true,
      },
      existingQueueLength: 0,
      abortSession: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([
      {
        type: "QUEUE_ADD",
        payload: {
          sessionID: "session-1",
          prompt: expect.objectContaining({ id: "prompt-1", text: "after part" }),
        },
      },
      {
        type: "SET_AFTER_PART_PENDING",
        payload: { sessionID: "session-1", pending: true },
      },
    ]);
  });
});

describe("dispatchNextQueuedPrompt", () => {
  test("shifts and dispatches the next queued prompt once", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const dispatched: Array<Record<string, unknown>> = [];
    const dispatching = new Set<string>();

    await dispatchNextQueuedPrompt({
      sessionId: "session-1",
      queue: [
        makeQueuedPrompt({
          id: "prompt-1",
          text: "ship it",
          images: ["one.png"],
          model: { providerID: "openai", modelID: "gpt-5" },
          agent: "reviewer",
          variant: "high",
        }),
      ],
      dispatchingSessionIds: dispatching,
      preparePromptText: (_sessionId, text) => `[prepared] ${text}`,
      dispatchPromptDirect: async (sessionId, text, images, model, agent, variant) => {
        dispatched.push({ sessionId, text, images, model, agent, variant });
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([{ type: "QUEUE_SHIFT", payload: { sessionID: "session-1" } }]);
    expect(dispatched).toEqual([
      {
        sessionId: "session-1",
        text: "[prepared] ship it",
        images: ["one.png"],
        model: { providerID: "openai", modelID: "gpt-5" },
        agent: "reviewer",
        variant: "high",
      },
    ]);
    expect(dispatching.size).toBe(0);
  });
});

describe("processBusyToIdleTransitions", () => {
  test("dispatches queued prompts and refreshes the active session", () => {
    const queued: string[] = [];
    const refreshed: Array<Record<string, unknown>> = [];

    const result = processBusyToIdleTransitions({
      previousBusySessionIds: new Set(["session-1", "session-2"]),
      currentBusySessionIds: new Set(["session-2"]),
      activeSessionId: "session-1",
      sessions: [
        makeSession({
          id: "session-1",
          _projectDir: "/repo",
          _workspaceId: "workspace-1",
        }),
      ],
      dispatchNextQueued: async (sessionId) => {
        queued.push(sessionId);
      },
      refreshSessionMessages: async (sessionId, projectTarget) => {
        refreshed.push({ sessionId, projectTarget });
      },
    });

    expect(result).toEqual({ "session-1": true });
    expect(queued).toEqual(["session-1"]);
    expect(refreshed).toEqual([
      {
        sessionId: "session-1",
        projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
      },
    ]);
  });
});

describe("processAfterPartQueueTriggers", () => {
  test("clears the trigger and aborts each session", () => {
    const actions: Array<Record<string, unknown>> = [];
    const aborts: Array<Record<string, unknown>> = [];

    processAfterPartQueueTriggers({
      sessionIds: ["session-1", "session-2"],
      abortSession: async (input) => {
        aborts.push(input);
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([
      {
        type: "CLEAR_AFTER_PART_TRIGGERED",
        payload: { sessionID: "session-1" },
      },
      {
        type: "CLEAR_AFTER_PART_TRIGGERED",
        payload: { sessionID: "session-2" },
      },
    ]);
    expect(aborts).toEqual([{ sessionId: "session-1" }, { sessionId: "session-2" }]);
  });
});

describe("sendQueuedPromptNow", () => {
  test("reorders to the front and aborts when the session is still busy", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const aborts: Array<Record<string, unknown>> = [];

    await sendQueuedPromptNow({
      sessionId: "session-1",
      promptId: "prompt-2",
      queue: [
        makeQueuedPrompt({ id: "prompt-1", text: "first" }),
        makeQueuedPrompt({ id: "prompt-2", text: "second" }),
      ],
      isBusy: true,
      abortSession: async (input) => {
        aborts.push(input);
      },
      dispatchPromptDirect: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([
      {
        type: "QUEUE_REORDER",
        payload: { sessionID: "session-1", fromIndex: 1, toIndex: 0 },
      },
    ]);
    expect(aborts).toEqual([{ sessionId: "session-1" }]);
  });

  test("removes and sends the prompt immediately when the session is idle", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const dispatched: Array<Record<string, unknown>> = [];

    await sendQueuedPromptNow({
      sessionId: "session-1",
      promptId: "prompt-2",
      queue: [
        makeQueuedPrompt({ id: "prompt-1", text: "first" }),
        makeQueuedPrompt({ id: "prompt-2", text: "second", images: ["two.png"] }),
      ],
      isBusy: false,
      abortSession: async () => undefined,
      dispatchPromptDirect: async (sessionId, text, images) => {
        dispatched.push({ sessionId, text, images });
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([
      {
        type: "QUEUE_REMOVE",
        payload: { sessionID: "session-1", promptID: "prompt-2" },
      },
    ]);
    expect(dispatched).toEqual([
      {
        sessionId: "session-1",
        text: "second",
        images: ["two.png"],
      },
    ]);
  });
});
