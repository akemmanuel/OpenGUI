import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { harnessEventToAdapterObservations } from "../packages/runtime/src/live-session-events/live-session-event-compat.ts";
import {
  rawSessionIdFromWire,
  toLiveSessionScopeSessionId,
} from "../packages/runtime/src/live-session-events/live-session-scope.ts";

describe("live session scope session ids", () => {
  test("canonicalizes raw and prefixed wire ids", () => {
    expect(toLiveSessionScopeSessionId("pi", "s1")).toBe("pi:s1");
    expect(toLiveSessionScopeSessionId("pi", "pi:s1")).toBe("pi:s1");
    expect(rawSessionIdFromWire("pi", "pi:s1")).toBe("s1");
  });

  test("harnessEventToAdapterObservations uses canonical scope.sessionId", () => {
    const observations = harnessEventToAdapterObservations({
      directory: "/tmp/project",
      harnessId: "pi",
      event: { type: "session.status", sessionID: "s1", status: { type: "idle" } },
    });
    expect(observations[0]).toMatchObject({
      kind: "activity",
      scope: { directory: "/tmp/project", harnessId: "pi", sessionId: "pi:s1" },
    });
  });
});
