import { describe, expect, test } from "vite-plus/test";
import {
  isCanonicalSessionNotification,
  mergeCanonicalEventForListener,
} from "./backend-event-normalization";

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

  test("preserves envelope directory for scoped projected transcript events", () => {
    const merged = mergeCanonicalEventForListener({
      id: "evt_3",
      type: "transcript.snapshot",
      directory: "/repo",
      sessionId: "opencode:raw-1",
      harnessId: "opencode",
      payload: {
        scope: { directory: "/repo", harnessId: "opencode", sessionId: "opencode:raw-1" },
        revision: 1,
        page: { revision: 1, messages: [], nextCursor: null },
      },
    });

    expect(merged?.directory).toBe("/repo");
    expect(merged?.sessionId).toBe("opencode:raw-1");
  });

  test("identifies backend SessionRecord notifications as non-Harness sidebar events", () => {
    expect(
      isCanonicalSessionNotification({
        id: "evt_4",
        type: "session.updated",
        directory: "/repo",
        harnessId: "opencode",
        sessionId: "opencode:raw-1",
        session: {
          id: "opencode:raw-1",
          rawId: "raw-1",
          directory: "/repo",
          harnessId: "opencode",
          title: "Backend record",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toBe(true);

    expect(
      isCanonicalSessionNotification({
        id: "evt_5",
        type: "session.updated",
        directory: "/repo",
        harnessId: "opencode",
        session: {
          id: "opencode:raw-1",
          _rawId: "raw-1",
          _projectDir: "/repo",
          time: { created: 1, updated: 2 },
        },
      }),
    ).toBe(false);
  });
});
