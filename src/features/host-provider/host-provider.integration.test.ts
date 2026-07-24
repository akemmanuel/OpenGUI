import { describe, expect, test, vi } from "vite-plus/test";
import { ActiveSessionTranscriptStore } from "@/features/session-transcript/active-session-transcript-store";
import { createHostTranscriptStream } from "@/protocol/host-transcript";
import type { HostSessionSnapshot } from "@/protocol/host-types";
import {
  createHostEventDispatcher,
  createHostReconnectHandler,
  hostEventSubscriptionSession,
} from "./host-event-stream";
import { resolveRestoredSessionId } from "./host-domain-state";

function runningSnapshot(): HostSessionSnapshot {
  return {
    id: "session-1",
    projectDirectory: "/project",
    title: "Build",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    status: "running",
    model: { connectionId: "openai", modelId: "gpt-4.1" },
    reasoning: "medium",
    entries: [],
    followUps: [],
  };
}

describe("HostProvider public event pipeline", () => {
  test("scopes live events to the selected Session for restricted remote actors", () => {
    expect(hostEventSubscriptionSession(null)).toBeUndefined();
    expect(hostEventSubscriptionSession("shared-session")).toBe("shared-session");
  });

  test("restores the saved active Session only when the Host still lists it", () => {
    expect(resolveRestoredSessionId(null, "session-2", ["session-1", "session-2"])).toBe(
      "session-2",
    );
    expect(resolveRestoredSessionId(null, "deleted", ["session-1"])).toBeNull();
    expect(resolveRestoredSessionId("session-1", "session-2", ["session-1", "session-2"])).toBe(
      "session-1",
    );
  });
  test("rehydrates the active Session after reconnect but not initial stream readiness", async () => {
    const hydrateTranscript = vi.fn(async () => {});
    const connected = createHostReconnectHandler({
      activeSessionIdRef: { current: "session-1" },
      hydrateTranscript,
    });

    connected();
    expect(hydrateTranscript).not.toHaveBeenCalled();
    connected();
    await Promise.resolve();
    expect(hydrateTranscript).toHaveBeenCalledWith("session-1");
  });

  test("projects ordered deltas and durable tool output through the real transcript store", () => {
    const snapshot = runningSnapshot();
    const scope = { directory: snapshot.projectDirectory, sessionId: snapshot.id };
    const transcriptStore = new ActiveSessionTranscriptStore();
    transcriptStore.select(scope);
    const activeStreamRef = { current: createHostTranscriptStream(snapshot) };
    let busy = new Set<string>();
    const dispatch = createHostEventDispatcher({
      activeStreamRef,
      setActiveSnapshot: () => {},
      setBusySessionIds: (update) => {
        busy = typeof update === "function" ? update(busy) : update;
      },
      transcriptStore,
      refreshSessions: async () => {},
    });

    dispatch({
      sessionId: snapshot.id,
      event: { type: "assistant_delta", runId: "run-1", delta: "Working" },
    });
    dispatch({
      sessionId: snapshot.id,
      event: {
        type: "entry_appended",
        entry: {
          id: "call-1",
          sessionId: snapshot.id,
          sequence: 1,
          kind: "tool_call",
          payload: {
            runId: "run-1",
            toolCallId: "tool-1",
            name: "shell",
            input: { command: "check" },
          },
          createdAt: "2026-07-01T00:00:01.000Z",
        },
      },
    });
    dispatch({
      sessionId: snapshot.id,
      event: {
        type: "entry_appended",
        entry: {
          id: "result-1",
          sessionId: snapshot.id,
          sequence: 2,
          kind: "tool_result",
          payload: {
            runId: "run-1",
            toolCallId: "tool-1",
            name: "shell",
            output: { output: "passed\n", exitCode: 0 },
          },
          createdAt: "2026-07-01T00:00:02.000Z",
        },
      },
    });

    expect(busy.has(snapshot.id)).toBe(true);
    const parts = transcriptStore.getSnapshot().messages.flatMap((message) => message.parts);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Working" }),
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({ status: "completed", output: "passed\n" }),
        }),
      ]),
    );
  });
});
