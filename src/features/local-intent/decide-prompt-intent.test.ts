import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { decidePromptIntentDispatch } from "@/features/local-intent/decide-prompt-intent";

describe("decidePromptIntentDispatch", () => {
  test("returns no dispatch when there is no Session entry", () => {
    expect(
      decidePromptIntentDispatch({
        sessionId: null,
        busySessionIds: new Set(),
      }),
    ).toBeNull();
  });

  test("prompts now by default", () => {
    expect(
      decidePromptIntentDispatch({
        sessionId: "session-1",
        busySessionIds: new Set(),
      }),
    ).toEqual({
      type: "prompt-now",
      sessionId: "session-1",
      mode: "queue",
    });
  });

  test("queues ordinary prompts at the back when the Session is busy", () => {
    expect(
      decidePromptIntentDispatch({
        sessionId: "session-1",
        busySessionIds: new Set(["session-1"]),
      }),
    ).toEqual({
      type: "queue-prompt",
      sessionId: "session-1",
      mode: "queue",
      insertAt: "back",
    });
  });

  test("queues interrupt prompts at the front when the Session is busy", () => {
    expect(
      decidePromptIntentDispatch({
        sessionId: "session-1",
        requestedMode: "interrupt",
        busySessionIds: new Set(["session-1"]),
      }),
    ).toEqual({
      type: "queue-prompt",
      sessionId: "session-1",
      mode: "interrupt",
      insertAt: "front",
    });
  });

  test("queues after-part prompts at the front when the Session is busy", () => {
    expect(
      decidePromptIntentDispatch({
        sessionId: "session-1",
        requestedMode: "after-part",
        busySessionIds: new Set(["session-1"]),
      }),
    ).toEqual({
      type: "queue-after-part",
      sessionId: "session-1",
      mode: "after-part",
      insertAt: "front",
    });
  });

  test("sends after-part prompts immediately when the Session is idle", () => {
    expect(
      decidePromptIntentDispatch({
        sessionId: "session-1",
        requestedMode: "after-part",
        busySessionIds: new Set(),
      }),
    ).toEqual({
      type: "prompt-now",
      sessionId: "session-1",
      mode: "after-part",
    });
  });
});
