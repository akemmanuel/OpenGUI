import { describe, expect, test } from "vite-plus/test";
import type { QueuedPrompt } from "@/hooks/agent-state-types";
import {
  pickQueuePresentationSlice,
  reduceQueuePresentation,
  removeSessionFromQueueSlice,
  renameSessionIdInQueueSlice,
} from "@/hooks/agent-reducer-queue-slice";

function prompt(id: string, text = "hi"): QueuedPrompt {
  return {
    id,
    text,
    createdAt: 1,
    mode: "queue",
  } as QueuedPrompt;
}

function emptySlice() {
  return pickQueuePresentationSlice({
    queuedPrompts: {},
    afterPartPending: new Set(),
    _afterPartTriggered: new Set(),
  });
}

describe("reduceQueuePresentation", () => {
  test("QUEUE_ADD then QUEUE_REMOVE clears session key", () => {
    let slice = emptySlice();
    slice = reduceQueuePresentation(slice, {
      type: "QUEUE_ADD",
      payload: { sessionID: "s1", prompt: prompt("q1") },
    });
    slice = reduceQueuePresentation(slice, {
      type: "QUEUE_REMOVE",
      payload: { sessionID: "s1", promptID: "q1" },
    });
    expect(slice.queuedPrompts).toEqual({});
  });

  test("SET_AFTER_PART_PENDING toggles after-part steering", () => {
    let slice = emptySlice();
    slice = reduceQueuePresentation(slice, {
      type: "SET_AFTER_PART_PENDING",
      payload: { sessionID: "s1", pending: true },
    });
    expect(slice.afterPartPending.has("s1")).toBe(true);
    slice = reduceQueuePresentation(slice, {
      type: "SET_AFTER_PART_PENDING",
      payload: { sessionID: "s1", pending: false },
    });
    expect(slice.afterPartPending.has("s1")).toBe(false);
  });
});

describe("renameSessionIdInQueueSlice", () => {
  test("renames queue bucket and after-part sets", () => {
    const slice = reduceQueuePresentation(emptySlice(), {
      type: "QUEUE_ADD",
      payload: { sessionID: "old", prompt: prompt("q1") },
    });
    const renamed = renameSessionIdInQueueSlice(
      reduceQueuePresentation(slice, {
        type: "SET_AFTER_PART_PENDING",
        payload: { sessionID: "old", pending: true },
      }),
      "old",
      "new",
    );
    expect(renamed.queuedPrompts.new).toHaveLength(1);
    expect(renamed.queuedPrompts.old).toBeUndefined();
    expect(renamed.afterPartPending.has("new")).toBe(true);
  });
});

describe("removeSessionFromQueueSlice", () => {
  test("drops queued prompts for deleted Session", () => {
    let slice = reduceQueuePresentation(emptySlice(), {
      type: "QUEUE_ADD",
      payload: { sessionID: "gone", prompt: prompt("q1") },
    });
    slice = removeSessionFromQueueSlice(slice, "gone");
    expect(slice.queuedPrompts).toEqual({});
  });
});
