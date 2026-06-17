import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { executeLocalIntentSendPrompt } from "@/hooks/local-intent-send-prompt";

describe("executeLocalIntentSendPrompt", () => {
  test("prompt-now path prepares text and dispatches immediately", async () => {
    const calls: Array<{ sessionId: string; text: string; mode: string }> = [];
    const dispatchCalls: unknown[] = [];

    await executeLocalIntentSendPrompt({
      text: "fix bug",
      activeSessionId: "s1",
      activeTargetDirectory: null,
      busySessionIds: new Set(),
      sessions: [],
      sessionMeta: {},
      dispatch: (action) => {
        dispatchCalls.push(action);
      },
      resolveSessionId: async () => "s1",
      ensureModelSelectedForNewChat: () => true,
      preparePromptText: (_sid, t) => `prepared:${t}`,
      enqueuePrompt: async () => true,
      dispatchPromptNow: async (sessionId, text, mode) => {
        calls.push({ sessionId, text, mode });
      },
      abortSession: async () => {},
    });

    expect(calls).toEqual([{ sessionId: "s1", text: "prepared:fix bug", mode: "queue" }]);
    expect(dispatchCalls).toHaveLength(0);
  });

  test("busy Session enqueues and aborts on interrupt mode", async () => {
    const enqueueCalls: unknown[] = [];
    const abortCalls: unknown[] = [];

    await executeLocalIntentSendPrompt({
      text: "stop and do this",
      mode: "interrupt",
      activeSessionId: "s1",
      activeTargetDirectory: null,
      busySessionIds: new Set(["s1"]),
      sessions: [],
      sessionMeta: {},
      dispatch: () => {},
      resolveSessionId: async () => "s1",
      ensureModelSelectedForNewChat: () => true,
      preparePromptText: (_sid, t) => t,
      enqueuePrompt: async (input) => {
        enqueueCalls.push(input);
        return true;
      },
      dispatchPromptNow: async () => {},
      abortSession: async (input) => {
        abortCalls.push(input);
      },
    });

    expect(enqueueCalls).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        mode: "interrupt",
        insertAt: "front",
      }),
    ]);
    expect(abortCalls).toEqual([{ sessionId: "s1", harnessId: undefined, target: undefined }]);
  });

  test("after-part sets pending flag after enqueue", async () => {
    const dispatchCalls: unknown[] = [];
    await executeLocalIntentSendPrompt({
      text: "steer",
      mode: "after-part",
      activeSessionId: "s1",
      activeTargetDirectory: null,
      busySessionIds: new Set(["s1"]),
      sessions: [],
      sessionMeta: {},
      dispatch: (action) => {
        dispatchCalls.push(action);
      },
      resolveSessionId: async () => "s1",
      ensureModelSelectedForNewChat: () => true,
      preparePromptText: (_sid, t) => t,
      enqueuePrompt: async () => true,
      dispatchPromptNow: async () => {},
      abortSession: async () => {},
    });

    expect(dispatchCalls).toEqual([
      {
        type: "SET_AFTER_PART_PENDING",
        payload: { sessionID: "s1", pending: true },
      },
    ]);
  });
});
