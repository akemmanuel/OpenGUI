import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { decidePromptIntentDispatch } from "@/hooks/local-intent-orchestration";

describe("decidePromptIntentDispatch", () => {
  test("returns no dispatch when there is no Session entry", () => {
    expect(
      decidePromptIntentDispatch({
        entry: { type: "missing-session" },
        busySessionIds: new Set(),
      }),
    ).toBeNull();
  });

  test("prompts now by default", () => {
    expect(
      decidePromptIntentDispatch({
        entry: { type: "use-session", sessionId: "session-1", createdFromActiveTarget: false },
        busySessionIds: new Set(),
      }),
    ).toEqual({ type: "prompt-now", sessionId: "session-1", mode: "queue" });
  });

  test("queues after-part prompts at the front when the Session is busy", () => {
    expect(
      decidePromptIntentDispatch({
        entry: { type: "use-session", sessionId: "session-1", createdFromActiveTarget: false },
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
        entry: { type: "use-session", sessionId: "session-1", createdFromActiveTarget: false },
        requestedMode: "after-part",
        busySessionIds: new Set(),
      }),
    ).toEqual({ type: "prompt-now", sessionId: "session-1", mode: "after-part" });
  });
});
