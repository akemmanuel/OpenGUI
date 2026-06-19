import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { LiveSessionEvent } from "@opengui/runtime/client";
import { dispatchLiveSessionActivity } from "@/features/session-transcript/live-session-activity";

const scope = { directory: "/repo", harnessId: "pi" as const, sessionId: "pi:s1" };
const projectKeys = new Set(["local\u0000/repo"]);

function liveEvent(
  partial: Partial<LiveSessionEvent> & Pick<LiveSessionEvent, "type">,
): LiveSessionEvent {
  return {
    version: 1,
    id: "e1",
    seq: 1,
    scope,
    time: { observed: 1 },
    ...partial,
  } as LiveSessionEvent;
}

describe("dispatchLiveSessionActivity", () => {
  test("maps run.started and run.finished to SESSION_STATUS", () => {
    const actions: Array<Record<string, unknown>> = [];
    dispatchLiveSessionActivity({
      event: liveEvent({ type: "run.started", seq: 1 }),
      expectedProjectKeys: projectKeys,
      dispatch: (action) => actions.push(action),
    });
    dispatchLiveSessionActivity({
      event: liveEvent({ type: "run.finished", reason: "idle", seq: 2 }),
      expectedProjectKeys: projectKeys,
      dispatch: (action) => actions.push(action),
    });

    expect(actions).toEqual([
      { type: "SESSION_STATUS", payload: { sessionID: "pi:s1", status: { type: "busy" } } },
      { type: "SESSION_STATUS", payload: { sessionID: "pi:s1", status: { type: "idle" } } },
    ]);
  });

  test("does not emit transcript actions for part.text.appended", () => {
    const actions: unknown[] = [];
    dispatchLiveSessionActivity({
      event: liveEvent({
        type: "part.text.appended",
        messageId: "m1",
        partId: "p1",
        partKind: "text",
        text: "x",
      }),
      expectedProjectKeys: projectKeys,
      dispatch: (action) => actions.push(action),
    });
    expect(actions).toEqual([]);
  });

  test("drops events outside expected project scope", () => {
    const actions: unknown[] = [];
    dispatchLiveSessionActivity({
      event: liveEvent({ type: "run.started" }),
      expectedProjectKeys: new Set(["local\u0000/other"]),
      dispatch: (action) => actions.push(action),
    });
    expect(actions).toEqual([]);
  });
});
