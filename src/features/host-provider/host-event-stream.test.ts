import { describe, expect, it, vi } from "vite-plus/test";
import type { HostEvent } from "@/protocol/host-types";
import {
  createHostEventDispatcher,
  isTerminalHostEvent,
  reduceBusySessionIds,
} from "./host-event-stream";

function entryEvent(kind: string): HostEvent {
  return {
    sessionId: "session-1",
    event: {
      type: "entry_appended",
      entry: {
        id: `entry-${kind}`,
        sessionId: "session-1",
        sequence: 1,
        kind,
        payload: {},
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    },
  };
}

describe("Host event dispatch", () => {
  it("recognizes every terminal run event", () => {
    for (const kind of ["run_completed", "run_failed", "run_aborted", "run_interrupted"]) {
      expect(isTerminalHostEvent(entryEvent(kind))).toBe(true);
    }
    expect(isTerminalHostEvent(entryEvent("run_started"))).toBe(false);
  });

  it("coordinates busy state and refreshes only after terminal events", async () => {
    let busy = new Set<string>();
    const refreshSessions = vi.fn(async () => {});
    const dispatch = createHostEventDispatcher({
      activeStreamRef: { current: null },
      setActiveSnapshot: vi.fn(),
      setBusySessionIds: (update) => {
        busy = typeof update === "function" ? update(busy) : update;
      },
      transcriptStore: { dispatch: vi.fn() } as never,
      refreshSessions,
    });

    dispatch(entryEvent("run_started"));
    expect(busy.has("session-1")).toBe(true);
    expect(refreshSessions).not.toHaveBeenCalled();

    dispatch(entryEvent("run_completed"));
    expect(busy.has("session-1")).toBe(false);
    expect(refreshSessions).toHaveBeenCalledOnce();
  });

  it("marks assistant deltas busy without touching an inactive transcript", () => {
    let busy = new Set<string>();
    const transcriptStore = { dispatch: vi.fn() };
    const dispatch = createHostEventDispatcher({
      activeStreamRef: { current: null },
      setActiveSnapshot: vi.fn(),
      setBusySessionIds: (update) => {
        busy = typeof update === "function" ? update(busy) : update;
      },
      transcriptStore: transcriptStore as never,
      refreshSessions: vi.fn(async () => {}),
    });

    dispatch({
      sessionId: "background-session",
      event: { type: "assistant_delta", runId: "run-1", delta: "hello" },
    });

    expect(busy.has("background-session")).toBe(true);
    expect(transcriptStore.dispatch).not.toHaveBeenCalled();
  });

  it("preserves busy-state identity when an event does not change it", () => {
    const idle = new Set<string>();
    expect(reduceBusySessionIds(idle, entryEvent("user_message"))).toBe(idle);

    const busy = new Set(["session-1"]);
    expect(
      reduceBusySessionIds(busy, {
        sessionId: "session-1",
        event: { type: "assistant_delta", runId: "run-1", delta: "hello" },
      }),
    ).toBe(busy);
  });

  it("removes a Follow-up projection when its User message is dispatched", () => {
    const onFollowUpDispatched = vi.fn();
    const dispatch = createHostEventDispatcher({
      activeStreamRef: { current: null },
      setActiveSnapshot: vi.fn(),
      setBusySessionIds: vi.fn(),
      transcriptStore: { dispatch: vi.fn() } as never,
      refreshSessions: vi.fn(async () => {}),
      onFollowUpDispatched,
    });
    const event = entryEvent("user_message");
    if (event.event.type === "entry_appended") {
      event.event.entry.payload = { followUpId: "follow-up-1" };
    }

    dispatch(event);

    expect(onFollowUpDispatched).toHaveBeenCalledWith("session-1", "follow-up-1");
  });
});
