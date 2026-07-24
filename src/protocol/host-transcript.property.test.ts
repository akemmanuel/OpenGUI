import { describe, expect, test } from "vite-plus/test";
import { seeded } from "../lib/__tests__/seeded.ts";
import type { HostEvent, HostSessionSnapshot } from "./host-types.ts";
import { applyHostTranscriptEvent, createHostTranscriptStream } from "./host-transcript.ts";

const snapshot: HostSessionSnapshot = {
  id: "property-session",
  projectDirectory: "/project",
  title: "Property",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "running",
  model: null,
  reasoning: "none",
  entries: [],
  followUps: [],
};

describe("seeded transcript ordering and deduplication properties", () => {
  test("every permutation and duplicate pattern projects one sequence-ordered durable log", () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const random = seeded(seed);
      const count = random.int(1, 80);
      const canonical = Array.from(
        { length: count },
        (_, index): HostEvent => ({
          sessionId: snapshot.id,
          event: {
            type: "entry_appended",
            entry: {
              id: `entry-${index + 1}`,
              sessionId: snapshot.id,
              sequence: index + 1,
              kind: "user_message",
              payload: { text: `message-${index + 1}` },
              createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
            },
          },
        }),
      );
      const delivery = random.shuffle([
        ...canonical,
        ...canonical.filter(() => random.int(0, 2) === 0),
      ]);
      let stream = createHostTranscriptStream(snapshot);
      for (const event of delivery) stream = applyHostTranscriptEvent(stream, event);
      expect(
        stream.snapshot.entries.map((entry) => entry.id),
        `seed ${seed}`,
      ).toEqual(
        canonical.map((event) => event.event.type === "entry_appended" && event.event.entry.id),
      );
    }
  });
});
