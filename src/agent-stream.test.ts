import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessEvent } from "./agents/backend.ts";
import {
  filterStreamEventsForSession,
  harnessEventToAgentStreamEvents,
  streamEventMatchesSession,
} from "@opengui/runtime";

describe("harnessEventToAgentStreamEvents", () => {
  test("maps session.status running to run.start", () => {
    const event: HarnessEvent = {
      type: "session.status",
      sessionID: "pi:raw-1",
      status: { type: "running" },
    };
    expect(harnessEventToAgentStreamEvents(event, { harnessId: "pi" })).toEqual([
      { type: "run.start", sessionId: "pi:raw-1" },
    ]);
  });

  test("maps session.status idle to run.end", () => {
    const event: HarnessEvent = {
      type: "session.status",
      sessionID: "raw-2",
      status: { type: "idle" },
    };
    expect(harnessEventToAgentStreamEvents(event, { harnessId: "pi" })).toEqual([
      { type: "run.end", sessionId: "pi:raw-2", reason: "idle" },
    ]);
  });

  test("maps message.part.delta text field", () => {
    const event: HarnessEvent = {
      type: "message.part.delta",
      sessionID: "codex:s1",
      messageID: "m1",
      partID: "p1",
      field: "text",
      delta: "hi",
    };
    expect(harnessEventToAgentStreamEvents(event, { harnessId: "codex" })).toEqual([
      {
        type: "text.delta",
        sessionId: "codex:s1",
        messageId: "m1",
        partId: "p1",
        delta: "hi",
      },
    ]);
  });

  test("maps message.part.delta reasoning field to thinking.delta", () => {
    const event: HarnessEvent = {
      type: "message.part.delta",
      sessionID: "claude-code:s1",
      messageID: "m1",
      partID: "p1",
      field: "reasoning",
      delta: "think",
    };
    const mapped = harnessEventToAgentStreamEvents(event, { harnessId: "claude-code" });
    expect(mapped[0]?.type).toBe("thinking.delta");
  });

  test("maps tool part running to tool.start", () => {
    const event: HarnessEvent = {
      type: "message.part.updated",
      part: {
        id: "part-1",
        sessionID: "pi:sess",
        messageID: "msg-1",
        type: "tool",
        tool: "read",
        tokens: {},
        state: { status: "running" },
      },
    };
    expect(harnessEventToAgentStreamEvents(event, { harnessId: "pi" })).toEqual([
      {
        type: "tool.start",
        sessionId: "pi:sess",
        messageId: "msg-1",
        partId: "part-1",
        tool: "read",
      },
    ]);
  });

  test("maps session.error to error and run.end", () => {
    const event: HarnessEvent = {
      type: "session.error",
      sessionID: "pi:abc",
      error: "auth failed",
    };
    expect(harnessEventToAgentStreamEvents(event, { harnessId: "pi" })).toEqual([
      { type: "error", sessionId: "pi:abc", message: "auth failed" },
      { type: "run.end", sessionId: "pi:abc", reason: "error" },
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
