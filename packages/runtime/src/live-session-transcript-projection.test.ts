import { describe, expect, test } from "vite-plus/test";
import type { Message, Part } from "../../../src/protocol/harness-types.ts";
import type { LiveSessionEvent } from "./live-session-events/live-session-event.ts";
import { createLiveSessionTranscriptProjection } from "./live-session-transcript-projection.ts";
import { LiveSessionEventBus } from "./live-session-events/live-session-event-bus.ts";
import { harnessEventsToLiveSessionEvents } from "./live-session-events/harness-events-to-live.ts";
import { createSessionTranscripts } from "./session-transcripts.ts";

const SCOPE = { directory: "/repo", harnessId: "pi", sessionId: "pi:session-1" };

function toolPart(id: string, status: string): Part {
  return {
    id,
    type: "tool",
    tool: "read",
    sessionID: SCOPE.sessionId,
    messageID: "msg-1",
    state: { status },
  } as Part;
}

function message(id: string, role: "user" | "assistant", created = 10, parentID?: string): Message {
  return {
    id,
    sessionID: SCOPE.sessionId,
    role,
    time: { created },
    ...(parentID ? { parentID } : {}),
  } as Message;
}

function entry(parts: Part[], completed?: number): { info: Message; parts: Part[] } {
  return {
    info: {
      id: "msg-1",
      sessionID: SCOPE.sessionId,
      role: "assistant",
      time: { created: 10, ...(completed !== undefined ? { completed } : {}) },
    } as Message,
    parts,
  };
}

function liveFromHarness(
  event: Parameters<typeof harnessEventsToLiveSessionEvents>[0]["event"],
  bus: LiveSessionEventBus,
): LiveSessionEvent[] {
  return harnessEventsToLiveSessionEvents({
    directory: SCOPE.directory,
    harnessId: SCOPE.harnessId as "pi",
    event,
    bus,
  });
}

function toolLiveSequence(
  bus: LiveSessionEventBus,
  partId: string,
  statuses: string[],
): LiveSessionEvent[] {
  const out: LiveSessionEvent[] = [];
  for (const status of statuses) {
    out.push(
      ...liveFromHarness(
        {
          type: "message.part.updated",
          part: toolPart(partId, status),
        },
        bus,
      ),
    );
  }
  return out;
}

