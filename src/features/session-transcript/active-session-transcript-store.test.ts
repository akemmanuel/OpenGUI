import { describe, expect, test, vi } from "vite-plus/test";
import type { LiveSessionEvent } from "@opengui/runtime/client";
import type { MessageEntry } from "@/hooks/agent-state-types";
import {
  ActiveSessionTranscriptStore,
  type FrameScheduler,
} from "@/features/session-transcript/active-session-transcript-store";
import type { ActiveTranscriptScope } from "@/features/session-transcript/transcript-input";

const scope: ActiveTranscriptScope = {
  directory: "/repo",
  harnessId: "pi",
  sessionId: "pi:s1",
};

function assistantEntry(id: string, text: string): MessageEntry {
  return {
    info: {
      id,
      sessionID: scope.sessionId,
      role: "assistant",
      time: { created: 1 },
      providerID: "",
      modelID: "",
    },
    parts: [
      { id: `${id}:p1`, sessionID: scope.sessionId, messageID: id, type: "text", text, tokens: {} },
    ],
  };
}

function userEntry(id: string, text: string): MessageEntry {
  return {
    info: {
      id,
      sessionID: scope.sessionId,
      role: "user",
      time: { created: 1 },
      providerID: "nvidia",
      modelID: "gpt-oss-20b",
    },
    parts: [
      {
        id: `${id}:p1`,
        sessionID: scope.sessionId,
        messageID: id,
        type: "text",
        text,
        tokens: {},
      },
    ],
  };
}

function liveEvent(
  partial: Partial<LiveSessionEvent> & Pick<LiveSessionEvent, "type">,
): LiveSessionEvent {
  return {
    version: 1,
    id: partial.id ?? "e-default",
    seq: partial.seq ?? 1,
    scope: {
      directory: scope.directory,
      harnessId: scope.harnessId as "pi",
      sessionId: scope.sessionId,
    },
    time: { observed: 1 },
    ...partial,
  } as LiveSessionEvent;
}

