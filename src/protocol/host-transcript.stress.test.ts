import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vite-plus/test";
import type { HostEvent, HostSessionSnapshot } from "./host-types";
import {
  applyHostTranscriptEvent,
  createHostTranscriptStream,
  projectHostTranscriptStream,
} from "./host-transcript";

function snapshot(): HostSessionSnapshot {
  return {
    id: "stress-session",
    projectDirectory: "/stress",
    title: "Stress",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    status: "running",
    model: { connectionId: "fixture", modelId: "fixture" },
    reasoning: "none",
    entries: [],
    followUps: [],
  };
}

describe("Host transcript stress invariants", () => {
  test("deduplicates and orders thousands of out-of-order durable events within a generous budget", () => {
    const count = 2_500;
    let stream = createHostTranscriptStream(snapshot());
    const started = performance.now();

    for (let sequence = count; sequence >= 1; sequence -= 1) {
      const event: HostEvent = {
        sessionId: "stress-session",
        event: {
          type: "entry_appended",
          entry: {
            id: `message-${sequence}`,
            sessionId: "stress-session",
            sequence,
            kind: "user_message",
            payload: { text: `Nachricht ${sequence}` },
            createdAt: "2026-07-01T00:00:01.000Z",
          },
        },
      };
      stream = applyHostTranscriptEvent(stream, event);
      stream = applyHostTranscriptEvent(stream, event);
    }

    const elapsedMs = performance.now() - started;
    expect(stream.snapshot.entries).toHaveLength(count);
    expect(stream.snapshot.entries[0]?.sequence).toBe(1);
    expect(stream.snapshot.entries.at(-1)?.sequence).toBe(count);
    expect(projectHostTranscriptStream(stream)).toHaveLength(count);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("keeps only one live buffer per run during large delta streams and releases it on durability", () => {
    let stream = createHostTranscriptStream(snapshot());
    for (let index = 0; index < 10_000; index += 1) {
      stream = applyHostTranscriptEvent(stream, {
        sessionId: "stress-session",
        event: { type: "assistant_delta", runId: "run-1", delta: "x" },
      });
    }
    expect(Object.keys(stream.assistantTextByRun)).toEqual(["run-1"]);
    expect(stream.assistantTextByRun["run-1"]).toHaveLength(10_000);

    stream = applyHostTranscriptEvent(stream, {
      sessionId: "stress-session",
      event: {
        type: "entry_appended",
        entry: {
          id: "assistant-1",
          sessionId: "stress-session",
          sequence: 1,
          kind: "assistant_message",
          payload: { runId: "run-1", text: "durable" },
          createdAt: "2026-07-01T00:00:02.000Z",
        },
      },
    });
    expect(stream.assistantTextByRun).toEqual({});
  });
});