describe("live-session-transcript-projection", () => {
  test("tool: terminal status blocks regression from running snapshot", () => {
    const bus = new LiveSessionEventBus();
    const p = createLiveSessionTranscriptProjection(SCOPE);
    p.ingestLiveSessionEvents(toolLiveSequence(bus, "t1", ["running", "completed", "running"]));
    const part = p.getMessages()[0]?.parts[0];
    expect(part?.type === "tool" && part.state.status).toBe("completed");
  });

  test("hydrate completed tool wins over prior live running", async () => {
    const bus = new LiveSessionEventBus();
    const p = createLiveSessionTranscriptProjection(SCOPE);
    p.ingestLiveSessionEvents(
      liveFromHarness({ type: "message.part.updated", part: toolPart("t1", "running") }, bus),
    );
    p.hydrateFromHarnessPage({
      messages: [entry([toolPart("t1", "completed")])],
      nextCursor: null,
    });
    const part = p.getMessages()[0]?.parts[0];
    expect(part?.type === "tool" && part.state.status).toBe("completed");
  });

  test("message completed finalizes pending tools via harness hydrate", () => {
    const p = createLiveSessionTranscriptProjection(SCOPE);
    p.hydrateFromHarnessPage({
      messages: [entry([toolPart("t1", "pending")], 99)],
      nextCursor: null,
    });
    const part = p.getMessages()[0]?.parts[0];
    expect(part?.type === "tool" && part.state.status).toBe("completed");
  });

  test("text: longer streamed prefix kept over shorter hydrate", () => {
    const bus = new LiveSessionEventBus();
    const p = createLiveSessionTranscriptProjection(SCOPE);
    const longText = "hello world stream";
    p.ingestLiveSessionEvents(
      liveFromHarness(
        {
          type: "message.part.updated",
          part: {
            id: "p1",
            type: "text",
            text: longText,
            sessionID: SCOPE.sessionId,
            messageID: "msg-1",
          } as Part,
        },
        bus,
      ),
    );
    p.hydrateFromHarnessPage({
      messages: [
        entry([
          {
            id: "p1",
            type: "text",
            text: "hello",
            sessionID: SCOPE.sessionId,
            messageID: "msg-1",
          } as Part,
        ]),
      ],
      nextCursor: null,
    });
    const part = p.getMessages()[0]?.parts[0] as { text?: string };
    expect(part.text).toBe(longText);
  });

  test("part.delta via live emits accumulated text", () => {
    const bus = new LiveSessionEventBus();
    const p = createLiveSessionTranscriptProjection(SCOPE);
    p.ingestLiveSessionEvents(
      liveFromHarness(
        {
          type: "message.part.delta",
          sessionID: SCOPE.sessionId,
          messageID: "msg-1",
          partID: "p1",
          field: "text",
          delta: "hi",
        },
        bus,
      ),
    );
    const part = p.getMessages()[0]?.parts[0] as { text?: string };
    expect(part.text).toBe("hi");
  });

  test("message order changes do not emit transcript.snapshot (live + idle reconcile)", async () => {
    const bus = new LiveSessionEventBus();
    const transcripts = createSessionTranscripts();
    await transcripts.readPage({
      scope: SCOPE,
      fetchHarnessPage: async () => ({ messages: [], nextCursor: null }),
    });
    const live: LiveSessionEvent[] = [];
    live.push(
      ...liveFromHarness(
        {
          type: "message.part.delta",
          sessionID: SCOPE.sessionId,
          messageID: "a-live",
          partID: "a-text",
          field: "text",
          delta: "answer",
        },
        bus,
      ),
    );
    live.push(
      ...liveFromHarness({ type: "message.updated", message: message("u-live", "user", 10) }, bus),
    );
    transcripts.ingest({ scope: SCOPE, events: live });
    const orderLive = liveFromHarness(
      { type: "message.updated", message: message("a-live", "assistant", 10, "u-live") },
      bus,
    );
    const events = transcripts.ingest({ scope: SCOPE, events: orderLive });
    expect(events.find((event) => event.type === "transcript.snapshot")).toBeUndefined();
  });

  test("idle run.finished emits transcript.snapshot with page cursor", async () => {
    const bus = new LiveSessionEventBus();
    const transcripts = createSessionTranscripts();
    await transcripts.readPage({
      scope: SCOPE,
      fetchHarnessPage: async () => ({ messages: [], nextCursor: "older-cursor" }),
    });
    transcripts.ingest({
      scope: SCOPE,
      events: liveFromHarness(
        {
          type: "message.part.delta",
          sessionID: SCOPE.sessionId,
          messageID: "a-live",
          partID: "a-text",
          field: "text",
          delta: "answer",
        },
        bus,
      ),
    });
    liveFromHarness(
      { type: "session.status", sessionID: SCOPE.sessionId, status: { type: "running" } },
      bus,
    );
    const idleLive = liveFromHarness(
      { type: "session.status", sessionID: SCOPE.sessionId, status: { type: "idle" } },
      bus,
    );
    const events = transcripts.ingest({ scope: SCOPE, events: idleLive });
    const snapshot = events.find((event) => event.type === "transcript.snapshot");
    expect(snapshot?.type).toBe("transcript.snapshot");
    expect(snapshot?.page.nextCursor).toBe("older-cursor");
  });

  test("part mutations do not emit transcript.message", async () => {
    const bus = new LiveSessionEventBus();
    const transcripts = createSessionTranscripts();
    await transcripts.readPage({
      scope: SCOPE,
      fetchHarnessPage: async () => ({ messages: [], nextCursor: null }),
    });
    const events = transcripts.ingest({
      scope: SCOPE,
      events: liveFromHarness(
        {
          type: "message.part.delta",
          sessionID: SCOPE.sessionId,
          messageID: "a-live",
          partID: "a-text",
          field: "text",
          delta: "answer",
        },
        bus,
      ),
    });
    expect(events.map((event) => event.type as string)).not.toContain("transcript.message");
  });

  test("idle status does not publish an empty unhydrated transcript snapshot", () => {
    const bus = new LiveSessionEventBus();
    const transcripts = createSessionTranscripts();
    const events = transcripts.ingest({
      scope: SCOPE,
      events: liveFromHarness(
        { type: "session.status", sessionID: SCOPE.sessionId, status: { type: "idle" } },
        bus,
      ),
    });
    expect(events).toEqual([]);
  });
});