function createTestStore(input?: { onFinalReconcile?: (scope: ActiveTranscriptScope) => void }) {
  const scheduled: Array<() => void> = [];
  const frameScheduler: FrameScheduler = {
    schedule: (cb) => {
      scheduled.push(cb);
      return cb;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle as () => void);
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
  const store = new ActiveSessionTranscriptStore({
    frameScheduler,
    effects: { scheduleFinalReconcile: input?.onFinalReconcile },
  });
  return { store, flushFrames: () => scheduled.splice(0).forEach((cb) => cb()) };
}

function streamOpen(store: ActiveSessionTranscriptStore, flushFrames: () => void) {
  store.select(scope);
  store.ingestLive(liveEvent({ type: "run.started", id: "run-1", seq: 1 }));
  store.ingestLive(
    liveEvent({
      type: "message.started",
      id: "m-start",
      seq: 2,
      messageId: "m1",
      role: "assistant",
    }),
  );
  store.ingestLive(
    liveEvent({
      type: "part.started",
      id: "p-start",
      seq: 3,
      messageId: "m1",
      partId: "p1",
      partKind: "text",
    }),
  );
  store.ingestLive(
    liveEvent({
      type: "part.text.appended",
      id: "d1",
      seq: 4,
      messageId: "m1",
      partId: "p1",
      partKind: "text",
      text: "OP",
    }),
  );
  store.ingestLive(
    liveEvent({
      type: "part.text.appended",
      id: "d2",
      seq: 5,
      messageId: "m1",
      partId: "p1",
      partKind: "text",
      text: "EN",
    }),
  );
  flushFrames();
}

describe("ActiveSessionTranscriptStore", () => {
  test("batches live appends into one revision per flushed frame", () => {
    const revisions: number[] = [];
    const { store, flushFrames } = createTestStore();
    store.subscribe((snap) => revisions.push(snap.revision));

    store.select(scope);
    store.ingestLive(
      liveEvent({
        type: "part.text.appended",
        id: "a1",
        seq: 1,
        messageId: "m1",
        partId: "p1",
        partKind: "text",
        text: "a",
      }),
    );
    store.ingestLive(
      liveEvent({
        type: "part.text.appended",
        id: "a2",
        seq: 2,
        messageId: "m1",
        partId: "p1",
        partKind: "text",
        text: "b",
      }),
    );
    expect(revisions).toEqual([1]);
    flushFrames();
    expect(revisions.at(-1)).toBe(2);
    expect(store.getSnapshot().messages[0]?.parts[0]).toMatchObject({ text: "ab" });
  });

  test("duplicate backend event ids do not duplicate text", () => {
    const { store, flushFrames } = createTestStore();
    store.select(scope);
    const append = liveEvent({
      type: "part.text.appended",
      id: "dup",
      seq: 10,
      messageId: "m1",
      partId: "p1",
      partKind: "text",
      text: "X",
    });
    store.ingestLive(append);
    store.ingestLive(append);
    flushFrames();
    expect(store.getSnapshot().messages[0]?.parts[0]).toMatchObject({ text: "X" });
  });

  test("prompt history selector stays stable across assistant token streaming", () => {
    const { store, flushFrames } = createTestStore();
    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [userEntry("u1", "build it")],
      hasMore: false,
      nextCursor: null,
      phase: "initial",
    });
    const before = store.getPromptHistory();

    store.ingestLive(
      liveEvent({
        type: "part.text.appended",
        id: "assistant-token",
        seq: 20,
        messageId: "a1",
        partId: "p1",
        partKind: "text",
        text: "streaming",
      }),
    );
    flushFrames();

    expect(store.getPromptHistory()).toBe(before);
    expect(store.getPromptHistory()).toEqual(["build it"]);
  });

  test("stale transcript page cannot shorten live text while running", () => {
    const { store, flushFrames } = createTestStore();
    streamOpen(store, flushFrames);
    expect(store.getSnapshot().messages[0]?.parts[0]).toMatchObject({ text: "OPEN" });

    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [assistantEntry("m1", "OP")],
      hasMore: false,
      nextCursor: null,
      phase: "initial",
    });

    expect(store.getSnapshot().messages[0]?.parts[0]).toMatchObject({ text: "OPEN" });
  });

  test("live tool events retain input and output for the message list", () => {
    const { store, flushFrames } = createTestStore();
    store.select(scope);

    store.ingestLive(
      liveEvent({
        type: "tool.started",
        id: "tool-start",
        seq: 1,
        messageId: "m1",
        partId: "tool-1",
        tool: "read",
      }),
    );
    store.ingestLive(
      liveEvent({
        type: "tool.input.updated",
        id: "tool-input",
        seq: 2,
        messageId: "m1",
        partId: "tool-1",
        input: { path: "package.json" },
      }),
    );
    store.ingestLive(
      liveEvent({
        type: "tool.output.replaced",
        id: "tool-output",
        seq: 3,
        messageId: "m1",
        partId: "tool-1",
        text: '{"name":"opengui"}',
        reason: "snapshot-rewrite",
      }),
    );
    store.ingestLive(
      liveEvent({
        type: "tool.finished",
        id: "tool-finished",
        seq: 4,
        messageId: "m1",
        partId: "tool-1",
        status: "completed",
      }),
    );
    flushFrames();

    expect(store.getSnapshot().messages[0]?.parts[0]).toMatchObject({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "package.json" },
        output: '{"name":"opengui"}',
      },
    });
  });

  test("run.finished schedules final reconcile once per burst", () => {
    vi.useFakeTimers();
    const reconcile = vi.fn();
    const { store } = createTestStore({ onFinalReconcile: reconcile });
    store.select(scope);

    store.ingestLive(liveEvent({ type: "run.finished", id: "f1", seq: 1, reason: "idle" }));
    vi.advanceTimersByTime(450);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(scope);

    vi.useRealTimers();
  });

  test("pending live frame commit is dropped after session switch", () => {
    const other: ActiveTranscriptScope = {
      directory: "/repo",
      harnessId: "pi",
      sessionId: "pi:other",
    };
    const scheduled: Array<() => void> = [];
    const frameScheduler: FrameScheduler = {
      schedule: (cb) => {
        scheduled.push(cb);
        return cb;
      },
      cancel: (handle) => {
        const index = scheduled.indexOf(handle as () => void);
        if (index >= 0) scheduled.splice(index, 1);
      },
    };
    const store = new ActiveSessionTranscriptStore({ frameScheduler });
    store.select(scope);
    store.ingestLive(
      liveEvent({
        type: "part.text.appended",
        id: "pre-switch",
        seq: 1,
        messageId: "m1",
        partId: "p1",
        partKind: "text",
        text: "draft",
      }),
    );
    expect(scheduled).toHaveLength(1);
    store.select(other);
    expect(store.getSnapshot().phase).toBe("loading");
    expect(store.getSnapshot().messages).toEqual([]);
    scheduled.splice(0).forEach((cb) => cb());
    expect(store.getSnapshot().phase).toBe("loading");
    expect(store.getSnapshot().messages).toEqual([]);
  });

  test("switching active session ignores late live events for the old scope", () => {
    const other: ActiveTranscriptScope = {
      directory: "/repo",
      harnessId: "pi",
      sessionId: "pi:other",
    };
    const { store, flushFrames } = createTestStore();
    store.select(scope);
    store.select(other);
    store.ingestLive(
      liveEvent({
        type: "part.text.appended",
        id: "late",
        seq: 99,
        messageId: "m1",
        partId: "p1",
        partKind: "text",
        text: "late",
      }),
    );
    flushFrames();
    expect(store.getSnapshot().scope).toEqual(other);
    expect(store.getSnapshot().messages).toEqual([]);
  });

  test("re-selecting the same scope does not clear messages or enter loading", () => {
    const { store } = createTestStore();
    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [assistantEntry("m1", "hello")],
      hasMore: false,
      nextCursor: null,
      phase: "initial",
    });
    store.select(scope);
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("ready");
    expect(snap.messages).toHaveLength(1);
  });

  test("final page replace is authoritative when not running", () => {
    const { store } = createTestStore();
    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [assistantEntry("m1", "final")],
      hasMore: false,
      nextCursor: null,
      phase: "final",
    });
    expect(store.getSnapshot().messages[0]?.parts[0]).toMatchObject({ text: "final" });
  });

  test("final page lag does not erase streamed assistant while session settles", () => {
    const { store } = createTestStore();
    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [userEntry("u1", "hi"), assistantEntry("a1", "streamed answer")],
      hasMore: false,
      nextCursor: null,
      phase: "initial",
    });

    store.ingestLive(liveEvent({ type: "run.finished", id: "done", seq: 20, reason: "idle" }));
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [userEntry("u1", "hi")],
      hasMore: false,
      nextCursor: null,
      phase: "final",
    });

    expect(store.getSnapshot().messages.map((message) => message.info.id)).toEqual(["u1", "a1"]);
  });

  test("transcript replacement renames streaming assistant to canonical id", () => {
    const { store } = createTestStore();
    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [userEntry("u1", "hi"), assistantEntry("old-assistant", "Hello")],
      hasMore: false,
      nextCursor: null,
      phase: "initial",
    });

    store.ingestLive(
      liveEvent({
        type: "transcript.rebased",
        id: "replace-1",
        seq: 10,
        reason: "harness-replaced-message",
        replacement: {
          oldMessageId: "old-assistant",
          newMessageId: "real-assistant",
        },
      }),
    );

    expect(store.getSnapshot().messages.map((message) => message.info.id)).toEqual([
      "u1",
      "real-assistant",
    ]);
    expect(store.getSnapshot().messages[1]?.parts[0]).toMatchObject({
      text: "Hello",
      messageID: "real-assistant",
    });
  });

  test("pi harness replacement keeps streamed parts then applies canonical snapshots", () => {
    const { store, flushFrames } = createTestStore();
    const syntheticId = "pi:stream:s1:assistant:0";
    const canonicalId = "08e70fe2";

    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [userEntry("u1", "hi")],
      hasMore: false,
      nextCursor: null,
      phase: "initial",
    });
    store.ingestLive(liveEvent({ type: "run.started", id: "run-1", seq: 1 }));
    store.ingestLive(
      liveEvent({
        type: "message.started",
        id: "m1",
        seq: 2,
        messageId: syntheticId,
        role: "assistant",
      }),
    );
    store.ingestLive(
      liveEvent({
        type: "part.started",
        id: "p1",
        seq: 3,
        messageId: syntheticId,
        partId: `${syntheticId}:reasoning:0`,
        partKind: "thinking",
      }),
    );
    store.ingestLive(
      liveEvent({
        type: "part.text.appended",
        id: "p2",
        seq: 4,
        messageId: syntheticId,
        partId: `${syntheticId}:reasoning:0`,
        partKind: "thinking",
        text: "planning",
      }),
    );
    flushFrames();

    store.ingestLive(
      liveEvent({
        type: "transcript.rebased",
        id: "reb",
        seq: 5,
        reason: "harness-replaced-message",
        replacement: { oldMessageId: syntheticId, newMessageId: canonicalId },
      }),
    );
    store.ingestLive(
      liveEvent({
        type: "message.started",
        id: "m2",
        seq: 6,
        messageId: canonicalId,
        role: "assistant",
      }),
    );
    store.ingestLive(
      liveEvent({
        type: "part.text.replaced",
        id: "p3",
        seq: 7,
        messageId: canonicalId,
        partId: `${canonicalId}:text:0`,
        partKind: "text",
        text: "done",
        reason: "snapshot-rewrite",
      }),
    );
    flushFrames();

    const snap = store.getSnapshot();
    expect(snap.messages.map((m) => m.info.id)).toEqual(["u1", canonicalId]);
    const assistant = snap.messages[1]!;
    expect(assistant.parts.some((p) => p.type === "reasoning" && p.text === "planning")).toBe(true);
    expect(assistant.parts.some((p) => p.type === "text" && p.text === "done")).toBe(true);
  });

  test("older page remains visible when the active transcript already has many messages", () => {
    const { store } = createTestStore();
    const current = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0
        ? userEntry(`live-${i}`, `current ${i}`)
        : assistantEntry(`live-${i}`, `current ${i}`),
    );
    const older = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? userEntry(`older-${i}`, `older ${i}`)
        : assistantEntry(`older-${i}`, `older ${i}`),
    );

    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: current,
      hasMore: true,
      nextCursor: "older-cursor",
      phase: "initial",
    });
    expect(store.beginLoadOlder()).toBe(true);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: older,
      hasMore: false,
      nextCursor: null,
      phase: "older",
    });

    const snap = store.getSnapshot();
    expect(snap.messages).toHaveLength(1030);
    expect(snap.messages.slice(0, 30).map((message) => message.info.id)).toEqual(
      older.map((message) => message.info.id),
    );
    expect(snap.hasOlder).toBe(false);
    expect(snap.loadingOlder).toBe(false);
  });

  test("older page failure keeps the transcript visible and retryable", () => {
    const { store } = createTestStore();
    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [userEntry("u1", "hello")],
      hasMore: true,
      nextCursor: "older-cursor",
      phase: "initial",
    });
    expect(store.beginLoadOlder()).toBe(true);

    store.dispatch({
      type: "page.failed",
      scope,
      error: "boom",
      phase: "older",
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("ready");
    expect(snap.messages.map((message) => message.info.id)).toEqual(["u1"]);
    expect(snap.hasOlder).toBe(true);
    expect(snap.olderCursor).toBe("older-cursor");
    expect(snap.loadingOlder).toBe(false);
    expect(snap.olderError).toBe("boom");
  });
});
