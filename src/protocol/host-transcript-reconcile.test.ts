import { describe, expect, test } from "vite-plus/test";
import type { HostSessionEntry, HostSessionSnapshot } from "./host-types";
import {
  applyHostTranscriptEvent,
  createHostTranscriptStream,
  projectHostTranscriptStream,
} from "./host-transcript";
import { reconcileHostTranscriptRead } from "./host-transcript-reconcile";

function entry(
  kind: HostSessionEntry["kind"],
  sequence: number,
  runId = "run-1",
): HostSessionEntry {
  return {
    id: `entry-${sequence}`,
    sessionId: "session-1",
    kind,
    sequence,
    payload: { runId, text: "Working" },
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
  };
}
function snapshot(entries: HostSessionEntry[]): HostSessionSnapshot {
  return {
    id: "session-1",
    projectDirectory: "/project",
    title: "Test",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries,
    followUps: [],
    model: null,
    reasoning: null,
  };
}

describe("reconcileHostTranscriptRead", () => {
  test.each([
    ["run_completed", "idle"],
    ["run_failed", "failed"],
    ["run_aborted", "stopped"],
    ["run_interrupted", "interrupted"],
  ] as const)("keeps a live %s over an older running read", (kind, status) => {
    const read = snapshot([entry("run_started", 1), entry("assistant_message", 2)]);
    let live = createHostTranscriptStream(read);
    live = applyHostTranscriptEvent(live, {
      sessionId: read.id,
      event: { type: "assistant_delta", runId: "run-1", delta: "partial" },
    });
    live = applyHostTranscriptEvent(live, {
      sessionId: read.id,
      event: { type: "entry_appended", entry: entry(kind, 3) },
    });
    const merged = reconcileHostTranscriptRead(read, live);
    expect(merged.snapshot.status).toBe(status);
    expect(merged.snapshot.entries).toHaveLength(3);
    expect(merged.assistantTextByRun).toEqual({});
    expect(projectHostTranscriptStream(merged)[0]?.info.time.completed).toBeDefined();
  });

  test("new run after completion stays running", () => {
    const read = snapshot([entry("run_started", 1), entry("run_completed", 2)]);
    const live = createHostTranscriptStream({
      ...read,
      entries: [...read.entries, entry("run_started", 3, "run-2")],
    });
    expect(reconcileHostTranscriptRead(read, live).snapshot.status).toBe("running");
  });

  test("keeps a delta delivered during a read even when the read has newer durable entries", () => {
    const atRead = createHostTranscriptStream(snapshot([entry("run_started", 1)]));
    const live = applyHostTranscriptEvent(atRead, {
      sessionId: "session-1",
      event: { type: "assistant_delta", runId: "run-1", delta: "new text" },
    });
    const merged = reconcileHostTranscriptRead(
      snapshot([entry("run_started", 1), entry("tool_call", 2)]),
      live,
      atRead,
    );
    expect(merged.assistantTextByRun).toEqual({ "run-1": "new text" });
    expect(merged.snapshot.status).toBe("running");
  });

  test("a durable read replaces unchanged partial buffers and uses fresh metadata", () => {
    const atRead = {
      ...createHostTranscriptStream(snapshot([entry("run_started", 1)])),
      assistantTextByRun: { "run-1": "partial" },
    };
    const read = {
      ...snapshot([entry("run_started", 1), entry("assistant_message", 2)]),
      model: { connectionId: "new", modelId: "new-model" },
    };
    const merged = reconcileHostTranscriptRead(read, atRead, atRead);
    expect(merged.assistantTextByRun).toEqual({});
    expect(merged.snapshot.model).toEqual(read.model);
  });

  test("keeps the next model segment's live buffer when its earlier message is already durable", () => {
    const read = snapshot([
      entry("run_started", 1),
      entry("assistant_message", 2),
      entry("tool_call", 3),
    ]);
    const atRead = {
      ...createHostTranscriptStream(read),
      assistantTextByRun: { "run-1": "next segment" },
    };
    const merged = reconcileHostTranscriptRead(read, atRead, atRead);
    expect(merged.assistantTextByRun).toEqual({ "run-1": "next segment" });
  });

  test("new tool entries do not discard an unpersisted model segment", () => {
    const atRead = {
      ...createHostTranscriptStream(snapshot([entry("run_started", 1)])),
      assistantTextByRun: { "run-1": "partial" },
    };
    const merged = reconcileHostTranscriptRead(
      snapshot([entry("run_started", 1), entry("tool_call", 2)]),
      atRead,
      atRead,
    );
    expect(merged.assistantTextByRun).toEqual({ "run-1": "partial" });
  });

  test("a newer live entry does not revert the read's model and reasoning metadata", () => {
    const read = {
      ...snapshot([entry("run_started", 1)]),
      model: { connectionId: "new", modelId: "new-model" },
      reasoning: "high" as const,
    };
    const live = createHostTranscriptStream(snapshot([...read.entries, entry("run_completed", 2)]));
    const merged = reconcileHostTranscriptRead(read, live);
    expect(merged.snapshot.model).toEqual(read.model);
    expect(merged.snapshot.reasoning).toBe("high");
    expect(merged.snapshot.status).toBe("idle");
  });

  test("retains a model retry delivered during hydration and clears it on completion", () => {
    const read = snapshot([entry("run_started", 1)]);
    const atRead = createHostTranscriptStream(read);
    const live = applyHostTranscriptEvent(atRead, {
      sessionId: read.id,
      event: {
        type: "model_retry",
        delayMs: 1000,
        runId: "run-1",
        attempt: 1,
        maxAttempts: 3,
        code: "overloaded",
      },
    });
    expect(reconcileHostTranscriptRead(read, live, atRead).retryByRun?.["run-1"]).toEqual({
      attempt: 1,
      maxAttempts: 3,
      code: "overloaded",
    });
    const completed = {
      ...read,
      status: "idle" as const,
      entries: [...read.entries, entry("run_completed", 2)],
    };
    expect(reconcileHostTranscriptRead(completed, live, atRead).retryByRun).toEqual({});
  });

  test("keeps live model and reasoning changes newer than the read", () => {
    const read = snapshot([entry("run_started", 1)]);
    const model = { connectionId: "live", modelId: "live-model" };
    let live = createHostTranscriptStream(read);
    live = applyHostTranscriptEvent(live, {
      sessionId: read.id,
      event: {
        type: "entry_appended",
        entry: { ...entry("model_changed", 2), payload: { model } },
      },
    });
    live = applyHostTranscriptEvent(live, {
      sessionId: read.id,
      event: {
        type: "entry_appended",
        entry: { ...entry("reasoning_changed", 3), payload: { reasoning: "high" } },
      },
    });
    const merged = reconcileHostTranscriptRead(read, live);
    expect(merged.snapshot.model).toEqual(model);
    expect(merged.snapshot.reasoning).toBe("high");
  });

  test("does not merge another session", () => {
    const read = snapshot([]);
    const live = createHostTranscriptStream({
      ...read,
      id: "other",
      entries: [entry("run_completed", 1)],
    });
    expect(reconcileHostTranscriptRead(read, live)).toEqual(createHostTranscriptStream(read));
  });
});
