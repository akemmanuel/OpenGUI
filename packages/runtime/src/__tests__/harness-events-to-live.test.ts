import { describe, expect, test } from "vite-plus/test";
import { LiveSessionEventBus } from "../live-session-events/live-session-event-bus.ts";
import { harnessEventsToLiveSessionEvents } from "../live-session-events/harness-events-to-live.ts";

describe("harnessEventsToLiveSessionEvents", () => {
  test("session.status idle yields run lifecycle when preceded by running", () => {
    const bus = new LiveSessionEventBus();
    const base = { directory: "/repo", harnessId: "pi" as const, bus };
    harnessEventsToLiveSessionEvents({
      ...base,
      event: {
        type: "session.status" as const,
        sessionID: "s1",
        status: { type: "running" as const },
      },
    });
    const idle = harnessEventsToLiveSessionEvents({
      ...base,
      event: { type: "session.status", sessionID: "s1", status: { type: "idle" } },
    });
    expect(idle.some((e) => e.type === "run.finished")).toBe(true);
  });
});
