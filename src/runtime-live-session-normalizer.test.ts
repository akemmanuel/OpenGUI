import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessEvent } from "./agents/backend.ts";
import { createSessionHandle } from "../packages/runtime/src/session-handle.ts";
import { LiveSessionProjection } from "../packages/runtime/src/live-session-events/live-session-projection.ts";
import { LiveSessionEventNormalizer } from "../packages/runtime/src/live-session-events/live-session-normalizer.ts";
import type { AdapterObservation } from "../packages/runtime/src/live-session-events/adapter-observation.ts";
import type { LiveSessionScope } from "../packages/runtime/src/live-session-events/live-session-event.ts";

const scope: LiveSessionScope = {
  directory: "/tmp/project",
  harnessId: "pi",
  sessionId: "pi:s1",
};

describe("LiveSessionEventNormalizer", () => {
  test("dedupes repeated running and idle observations", () => {
    const normalizer = new LiveSessionEventNormalizer();
    const events = [
      normalizer.ingest({ kind: "activity", scope, state: "running" }),
      normalizer.ingest({ kind: "activity", scope, state: "running" }),
      normalizer.ingest({ kind: "activity", scope, state: "idle" }),
      normalizer.ingest({ kind: "activity", scope, state: "idle" }),
    ].flat();

    expect(events.map((event) => event.type)).toEqual(["run.started", "run.finished"]);
    expect(events[1]).toMatchObject({ type: "run.finished", reason: "idle" });
  });

  test("turns progressive Pi-style part snapshots into appends", () => {
    const normalizer = new LiveSessionEventNormalizer();
    const events = ["OP", "OPENG", "OPENGUI"].flatMap((text) =>
      normalizer.ingest(partSnapshot(text)),
    );

    expect(events.map((event) => event.type)).toEqual([
      "message.started",
      "part.started",
      "part.text.appended",
      "part.text.appended",
      "part.text.appended",
    ]);
    expect(events.filter((event) => event.type === "part.text.appended")).toMatchObject([
      { text: "OP" },
      { text: "ENG" },
      { text: "UI" },
    ]);
  });

  test("ignores repeated identical snapshots", () => {
    const normalizer = new LiveSessionEventNormalizer();
    normalizer.ingest(partSnapshot("same"));
    const events = normalizer.ingest(partSnapshot("same"));

    expect(events).toEqual([]);
  });

  test("emits replacement when snapshot text becomes empty", () => {
    const normalizer = new LiveSessionEventNormalizer();
    normalizer.ingest(partSnapshot("hello"));
    const events = normalizer.ingest(partSnapshot(""));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "part.text.replaced",
      text: "",
      reason: "snapshot-rewrite",
    });
  });

  test("part ids are scoped per message", () => {
    const normalizer = new LiveSessionEventNormalizer();
    const events = [
      ...normalizer.ingest(partSnapshotForMessage("m1", "p1", "a")),
      ...normalizer.ingest(partSnapshotForMessage("m2", "p1", "b")),
    ];
    const appends = events.filter((e) => e.type === "part.text.appended");
    expect(appends).toHaveLength(2);
    expect(appends[0]).toMatchObject({ messageId: "m1", text: "a" });
    expect(appends[1]).toMatchObject({ messageId: "m2", text: "b" });
  });

  test("turns non-prefix snapshots into replacements", () => {
    const normalizer = new LiveSessionEventNormalizer();
    normalizer.ingest(partSnapshot("I will use rg"));
    const events = normalizer.ingest(partSnapshot("I will inspect package.json"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "part.text.replaced",
      text: "I will inspect package.json",
      reason: "snapshot-rewrite",
    });
  });

  test("delta and snapshot paths converge in projection", () => {
    const snapshotNormalizer = new LiveSessionEventNormalizer();
    const deltaNormalizer = new LiveSessionEventNormalizer();
    const snapshotProjection = new LiveSessionProjection();
    const deltaProjection = new LiveSessionProjection();

    ["O", "OP", "OPEN"].forEach((text) => {
      snapshotNormalizer
        .ingest(partSnapshot(text))
        .forEach((event) => snapshotProjection.apply(event));
    });
    ["O", "P", "EN"].forEach((text) => {
      deltaNormalizer
        .ingest({
          kind: "part.delta",
          scope,
          messageId: "m1",
          partId: "p1",
          partKind: "text",
          text,
        })
        .forEach((event) => deltaProjection.apply(event));
    });

    expect(snapshotProjection.getMessages()).toEqual(deltaProjection.getMessages());
  });
});

describe("SessionHandle live event compatibility", () => {
  test("waitUntilIdle does not duplicate onEvent or onStream output", async () => {
    let status: "idle" | "running" = "running";
    const subscribers = new Set<(event: HarnessEvent) => void>();
    const session = createSessionHandle({
      harnessId: "pi",
      directory: "/tmp/project",
      sessionId: "pi:s1",
      service: {} as never,
      transcripts: {} as never,
      resolveSessionIds: () => ({ rawId: "s1" }),
      getSessionStatus: () => status,
      markSessionRunning: () => {
        status = "running";
      },
      subscribeHarnessEvents: (handler) => {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
      },
    });
    const liveTypes: string[] = [];
    const streamTypes: string[] = [];
    const offEvent = session.onEvent((event) => liveTypes.push(event.type));
    const offStream = session.onStream((event) => streamTypes.push(event.type));

    emit(subscribers, { type: "session.status", sessionID: "s1", status: { type: "running" } });
    const waiting = session.waitUntilIdle({ timeoutMs: 1_000 });
    status = "idle";
    emit(subscribers, { type: "session.status", sessionID: "s1", status: { type: "idle" } });
    await waiting;

    expect(liveTypes).toEqual(["run.started", "run.finished"]);
    expect(streamTypes).toEqual(["run.start", "run.end"]);
    offEvent();
    offStream();
    session.close();
  });
});

function partSnapshot(text: string): AdapterObservation {
  return partSnapshotForMessage("m1", "p1", text);
}

function partSnapshotForMessage(
  messageId: string,
  partId: string,
  text: string,
): AdapterObservation {
  return {
    kind: "part.snapshot",
    scope,
    messageId,
    part: {
      id: partId,
      sessionID: "pi:s1",
      messageID: messageId,
      type: "text",
      text,
      tokens: {},
    },
  };
}

function emit(subscribers: Set<(event: HarnessEvent) => void>, event: HarnessEvent): void {
  for (const subscriber of subscribers) subscriber(event);
}
