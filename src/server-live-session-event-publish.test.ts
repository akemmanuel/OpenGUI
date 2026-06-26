import { describe, expect, test } from "vite-plus/test";
import type { HarnessEvent } from "@/agents/backend";
import { LiveSessionEventBus } from "@opengui/runtime";
import { BackendEventBus } from "../server/services/event-bus.ts";
import { publishLiveSessionHarnessEvent } from "../server/live-session-event-publish.ts";

const directory = "/tmp/project";
const harnessId = "pi" as const;
const sessionId = "pi:s1";

describe("publishLiveSessionHarnessEvent", () => {
  test("publishes deduped run.started and run.finished for repeated session.status", () => {
    const events = new BackendEventBus();
    const bus = new LiveSessionEventBus();
    const envelopes: Array<{ type: string; payload: unknown }> = [];
    events.subscribe((envelope) => {
      envelopes.push({ type: envelope.type, payload: envelope.payload });
    });

    const running: HarnessEvent = {
      type: "session.status",
      sessionID: sessionId,
      status: { type: "running" },
    };
    const idle: HarnessEvent = {
      type: "session.status",
      sessionID: sessionId,
      status: { type: "idle" },
    };

    const services = { events };
    publishLiveSessionHarnessEvent(services, { directory, harnessId, event: running }, bus);
    publishLiveSessionHarnessEvent(services, { directory, harnessId, event: running }, bus);
    publishLiveSessionHarnessEvent(services, { directory, harnessId, event: idle }, bus);
    publishLiveSessionHarnessEvent(services, { directory, harnessId, event: idle }, bus);

    expect(envelopes.map((e) => e.type)).toEqual(["run.started", "run.finished"]);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]!.payload).toMatchObject({
      type: "run.started",
      scope: { directory, harnessId, sessionId },
    });
    expect(envelopes[1]!.payload).toMatchObject({
      type: "run.finished",
      reason: "idle",
    });
  });

  test("publishes part.text.appended for progressive message.part.updated snapshots", () => {
    const events = new BackendEventBus();
    const bus = new LiveSessionEventBus();
    const types: string[] = [];
    events.subscribe((envelope) => types.push(envelope.type));

    const part = (text: string) =>
      ({
        type: "message.part.updated",
        part: {
          id: "p1",
          sessionID: sessionId,
          messageID: "m1",
          type: "text",
          text,
          tokens: {},
        },
      }) satisfies HarnessEvent;

    const services = { events };
    publishLiveSessionHarnessEvent(services, { directory, harnessId, event: part("OP") }, bus);
    publishLiveSessionHarnessEvent(services, { directory, harnessId, event: part("OPENG") }, bus);

    expect(types).toEqual([
      "message.started",
      "part.started",
      "part.text.appended",
      "part.text.appended",
    ]);
  });

  test("publishes part.text.appended for message.part.delta", () => {
    const events = new BackendEventBus();
    const bus = new LiveSessionEventBus();
    const appended: unknown[] = [];
    events.subscribe((envelope) => {
      if (envelope.type === "part.text.appended") appended.push(envelope.payload);
    });

    const delta: HarnessEvent = {
      type: "message.part.delta",
      sessionID: sessionId,
      messageID: "m1",
      partID: "p1",
      field: "text",
      delta: "hello",
    };
    publishLiveSessionHarnessEvent({ events }, { directory, harnessId, event: delta }, bus);

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ type: "part.text.appended", text: "hello" });
  });
});
