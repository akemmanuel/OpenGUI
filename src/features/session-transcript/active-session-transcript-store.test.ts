import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
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
});
