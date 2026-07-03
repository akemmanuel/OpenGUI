import { describe, expect, test } from "vite-plus/test";
import { createSessionTranscripts, LiveSessionEventBus } from "@opengui/runtime";
import type { LiveSessionScope } from "@opengui/runtime";
import type { MessageEntry } from "@/hooks/agent-state-types";
import {
  ActiveSessionTranscriptStore,
  type FrameScheduler,
} from "@/features/session-transcript/active-session-transcript-store";
import type { ActiveTranscriptScope } from "@/features/session-transcript/transcript-input";

const scope: ActiveTranscriptScope & LiveSessionScope = {
  directory: "/repo",
  harnessId: "pi",
  sessionId: "pi:s1",
};

function userEntry(id: string, text: string): MessageEntry {
  return {
    info: {
      id,
      sessionID: scope.sessionId,
      role: "user",
      time: { created: 1 },
      providerID: "nvidia",
      modelID: "openai/gpt-oss-120b",
    },
    parts: [
      {
        id: `${id}:text:0`,
        sessionID: scope.sessionId,
        messageID: id,
        type: "text",
        text,
        tokens: {},
      },
    ],
  };
}

function assistantInfo(id: string): MessageEntry["info"] {
  return {
    id,
    sessionID: scope.sessionId,
    role: "assistant",
    time: { created: 2 },
    providerID: "nvidia",
    modelID: "openai/gpt-oss-120b",
  };
}

function createStore() {
  const scheduled: Array<() => void> = [];
  const frameScheduler: FrameScheduler = {
    schedule: (cb) => {
      scheduled.push(cb);
      return cb;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle as () => void);
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
  const store = new ActiveSessionTranscriptStore({ frameScheduler });
  return { store, flushFrames: () => scheduled.splice(0).forEach((cb) => cb()) };
}

describe("runtime transcript settle regression", () => {
  test("idle projected snapshot applies when run has finished and snapshot includes streamed assistant", async () => {
    const { store, flushFrames } = createStore();
    const liveBus = new LiveSessionEventBus();
    const transcripts = createSessionTranscripts();
    const user = userEntry("u1", "hi");
    const assistant = assistantInfo("a1");

    store.select(scope);
    store.dispatch({
      type: "page.loaded",
      scope,
      messages: [user],
      hasMore: false,
      nextCursor: null,
      phase: "initial",
    });

    for (const event of liveBus.publish([
      { kind: "activity", scope, state: "running" },
      { kind: "message.snapshot", scope, message: assistant },
      {
        kind: "part.snapshot",
        scope,
        messageId: assistant.id,
        part: {
          id: `${assistant.id}:reasoning:0`,
          sessionID: scope.sessionId,
          messageID: assistant.id,
          type: "reasoning",
          text: "thinking through it",
          time: { start: 2 },
          tokens: {},
        },
      },
      {
        kind: "part.snapshot",
        scope,
        messageId: assistant.id,
        part: {
          id: `${assistant.id}:text:0`,
          sessionID: scope.sessionId,
          messageID: assistant.id,
          type: "text",
          text: "Hello!",
          tokens: {},
        },
      },
    ])) {
      store.ingestLive(event);
    }
    flushFrames();

    expect(store.getSnapshot().messages.map((message) => message.info.id)).toEqual(["u1", "a1"]);
    expect(store.getSnapshot().messages[1]?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
    ]);

    for (const event of liveBus.publish([{ kind: "activity", scope, state: "idle" }])) {
      store.ingestLive(event);
    }

    await transcripts.readPage({
      scope,
      fetchHarnessPage: async () => ({ messages: [user], nextCursor: null }),
    });
    const transcriptIdleBus = new LiveSessionEventBus();
    transcriptIdleBus.publish([{ kind: "activity", scope, state: "running" }]);
    const idleLive = transcriptIdleBus.publish([{ kind: "activity", scope, state: "idle" }]);
    const streamedBeforeIdle = store.getSnapshot().messages;
    const [snapshot] = transcripts.ingest({ scope, events: idleLive });
    expect(snapshot?.type).toBe("transcript.snapshot");

    store.dispatch({
      type: "snapshot.loaded",
      scope,
      messages: streamedBeforeIdle,
      hasMore: false,
      nextCursor: null,
    });

    expect(store.getSnapshot().messages.map((message) => message.info.id)).toEqual(["u1", "a1"]);
    expect(store.getSnapshot().messages[1]?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
    ]);
  });
});
