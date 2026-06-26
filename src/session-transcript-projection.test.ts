import { describe, expect, test } from "vite-plus/test";
import type { Message, Part } from "@/protocol/harness-types";
import {
  createSessionTranscriptProjection,
  createSessionTranscripts,
  type TranscriptMessageEntry,
} from "@opengui/runtime";

const SCOPE = { directory: "/repo", harnessId: "pi", sessionId: "session-1" };

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

function textPart(id: string, messageID: string, text: string): Part {
  return {
    id,
    type: "text",
    text,
    sessionID: SCOPE.sessionId,
    messageID,
  } as Part;
}

function messageEntry(info: Message, parts: Part[] = []): TranscriptMessageEntry {
  return { info, parts };
}

function entry(parts: Part[], completed?: number): TranscriptMessageEntry {
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

describe("session-transcript-projection", () => {
  test("tool: terminal status blocks regression from running snapshot", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.ingestHarnessEvent({ type: "message.part.updated", part: toolPart("t1", "running") });
    p.ingestHarnessEvent({ type: "message.part.updated", part: toolPart("t1", "completed") });
    p.ingestHarnessEvent({ type: "message.part.updated", part: toolPart("t1", "running") });
    const part = p.getMessages()[0]?.parts[0];
    expect(part?.type === "tool" && part.state.status).toBe("completed");
  });

  test("hydrate completed tool wins over prior live running", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.ingestHarnessEvent({ type: "message.part.updated", part: toolPart("t1", "running") });
    p.hydrateFromHarnessPage({
      messages: [entry([toolPart("t1", "completed")])],
      nextCursor: null,
    });
    const part = p.getMessages()[0]?.parts[0];
    expect(part?.type === "tool" && part.state.status).toBe("completed");
  });

  test("message completed finalizes pending tools", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.ingestHarnessEvent({ type: "message.part.updated", part: toolPart("t1", "pending") });
    p.ingestHarnessEvent({
      type: "message.updated",
      message: {
        id: "msg-1",
        sessionID: SCOPE.sessionId,
        role: "assistant",
        time: { created: 10, completed: 99 },
      } as Message,
    });
    const part = p.getMessages()[0]?.parts[0];
    expect(part?.type === "tool" && part.state.status).toBe("completed");
  });

  test("text: longer streamed prefix kept over shorter hydrate", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    const longText = "hello world stream";
    p.ingestHarnessEvent({
      type: "message.part.updated",
      part: {
        id: "p1",
        type: "text",
        text: longText,
        sessionID: SCOPE.sessionId,
        messageID: "msg-1",
      } as Part,
    });
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

  test("hydrate then live yields same monotonic tool state", () => {
    const a = createSessionTranscriptProjection(SCOPE);
    a.hydrateFromHarnessPage({
      messages: [entry([toolPart("t1", "completed")])],
      nextCursor: null,
    });
    a.ingestHarnessEvent({ type: "message.part.updated", part: toolPart("t1", "running") });
    const b = createSessionTranscriptProjection(SCOPE);
    b.ingestHarnessEvent({ type: "message.part.updated", part: toolPart("t1", "running") });
    b.hydrateFromHarnessPage({
      messages: [entry([toolPart("t1", "completed")])],
      nextCursor: null,
    });
    expect(a.getMessages()).toEqual(b.getMessages());
  });

  test("part.delta emits projected message.part.updated", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    const events = p.ingestHarnessEvent({
      type: "message.part.delta",
      sessionID: SCOPE.sessionId,
      messageID: "msg-1",
      partID: "p1",
      field: "text",
      delta: "hi",
    });
    expect(events.some((e) => e.type === "message.part.updated")).toBe(true);
    const part = p.getMessages()[0]?.parts[0] as { text?: string };
    expect(part.text).toBe("hi");
  });

  test("same-millisecond user and assistant messages preserve turn order", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.ingestHarnessEvent({ type: "message.updated", message: message("u-same", "user", 10) });
    p.ingestHarnessEvent({
      type: "message.updated",
      message: message("a-same", "assistant", 10, "u-same"),
    });
    expect(p.getMessages().map((m) => m.info.id)).toEqual(["u-same", "a-same"]);
  });

  test("placeholder assistant parts do not pin the message before their parent", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.ingestHarnessEvent({
      type: "message.part.delta",
      sessionID: SCOPE.sessionId,
      messageID: "a-placeholder",
      partID: "z-text",
      field: "text",
      delta: "working",
    });
    p.ingestHarnessEvent({
      type: "message.updated",
      message: message("u-parent", "user", 10),
    });
    p.ingestHarnessEvent({
      type: "message.updated",
      message: message("a-placeholder", "assistant", 10, "u-parent"),
    });
    expect(p.getMessages().map((m) => m.info.id)).toEqual(["u-parent", "a-placeholder"]);
  });

  test("part events without timestamps preserve arrival order", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.ingestHarnessEvent({ type: "message.part.updated", part: textPart("z-first", "msg-1", "1") });
    p.ingestHarnessEvent({
      type: "message.part.updated",
      part: textPart("a-second", "msg-1", "2"),
    });
    expect(p.getMessages()[0]?.parts.map((part) => part.id)).toEqual(["z-first", "a-second"]);
  });

  test("harness page part order is canonical even when ids sort differently", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.hydrateFromHarnessPage({
      messages: [
        messageEntry(message("msg-page", "assistant"), [
          textPart("z-first", "msg-page", "1"),
          textPart("a-second", "msg-page", "2"),
        ]),
      ],
      nextCursor: null,
    });
    expect(p.getMessages()[0]?.parts.map((part) => part.id)).toEqual(["z-first", "a-second"]);
  });

  test("hydrate/live and live/hydrate converge on ordered turn transcript", () => {
    const page = {
      messages: [
        messageEntry(message("u-turn", "user", 10), [textPart("u-text", "u-turn", "prompt")]),
        messageEntry(message("a-turn", "assistant", 10, "u-turn"), [
          textPart("a-text", "a-turn", "answer"),
        ]),
      ],
      nextCursor: null,
    };
    const liveEvents = [
      {
        type: "message.part.delta" as const,
        sessionID: SCOPE.sessionId,
        messageID: "a-turn",
        partID: "a-text",
        field: "text",
        delta: "answer",
      },
      { type: "message.updated" as const, message: message("u-turn", "user", 10) },
      {
        type: "message.updated" as const,
        message: message("a-turn", "assistant", 10, "u-turn"),
      },
    ];

    const a = createSessionTranscriptProjection(SCOPE);
    for (const event of liveEvents) a.ingestHarnessEvent(event);
    a.hydrateFromHarnessPage(page);

    const b = createSessionTranscriptProjection(SCOPE);
    b.hydrateFromHarnessPage(page);
    for (const event of liveEvents) b.ingestHarnessEvent(event);

    expect(a.getMessages()).toEqual(b.getMessages());
    expect(a.getMessages().map((m) => m.info.id)).toEqual(["u-turn", "a-turn"]);
  });

  test("duplicate delta event ids are idempotent", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    const event = {
      id: "delta-1",
      type: "message.part.delta" as const,
      sessionID: SCOPE.sessionId,
      messageID: "msg-1",
      partID: "p1",
      field: "text",
      delta: "hi",
    };
    p.ingestHarnessEvent(event);
    p.ingestHarnessEvent(event);
    const part = p.getMessages()[0]?.parts[0] as { text?: string };
    expect(part.text).toBe("hi");
  });

  test("full updates cover later stale deltas without duplicating text", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.ingestHarnessEvent({
      type: "message.part.updated",
      part: textPart("p1", "msg-1", "hello world"),
    });
    p.ingestHarnessEvent({
      type: "message.part.delta",
      sessionID: SCOPE.sessionId,
      messageID: "msg-1",
      partID: "p1",
      field: "text",
      delta: "hello",
    });
    p.ingestHarnessEvent({
      type: "message.part.delta",
      sessionID: SCOPE.sessionId,
      messageID: "msg-1",
      partID: "p1",
      field: "text",
      delta: " world",
    });
    p.ingestHarnessEvent({
      type: "message.part.delta",
      sessionID: SCOPE.sessionId,
      messageID: "msg-1",
      partID: "p1",
      field: "text",
      delta: "!",
    });
    const part = p.getMessages()[0]?.parts[0] as { text?: string };
    expect(part.text).toBe("hello world!");
  });

  test("cumulative delta payloads replace the field instead of appending the prefix again", () => {
    const p = createSessionTranscriptProjection(SCOPE);
    p.ingestHarnessEvent({
      type: "message.part.delta",
      sessionID: SCOPE.sessionId,
      messageID: "msg-1",
      partID: "p1",
      field: "text",
      delta: "hello",
    });
    p.ingestHarnessEvent({
      type: "message.part.delta",
      sessionID: SCOPE.sessionId,
      messageID: "msg-1",
      partID: "p1",
      field: "text",
      delta: "hello world",
    });
    const part = p.getMessages()[0]?.parts[0] as { text?: string };
    expect(part.text).toBe("hello world");
  });

  test("session transcripts emit a snapshot when message order changes", async () => {
    const transcripts = createSessionTranscripts();
    await transcripts.readPage({
      scope: SCOPE,
      fetchHarnessPage: async () => ({ messages: [], nextCursor: null }),
    });
    transcripts.ingest({
      scope: SCOPE,
      event: {
        type: "message.part.delta",
        sessionID: SCOPE.sessionId,
        messageID: "a-live",
        partID: "a-text",
        field: "text",
        delta: "answer",
      },
    });
    transcripts.ingest({
      scope: SCOPE,
      event: { type: "message.updated", message: message("u-live", "user", 10) },
    });
    const events = transcripts.ingest({
      scope: SCOPE,
      event: {
        type: "message.updated",
        message: message("a-live", "assistant", 10, "u-live"),
      },
    });
    const snapshot = events.find((event) => event.type === "transcript.snapshot");
    expect(snapshot?.type).toBe("transcript.snapshot");
    expect(snapshot?.page.messages.map((entry) => entry.info.id)).toEqual(["u-live", "a-live"]);
  });

  test("live order snapshots preserve the last harness page cursor", async () => {
    const transcripts = createSessionTranscripts();
    await transcripts.readPage({
      scope: SCOPE,
      fetchHarnessPage: async () => ({ messages: [], nextCursor: "older-cursor" }),
    });
    transcripts.ingest({
      scope: SCOPE,
      event: {
        type: "message.part.delta",
        sessionID: SCOPE.sessionId,
        messageID: "a-live",
        partID: "a-text",
        field: "text",
        delta: "answer",
      },
    });
    transcripts.ingest({
      scope: SCOPE,
      event: { type: "message.updated", message: message("u-live", "user", 10) },
    });
    const events = transcripts.ingest({
      scope: SCOPE,
      event: {
        type: "message.updated",
        message: message("a-live", "assistant", 10, "u-live"),
      },
    });
    const snapshot = events.find((event) => event.type === "transcript.snapshot");
    expect(snapshot?.type).toBe("transcript.snapshot");
    expect(snapshot?.page.nextCursor).toBe("older-cursor");
  });

  test("idle status does not publish an empty unhydrated transcript snapshot", () => {
    const transcripts = createSessionTranscripts();
    const events = transcripts.ingest({
      scope: SCOPE,
      event: { type: "session.status", sessionID: SCOPE.sessionId, status: { type: "idle" } },
    });
    expect(events).toEqual([]);
  });
});
