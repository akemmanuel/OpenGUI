import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mergeCanonicalEventForListener } from "./backend-event-normalization";

describe("mergeCanonicalEventForListener", () => {
  test("keeps payload sessionId for queue events", () => {
    const merged = mergeCanonicalEventForListener({
      id: "evt_1",
      type: "queue.removed",
      sessionId: "session_canonical_index",
      harnessId: "opencode",
      payload: {
        sessionId: "opencode:raw-1",
        canonicalSessionId: "session_canonical_index",
        entryId: "q1",
        entries: [],
      },
    });

    expect(merged?.sessionId).toBe("opencode:raw-1");
    expect(merged?.entries).toEqual([]);
  });

  test("uses envelope sessionId for non-queue canonical events", () => {
    const merged = mergeCanonicalEventForListener({
      id: "evt_2",
      type: "session.updated",
      sessionId: "session_canonical_index",
      projectId: "/repo",
      harnessId: "opencode",
      payload: {
        sessionId: "session_canonical_index",
        session: { id: "session_canonical_index" },
      },
    });

    expect(merged?.sessionId).toBe("session_canonical_index");
  });
});
