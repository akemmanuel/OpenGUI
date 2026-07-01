import { describe, expect, test } from "vite-plus/test";
import {
  filterStreamEventsForSession,
  liveSessionEventToAgentStreamEvents,
  streamEventMatchesSession,
} from "@opengui/runtime";

describe("liveSessionEventToAgentStreamEvents", () => {
  test("maps canonical lifecycle events", () => {
    expect(
      liveSessionEventToAgentStreamEvents({
        version: 1,
        id: "evt-1",
        seq: 1,
        type: "run.started",
        scope: { directory: "/repo", harnessId: "pi", sessionId: "raw-1" },
        time: { observed: 1 },
      }),
    ).toEqual([{ type: "run.start", sessionId: "pi:raw-1" }]);
  });

  test("maps canonical text append events", () => {
    expect(
      liveSessionEventToAgentStreamEvents({
        version: 1,
        id: "evt-1",
        seq: 1,
        type: "part.text.appended",
        scope: { directory: "/repo", harnessId: "codex", sessionId: "s1" },
        messageId: "m1",
        partId: "p1",
        partKind: "text",
        text: "hi",
        time: { observed: 1 },
      }),
    ).toEqual([
      { type: "text.delta", sessionId: "codex:s1", messageId: "m1", partId: "p1", delta: "hi" },
    ]);
  });
});

describe("streamEventMatchesSession", () => {
  test("matches frontend id and raw wire id", () => {
    expect(streamEventMatchesSession("pi:raw-1", "pi:raw-1", "pi")).toBe(true);
    expect(streamEventMatchesSession("pi:raw-1", "raw-1", "pi")).toBe(true);
    expect(streamEventMatchesSession("pi:raw-1", "pi:other", "pi")).toBe(false);
  });

  test("filterStreamEventsForSession keeps matching only", () => {
    const events = [
      { type: "run.start" as const, sessionId: "pi:a" },
      { type: "run.start" as const, sessionId: "pi:b" },
    ];
    expect(filterStreamEventsForSession(events, "pi:a", "pi")).toEqual([
      { type: "run.start", sessionId: "pi:a" },
    ]);
  });
});
