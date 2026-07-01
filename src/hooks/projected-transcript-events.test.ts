import { describe, expect, test } from "vite-plus/test";
import {
  isExpectedProjectedTranscriptScope,
  tryParseProjectedTranscriptEvent,
} from "./projected-transcript-events";

describe("tryParseProjectedTranscriptEvent", () => {
  test("parses transcript.snapshot envelope", () => {
    const parsed = tryParseProjectedTranscriptEvent({
      type: "transcript.snapshot",
      scope: { directory: "/repo", harnessId: "pi", sessionId: "pi:s1" },
      revision: 2,
      page: { revision: 2, messages: [], nextCursor: null },
    });
    expect(parsed?.type).toBe("transcript.snapshot");
  });

  test("ignores legacy transcript.message envelopes", () => {
    expect(
      tryParseProjectedTranscriptEvent({
        type: "transcript.message",
        scope: { directory: "/repo", harnessId: "pi", sessionId: "pi:s1" },
        revision: 1,
        entry: { info: { id: "m1" }, parts: [] },
      }),
    ).toBeNull();
  });

  test("returns null without scope", () => {
    expect(tryParseProjectedTranscriptEvent({ type: "transcript.snapshot" })).toBeNull();
  });
});

describe("isExpectedProjectedTranscriptScope", () => {
  test("matches project key by directory", () => {
    expect(
      isExpectedProjectedTranscriptScope(
        { directory: "/repo", harnessId: "pi", sessionId: "pi:s1" },
        new Set(["local\u0000/repo"]),
      ),
    ).toBe(true);
  });
});
