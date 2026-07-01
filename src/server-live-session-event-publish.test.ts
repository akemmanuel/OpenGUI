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

  test("publishes tool input and output from tool snapshots", () => {
    const events = new BackendEventBus();
    const bus = new LiveSessionEventBus();
    const emitted: unknown[] = [];
    events.subscribe((envelope) => emitted.push(envelope.payload));

    const toolSnapshot: HarnessEvent = {
      type: "message.part.updated",
      part: {
        id: "tool-1",
        sessionID: sessionId,
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "read",
        tokens: {},
        state: {
          status: "completed",
          input: { path: "package.json" },
          output: '{"name":"opengui"}',
        },
      },
    };

    publishLiveSessionHarnessEvent({ events }, { directory, harnessId, event: toolSnapshot }, bus);

    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.started", tool: "read" }),
        expect.objectContaining({ type: "tool.input.updated", input: { path: "package.json" } }),
        expect.objectContaining({
          type: "tool.output.replaced",
          text: '{"name":"opengui"}',
        }),
        expect.objectContaining({ type: "tool.finished", status: "completed" }),
      ]),
    );
  });

  test("preserves replacement identity for replaced messages", () => {
    const events = new BackendEventBus();
    const bus = new LiveSessionEventBus();
    const rebased: unknown[] = [];
    events.subscribe((envelope) => {
      if (envelope.type === "transcript.rebased") rebased.push(envelope.payload);
    });

    const replaced: HarnessEvent = {
      type: "message.replaced",
      sessionID: sessionId,
      oldId: "old-assistant",
      message: {
        id: "real-assistant",
        sessionID: sessionId,
        role: "assistant",
        time: { created: 1, completed: 2 },
        providerID: "pi",
        modelID: "model",
      },
      parts: [],
    };

    publishLiveSessionHarnessEvent({ events }, { directory, harnessId, event: replaced }, bus);

    expect(rebased).toHaveLength(1);
    expect(rebased[0]).toMatchObject({
      type: "transcript.rebased",
      reason: "harness-replaced-message",
      replacement: {
        oldMessageId: "old-assistant",
        newMessageId: "real-assistant",
      },
    });
  });

  test("replaced tool-call messages retain canonical tool input and output", () => {
    const events = new BackendEventBus();
    const bus = new LiveSessionEventBus();
    const emitted: unknown[] = [];
    events.subscribe((envelope) => emitted.push(envelope.payload));

    const replaced: HarnessEvent = {
      type: "message.replaced",
      sessionID: sessionId,
      oldId: "streaming-assistant",
      message: {
        id: "real-assistant",
        sessionID: sessionId,
        role: "assistant",
        time: { created: 1, completed: 2 },
        providerID: "pi",
        modelID: "model",
      },
      parts: [
        {
          id: "tool-1",
          sessionID: sessionId,
          messageID: "real-assistant",
          type: "tool",
          callID: "call-1",
          tool: "read",
          tokens: {},
          state: {
            status: "completed",
            input: { path: "package.json" },
            output: '{"name":"opengui"}',
          },
        },
      ],
    };

    publishLiveSessionHarnessEvent({ events }, { directory, harnessId, event: replaced }, bus);

    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "transcript.rebased",
          replacement: {
            oldMessageId: "streaming-assistant",
            newMessageId: "real-assistant",
          },
        }),
        expect.objectContaining({ type: "tool.input.updated", input: { path: "package.json" } }),
        expect.objectContaining({
          type: "tool.output.replaced",
          text: '{"name":"opengui"}',
        }),
      ]),
    );
  });
});
