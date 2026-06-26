import { describe, expect, test } from "vite-plus/test";
import { BackendEventBus } from "../server/services/event-bus.ts";
import { publishProjectedTranscriptEvent } from "../server/projected-transcript-publish.ts";

const scope = { directory: "/repo", harnessId: "pi" as const, sessionId: "pi:s1" };

describe("publishProjectedTranscriptEvent", () => {
  test("does not publish transcript.message on the canonical bus", () => {
    const events = new BackendEventBus();
    const published: string[] = [];
    events.subscribe((envelope) => published.push(envelope.type));

    const ok = publishProjectedTranscriptEvent(
      { events },
      {
        type: "transcript.message",
        scope,
        revision: 1,
        entry: {
          info: {
            id: "m1",
            sessionID: "pi:s1",
            role: "assistant",
            time: { created: 1 },
            providerID: "",
            modelID: "",
          },
          parts: [],
        },
      },
    );

    expect(ok).toBe(false);
    expect(published).toEqual([]);
  });

  test("publishes transcript.snapshot and transcript.message.removed", () => {
    const events = new BackendEventBus();
    const published: string[] = [];
    events.subscribe((envelope) => published.push(envelope.type));

    publishProjectedTranscriptEvent(
      { events },
      {
        type: "transcript.snapshot",
        scope,
        revision: 2,
        page: { revision: 2, messages: [], nextCursor: null },
      },
    );
    publishProjectedTranscriptEvent(
      { events },
      {
        type: "transcript.message.removed",
        scope,
        revision: 3,
        messageID: "m1",
      },
    );

    expect(published).toEqual(["transcript.snapshot", "transcript.message.removed"]);
  });
});
