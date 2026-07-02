import { describe, expect, test } from "vite-plus/test";
import type { Part } from "../../../../src/protocol/harness-types.ts";
import { applyTranscriptPartDelta } from "../transcript-part-delta.ts";

const SCOPE = { sessionID: "s1", messageID: "m1", partID: "p1", field: "text" as const };

describe("applyTranscriptPartDelta", () => {
  test("duplicate event id is idempotent", () => {
    const state = { cursor: 0, seenEventIds: new Set<string>() };
    const part = { id: "p1", type: "text", text: "hi" } as Part;
    const event = { type: "message.part.delta" as const, ...SCOPE, id: "d1", delta: "hi" };
    applyTranscriptPartDelta(part, event, state);
    const second = applyTranscriptPartDelta(part, event, state);
    expect(second.duplicate).toBe(true);
    expect(second.changed).toBe(false);
  });

  test("cumulative delta replaces field instead of double-appending prefix", () => {
    const state = { cursor: 0, seenEventIds: new Set<string>() };
    let part = { id: "p1", type: "text", text: "" } as Part;
    part = applyTranscriptPartDelta(
      part,
      { type: "message.part.delta", ...SCOPE, delta: "hello" },
      state,
    ).part;
    const result = applyTranscriptPartDelta(
      part,
      { type: "message.part.delta", ...SCOPE, delta: "hello world" },
      state,
    );
    expect(result.part).toMatchObject({ text: "hello world" });
  });
});
