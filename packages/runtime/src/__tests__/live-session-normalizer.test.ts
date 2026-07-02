import { describe, expect, test } from "vite-plus/test";
import { LiveSessionProjection } from "../live-session-events/live-session-projection.ts";
import { LiveSessionEventNormalizer } from "../live-session-events/live-session-normalizer.ts";
import type { AdapterObservation } from "../live-session-events/adapter-observation.ts";
import type { LiveSessionScope } from "../live-session-events/live-session-event.ts";

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

function partSnapshot(text: string): AdapterObservation {
  return {
    kind: "part.snapshot",
    scope,
    messageId: "m1",
    part: {
      id: "p1",
      sessionID: scope.sessionId,
      messageID: "m1",
      type: "text",
      text,
      tokens: {},
    },
  };
}
